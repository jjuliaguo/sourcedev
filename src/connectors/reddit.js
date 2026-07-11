// Reddit connector — same role as Hacker News: earliest trend signal +
// corroboration, but a different community. r/ExperiencedDevs and r/devops
// skew toward productivity/security discussion that never reaches HN's
// front page.
//
// Reddit's unauthenticated .json endpoints return a hard 403 for datacenter/
// cloud-origin IPs (confirmed live) — this affects every server host, not
// just this one. OAuth client_credentials gets a different, non-blocked
// access tier, so that's what's used here. Requires REDDIT_CLIENT_ID /
// REDDIT_CLIENT_SECRET (free "script" app at reddit.com/prefs/apps).
import { config } from '../config.js';
import { upsertMention, db } from '../db.js';

function windowEpoch() {
  return Math.floor((Date.now() - config.windowDays * 86400_000) / 1000);
}

// Exported so the on-demand topic-research module can reuse the same
// app-only OAuth (Reddit's unauthenticated .json API is 403'd for cloud IPs).
export async function getAccessToken() {
  const basic = Buffer.from(`${config.reddit.clientId}:${config.reddit.clientSecret}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.reddit.userAgent,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Reddit auth failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

async function redditFetch(token, subreddit, params) {
  const url = `https://oauth.reddit.com/r/${subreddit}/new?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': config.reddit.userAgent },
  });
  if (!res.ok) throw new Error(`Reddit ${res.status} (r/${subreddit})`);
  return res.json();
}

// Match a post to a known project: github URL match first, then repo-name-in-title.
function matchProject(post, projectsByRepoUrl, projectsByName) {
  const u = (post.url ?? '').toLowerCase();
  const ghMatch = u.match(/github\.com\/([\w.-]+\/[\w.-]+)/);
  if (ghMatch) {
    const fullName = ghMatch[1].replace(/\.git$/, '').toLowerCase();
    if (projectsByRepoUrl.has(fullName)) return projectsByRepoUrl.get(fullName);
  }
  const title = ` ${(post.title ?? '').toLowerCase()} `;
  for (const [name, id] of projectsByName) {
    if (name.length > 3 && title.includes(` ${name} `)) return id;
  }
  return null;
}

export async function ingestReddit(log = console.log) {
  const stats = { checked: 0, matched: 0 };
  if (!config.reddit.enabled) {
    log('  [reddit] skipped — set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET to enable');
    return { ...stats, mode: 'skipped-no-key' };
  }

  const since = windowEpoch();
  const projects = db.prepare(`SELECT id, full_name, name FROM projects`).all();
  const projectsByRepoUrl = new Map(projects.map((p) => [p.full_name.toLowerCase(), p.id]));
  const projectsByName = new Map(projects.map((p) => [p.name.toLowerCase(), p.id]));

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    log(`  [reddit] auth FAILED: ${e.message}`);
    return { ...stats, mode: 'auth-failed' };
  }

  for (const subreddit of config.reddit.subreddits) {
    try {
      const data = await redditFetch(token, subreddit, { limit: '75' });
      const posts = (data?.data?.children ?? [])
        .map((c) => c.data)
        .filter((p) => p.created_utc > since && (p.score ?? 0) >= config.reddit.minScore);

      for (const post of posts) {
        const projectId = matchProject(post, projectsByRepoUrl, projectsByName);
        if (projectId) stats.matched++;
        upsertMention({
          source: `reddit:${subreddit}`,
          external_id: post.id,
          title: post.title ?? '',
          url: post.url?.startsWith('http') ? post.url : `https://reddit.com${post.permalink}`,
          points: post.score ?? 0,
          comments: post.num_comments ?? 0,
          author: post.author ?? '',
          posted_at: new Date(post.created_utc * 1000).toISOString(),
          is_show_hn: 0,
          project_id: projectId,
        });
      }
      stats.checked += posts.length;
      log(`  [reddit] r/${subreddit} → ${posts.length} posts`);
    } catch (e) {
      log(`  [reddit] r/${subreddit} FAILED: ${e.message}`);
    }
  }
  return stats;
}
