// SQLite data layer. One normalized store for all connectors.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  full_name TEXT UNIQUE NOT NULL,      -- github owner/repo
  name TEXT, url TEXT, description TEXT,
  language TEXT, topics TEXT,          -- topics = JSON array
  owner_login TEXT, owner_type TEXT,
  repo_created_at TEXT,
  discovered_via TEXT,                 -- which query label proposed it
  first_seen TEXT DEFAULT (datetime('now')),
  last_seen TEXT
);

-- Star history: velocity needs history, acceleration needs >=2 snapshots.
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  captured_at TEXT DEFAULT (datetime('now')),
  stars INTEGER, forks INTEGER, open_issues INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id, captured_at);

CREATE TABLE IF NOT EXISTS builders (
  id INTEGER PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  name TEXT, url TEXT, avatar_url TEXT,
  followers INTEGER, public_repos INTEGER,
  bio TEXT, company TEXT, blog TEXT, twitter TEXT,
  enriched INTEGER DEFAULT 0,          -- 1 once user-details fetched
  first_seen TEXT DEFAULT (datetime('now'))
);

-- Cross-source mentions (HN now; reddit/X later). project_id set when matched.
CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT, url TEXT,
  points INTEGER, comments INTEGER,
  author TEXT, posted_at TEXT,
  is_show_hn INTEGER DEFAULT 0,
  project_id INTEGER REFERENCES projects(id),
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_project ON mentions(project_id);

-- npm/PyPI adoption confirmation. name is internally stored as
-- "registry:package" so an npm and PyPI package can never collide on the
-- UNIQUE constraint; display_name is the human-readable package name.
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  weekly_downloads INTEGER,
  prev_weekly_downloads INTEGER,
  captured_at TEXT DEFAULT (datetime('now'))
);

-- Latest score per entity, with transparent breakdown JSON for the UI.
CREATE TABLE IF NOT EXISTS scores (
  entity_type TEXT NOT NULL,           -- 'project' | 'builder'
  entity_id INTEGER NOT NULL,
  computed_at TEXT DEFAULT (datetime('now')),
  total REAL,
  breakdown TEXT,                      -- JSON
  PRIMARY KEY(entity_type, entity_id)
);

-- User triage: the training-data loop. save | track | dismiss
CREATE TABLE IF NOT EXISTS triage (
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(entity_type, entity_id)
);

-- Named trends (LLM-clustered, or keyword fallback).
CREATE TABLE IF NOT EXISTS trends (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  summary TEXT,
  why_rising TEXT,
  project_ids TEXT,                    -- JSON array of project ids
  score REAL,
  source TEXT,                         -- 'llm' | 'keyword'
  created_at TEXT DEFAULT (datetime('now'))
);

-- On-demand topic research briefs (Trends-tab search box). Each row is one
-- multi-source lookup: the synthesized markdown brief + the raw engagement-
-- ranked sources (HN / Reddit / Polymarket / web) that grounded it.
CREATE TABLE IF NOT EXISTS research (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,
  brief TEXT,                          -- synthesized markdown (null in no-key mode)
  mode TEXT,                           -- 'llm' | 'no-key' | 'error'
  sources TEXT,                        -- JSON: { hn, reddit, polymarket, web }
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_research_created ON research(created_at);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT DEFAULT 'running',
  stats TEXT                           -- JSON
);
`);

// Idempotent migrations for columns added after the initial schema shipped.
for (const col of [
  'location TEXT',            // free-text GitHub location
  'region TEXT',              // north_america | other | NULL (unknown)
  'university TEXT',          // matched top-50 university, if any
  'is_student INTEGER DEFAULT 0',
  'profile_summary TEXT',     // LLM-written scout-oriented description
  'target_employer TEXT',     // matched founder-dense company display name, if any
  'employer_source TEXT',     // org_member | text_match | NULL — org membership is stronger evidence
  'discovered_via TEXT',      // project | employer | NULL(legacy) — why this builder row exists
]) {
  try { db.exec(`ALTER TABLE builders ADD COLUMN ${col}`); } catch { /* column exists */ }
}
for (const col of ['registry TEXT DEFAULT \'npm\'', 'display_name TEXT']) {
  try { db.exec(`ALTER TABLE packages ADD COLUMN ${col}`); } catch { /* column exists */ }
}
// Backfill rows written before the registry/display_name columns existed:
// their `name` is still the plain package name (no registry prefix).
db.exec(`
  UPDATE packages SET display_name = name, registry = 'npm'
  WHERE display_name IS NULL AND name NOT LIKE 'npm:%' AND name NOT LIKE 'pypi:%';
  UPDATE packages SET name = 'npm:' || name
  WHERE registry = 'npm' AND name NOT LIKE 'npm:%';
`);

// ---- helpers ----

export function upsertProject(p) {
  const row = db.prepare(`
    INSERT INTO projects (full_name, name, url, description, language, topics, owner_login, owner_type, repo_created_at, discovered_via, last_seen)
    VALUES (@full_name, @name, @url, @description, @language, @topics, @owner_login, @owner_type, @repo_created_at, @discovered_via, datetime('now'))
    ON CONFLICT(full_name) DO UPDATE SET
      description=excluded.description, language=excluded.language, topics=excluded.topics,
      last_seen=datetime('now')
    RETURNING id
  `).get(p);
  return row.id;
}

export function addSnapshot(projectId, { stars, forks, open_issues }) {
  db.prepare(`INSERT INTO snapshots (project_id, stars, forks, open_issues) VALUES (?, ?, ?, ?)`)
    .run(projectId, stars, forks, open_issues);
}

export function upsertBuilder(b) {
  // discovered_via is intentionally NOT updated on conflict: the first
  // discovery path (project vs employer) is the row's provenance for good.
  const row = db.prepare(`
    INSERT INTO builders (login, name, url, avatar_url, discovered_via)
    VALUES (@login, @name, @url, @avatar_url, @discovered_via)
    ON CONFLICT(login) DO UPDATE SET avatar_url=excluded.avatar_url
    RETURNING id
  `).get({ discovered_via: null, ...b });
  return row.id;
}

export function enrichBuilder(login, d) {
  // Employer precedence lives here so no caller can get it wrong: a
  // confirmed org_member tag is never downgraded by a later re-enrichment
  // that only has text-match (or no) employer signal.
  db.prepare(`
    UPDATE builders SET name=@name, followers=@followers, public_repos=@public_repos,
      bio=@bio, company=@company, blog=@blog, twitter=@twitter,
      location=@location, region=@region, university=@university, is_student=@is_student,
      target_employer = CASE WHEN employer_source='org_member' THEN target_employer ELSE @target_employer END,
      employer_source = CASE WHEN employer_source='org_member' THEN employer_source ELSE @employer_source END,
      enriched=2
    WHERE login=@login
  `).run({ login, target_employer: null, employer_source: null, ...d });
}

// Tag a builder as a confirmed public member of a target company's GitHub org.
// org_member always wins over any prior text_match tag.
export function tagOrgMember(login, companyName) {
  db.prepare(`
    UPDATE builders SET target_employer=?, employer_source='org_member' WHERE login=?
  `).run(companyName, login);
}

export function saveBuilderSummary(login, summary) {
  db.prepare(`UPDATE builders SET profile_summary=? WHERE login=?`).run(summary, login);
}

export function upsertMention(m) {
  db.prepare(`
    INSERT INTO mentions (source, external_id, title, url, points, comments, author, posted_at, is_show_hn, project_id)
    VALUES (@source, @external_id, @title, @url, @points, @comments, @author, @posted_at, @is_show_hn, @project_id)
    ON CONFLICT(source, external_id) DO UPDATE SET
      points=excluded.points, comments=excluded.comments, project_id=COALESCE(excluded.project_id, mentions.project_id)
  `).run(m);
}

export function upsertPackage(displayName, projectId, weeklyDownloads, registry = 'npm') {
  const internalName = `${registry}:${displayName}`;
  db.prepare(`
    INSERT INTO packages (name, display_name, registry, project_id, weekly_downloads)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      prev_weekly_downloads=packages.weekly_downloads,
      weekly_downloads=excluded.weekly_downloads,
      captured_at=datetime('now')
  `).run(internalName, displayName, registry, projectId, weeklyDownloads);
}

// A project may now have both an npm and a PyPI match.
export function getPackagesForProject(projectId) {
  return db.prepare(`SELECT display_name, registry, weekly_downloads, prev_weekly_downloads FROM packages WHERE project_id=?`).all(projectId);
}

export function saveScore(entityType, entityId, total, breakdown) {
  db.prepare(`
    INSERT INTO scores (entity_type, entity_id, total, breakdown, computed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET
      total=excluded.total, breakdown=excluded.breakdown, computed_at=excluded.computed_at
  `).run(entityType, entityId, total, JSON.stringify(breakdown));
}

export function setTriage(entityType, entityId, status) {
  db.prepare(`
    INSERT INTO triage (entity_type, entity_id, status, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET status=excluded.status, updated_at=datetime('now')
  `).run(entityType, entityId, status);
}

export function saveTrend(t) {
  db.prepare(`
    INSERT INTO trends (name, summary, why_rising, project_ids, score, source)
    VALUES (@name, @summary, @why_rising, @project_ids, @score, @source)
    ON CONFLICT(name) DO UPDATE SET
      summary=excluded.summary, why_rising=excluded.why_rising,
      project_ids=excluded.project_ids, score=excluded.score, source=excluded.source,
      created_at=datetime('now')
  `).run(t);
}

export function saveResearch({ topic, brief, mode, sources }) {
  return db.prepare(`
    INSERT INTO research (topic, brief, mode, sources)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `).get(topic, brief ?? null, mode, JSON.stringify(sources ?? {})).id;
}

export function listResearch(limit = 25) {
  return db.prepare(
    `SELECT id, topic, mode, created_at FROM research ORDER BY id DESC LIMIT ?`
  ).all(limit);
}

export function getResearchById(id) {
  const r = db.prepare(`SELECT * FROM research WHERE id=?`).get(id);
  if (!r) return null;
  return { ...r, sources: JSON.parse(r.sources || '{}') };
}

export function startRun() {
  return db.prepare(`INSERT INTO runs DEFAULT VALUES RETURNING id`).get().id;
}
export function finishRun(id, status, stats) {
  db.prepare(`UPDATE runs SET finished_at=datetime('now'), status=?, stats=? WHERE id=?`)
    .run(status, JSON.stringify(stats), id);
}
