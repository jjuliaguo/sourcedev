// Pipeline orchestrator: ingest → score → enrich.
// Run directly (`npm run ingest`) or import runPipeline() from the server.
import { ingestGitHub, ingestFounderDenseEmployers } from '../connectors/github.js';
import { ingestHackerNews } from '../connectors/hackernews.js';
import { ingestReddit } from '../connectors/reddit.js';
import { ingestNpm } from '../connectors/npm.js';
import { ingestPyPI } from '../connectors/pypi.js';
import { scoreAll } from './score.js';
import { enrichTrends, enrichBuilderProfiles } from './enrich.js';
import { startRun, finishRun } from '../db.js';

export async function runPipeline(log = console.log) {
  const runId = startRun();
  const stats = {};
  try {
    log('▶ 1/8 GitHub (propose projects + builders)');
    stats.github = await ingestGitHub(log);

    log('▶ 2/8 Founder-dense employers (org enumeration + text-match backfill)');
    stats.employers = await ingestFounderDenseEmployers(log);

    log('▶ 3/8 Hacker News (trend signal + corroboration)');
    stats.hackernews = await ingestHackerNews(log);

    log('▶ 4/8 Reddit (trend signal + corroboration)');
    stats.reddit = await ingestReddit(log);

    log('▶ 5/8 npm (adoption confirmation)');
    stats.npm = await ingestNpm(log);

    log('▶ 6/8 PyPI (adoption confirmation)');
    stats.pypi = await ingestPyPI(log);

    log('▶ 7/8 Scoring (velocity × novelty × corroboration)');
    stats.scoring = scoreAll();

    log('▶ 8/8 Trend + profile enrichment');
    stats.enrichment = await enrichTrends(log);
    stats.profiles = await enrichBuilderProfiles(log);

    finishRun(runId, 'ok', stats);
    log('✔ Pipeline complete: ' + JSON.stringify(stats));
    return { ok: true, stats };
  } catch (e) {
    finishRun(runId, 'error', { ...stats, error: e.message });
    log('✖ Pipeline failed: ' + e.message);
    return { ok: false, error: e.message, stats };
  }
}

// CLI entry
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  runPipeline().then((r) => process.exit(r.ok ? 0 : 1));
}
