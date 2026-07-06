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
  // Phrase-in-name/description queries, not bare topic tags: topics like
  // "llm"/"ai-agents"/"rag" are used by any hobby/consumer AI project (a diet-
  // tracking app can carry "rag" just as easily as a devtool), so they drown
  // real devtool signal in noise. Targeted at four problem areas: evaluating
  // code quality, measuring developer productivity, managing LLM/token cost,
  // and code security/IP. Verified against the live API before shipping.
  github: {
    apiBase: 'https://api.github.com',
    token: process.env.GITHUB_TOKEN || null,
    perPage: 50,
    queries: [
      // code quality evaluation
      { q: '"code review" created:>{window} stars:>5', label: 'code-review' },
      { q: '"code quality" created:>{window} stars:>5', label: 'code-quality' },
      { q: '"static analysis" AI created:>{window} stars:>5', label: 'static-analysis' },
      // developer productivity measurement
      { q: '"developer productivity" created:>{window} stars:>3', label: 'dev-productivity' },
      { q: '"engineering metrics" stars:>3', label: 'eng-metrics' },
      // LLM / token cost management
      { q: '"llm cost" created:>{window} stars:>3', label: 'llm-cost' },
      { q: '"llm observability" stars:>3', label: 'llm-observability' },
      // security & IP concerns
      { q: '"prompt injection" created:>{window} stars:>3', label: 'prompt-injection' },
      { q: 'SBOM AI created:>{window} stars:>3', label: 'ai-sbom' },
      { q: '"license compliance" stars:>3', label: 'license-compliance' },
      // general devtool anchors (legitimately curated tags, kept)
      { q: 'topic:mcp created:>{window} stars:>5', label: 'mcp' },
      { q: 'topic:developer-tools created:>{window} stars:>10', label: 'devtools' },
      // very fresh — low star bar, catches things days old
      { q: '"code review" created:>{fresh} stars:>2', label: 'code-review-fresh' },
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
    // Focus boost: generic "AI coding agent" projects rack up far more stars
    // than niche devtool-problem projects on raw velocity alone, so without
    // this, code-quality/cost/productivity/security tools never reach the
    // top even when that's explicitly the point. Labels must match
    // github.queries labels above.
    focusBoost: 1.3,
    focusLabels: [
      'code-review', 'code-quality', 'static-analysis',
      'dev-productivity', 'eng-metrics',
      'llm-cost', 'llm-observability',
      'prompt-injection', 'ai-sbom', 'license-compliance',
      'code-review-fresh',
    ],
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
