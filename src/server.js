// API server + static UI. The triage UX is the product surface.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db, setTriage, getPackagesForProject } from './db.js';
import { runPipeline } from './pipeline/run.js';
import { fetchAndEnrichBuilder } from './connectors/github.js';
import { summarizeBuilders } from './pipeline/enrich.js';
import { isMostlyEnglish, isConsumerApp, isMirrorOrBoilerplate } from './util.js';

const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

// ---- feed ----

app.get('/api/feed', (req, res) => {
  const tab = req.query.tab ?? 'projects';
  const includeDismissed = req.query.include === 'all';
  const savedOnly = req.query.filter === 'saved';

  if (tab === 'projects') {
    // Fetch all scored candidates (no SQL LIMIT) — focus-area projects often
    // score lower on raw velocity than generic AI-agent hype, so cutting to
    // the top N by score *before* the focus-priority sort would drop them.
    let rows = db.prepare(`
      SELECT p.id, p.full_name, p.name, p.url, p.description, p.language, p.topics,
             p.owner_login, p.repo_created_at, p.discovered_via,
             sc.total AS score, sc.breakdown, t.status AS triage
      FROM projects p
      JOIN scores sc ON sc.entity_type='project' AND sc.entity_id=p.id
      LEFT JOIN triage t ON t.entity_type='project' AND t.entity_id=p.id
    `).all();
    rows = filterTriage(rows, includeDismissed, savedOnly)
      .filter((r) => isMostlyEnglish(`${r.name} ${r.description ?? ''}`))
      .filter((r) => !isConsumerApp(`${r.name} ${r.description ?? ''}`))
      .filter((r) => !isMirrorOrBoilerplate(r.description ?? ''))
      .map((r) => ({ ...r, topics: JSON.parse(r.topics || '[]'), breakdown: JSON.parse(r.breakdown || '{}') }));

    // Hard categorical priority: your four target problem areas (code quality,
    // productivity, LLM/token cost, security/IP) always rank above generic
    // devtool/agent projects, regardless of raw score — a soft multiplier
    // alone can't reliably beat the star-count gap generic AI-agent hype has.
    rows.sort((a, b) => {
      const focusDiff = (b.breakdown.isFocusArea ? 1 : 0) - (a.breakdown.isFocusArea ? 1 : 0);
      return focusDiff !== 0 ? focusDiff : b.score - a.score;
    });

    return res.json(rows.slice(0, 150));
  }

  if (tab === 'builders') {
    let rows = db.prepare(`
      SELECT b.id, b.login, b.name, b.url, b.avatar_url, b.followers, b.bio, b.company, b.blog, b.twitter,
             b.location, b.region, b.university, b.is_student, b.profile_summary,
             b.target_employer, b.employer_source, b.discovered_via,
             sc.total AS score, sc.breakdown, t.status AS triage
      FROM builders b
      JOIN scores sc ON sc.entity_type='builder' AND sc.entity_id=b.id
      LEFT JOIN triage t ON t.entity_type='builder' AND t.entity_id=b.id
      ORDER BY sc.total DESC LIMIT 100
    `).all();
    rows = filterTriage(rows, includeDismissed, savedOnly)
      .filter((r) => isMostlyEnglish(`${r.name ?? ''} ${r.bio ?? ''}`));
    return res.json(rows.map((r) => ({ ...r, breakdown: JSON.parse(r.breakdown || '{}') })));
  }

  if (tab === 'trends') {
    const rows = db.prepare(`SELECT * FROM trends ORDER BY score DESC`).all();
    const byId = new Map(
      db.prepare(`SELECT id, full_name, name, description, url FROM projects`).all()
        .filter((p) => isMostlyEnglish(`${p.name} ${p.description ?? ''}`))
        .map((p) => [p.id, p])
    );
    return res.json(rows.map((r) => ({
      ...r,
      projects: JSON.parse(r.project_ids || '[]').map((id) => byId.get(id)).filter(Boolean),
    })));
  }

  res.status(400).json({ error: 'unknown tab' });
});

function filterTriage(rows, includeDismissed, savedOnly) {
  if (savedOnly) return rows.filter((r) => r.triage === 'save' || r.triage === 'track');
  if (!includeDismissed) return rows.filter((r) => r.triage !== 'dismiss');
  return rows;
}

// ---- profiles (assembled from source data; builders lazily enriched live) ----

app.get('/api/project/:id', (req, res) => {
  const p = db.prepare(`
    SELECT p.*, sc.total AS score, sc.breakdown
    FROM projects p LEFT JOIN scores sc ON sc.entity_type='project' AND sc.entity_id=p.id
    WHERE p.id=?
  `).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });

  const snapshots = db.prepare(
    `SELECT stars, forks, captured_at FROM snapshots WHERE project_id=? ORDER BY captured_at ASC`
  ).all(p.id);
  const mentions = db.prepare(
    `SELECT source, title, url, points, comments, posted_at, is_show_hn FROM mentions WHERE project_id=? ORDER BY points DESC`
  ).all(p.id);
  const packages = getPackagesForProject(p.id);
  const owner = db.prepare(`
    SELECT b.*, sc.total AS score FROM builders b
    LEFT JOIN scores sc ON sc.entity_type='builder' AND sc.entity_id=b.id
    WHERE b.login=?
  `).get(p.owner_login);
  const triage = db.prepare(
    `SELECT status FROM triage WHERE entity_type='project' AND entity_id=?`
  ).get(p.id);

  res.json({
    ...p,
    topics: JSON.parse(p.topics || '[]'),
    breakdown: JSON.parse(p.breakdown || '{}'),
    triage: triage?.status ?? null,
    snapshots, mentions, packages, owner: owner ?? null,
  });
});

app.get('/api/builder/:id', async (req, res) => {
  let b = db.prepare(`
    SELECT b.*, sc.total AS score, sc.breakdown FROM builders b
    LEFT JOIN scores sc ON sc.entity_type='builder' AND sc.entity_id=b.id
    WHERE b.id=?
  `).get(req.params.id);
  if (!b) return res.status(404).json({ error: 'not found' });

  // First profile open: pull their details live from GitHub so the profile is ready.
  // enriched < 2 also refreshes rows saved before location/university tracking existed.
  if (b.enriched < 2) {
    try {
      await fetchAndEnrichBuilder(b.login);
      b = { ...b, ...db.prepare(`SELECT * FROM builders WHERE id=?`).get(b.id) };
    } catch { /* rate limited — show what we have */ }
  }

  // Generate the scout-oriented description on first open if the pipeline hasn't yet.
  if (!b.profile_summary) {
    try {
      await summarizeBuilders([b]);
      b = { ...b, ...db.prepare(`SELECT * FROM builders WHERE id=?`).get(b.id) };
    } catch { /* no key or LLM error — bio is the fallback */ }
  }

  const projects = db.prepare(`
    SELECT p.id, p.full_name, p.name, p.url, p.description, p.language, sc.total AS score, sc.breakdown
    FROM projects p LEFT JOIN scores sc ON sc.entity_type='project' AND sc.entity_id=p.id
    WHERE p.owner_login=? ORDER BY sc.total DESC
  `).all(b.login).map((r) => ({ ...r, breakdown: JSON.parse(r.breakdown || '{}') }));

  // HN/Reddit activity around their projects — corroboration a scout can click through.
  const mentions = db.prepare(`
    SELECT m.source, m.title, m.url, m.points, m.posted_at, m.is_show_hn
    FROM mentions m JOIN projects p ON p.id = m.project_id
    WHERE p.owner_login=? ORDER BY m.points DESC LIMIT 10
  `).all(b.login);

  const triage = db.prepare(
    `SELECT status FROM triage WHERE entity_type='builder' AND entity_id=?`
  ).get(b.id);

  res.json({
    ...b,
    breakdown: JSON.parse(b.breakdown || '{}'),
    triage: triage?.status ?? null,
    projects, mentions,
  });
});

// ---- triage (the training-data loop) ----

app.post('/api/triage', (req, res) => {
  const { type, id, status } = req.body ?? {};
  if (!['project', 'builder'].includes(type) || !['save', 'track', 'dismiss', 'clear'].includes(status)) {
    return res.status(400).json({ error: 'bad request' });
  }
  if (status === 'clear') {
    db.prepare(`DELETE FROM triage WHERE entity_type=? AND entity_id=?`).run(type, id);
  } else {
    setTriage(type, id, status);
  }
  res.json({ ok: true });
});

// ---- pipeline control ----

let running = false;
let lastLog = [];

function startRefresh(trigger) {
  if (running) return false;
  running = true;
  lastLog = [];
  const log = (line) => { lastLog.push(line); console.log(line); };
  log(`(refresh triggered: ${trigger})`);
  runPipeline(log).finally(() => { running = false; });
  return true;
}

app.post('/api/refresh', (req, res) => {
  if (!startRefresh('manual')) return res.status(409).json({ error: 'pipeline already running' });
  res.json({ ok: true, started: true });
});

// ---- auto-refresh scheduler ----
// The acceleration signal needs regular star snapshots, so the feed sharpens
// with daily runs. The service is always-on, so it schedules itself: every
// half hour, run the pipeline if the last successful run is older than
// AUTO_REFRESH_HOURS. Reading the runs table (not an in-memory timer) makes
// this survive restarts/redeploys without drift or double-runs.
function autoRefreshCheck() {
  if (running) return;
  const last = db.prepare(`SELECT finished_at FROM runs WHERE status='ok' ORDER BY id DESC LIMIT 1`).get();
  const ageHours = last
    ? (Date.now() - new Date(last.finished_at + 'Z').getTime()) / 3_600_000
    : Infinity;
  if (ageHours >= config.server.autoRefreshHours) {
    console.log(`auto-refresh: last successful run ${last ? ageHours.toFixed(1) + 'h ago' : 'never'} → starting pipeline`);
    startRefresh('auto');
  }
}

if (config.server.autoRefreshHours > 0) {
  setInterval(autoRefreshCheck, 30 * 60_000);
  setTimeout(autoRefreshCheck, 60_000); // first check shortly after boot
  console.log(`auto-refresh enabled: every ${config.server.autoRefreshHours}h`);
}

app.get('/api/status', (req, res) => {
  const lastRun = db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`).get();
  const counts = {
    projects: db.prepare(`SELECT COUNT(*) c FROM projects`).get().c,
    builders: db.prepare(`SELECT COUNT(*) c FROM builders`).get().c,
    mentions: db.prepare(`SELECT COUNT(*) c FROM mentions`).get().c,
    trends: db.prepare(`SELECT COUNT(*) c FROM trends`).get().c,
    saved: db.prepare(`SELECT COUNT(*) c FROM triage WHERE status IN ('save','track')`).get().c,
  };
  res.json({ running, lastRun, counts, log: lastLog.slice(-20) });
});

app.listen(config.server.port, () => {
  console.log(`sourceDev running → http://localhost:${config.server.port}`);
});
