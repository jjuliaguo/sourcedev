// Central configuration for the sourcing pipeline.
// Vertical scope: AI devtools first (widen by editing `topics`).

import { fileURLToPath } from 'node:url';

// Load .env if present (Node 22 native support) — optional, so no error if missing.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  // no .env file — GITHUB_TOKEN / ANTHROPIC_API_KEY may still come from the shell env
}

export const config = {
  // DATA_DIR lets a deploy target (e.g. a Railway volume) point this at a
  // persistent mount without touching code. Defaults to the local data/ folder.
  dbPath: process.env.DATA_DIR
    ? `${process.env.DATA_DIR}/sourcedev.db`
    : fileURLToPath(new URL('../data/sourcedev.db', import.meta.url)),

  // How far back "emerging" looks (days). Repos older than this are ignored at ingest.
  windowDays: 90,
  // Very-fresh window for catching things days old.
  freshWindowDays: 14,

  // GitHub search queries — each proposes candidate projects.
  // Kept small: unauthenticated search API allows 10 req/min.
  github: {
    apiBase: 'https://api.github.com',
    token: process.env.GITHUB_TOKEN || null,
    perPage: 50,
    queries: [
      // topic-based, recent window
      { q: 'topic:llm created:>{window} stars:>15', label: 'llm' },
      { q: 'topic:ai-agents created:>{window} stars:>10', label: 'ai-agents' },
      { q: 'topic:mcp created:>{window} stars:>5', label: 'mcp' },
      { q: 'topic:developer-tools created:>{window} stars:>10', label: 'devtools' },
      { q: 'topic:rag created:>{window} stars:>10', label: 'rag' },
      // very fresh — low star bar, catches things days old
      { q: 'topic:llm created:>{fresh} stars:>3', label: 'llm-fresh' },
    ],
  },

  // Hacker News (Algolia) — earliest trend signal + corroboration.
  hackernews: {
    apiBase: 'https://hn.algolia.com/api/v1',
    // Show HN posts in window are always ingested; keyword queries add topic stories.
    keywordQueries: ['llm', 'ai agents', 'mcp server', 'rag', 'llm evals', 'developer tools'],
    hitsPerPage: 100,
    minPoints: 3,
  },

  // npm registry — adoption confirmation for top-scored projects.
  npm: {
    registryBase: 'https://registry.npmjs.org',
    downloadsBase: 'https://api.npmjs.org/downloads/point',
    // Only try to match packages for the top N projects (1-2 requests each).
    maxProjectsToCheck: 25,
  },

  scoring: {
    weights: { velocity: 0.6, acceleration: 0.4 },
    // Novelty decay: penalize past this many stars (we're late once it's trending).
    noveltyStarKnee: 2000,
    // Corroboration boosts (multiplier contributions, capped).
    corroboration: {
      perHnMention: 0.15,
      hnPointsAt: 100, // an HN mention with this many points adds a full extra boost
      npmGrowthBoost: 0.3,
      maxMultiplier: 2.0,
    },
  },

  enrichment: {
    model: 'gemini-2.5-flash',
    apiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || null,
    get enabled() { return !!this.apiKey; },
    maxProjectsToCluster: 40,
    maxTrends: 8,
  },

  server: { port: Number(process.env.PORT) || 4242 },
};
