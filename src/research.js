// On-demand topic research — the Trends-tab search box.
//
// Inspired by the "last30days" agent skill: for ANY topic, fan out across
// engagement-ranked sources in parallel, then synthesize a grounded brief.
// Sources here are the ones that work server-side in Node with no extra paid
// auth — Hacker News (relevance), Reddit (site-wide search, if creds set),
// Polymarket (real-money odds), and the open web via Gemini + Google Search
// grounding. X / YouTube / TikTok need browser cookies or paid APIs and are
// deliberately left out (a note is surfaced to the user instead).
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { getAccessToken } from './connectors/reddit.js';

// ---- individual sources (each resolves to [] on failure; one dead source
// must never sink the whole brief) --------------------------------------------

async function searchHackerNews(topic) {
  const url = `${config.hackernews.apiBase}/search?` + new URLSearchParams({
    query: topic,
    tags: 'story',
    hitsPerPage: String(config.research.hnHits),
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HN ${res.status}`);
  const data = await res.json();
  return (data.hits ?? [])
    .filter((h) => h.title)
    .map((h) => ({
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points ?? 0,
      comments: h.num_comments ?? 0,
      author: h.author ?? '',
      posted_at: h.created_at ?? null,
    }))
    .sort((a, b) => b.points - a.points);
}

async function searchReddit(topic) {
  if (!config.reddit.enabled) return { skipped: true, items: [] };
  const token = await getAccessToken();
  const url = `https://oauth.reddit.com/search?` + new URLSearchParams({
    q: topic,
    sort: 'relevance',
    t: config.research.redditWindow,
    type: 'link',
    limit: String(config.research.redditLimit),
  });
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': config.reddit.userAgent },
  });
  if (!res.ok) throw new Error(`Reddit ${res.status}`);
  const data = await res.json();
  const items = (data?.data?.children ?? [])
    .map((c) => c.data)
    .filter((p) => p.title)
    .map((p) => ({
      title: p.title,
      url: p.url?.startsWith('http') && !p.is_self ? p.url : `https://reddit.com${p.permalink}`,
      subreddit: p.subreddit,
      points: p.score ?? 0,
      comments: p.num_comments ?? 0,
      posted_at: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
    }))
    .sort((a, b) => b.points - a.points);
  return { skipped: false, items };
}

// Parse Polymarket's JSON-string fields ('["Yes","No"]' / '["0.84","0.16"]')
// into the single leading outcome with its implied probability.
function leadingOutcome(market) {
  try {
    const outcomes = JSON.parse(market.outcomes ?? '[]');
    const prices = JSON.parse(market.outcomePrices ?? '[]').map(Number);
    if (!outcomes.length || outcomes.length !== prices.length) return null;
    let best = 0;
    for (let i = 1; i < prices.length; i++) if (prices[i] > prices[best]) best = i;
    return { outcome: outcomes[best], prob: prices[best] };
  } catch { return null; }
}

async function searchPolymarket(topic) {
  const url = `https://gamma-api.polymarket.com/public-search?` + new URLSearchParams({
    q: topic,
    limit_per_type: String(config.research.polymarketEvents),
  });
  const res = await fetch(url, { headers: { 'User-Agent': config.reddit.userAgent } });
  if (!res.ok) throw new Error(`Polymarket ${res.status}`);
  const data = await res.json();
  return (data.events ?? [])
    .filter((e) => !e.closed && (e.markets ?? []).length)
    .map((e) => {
      const markets = [...e.markets]
        .sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0))
        .slice(0, config.research.polymarketMarketsPerEvent)
        .map((m) => ({ question: m.question, ...leadingOutcome(m) }))
        .filter((m) => m.outcome);
      return {
        title: e.title,
        url: `https://polymarket.com/event/${e.slug}`,
        volume: Math.round(Number(e.volume ?? 0)),
        endDate: e.endDate ?? null,
        markets,
      };
    })
    .filter((e) => e.markets.length)
    .sort((a, b) => b.volume - a.volume);
}

// ---- synthesis (Gemini + Google Search grounding) ---------------------------

function sourceDigest({ hn, reddit, polymarket }) {
  const lines = [];
  if (hn.length) {
    lines.push('## Hacker News (ranked by points)');
    lines.push(...hn.slice(0, 10).map((h) => `- (${h.points} pts, ${h.comments} comments) ${h.title} — ${h.url}`));
  }
  if (reddit.length) {
    lines.push('\n## Reddit (ranked by upvotes)');
    lines.push(...reddit.slice(0, 10).map((r) => `- (${r.points} upvotes, r/${r.subreddit}) ${r.title} — ${r.url}`));
  }
  if (polymarket.length) {
    lines.push('\n## Polymarket (real-money odds)');
    for (const e of polymarket) {
      lines.push(`- ${e.title} ($${e.volume.toLocaleString()} vol): ` +
        e.markets.map((m) => `${m.question} → ${m.outcome} ${Math.round(m.prob * 100)}%`).join('; '));
    }
  }
  return lines.join('\n');
}

async function synthesize(topic, gathered) {
  const client = new GoogleGenAI({ apiKey: config.enrichment.apiKey });
  const response = await client.models.generateContent({
    model: config.enrichment.model,
    contents:
      `Topic to research: "${topic}"\n\n` +
      `Below are the top engagement-ranked results already gathered from Hacker ` +
      `News, Reddit, and Polymarket. Use Google Search to fill in the broader web ` +
      `picture and the latest developments, then synthesize everything into one brief.\n\n` +
      (sourceDigest(gathered) || '(no community results found — rely on web search)'),
    config: {
      tools: [{ googleSearch: {} }],
      systemInstruction:
        'You are a research analyst writing a grounded, skimmable brief on a topic ' +
        'for a busy technical reader. Ground every claim in the provided community ' +
        'signals and your web search — never speculate beyond the evidence. ' +
        'Return GitHub-flavored Markdown with these sections: a one-paragraph **TL;DR**; ' +
        '**What\'s happening** (3-6 bullet points of concrete recent developments); ' +
        '**Sentiment & debate** (how the community is reacting — cite HN/Reddit signal); ' +
        'and, only if prediction-market data was provided, **Market signal** (what the ' +
        'Polymarket odds imply). Keep it tight — under ~350 words. Use inline [links](url) ' +
        'to sources where natural. Do not invent statistics.',
    },
  });

  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const web = [];
  const seen = new Set();
  for (const c of chunks) {
    const uri = c.web?.uri;
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      web.push({ title: c.web.title || uri, url: uri });
    }
    if (web.length >= config.research.maxWebSources) break;
  }
  return { brief: response.text ?? '', web };
}

// ---- orchestrator -----------------------------------------------------------

export async function runResearch(topic, log = console.log) {
  const clean = topic.trim().slice(0, 200);
  if (!clean) throw new Error('empty topic');

  const settle = (p, label) => p.catch((e) => { log(`  [research] ${label} failed: ${e.message}`); return null; });
  const [hn, redditRes, polymarket] = await Promise.all([
    settle(searchHackerNews(clean), 'hn'),
    settle(searchReddit(clean), 'reddit'),
    settle(searchPolymarket(clean), 'polymarket'),
  ]);

  const reddit = redditRes ?? { skipped: !config.reddit.enabled, items: [] };
  const gathered = { hn: hn ?? [], reddit: reddit.items, polymarket: polymarket ?? [] };

  const sources = {
    hn: gathered.hn,
    reddit: gathered.reddit,
    redditSkipped: reddit.skipped,
    polymarket: gathered.polymarket,
    web: [],
    // Surfaced to the user so the missing platforms are honest, not silent.
    unavailable: ['X / Twitter', 'YouTube', 'TikTok'],
  };

  let brief = null;
  let mode = 'no-key';
  if (config.enrichment.enabled) {
    try {
      const out = await synthesize(clean, gathered);
      brief = out.brief;
      sources.web = out.web;
      mode = 'llm';
      log(`  [research] "${clean}" → synthesized (${sources.web.length} web sources)`);
    } catch (e) {
      log(`  [research] synthesis failed: ${e.message}`);
      mode = 'error';
    }
  } else {
    log(`  [research] "${clean}" → gathered sources only (set GOOGLE_API_KEY for synthesis)`);
  }

  return { topic: clean, brief, mode, sources };
}
