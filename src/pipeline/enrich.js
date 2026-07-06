// LLM enrichment layer (optional — requires GOOGLE_API_KEY / GEMINI_API_KEY).
// Clusters top-scored projects + HN chatter into named trends with
// "why it's rising" summaries. Falls back to keyword grouping when no key.
import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config.js';
import { db, saveTrend, saveBuilderSummary } from '../db.js';

const TREND_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    trends: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: 'Short trend name, e.g. "Local-first sync engines"' },
          summary: { type: Type.STRING, description: 'One-sentence description of the trend' },
          why_rising: { type: Type.STRING, description: 'Why this is emerging NOW — the signal a VC scout cares about' },
          project_ids: { type: Type.ARRAY, items: { type: Type.INTEGER }, description: 'IDs of projects in this cluster' },
          heat: { type: Type.INTEGER, description: 'How hot: 1 (early whisper) to 10 (about to be obvious)' },
        },
        required: ['name', 'summary', 'why_rising', 'project_ids', 'heat'],
      },
    },
  },
  required: ['trends'],
};

function topProjectsForClustering() {
  return db.prepare(`
    SELECT p.id, p.full_name, p.description, p.language, p.topics, sc.total AS score, sc.breakdown
    FROM projects p JOIN scores sc ON sc.entity_type='project' AND sc.entity_id=p.id
    ORDER BY sc.total DESC LIMIT ?
  `).all(config.enrichment.maxProjectsToCluster);
}

function recentHnTitles() {
  return db.prepare(`
    SELECT title, points FROM mentions WHERE source='hn'
    ORDER BY points DESC LIMIT 60
  `).all();
}

export async function enrichTrends(log = console.log) {
  const projects = topProjectsForClustering();
  if (!projects.length) return { trends: 0, mode: 'skipped-no-data' };

  if (!config.enrichment.enabled) {
    return keywordFallback(projects, log);
  }

  const client = new GoogleGenAI({ apiKey: config.enrichment.apiKey });
  const hn = recentHnTitles();

  const projectList = projects.map((p) =>
    `id=${p.id} ${p.full_name} [${p.language}] (score ${Math.round(p.score)}) topics=${p.topics}: ${p.description?.slice(0, 150)}`
  ).join('\n');
  const hnList = hn.map((h) => `(${h.points}pts) ${h.title}`).join('\n');

  try {
    const response = await client.models.generateContent({
      model: config.enrichment.model,
      contents:
        `Cluster these emerging projects into at most ${config.enrichment.maxTrends} named trends.\n\n` +
        `## Projects (ranked by emergence score)\n${projectList}\n\n` +
        `## Recent Hacker News chatter (corroboration)\n${hnList}`,
      config: {
        systemInstruction:
          'You are a devtools trend analyst for an early-stage VC scout. You cluster emerging ' +
          'open-source projects and technical chatter into named trends. Prioritize what is ' +
          'EMERGING (accelerating, early, pre-hype) over what is already popular. A good trend ' +
          'name is specific ("MCP server frameworks", not "AI tools"). Only cluster projects that ' +
          'genuinely share a technical thesis; leave outliers unclustered.',
        responseMimeType: 'application/json',
        responseSchema: TREND_SCHEMA,
      },
    });

    const text = response.text ?? '{}';
    const { trends } = JSON.parse(text);
    for (const t of trends ?? []) {
      saveTrend({
        name: t.name,
        summary: t.summary,
        why_rising: t.why_rising,
        project_ids: JSON.stringify(t.project_ids),
        score: t.heat * 10,
        source: 'llm',
      });
    }
    log(`  [enrich] LLM clustered ${trends?.length ?? 0} trends`);
    return { trends: trends?.length ?? 0, mode: 'llm' };
  } catch (e) {
    log(`  [enrich] LLM failed (${e.message}) — falling back to keyword grouping`);
    return keywordFallback(projects, log);
  }
}

// ---------------------------------------------------------------------------
// Builder profile summaries: 1-2 sentence scout-oriented descriptions.

const PROFILE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    profiles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          login: { type: Type.STRING, description: 'GitHub login, exactly as given' },
          summary: { type: Type.STRING, description: '1-2 sentences: who they are, what they are building, and why a scout should care. Plain English, no fluff.' },
        },
        required: ['login', 'summary'],
      },
    },
  },
  required: ['profiles'],
};

function builderContext(b) {
  const projects = db.prepare(`
    SELECT p.name, p.description, s.stars FROM projects p
    JOIN (SELECT project_id, MAX(stars) stars FROM snapshots GROUP BY project_id) s ON s.project_id = p.id
    WHERE p.owner_login=? ORDER BY s.stars DESC LIMIT 3
  `).all(b.login);
  const parts = [
    `login=${b.login}`,
    b.name ? `name: ${b.name}` : '',
    b.bio ? `bio: ${b.bio}` : '',
    b.company ? `company: ${b.company}` : '',
    b.location ? `location: ${b.location}` : '',
    b.university ? `university: ${b.university}${b.is_student ? ' (student)' : ''}` : '',
    b.followers != null ? `followers: ${b.followers}` : '',
    `projects: ${projects.map((p) => `${p.name} (${p.stars}★) — ${p.description?.slice(0, 120) ?? ''}`).join(' | ')}`,
  ];
  return parts.filter(Boolean).join('\n');
}

// Summarize the given builder rows via one Gemini call. Used batch-wise by the
// pipeline and one-at-a-time by the profile endpoint. Returns count written.
export async function summarizeBuilders(builders, log = console.log) {
  if (!config.enrichment.enabled || !builders.length) return 0;
  const client = new GoogleGenAI({ apiKey: config.enrichment.apiKey });

  const response = await client.models.generateContent({
    model: config.enrichment.model,
    contents:
      'Write a profile summary for each of these builders.\n\n' +
      builders.map((b) => `---\n${builderContext(b)}`).join('\n'),
    config: {
      systemInstruction:
        'You write short builder profiles for an early-stage VC scout hunting pre-company ' +
        'devtool founders. For each builder: 1-2 sentences covering who they are, what they ' +
        'are building (in concrete terms — what the tool actually does), and the strongest ' +
        'signal (momentum, background, university, launch). Direct and factual; never invent ' +
        'details not present in the data. Do not start with the person\'s name or "is a".',
      responseMimeType: 'application/json',
      responseSchema: PROFILE_SCHEMA,
    },
  });

  const { profiles } = JSON.parse(response.text ?? '{}');
  let written = 0;
  const known = new Set(builders.map((b) => b.login));
  for (const p of profiles ?? []) {
    if (known.has(p.login) && p.summary?.trim()) {
      saveBuilderSummary(p.login, p.summary.trim());
      written++;
    }
  }
  return written;
}

// Pipeline step: batch-summarize the top-scored builders that lack a summary.
export async function enrichBuilderProfiles(log = console.log) {
  if (!config.enrichment.enabled) return { summaries: 0, mode: 'skipped-no-key' };
  const builders = db.prepare(`
    SELECT b.* FROM builders b
    JOIN scores sc ON sc.entity_type='builder' AND sc.entity_id=b.id
    WHERE b.profile_summary IS NULL AND b.enriched > 0
    ORDER BY sc.total DESC LIMIT 40
  `).all();
  if (!builders.length) return { summaries: 0, mode: 'none-needed' };
  try {
    const written = await summarizeBuilders(builders, log);
    log(`  [enrich] wrote ${written} builder profile summaries`);
    return { summaries: written, mode: 'llm' };
  } catch (e) {
    log(`  [enrich] profile summaries failed (${e.message}) — cards fall back to raw bios`);
    return { summaries: 0, mode: 'failed' };
  }
}

// No API key / LLM failure: group by shared GitHub topics. Crude but honest.
function keywordFallback(projects, log) {
  const byTopic = new Map();
  for (const p of projects) {
    for (const topic of JSON.parse(p.topics || '[]')) {
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      byTopic.get(topic).push(p);
    }
  }
  const clusters = [...byTopic.entries()]
    .filter(([, ps]) => ps.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, config.enrichment.maxTrends);

  for (const [topic, ps] of clusters) {
    const avg = ps.reduce((s, p) => s + p.score, 0) / ps.length;
    saveTrend({
      name: topic,
      summary: `${ps.length} emerging projects share the "${topic}" topic`,
      why_rising: 'Keyword-grouped (set GOOGLE_API_KEY for LLM trend analysis)',
      project_ids: JSON.stringify(ps.map((p) => p.id)),
      score: Math.round(avg),
      source: 'keyword',
    });
  }
  log(`  [enrich] keyword fallback → ${clusters.length} topic groups`);
  return { trends: clusters.length, mode: 'keyword' };
}
