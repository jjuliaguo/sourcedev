// LLM enrichment layer (optional — requires ANTHROPIC_API_KEY).
// Clusters top-scored projects + HN chatter into named trends with
// "why it's rising" summaries. Falls back to keyword grouping when no key.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { db, saveTrend } from '../db.js';

const TREND_SCHEMA = {
  type: 'object',
  properties: {
    trends: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short trend name, e.g. "Local-first sync engines"' },
          summary: { type: 'string', description: 'One-sentence description of the trend' },
          why_rising: { type: 'string', description: 'Why this is emerging NOW — the signal a VC scout cares about' },
          project_ids: { type: 'array', items: { type: 'integer' }, description: 'IDs of projects in this cluster' },
          heat: { type: 'integer', description: 'How hot: 1 (early whisper) to 10 (about to be obvious)' },
        },
        required: ['name', 'summary', 'why_rising', 'project_ids', 'heat'],
        additionalProperties: false,
      },
    },
  },
  required: ['trends'],
  additionalProperties: false,
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

  const client = new Anthropic();
  const hn = recentHnTitles();

  const projectList = projects.map((p) =>
    `id=${p.id} ${p.full_name} [${p.language}] (score ${Math.round(p.score)}) topics=${p.topics}: ${p.description?.slice(0, 150)}`
  ).join('\n');
  const hnList = hn.map((h) => `(${h.points}pts) ${h.title}`).join('\n');

  try {
    const response = await client.messages.create({
      model: config.enrichment.model,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system:
        'You are a devtools trend analyst for an early-stage VC scout. You cluster emerging ' +
        'open-source projects and technical chatter into named trends. Prioritize what is ' +
        'EMERGING (accelerating, early, pre-hype) over what is already popular. A good trend ' +
        'name is specific ("MCP server frameworks", not "AI tools"). Only cluster projects that ' +
        'genuinely share a technical thesis; leave outliers unclustered.',
      messages: [{
        role: 'user',
        content:
          `Cluster these emerging projects into at most ${config.enrichment.maxTrends} named trends.\n\n` +
          `## Projects (ranked by emergence score)\n${projectList}\n\n` +
          `## Recent Hacker News chatter (corroboration)\n${hnList}`,
      }],
      output_config: { format: { type: 'json_schema', schema: TREND_SCHEMA } },
    });

    if (response.stop_reason === 'refusal') {
      log('  [enrich] model refused — falling back to keyword grouping');
      return keywordFallback(projects, log);
    }
    const text = response.content.find((b) => b.type === 'text')?.text ?? '{}';
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
      why_rising: 'Keyword-grouped (set ANTHROPIC_API_KEY for LLM trend analysis)',
      project_ids: JSON.stringify(ps.map((p) => p.id)),
      score: Math.round(avg),
      source: 'keyword',
    });
  }
  log(`  [enrich] keyword fallback → ${clusters.length} topic groups`);
  return { trends: clusters.length, mode: 'keyword' };
}
