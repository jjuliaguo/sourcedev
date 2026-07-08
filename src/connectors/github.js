// GitHub connector — the spine. Proposes projects + builders, snapshots stars.
// Frugal by design: unauthenticated search = 10 req/min, core = 60 req/hr.
// Set GITHUB_TOKEN for 30 req/min search and 5000 req/hr core.
import { config } from '../config.js';
import { upsertProject, addSnapshot, upsertBuilder, enrichBuilder, tagOrgMember, db } from '../db.js';
import { isMostlyEnglish, isConsumerApp, isMirrorOrBoilerplate, classifyRegion, detectUniversity, detectFounderDenseEmployer } from '../util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers() {
  const h = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'sourcedev-pipeline' };
  if (config.github.token) h.Authorization = `Bearer ${config.github.token}`;
  return h;
}

function dateStr(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
}

async function ghFetch(url) {
  const res = await fetch(url, { headers: headers() });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    const err = new Error(`GitHub rate limited (reset ${reset})`);
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${url}`);
  return res.json();
}

export async function ingestGitHub(log = console.log) {
  const window = dateStr(config.windowDays);
  const fresh = dateStr(config.freshWindowDays);
  const stats = { queries: 0, repos: 0, builders: 0, buildersEnriched: 0 };
  const seen = new Set();

  for (const { q, label } of config.github.queries) {
    const query = q.replace('{window}', window).replace('{fresh}', fresh);
    const url = `${config.github.apiBase}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${config.github.perPage}`;
    try {
      const data = await ghFetch(url);
      stats.queries++;
      for (const repo of data.items ?? []) {
        if (seen.has(repo.full_name)) continue;
        seen.add(repo.full_name);
        // English-readable feed only.
        if (!isMostlyEnglish(`${repo.name} ${repo.description ?? ''}`)) continue;
        // Safety net: reject stray consumer/hobby apps a devtool query pulled in.
        if (isConsumerApp(`${repo.name} ${repo.description ?? ''}`)) continue;
        // Phrase-search false positive: mirrors / contribution boilerplate.
        if (isMirrorOrBoilerplate(repo.description ?? '')) continue;
        const projectId = upsertProject({
          full_name: repo.full_name,
          name: repo.name,
          url: repo.html_url,
          description: repo.description ?? '',
          language: repo.language ?? '',
          topics: JSON.stringify(repo.topics ?? []),
          owner_login: repo.owner?.login ?? '',
          owner_type: repo.owner?.type ?? '',
          repo_created_at: repo.created_at,
          discovered_via: label,
        });
        addSnapshot(projectId, {
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          open_issues: repo.open_issues_count,
        });
        stats.repos++;
        if (repo.owner?.type === 'User') {
          upsertBuilder({
            login: repo.owner.login,
            name: null,
            url: repo.owner.html_url,
            avatar_url: repo.owner.avatar_url,
            discovered_via: 'project',
          });
          stats.builders++;
        }
      }
      log(`  [github] "${label}" → ${data.items?.length ?? 0} repos`);
    } catch (e) {
      log(`  [github] "${label}" FAILED: ${e.message}`);
      if (e.rateLimited) break;
    }
    // Search API: 10 req/min unauth → 6.5s between queries keeps us safe.
    if (!config.github.token) await sleep(6500);
  }

  // Enrich builders (owners of highest-starred fresh repos) with user details.
  // Costs 1 core request each — keep small when unauthenticated.
  // enriched < 2 also re-fetches rows enriched before location/region tracking existed.
  const budget = config.github.token ? 100 : 6;
  const toEnrich = db.prepare(`
    SELECT b.login FROM builders b
    JOIN projects p ON p.owner_login = b.login
    JOIN snapshots s ON s.project_id = p.id
    WHERE b.enriched < 2
    GROUP BY b.login ORDER BY MAX(s.stars) DESC LIMIT ?
  `).all(budget);
  for (const { login } of toEnrich) {
    try {
      await fetchAndEnrichBuilder(login);
      stats.buildersEnriched++;
    } catch (e) {
      if (e.rateLimited) break;
    }
  }
  return stats;
}

// Pull a builder's profile live from GitHub and persist it.
// Used at ingest and on-demand when a profile is opened in the UI.
// knownEmployer: set when the caller already knows the employer from org
// enumeration — confirmed membership, no need to regex-match the bio.
export async function fetchAndEnrichBuilder(login, { knownEmployer } = {}) {
  const u = await ghFetch(`${config.github.apiBase}/users/${login}`);
  // Derived signals: region from location, university + employer from bio + company.
  const bioText = `${u.bio ?? ''} ${u.company ?? ''}`;
  const uni = detectUniversity(bioText);
  const employer = knownEmployer
    ? { company: knownEmployer }
    : detectFounderDenseEmployer(bioText);
  const details = {
    name: u.name ?? null, followers: u.followers ?? 0, public_repos: u.public_repos ?? 0,
    bio: u.bio ?? null, company: u.company ?? null, blog: u.blog ?? null,
    twitter: u.twitter_username ?? null,
    location: u.location ?? null,
    region: classifyRegion(u.location ?? ''),
    university: uni?.university ?? null,
    is_student: uni?.isStudent ? 1 : 0,
    target_employer: employer?.company ?? null,
    employer_source: employer ? (knownEmployer ? 'org_member' : 'text_match') : null,
  };
  enrichBuilder(login, details);
  return details;
}

// ---------------------------------------------------------------------------
// Founder-dense employer sourcing: surface technical people at companies with
// high future-founder density, independent of whether they own a breakout
// repo. Two prongs: public org-member enumeration + bio text-match backfill.

// GET /orgs/{org}/members only returns PUBLICLY visible members — GitHub
// hides private-membership members from this endpoint with no workaround
// (verified: Anduril's org exists but shows 0 public members).
async function fetchOrgMembers(orgSlug, maxMembers) {
  const members = [];
  let page = 1;
  while (members.length < maxMembers) {
    const perPage = Math.min(100, maxMembers - members.length);
    const data = await ghFetch(
      `${config.github.apiBase}/orgs/${orgSlug}/members?per_page=${perPage}&page=${page}`
    );
    if (!data.length) break;
    members.push(...data);
    if (data.length < perPage) break; // last page
    page++;
  }
  return members;
}

// Second prong: catch target-employer builders already in the DB whose org
// membership is private (or whose company has no usable org — Anduril, Ramp)
// but who self-report the employer in their bio/company field. Pure local
// regex scan, zero API cost.
function backfillTextMatchEmployers(log) {
  const candidates = db.prepare(`
    SELECT login, bio, company FROM builders
    WHERE enriched = 2 AND target_employer IS NULL
  `).all();
  let matched = 0;
  for (const b of candidates) {
    const hit = detectFounderDenseEmployer(`${b.bio ?? ''} ${b.company ?? ''}`);
    if (hit) {
      db.prepare(`UPDATE builders SET target_employer=?, employer_source='text_match' WHERE login=?`)
        .run(hit.company, b.login);
      matched++;
    }
  }
  log(`  [employers] text-match backfill → ${matched} builders tagged`);
  return matched;
}

export async function ingestFounderDenseEmployers(log = console.log) {
  const stats = { orgsChecked: 0, membersFound: 0, enriched: 0, textMatched: 0 };

  const budget = config.github.token
    ? config.founderDenseEmployers.orgMemberBudget.withToken
    : config.founderDenseEmployers.orgMemberBudget.withoutToken;

  if (budget > 0) {
    for (const { name, orgSlug } of config.founderDenseEmployers.companies) {
      if (!orgSlug) continue; // no public GitHub org (Ramp) — text-match only
      try {
        const members = await fetchOrgMembers(orgSlug, 100);
        stats.orgsChecked++;
        for (const m of members) {
          upsertBuilder({
            login: m.login,
            name: null,
            url: m.html_url,
            avatar_url: m.avatar_url,
            discovered_via: 'employer',
          });
          tagOrgMember(m.login, name); // confirmed membership — org_member always wins
          stats.membersFound++;
        }
        log(`  [employers] ${name} (${orgSlug}) → ${members.length} public members`);
      } catch (e) {
        log(`  [employers] ${name} FAILED: ${e.message}`);
        if (e.rateLimited) break;
      }
    }

    // Enrich newly-discovered org members (separate budget lane from the
    // project-owner enrichment in ingestGitHub, so neither starves the other).
    const toEnrich = db.prepare(`
      SELECT login, target_employer FROM builders
      WHERE discovered_via='employer' AND enriched < 2
      LIMIT ?
    `).all(budget);
    for (const { login, target_employer } of toEnrich) {
      try {
        await fetchAndEnrichBuilder(login, { knownEmployer: target_employer });
        stats.enriched++;
      } catch (e) {
        if (e.rateLimited) break;
      }
    }
  } else {
    log('  [employers] org enumeration skipped — set GITHUB_TOKEN to enable');
  }

  // Text-match backfill runs regardless (no API cost) — it's the only signal
  // for companies without an enumerable org, and catches private members.
  stats.textMatched = backfillTextMatchEmployers(log);
  return stats;
}
