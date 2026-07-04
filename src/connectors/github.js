// GitHub connector — the spine. Proposes projects + builders, snapshots stars.
// Frugal by design: unauthenticated search = 10 req/min, core = 60 req/hr.
// Set GITHUB_TOKEN for 30 req/min search and 5000 req/hr core.
import { config } from '../config.js';
import { upsertProject, addSnapshot, upsertBuilder, enrichBuilder, db } from '../db.js';
import { isMostlyEnglish } from '../util.js';

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

  // Enrich a handful of builders (owners of highest-starred fresh repos) with user details.
  // Costs 1 core request each — keep small when unauthenticated.
  const budget = config.github.token ? 20 : 6;
  const toEnrich = db.prepare(`
    SELECT b.login FROM builders b
    JOIN projects p ON p.owner_login = b.login
    JOIN snapshots s ON s.project_id = p.id
    WHERE b.enriched = 0
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
export async function fetchAndEnrichBuilder(login) {
  const u = await ghFetch(`${config.github.apiBase}/users/${login}`);
  const details = {
    name: u.name ?? null, followers: u.followers ?? 0, public_repos: u.public_repos ?? 0,
    bio: u.bio ?? null, company: u.company ?? null, blog: u.blog ?? null,
    twitter: u.twitter_username ?? null,
  };
  enrichBuilder(login, details);
  return details;
}
