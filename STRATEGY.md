# Sourcing Platform — Strategy

_Last updated: 2026-07-04_

## 1. Thesis

Surface technical builders and the devtool trends they're riding **before** they appear
in any funding database or "GitHub Trending" list — ranked by **acceleration of activity**,
not absolute volume.

The word **before** is the product. Everyone else (Harmonic, Specter, Tracxn, PitchBook)
tracks companies *after* they legally exist and have funding/headcount. Our wedge is the
**pre-company, pre-hype window**: the builder with a repo going vertical but no company yet,
the problem being argued about on HN before anyone's shipped the tool. Technical-depth-first
is the unfair angle.

## 2. Primary user (decided)

**Early-stage VC / scout** focused on devtools / infra / AI tooling.

- **Job-to-be-done:** "Get me to the founder before the round."
- **Why this persona:** highest willingness to pay (deal flow is their lifeblood), clearest
  value metric (lead time on a deal), and it forces the hardest / most defensible version of
  the product (earliest signal + builder identity resolution).
- **Expansion path:** same underlying graph, different lens → technical recruiting next,
  then founder/competitive-watch. Do NOT build for these yet.

## 3. Entities we track

- **Trend / problem** — e.g. "local-first sync", "LLM eval tooling", "typed SQL in Rust".
  Emerges from clustering many raw mentions.
- **Project** — OSS repo, usually pre-company.
- **Builder** — a technical person whose activity suggests they're about to (or just did)
  start something.

## 4. Core loop (retention hook)

Daily/weekly **ranked digest** of new emerging entities
→ user **triages** (save / track / dismiss)
→ those actions **train the ranker**
→ user **acts** (reach out / add to pipeline).

The save/dismiss signal is dual-purpose: retention AND proprietary training data.

## 5. What "good" means (metrics)

- **Precision@feed** — % of surfaced items the user marks "worth a look". Trust metric;
  below ~30% users churn.
- **Lead time** — days between when we surfaced something and when it hit a public milestone
  (funding, HN front page, 5k stars). This is the entire value prop and the marketing proof.
- **Coverage** — of things that later blew up, how many did we catch early (measured
  retroactively against outcomes).

## 6. Moat (what compounds)

The data is public — the moat is what we build on top:

1. **Identity resolution** — linking `github handle → HN user → X account → eventual
   company/person`. Hard, defensible, more valuable the longer we run.
2. **Outcome-calibrated scoring** — we know which surfaced builders actually raised/shipped,
   so our ranker beats anyone starting fresh.

## 7. Signal sources & their distinct jobs

Design principle: **one source proposes, others confirm.** A repo spiking is a hypothesis;
HN discussion + download growth turns it into a ranked lead. Cross-source confirmation is
what keeps precision high.

| Source | Role in pipeline | Emerging indicator |
|---|---|---|
| **GitHub** | The spine — identity + project + builder | **star/contributor velocity & acceleration**, not totals |
| **Package registries** (npm/PyPI/crates.io) | Adoption confirmation | download growth curve |
| **HN / Show HN / Lobsters** | Earliest trend & problem signal, launch intent | Show HN traction, rising discussion |
| **X / Reddit / dev.to** | Corroboration + sentiment | rising cross-source mention frequency |

## 8. Scoring model (principle, not final formula)

`emergence_score = f(velocity, acceleration, cross_source_corroboration, novelty_decay)`

- Reward **second derivative** (acceleration), not just volume.
- Reward **novelty** — decay score as something becomes widely known (we're too late once
  it's on GitHub Trending).
- Multiply by **corroboration** — signal present in ≥2 independent sources ranks far higher.
- Guard against **gaming** (star bots, coordinated posts) — require independent corroboration.

## 9. Phased roadmap

- **Phase 0 — Signal spike (validation).** GitHub star/contributor velocity on a scoped set.
  Prove a scout would care. Manual eval, no UI beyond a ranked list.
- **Phase 1 — MVP.** GitHub spine ingestion → normalized store → acceleration scoring →
  ranked feed UI with save/dismiss. Add HN for trend/launch signal.
- **Phase 2 — Corroboration + enrichment.** Package-registry adoption, HN mention linking,
  LLM layer (trend clustering, "why it's rising" summaries, builder profiles), identity
  resolution v1.
- **Phase 3 — Learned ranker + workflow.** Ranker trained on save/dismiss + outcomes,
  alerts/digests, pipeline CRM, contactability enrichment.
- **Phase 4 — Outcome loop.** Track which surfaced items later raised/shipped; lead-time
  reporting becomes the marketing proof and the training target.

## 10. Biggest risks / hard parts

1. **Identity resolution** across sources — technically hard, but it's the moat.
2. **Signal-to-noise** — avoid recreating "GitHub Trending"; the acceleration + novelty-decay
   math is what differentiates.
3. **Gaming** — bot stars, coordinated posts. Mitigate with cross-source corroboration.
4. **Trend clustering coherence** — LLM must name/cluster trends a human finds meaningful.
5. **Contactability** — a great lead a scout can't reach is worth little.

## 11. Tech stack POV (revisit in architecture phase)

Lightweight starting bias, not final:
- **Ingestion:** scheduled workers per connector, normalized event store.
- **Store:** Postgres for entities/relationships; a time-series-friendly layout for signal
  history (velocity needs history).
- **LLM layer:** Claude (Opus for enrichment/clustering, cheaper tier for high-volume
  classification) for trend clustering, summaries, builder profiles.
- **UI:** simple ranked-feed web app; the triage UX is the product surface.

## 12. Open questions (to resolve before/during Phase 1)

- Scope of the first vertical: all devtools, or narrow to one (AI tooling / infra / DX)?
- Digest cadence: daily vs weekly for the first users?
- How much identity resolution is "enough" for the MVP vs Phase 2?
- Data/ToS constraints per source (esp. X/Twitter, Reddit) — affects connector priority.
