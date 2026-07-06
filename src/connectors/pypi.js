// PyPI connector — adoption confirmation (parallel role to npm.js).
// PyPI has no reliable free-text search JSON API (XML-RPC search was
// disabled in 2018), so instead of searching, we guess candidate package
// names from the project name and verify via the repository URL in the
// package's own metadata — same "propose, then confirm" principle as npm.
import { config } from '../config.js';
import { upsertPackage, db } from '../db.js';

async function jsonFetch(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function candidateNames(project) {
  const base = project.name.toLowerCase();
  return [...new Set([base, base.replace(/_/g, '-'), base.replace(/-/g, '_')])];
}

async function findPackageForProject(project) {
  const target = project.full_name.toLowerCase();
  for (const candidate of candidateNames(project)) {
    const data = await jsonFetch(`${config.pypi.jsonBase}/${encodeURIComponent(candidate)}/json`);
    const info = data?.info;
    if (!info) continue;
    const urls = [
      ...Object.values(info.project_urls ?? {}),
      info.home_page ?? '',
      info.package_url ?? '',
    ].map((u) => (u || '').toLowerCase());
    if (urls.some((u) => u.includes(`github.com/${target}`))) return info.name; // canonical casing
  }
  return null;
}

export async function ingestPyPI(log = console.log) {
  const stats = { checked: 0, matched: 0 };

  const top = db.prepare(`
    SELECT p.id, p.name, p.full_name, MAX(s.stars) AS stars
    FROM projects p JOIN snapshots s ON s.project_id = p.id
    GROUP BY p.id ORDER BY stars DESC LIMIT ?
  `).all(config.pypi.maxProjectsToCheck);

  for (const project of top) {
    try {
      stats.checked++;
      const known = db.prepare(`SELECT display_name FROM packages WHERE project_id=? AND registry='pypi'`).get(project.id);
      const pkgName = known?.display_name ?? (await findPackageForProject(project));
      if (!pkgName) continue;
      const dl = await jsonFetch(`${config.pypi.statsBase}/${encodeURIComponent(pkgName.toLowerCase())}/recent`);
      const weekly = dl?.data?.last_week;
      if (weekly != null) {
        upsertPackage(pkgName, project.id, weekly, 'pypi');
        stats.matched++;
        log(`  [pypi] ${project.full_name} → ${pkgName} (${weekly}/wk)`);
      }
    } catch {
      // pypi is confirmation, not critical path — skip failures silently.
    }
  }
  return stats;
}
