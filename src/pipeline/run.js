// Pipeline orchestrator: ingest → score → enrich.
// Run directly (`npm run ingest`) or import runPipeline() from the server.
import { ingestGitHub } from '../connectors/github.js';
import { ingestHackerNews } from '../connectors/hackernews.js';
import { ingestNpm } from '../connectors/npm.js';
import { scoreAll } from './score.js';
import { enrichTrends } from './enrich.js';
import { startRun, finishRun } from '../db.js';

export async function runPipeline(log = console.log) {
  const runId = startRun();
  const stats = {};
  try {
    log('▶ 1/5 GitHub (propose projects + builders)');
    stats.github = await ingestGitHub(log);

    log('▶ 2/5 Hacker News (trend signal + corroboration)');
    stats.hackernews = await ingestHackerNews(log);

    log('▶ 3/5 npm (adoption confirmation)');
    stats.npm = await ingestNpm(log);

    log('▶ 4/5 Scoring (velocity × novelty × corroboration)');
    stats.scoring = scoreAll();

    log('▶ 5/5 Trend enrichment');
    stats.enrichment = await enrichTrends(log);

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
