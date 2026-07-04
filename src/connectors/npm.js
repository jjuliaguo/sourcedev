// npm connector — adoption confirmation.
// For top projects, find a matching npm package (by repository URL) and record weekly downloads.
import { config } from '../config.js';
import { upsertPackage, db } from '../db.js';

async function jsonFetch(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

// Search the registry for the project name; accept only a repository-URL match.
async function findPackageForProject(project) {
  const data = await jsonFetch(
    `${config.npm.registryBase}/-/v1/search?text=${encodeURIComponent(project.name)}&size=5`
  );
  if (!data?.objects) return null;
  const target = project.full_name.toLowerCase();
  for (const { package: pkg } of data.objects) {
    const repo = (pkg.links?.repository ?? '').toLowerCase();
    if (repo.includes(`github.com/${target}`)) return pkg.name;
  }
  return null;
}

export async function ingestNpm(log = console.log) {
  const stats = { checked: 0, matched: 0 };

  // Check the top projects by latest star count (pre-scoring proxy).
  const top = db.prepare(`
    SELECT p.id, p.name, p.full_name, MAX(s.stars) AS stars
    FROM projects p JOIN snapshots s ON s.project_id = p.id
    GROUP BY p.id ORDER BY stars DESC LIMIT ?
  `).all(config.npm.maxProjectsToCheck);

  for (const project of top) {
    try {
      stats.checked++;
      // Reuse an already-known package mapping if we have one.
      const known = db.prepare(`SELECT name FROM packages WHERE project_id=?`).get(project.id);
      const pkgName = known?.name ?? (await findPackageForProject(project));
      if (!pkgName) continue;
      const dl = await jsonFetch(
        `${config.npm.downloadsBase}/last-week/${encodeURIComponent(pkgName)}`
      );
      if (dl?.downloads != null) {
        upsertPackage(pkgName, project.id, dl.downloads);
        stats.matched++;
        log(`  [npm] ${project.full_name} → ${pkgName} (${dl.downloads}/wk)`);
      }
    } catch {
      // npm is confirmation, not critical path — skip failures silently.
    }
  }
  return stats;
}
