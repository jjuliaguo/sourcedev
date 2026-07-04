# sourceDev

**An AI-powered sourcing radar for emerging devtool trends and builders — built for early-stage VC scouts.**

Surfaces technical builders and the trends they're riding *before* they appear in funding
databases or GitHub Trending, ranked by **acceleration of activity, not absolute volume**.
Full product strategy in [STRATEGY.md](STRATEGY.md).

## Quick start

```sh
npm install
npm run ingest     # run the pipeline: ingest → score → enrich
npm run serve      # http://localhost:4242
```

Optional environment variables:

| Var | Effect |
|---|---|
| `GITHUB_TOKEN` | 5000 req/hr instead of 60 — more queries, more builder enrichment |
| `ANTHROPIC_API_KEY` | Enables LLM trend clustering + "why it's rising" analysis (Claude Opus 4.8). Without it, trends fall back to keyword grouping |
| `PORT` | Server port (default 4242) |

## How it works — the process

```
┌─────────────── INGEST (one source proposes, others confirm) ───────────────┐
│                                                                             │
│  GitHub search ──► projects + builders + star snapshots   (the spine)       │
│  HN / Show HN ──► mentions, matched to projects by URL    (earliest signal) │
│  npm registry ──► weekly downloads for top projects       (adoption proof)  │
│                                                                             │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               ▼
                    SQLite (data/sourcedev.db)
                               ▼
┌─────────────── SCORE ────────────────────────────────────────────────────────┐
│  emergence = base(velocity, acceleration) × novelty_decay × corroboration    │
│                                                                              │
│  velocity      stars/day (recent-window velocity once snapshots accumulate) │
│  acceleration  recent velocity − lifetime velocity (needs ≥2 snapshots)     │
│  novelty       decays past 2k stars — once it's trending, we're late        │
│  corroboration multiplier when HN mentions / npm growth confirm (cap ×2)    │
│                                                                              │
│  builder score = best project score × indie bonus (<500 followers = the     │
│  pre-discovery profile a scout wants; >10k followers = already found)       │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               ▼
┌─────────────── ENRICH (optional, Claude Opus 4.8) ──────────────────────────┐
│  Clusters top-scored projects + HN chatter into named trends with           │
│  "why it's rising NOW" summaries. Structured JSON output, keyword fallback. │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               ▼
┌─────────────── SERVE ────────────────────────────────────────────────────────┐
│  Ranked feed UI: Projects / Builders / Trends tabs                           │
│  Transparent score breakdown chips on every card                             │
│  save / track / dismiss triage → persisted → future ranker training data     │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Key mechanic:** acceleration needs history. The first run scores on lifetime velocity
(stars ÷ repo age). Every subsequent run adds star snapshots, so recent-window velocity and
acceleration kick in — the feed gets sharper the longer you run it. Run it daily.

## Code map

| Path | What it does |
|---|---|
| [src/config.js](src/config.js) | Topics (AI-devtools vertical), queries, scoring weights — the tuning surface |
| [src/db.js](src/db.js) | SQLite schema + data layer (projects, snapshots, builders, mentions, packages, scores, triage, trends) |
| [src/connectors/github.js](src/connectors/github.js) | Proposes projects/builders, snapshots stars, rate-limit aware |
| [src/connectors/hackernews.js](src/connectors/hackernews.js) | Show HN + topic chatter via Algolia; URL/name matching to projects |
| [src/connectors/npm.js](src/connectors/npm.js) | Repository-URL-verified package matching + weekly downloads |
| [src/pipeline/score.js](src/pipeline/score.js) | The emergence formula |
| [src/pipeline/enrich.js](src/pipeline/enrich.js) | Claude trend clustering (structured output) + keyword fallback |
| [src/pipeline/run.js](src/pipeline/run.js) | Orchestrator: ingest → score → enrich, run tracking |
| [src/server.js](src/server.js) | Express API: `/api/feed`, `/api/triage`, `/api/refresh`, `/api/status` |
| [public/](public/index.html) | Ranked-feed UI with triage |

## Roadmap (see STRATEGY.md §9)

- **Done — Phase 1 MVP:** GitHub spine + HN + npm, emergence scoring, ranked feed, triage.
- **Phase 2:** more corroboration sources (Reddit, dev.to, PyPI/crates.io), identity
  resolution v1 (github ↔ HN ↔ X), LLM builder profiles.
- **Phase 3:** learned ranker trained on save/dismiss, daily digest/alerts, pipeline CRM.
- **Phase 4:** outcome loop — track which surfaced builders raised/shipped; lead-time
  reporting becomes the proof and the training target.
