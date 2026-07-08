// Scoring engine.
// emergence = base(velocity, acceleration) × novelty_decay × corroboration
// Principles: reward the second derivative, decay as things get known,
// multiply when independent sources agree.
import { config } from '../config.js';
import { db, saveScore, getPackagesForProject } from '../db.js';

const W = config.scoring;

function daysBetween(a, b) {
  return Math.max((b - a) / 86400_000, 0.5); // floor at half a day
}

// Log-scaled 0-100 from stars/day. 1/day ≈ 34, 10/day ≈ 67, 100/day ≈ 100.
function velocityScore(starsPerDay) {
  return Math.min(100, Math.max(0, 33.3 * Math.log10(1 + starsPerDay * 9)));
}

export function scoreProjects() {
  const projects = db.prepare(`SELECT * FROM projects`).all();
  let scored = 0;

  for (const p of projects) {
    const snaps = db.prepare(
      `SELECT stars, captured_at FROM snapshots WHERE project_id=? ORDER BY captured_at ASC`
    ).all(p.id);
    if (!snaps.length) continue;

    const latest = snaps[snaps.length - 1];
    const stars = latest.stars ?? 0;
    const createdAt = new Date(p.repo_created_at).getTime();
    const now = Date.now();
    const ageDays = daysBetween(createdAt, now);

    // --- velocity: lifetime stars/day (recent window velocity once we have history)
    const lifetimeV = stars / ageDays;
    let recentV = null;
    const first = snaps[0];
    const spanDays = daysBetween(new Date(first.captured_at + 'Z').getTime(), new Date(latest.captured_at + 'Z').getTime());
    if (snaps.length >= 2 && spanDays >= 0.5) {
      recentV = (latest.stars - first.stars) / spanDays;
    }
    const velocity = recentV ?? lifetimeV;

    // --- acceleration: recent velocity vs lifetime baseline (0 until we have history)
    const accel = recentV != null ? Math.max(0, recentV - lifetimeV) : 0;

    // --- base score
    const base =
      W.weights.velocity * velocityScore(velocity) +
      W.weights.acceleration * velocityScore(accel);

    // --- novelty decay: past the knee, each 10x stars halves the score.
    const novelty = stars > W.noveltyStarKnee
      ? 1 / (1 + Math.log10(stars / W.noveltyStarKnee))
      : 1;

    // --- corroboration: independent sources agreeing
    const mentions = db.prepare(
      `SELECT source, points, is_show_hn FROM mentions WHERE project_id=?`
    ).all(p.id);
    const hnMentionCount = mentions.filter((m) => m.source === 'hn').length;
    const redditMentionCount = mentions.filter((m) => m.source.startsWith('reddit')).length;
    // A project can now have both an npm and a PyPI match.
    const packages = getPackagesForProject(p.id);

    let corro = 1;
    const c = W.corroboration;
    for (const m of mentions) {
      corro += c.perHnMention + Math.min(1, (m.points ?? 0) / c.hnPointsAt) * c.perHnMention * 2;
      if (m.is_show_hn) corro += c.perHnMention; // launch intent bonus
    }
    let npmGrowing = false;
    // Combined across registries: best weekly-download figure for display,
    // corroboration boost applies once per registry that confirms adoption.
    const bestPkg = packages.reduce((best, pk) =>
      (pk.weekly_downloads ?? 0) > (best?.weekly_downloads ?? 0) ? pk : best, null);
    for (const pkg of packages) {
      corro += c.npmGrowthBoost * 0.5; // exists on a registry at all = mild confirmation
      if (pkg.prev_weekly_downloads && pkg.weekly_downloads > pkg.prev_weekly_downloads * 1.1) {
        corro += c.npmGrowthBoost; // actually growing
        npmGrowing = true;
      }
    }
    corro = Math.min(corro, c.maxMultiplier);

    // --- lead geography: prefer North America (via the repo owner's location)
    const owner = db.prepare(`SELECT region FROM builders WHERE login=?`).get(p.owner_login);
    const regionFactor = owner?.region === 'north_america' ? 1.1
      : owner?.region === 'other' ? 0.85 : 1;

    // --- focus boost: prioritize the four target problem areas (code quality,
    // productivity, LLM/token cost, security/IP) over generic AI-agent hype.
    const focusFactor = W.focusLabels.includes(p.discovered_via) ? W.focusBoost : 1;

    const total = Math.min(100, base * novelty * corro * regionFactor * focusFactor);

    saveScore('project', p.id, total, {
      ownerRegion: owner?.region ?? null,
      isFocusArea: focusFactor > 1,
      stars,
      ageDays: Math.round(ageDays * 10) / 10,
      velocity: Math.round(velocity * 100) / 100,
      recentVelocity: recentV != null ? Math.round(recentV * 100) / 100 : null,
      acceleration: Math.round(accel * 100) / 100,
      base: Math.round(base * 10) / 10,
      novelty: Math.round(novelty * 100) / 100,
      corroboration: Math.round(corro * 100) / 100,
      hnMentions: hnMentionCount,
      redditMentions: redditMentionCount,
      npmWeeklyDownloads: bestPkg?.weekly_downloads ?? null,
      packageRegistry: bestPkg?.registry ?? null,
      npmGrowing,
    });
    scored++;
  }
  return { projectsScored: scored };
}

// Base score for a builder with NO owned+scored project. The dominant factor
// is a founder-dense-employer match (the entire point: strong people at
// Palantir/Stripe/etc. usually have no breakout public repo — they were
// invisible to the old project-only scoring). A small technical-activity
// proxy breaks ties among employer-matched builders. Region/university
// multipliers are applied by the shared path in scoreBuilders() afterwards —
// do NOT duplicate them here.
// NOTE: employerBase was first shipped at 55, which made ~85% of the feed
// employer-sourced profiles pinned at the 100 cap, crowding out genuinely
// hot project-sourced builders. 42 keeps an org-confirmed NA match in the
// feed's upper-middle (~78 with the typical indie×NA stack) while letting
// breakout OSS signal stay on top — still dominant vs a modest project with
// the full university stack (52×1.56≈81 vs 40×1.56≈62).
const NO_PROJECT = {
  employerBase: 42,
  sourceBonus: { org_member: 10, text_match: 0 }, // confirmed org membership > a bio regex hit
  activityMax: 15,
};

function baseScoreNoProject(b) {
  if (!b.target_employer) return null; // no project AND no employer — nothing to score on
  let score = NO_PROJECT.employerBase + (NO_PROJECT.sourceBonus[b.employer_source] ?? 0);
  const repoActivity = Math.min(1, (b.public_repos ?? 0) / 20);
  const followerActivity = Math.min(1, (b.followers ?? 0) / 200);
  score += NO_PROJECT.activityMax * (0.7 * repoActivity + 0.3 * followerActivity);
  return score; // 55-90 before the shared multiplier stack
}

export function scoreBuilders() {
  // Builder score: best owned project's emergence — or, when they own no
  // scored project, employer-signal base — times indie/region/university.
  const builders = db.prepare(`SELECT * FROM builders`).all();
  let scored = 0;

  for (const b of builders) {
    const best = db.prepare(`
      SELECT p.id, p.full_name, sc.total, sc.breakdown
      FROM projects p JOIN scores sc ON sc.entity_type='project' AND sc.entity_id=p.id
      WHERE p.owner_login=? ORDER BY sc.total DESC LIMIT 1
    `).get(b.login);

    let total, sourceKind;
    if (best) {
      total = best.total;
      sourceKind = 'project';
    } else {
      total = baseScoreNoProject(b);
      sourceKind = 'employer';
      if (total == null) continue;
    }

    // --- shared multiplier stack: identical for both paths ---
    // Indie bonus: unknown builders (low followers) shipping something emerging = the exact
    // "pre-company" profile a scout wants. Famous accounts are already discovered.
    if (b.enriched) {
      if (b.followers != null && b.followers < 500) total *= 1.15;
      else if (b.followers > 10000) total *= 0.8;
    }

    // Lead geography: North America preferred.
    const regionFactor = b.region === 'north_america' ? 1.2 : b.region === 'other' ? 0.7 : 1;
    total *= regionFactor;

    // Top-university signal: students at top-50 schools are the highest-value profile.
    const uniFactor = b.university ? (b.is_student ? 1.3 : 1.15) : 1;
    total *= uniFactor;

    total = Math.min(100, total);

    saveScore('builder', b.id, total, {
      sourceKind,
      bestProject: best?.full_name ?? null,
      bestProjectScore: best ? Math.round(best.total * 10) / 10 : null,
      targetEmployer: b.target_employer ?? null,
      employerSource: b.employer_source ?? null,
      followers: b.followers,
      publicRepos: b.public_repos ?? null,
      indieBonus: b.enriched ? (b.followers < 500 ? 1.15 : b.followers > 10000 ? 0.8 : 1) : null,
      location: b.location ?? null,
      region: b.region ?? null,
      university: b.university ?? null,
      isStudent: !!b.is_student,
    });
    scored++;
  }
  return { buildersScored: scored };
}

export function scoreAll() {
  return { ...scoreProjects(), ...scoreBuilders() };
}
