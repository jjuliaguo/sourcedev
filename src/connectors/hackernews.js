// Hacker News connector (Algolia API, free/no-auth).
// Job: earliest trend signal (Show HN, topic chatter) + corroboration of GitHub projects.
import { config } from '../config.js';
import { upsertMention, db } from '../db.js';

function windowEpoch() {
  return Math.floor((Date.now() - config.windowDays * 86400_000) / 1000);
}

async function hnSearch(params) {
  const url = `${config.hackernews.apiBase}/search_by_date?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HN Algolia ${res.status}`);
  return res.json();
}

// Match a mention to a known project: github URL match first, then repo-name-in-title.
function matchProject(story, projectsByRepoUrl, projectsByName) {
  const u = (story.url ?? '').toLowerCase();
  const ghMatch = u.match(/github\.com\/([\w.-]+\/[\w.-]+)/);
  if (ghMatch) {
    const fullName = ghMatch[1].replace(/\.git$/, '').toLowerCase();
    if (projectsByRepoUrl.has(fullName)) return projectsByRepoUrl.get(fullName);
  }
  const title = ` ${(story.title ?? '').toLowerCase()} `;
  for (const [name, id] of projectsByName) {
    if (name.length > 3 && title.includes(` ${name} `)) return id;
  }
  return null;
}

export async function ingestHackerNews(log = console.log) {
  const stats = { showHn: 0, keywordStories: 0, matched: 0 };
  const since = windowEpoch();

  const projects = db.prepare(`SELECT id, full_name, name FROM projects`).all();
  const projectsByRepoUrl = new Map(projects.map((p) => [p.full_name.toLowerCase(), p.id]));
  const projectsByName = new Map(projects.map((p) => [p.name.toLowerCase(), p.id]));

  const ingestHits = (hits, isShowHn) => {
    for (const s of hits) {
      if ((s.points ?? 0) < config.hackernews.minPoints) continue;
      const projectId = matchProject(s, projectsByRepoUrl, projectsByName);
      if (projectId) stats.matched++;
      upsertMention({
        source: 'hn',
        external_id: String(s.objectID),
        title: s.title ?? '',
        url: s.url ?? `https://news.ycombinator.com/item?id=${s.objectID}`,
        points: s.points ?? 0,
        comments: s.num_comments ?? 0,
        author: s.author ?? '',
        posted_at: s.created_at ?? '',
        is_show_hn: isShowHn ? 1 : 0,
        project_id: projectId,
      });
    }
  };

  // 1. All Show HN in the window (launch intent — the earliest builder signal).
  try {
    const data = await hnSearch({
      tags: 'show_hn',
      numericFilters: `created_at_i>${since}`,
      hitsPerPage: String(config.hackernews.hitsPerPage),
    });
    ingestHits(data.hits ?? [], true);
    stats.showHn = data.hits?.length ?? 0;
    log(`  [hn] Show HN → ${stats.showHn} posts`);
  } catch (e) {
    log(`  [hn] Show HN FAILED: ${e.message}`);
  }

  // 2. Topic keyword stories (trend chatter).
  for (const kw of config.hackernews.keywordQueries) {
    try {
      const data = await hnSearch({
        query: kw,
        tags: 'story',
        numericFilters: `created_at_i>${since}`,
        hitsPerPage: '50',
      });
      ingestHits(data.hits ?? [], false);
      stats.keywordStories += data.hits?.length ?? 0;
      log(`  [hn] "${kw}" → ${data.hits?.length ?? 0} stories`);
    } catch (e) {
      log(`  [hn] "${kw}" FAILED: ${e.message}`);
    }
  }
  return stats;
}
