let currentTab = 'projects';
let savedOnly = false;

const feed = document.getElementById('feed');
const statusLine = document.getElementById('status-line');
const refreshBtn = document.getElementById('refresh-btn');
const overlay = document.getElementById('overlay');
const profilePanel = document.getElementById('profile');
const profileBody = document.getElementById('profile-body');

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    loadFeed();
  });
});

document.getElementById('saved-only').addEventListener('change', (e) => {
  savedOnly = e.target.checked;
  loadFeed();
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Refreshing…';
  await fetch('/api/refresh', { method: 'POST' });
  pollStatus();
});

overlay.addEventListener('click', closeProfile);
document.getElementById('profile-close').addEventListener('click', closeProfile);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProfile(); });

function closeProfile() {
  overlay.classList.add('hidden');
  profilePanel.classList.add('hidden');
}

function openProfilePanel() {
  overlay.classList.remove('hidden');
  profilePanel.classList.remove('hidden');
  profilePanel.scrollTop = 0;
  profileBody.innerHTML = '<div class="p-loading">Loading profile…</div>';
}

async function pollStatus() {
  const res = await fetch('/api/status');
  const s = await res.json();
  statusLine.textContent = s.running
    ? 'Gathering fresh signals…'
    : `${s.counts.projects} projects · ${s.counts.builders} builders · ${s.counts.saved} saved`;
  if (s.running) {
    setTimeout(pollStatus, 1500);
  } else {
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh';
    loadFeed();
  }
}

async function loadFeed() {
  const params = new URLSearchParams({ tab: currentTab });
  if (savedOnly) params.set('filter', 'saved');
  const res = await fetch(`/api/feed?${params}`);
  const items = await res.json();

  // The Trends tab leads with the on-demand research box, then the clustered
  // trend cards below — so it renders even when there are no clustered trends.
  if (currentTab === 'trends') {
    feed.innerHTML = '';
    feed.appendChild(researchPanel());
    loadResearchHistory();
    if (items.length) {
      const heading = document.createElement('h2');
      heading.className = 'section-heading';
      heading.textContent = 'Emerging trends from your radar';
      feed.appendChild(heading);
      for (const item of items) feed.appendChild(trendCard(item));
    }
    return;
  }

  if (!items.length) {
    feed.innerHTML = `<div class="empty">Nothing here yet — hit Refresh to gather signals.</div>`;
    return;
  }
  feed.innerHTML = '';
  for (const item of items) {
    feed.appendChild(currentTab === 'projects' ? projectCard(item) : builderCard(item));
  }
}

// ---------- shared bits ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(n) {
  if (n == null) return '';
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
}

function scoreEl(score) {
  const cls = score >= 60 ? '' : score >= 30 ? 'mid' : 'low';
  return `<div class="score-col"><div class="score ${cls}">${Math.round(score)}</div><div class="score-label">momentum</div></div>`;
}

function ageWords(days) {
  if (days < 14) return `${Math.round(days)} days old`;
  if (days < 60) return `${Math.round(days / 7)} weeks old`;
  return `${Math.round(days / 30)} months old`;
}

function packageLink(pkg) {
  const url = pkg.registry === 'pypi'
    ? `https://pypi.org/project/${encodeURIComponent(pkg.display_name)}/`
    : `https://www.npmjs.com/package/${encodeURIComponent(pkg.display_name)}`;
  const label = pkg.registry === 'pypi' ? 'View on PyPI →' : 'View on npm →';
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${label}</a>`;
}

function mentionSourceLabel(m) {
  if (m.is_show_hn) return 'Show HN · ';
  if (m.source?.startsWith('reddit:')) return `r/${m.source.split(':')[1]} · `;
  return '';
}

function triageButtons(type, item) {
  const div = document.createElement('div');
  div.className = 'actions';
  for (const [status, label] of [['save', 'Save'], ['track', 'Track'], ['dismiss', 'Dismiss']]) {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (item.triage === status) btn.classList.add(`active-${status}`);
    btn.addEventListener('click', async (e) => {
      e.stopPropagation(); // don't open the profile
      const newStatus = item.triage === status ? 'clear' : status;
      await fetch('/api/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, id: item.id, status: newStatus }),
      });
      loadFeed();
    });
    div.appendChild(btn);
  }
  return div;
}

// ---------- feed cards ----------

function projectChips(b, topics) {
  return [
    b.isFocusArea ? `<span class="chip focus">🎯 Core focus area</span>` : '',
    `<span class="chip">${fmtNum(b.stars)} stars</span>`,
    `<span class="chip ${b.velocity >= 5 ? 'good' : ''}">${b.velocity >= 1 ? Math.round(b.velocity) : b.velocity} new stars a day</span>`,
    b.acceleration > 0 ? `<span class="chip good">Speeding up</span>` : '',
    `<span class="chip">${ageWords(b.ageDays)}</span>`,
    b.hnMentions ? `<span class="chip notable">Talked about on Hacker News</span>` : '',
    b.redditMentions ? `<span class="chip notable">Talked about on Reddit</span>` : '',
    b.npmWeeklyDownloads ? `<span class="chip ${b.npmGrowing ? 'good' : 'info'}">${fmtNum(b.npmWeeklyDownloads)} downloads/week${b.npmGrowing ? ', growing' : ''}</span>` : '',
    ...(topics || []).slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`),
  ].join('');
}

function projectCard(p) {
  const card = document.createElement('div');
  card.className = 'card' + (p.triage === 'save' ? ' saved' : p.triage === 'track' ? ' tracked' : '');
  card.innerHTML = `
    ${scoreEl(p.score)}
    <div class="card-body">
      <div class="card-title">
        <span class="name">${esc(p.name)}</span>
        <span class="lang">by ${esc(p.owner_login)}${p.language ? ' · ' + esc(p.language) : ''}</span>
      </div>
      <div class="desc">${esc(p.description)}</div>
      <div class="chips">${projectChips(p.breakdown, p.topics)}</div>
    </div>`;
  card.appendChild(triageButtons('project', p));
  card.addEventListener('click', () => openProjectProfile(p.id));
  return card;
}

function builderCard(b) {
  const card = document.createElement('div');
  card.className = 'card' + (b.triage === 'save' ? ' saved' : b.triage === 'track' ? ' tracked' : '');
  const d = b.breakdown;
  card.innerHTML = `
    <img class="avatar" src="${esc(b.avatar_url)}" alt="" loading="lazy" />
    ${scoreEl(b.score)}
    <div class="card-body">
      <div class="card-title">
        <span class="name">${esc(b.name || b.login)}</span>
        ${b.name ? `<span class="lang">${esc(b.login)}</span>` : ''}
        ${b.university ? `<span class="chip uni">🎓 ${esc(b.university)}${b.is_student ? ' student' : ''}</span>` : ''}
        ${b.target_employer ? `<span class="chip employer">🏢 ${esc(b.target_employer)}</span>` : ''}
      </div>
      <div class="desc">${esc(b.profile_summary || b.bio || '')}</div>
      <div class="chips">
        ${d.bestProject ? `<span class="chip good">Building ${esc(d.bestProject.split('/')[1] || d.bestProject)}</span>` : ''}
        ${b.location ? `<span class="chip ${b.region === 'north_america' ? 'info' : ''}">📍 ${esc(b.location)}</span>` : ''}
        ${b.followers != null ? `<span class="chip ${b.followers < 500 ? 'notable' : ''}">${fmtNum(b.followers)} followers${b.followers < 500 ? ' — not widely known yet' : ''}</span>` : ''}
        ${b.company && !b.university && !b.target_employer ? `<span class="chip">${esc(b.company)}</span>` : ''}
      </div>
    </div>`;
  card.appendChild(triageButtons('builder', b));
  card.addEventListener('click', () => openBuilderProfile(b.id));
  return card;
}

// ---------- topic research (Trends tab) ----------

let researchBusy = false;

function researchPanel() {
  const wrap = document.createElement('div');
  wrap.className = 'research';
  wrap.innerHTML = `
    <div class="research-intro">
      <h2 class="section-heading">Research any topic</h2>
      <p class="research-sub">Fan out across Hacker News, Reddit, Polymarket and the open web, ranked by real engagement — then get a grounded summary.</p>
      <form class="research-form" id="research-form">
        <input type="text" id="research-input" placeholder="e.g. local-first sync engines, LLM eval tooling, AI code review…" autocomplete="off" />
        <button type="submit" id="research-go">Research</button>
      </form>
      <div class="research-history" id="research-history"></div>
    </div>
    <div class="research-result" id="research-result"></div>`;

  wrap.querySelector('#research-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runResearch(wrap.querySelector('#research-input').value);
  });
  return wrap;
}

async function runResearch(topic) {
  topic = (topic || '').trim();
  if (!topic || researchBusy) return;
  researchBusy = true;
  const go = document.getElementById('research-go');
  const result = document.getElementById('research-result');
  if (go) { go.disabled = true; go.textContent = 'Researching…'; }
  result.innerHTML = `<div class="research-loading">Gathering signals across HN, Reddit, Polymarket &amp; the web — this takes a few seconds…</div>`;
  try {
    const res = await fetch('/api/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    renderResearchResult(await res.json());
    loadResearchHistory();
  } catch (e) {
    result.innerHTML = `<div class="research-error">Research failed: ${esc(e.message)}</div>`;
  } finally {
    researchBusy = false;
    if (go) { go.disabled = false; go.textContent = 'Research'; }
  }
}

async function loadResearchHistory() {
  const box = document.getElementById('research-history');
  if (!box) return;
  const rows = await fetch('/api/research').then((r) => r.json()).catch(() => []);
  if (!rows.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<span class="research-history-label">Recent:</span>`;
  for (const r of rows.slice(0, 8)) {
    const chip = document.createElement('button');
    chip.className = 'research-chip';
    chip.textContent = r.topic;
    chip.addEventListener('click', () => openResearch(r.id));
    box.appendChild(chip);
  }
}

async function openResearch(id) {
  const result = document.getElementById('research-result');
  result.innerHTML = `<div class="research-loading">Loading…</div>`;
  const data = await fetch(`/api/research/${id}`).then((r) => r.json()).catch(() => null);
  if (data) renderResearchResult(data);
}

function renderResearchResult(data) {
  const result = document.getElementById('research-result');
  const s = data.sources || {};

  const briefHtml = data.brief
    ? `<div class="research-brief">${mdToHtml(data.brief)}</div>`
    : `<div class="research-note">No synthesized summary — set <code>GOOGLE_API_KEY</code> to enable the grounded web brief. Raw sources below.</div>`;

  const sourceList = (items, render) =>
    items && items.length ? `<ul class="research-sources">${items.map(render).join('')}</ul>` : '';

  const hn = sourceList(s.hn, (h) =>
    `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a>
     <span class="src-meta">${h.points} pts · ${h.comments} comments</span></li>`);

  const reddit = s.redditSkipped
    ? `<p class="research-note-sm">Reddit skipped — set <code>REDDIT_CLIENT_ID</code>/<code>REDDIT_CLIENT_SECRET</code> to include it.</p>`
    : sourceList(s.reddit, (r) =>
        `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>
         <span class="src-meta">${r.points} upvotes · r/${esc(r.subreddit)}</span></li>`);

  const polymarket = sourceList(s.polymarket, (e) =>
    `<li><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>
     <span class="src-meta">$${fmtNum(e.volume)} volume</span>
     <div class="src-odds">${(e.markets || []).map((m) =>
       `<span class="odds-chip">${esc(m.question)} → ${esc(m.outcome)} ${Math.round(m.prob * 100)}%</span>`).join('')}</div></li>`);

  const web = sourceList(s.web, (w) =>
    `<li><a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.title)}</a></li>`);

  const section = (title, body) => body
    ? `<div class="research-source-group"><h4>${title}</h4>${body}</div>` : '';

  result.innerHTML = `
    <div class="research-card">
      <div class="research-topic">${esc(data.topic)}</div>
      ${briefHtml}
      <div class="research-source-cols">
        ${section('Hacker News', hn)}
        ${section('Reddit', reddit)}
        ${section('Polymarket', polymarket)}
        ${section('Around the web', web)}
      </div>
      ${s.unavailable && s.unavailable.length
        ? `<div class="research-note-sm">Not searched (need browser auth or paid APIs): ${s.unavailable.map(esc).join(', ')}.</div>` : ''}
    </div>`;
}

// Minimal, safe Markdown → HTML. Escapes first, then applies a small subset
// (headings, bold, inline links, bullet lists, paragraphs) — enough for the
// synthesized briefs without pulling in a markdown dependency.
function mdToHtml(md) {
  const lines = esc(md).split('\n');
  const out = [];
  let inList = false;
  const inline = (t) => t
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    let m;
    if ((m = line.match(/^#{1,4}\s+(.*)$/))) { closeList(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  closeList();
  return out.join('');
}

function trendCard(t) {
  const card = document.createElement('div');
  card.className = 'card trend-card';
  const projects = (t.projects || [])
    .map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name || p.full_name)}</a>`)
    .join('');
  card.innerHTML = `
    <div class="trend-head">
      <span class="trend-name">${esc(t.name)}</span>
      <span class="trend-heat">Heat ${Math.round(t.score / 10)} out of 10</span>
    </div>
    <div class="desc">${esc(t.summary)}</div>
    ${t.source === 'llm' ? `<div class="trend-why">${esc(t.why_rising)}</div>` : ''}
    <div class="trend-projects">${projects}</div>`;
  return card;
}

// ---------- profile panel ----------

async function openProjectProfile(id) {
  openProfilePanel();
  const res = await fetch(`/api/project/${id}`);
  const p = await res.json();
  const b = p.breakdown || {};

  const stats = [
    [fmtNum(b.stars), 'stars'],
    [`${b.velocity >= 1 ? Math.round(b.velocity) : b.velocity}/day`, 'new stars'],
    [ageWords(b.ageDays), 'repo age'],
    [Math.round(p.score ?? 0), 'momentum'],
    b.npmWeeklyDownloads ? [fmtNum(b.npmWeeklyDownloads), (b.packageRegistry || 'npm') + ' downloads/wk'] : null,
    b.hnMentions ? [b.hnMentions, 'Hacker News posts'] : null,
    b.redditMentions ? [b.redditMentions, 'Reddit posts'] : null,
  ].filter(Boolean).map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');

  const mentions = (p.mentions || []).map((m) => `
    <div class="p-item">
      <a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>
      <div class="meta">${mentionSourceLabel(m)}${m.points} points · ${new Date(m.posted_at).toLocaleDateString()}</div>
    </div>`).join('');

  const owner = p.owner ? `
    <div class="p-item" style="display:flex;gap:12px;align-items:center;">
      <img class="avatar" src="${esc(p.owner.avatar_url)}" alt="" />
      <div>
        <a href="${esc(p.owner.url)}" target="_blank" rel="noopener">${esc(p.owner.name || p.owner.login)}</a>
        ${p.owner.university ? `<span class="chip uni">🎓 ${esc(p.owner.university)}${p.owner.is_student ? ' student' : ''}</span>` : ''}
        <div class="meta">${esc(p.owner.profile_summary || p.owner.bio || '')}</div>
        <div class="meta">${[p.owner.location, p.owner.followers != null ? fmtNum(p.owner.followers) + ' followers' : ''].filter(Boolean).join(' · ')}</div>
      </div>
    </div>` : '';

  profileBody.innerHTML = `
    <div class="p-header">
      <div>
        <div class="p-title">${esc(p.name)}</div>
        <div class="p-sub">${esc(p.description ?? '')}</div>
      </div>
    </div>
    <div class="p-links">
      <a href="${esc(p.url)}" target="_blank" rel="noopener">View on GitHub →</a>
      ${(p.packages || []).map((pkg) => packageLink(pkg)).join('')}
    </div>
    <div class="p-section"><h3>At a glance</h3><div class="stat-grid">${stats}</div></div>
    ${sparklineSection(p.snapshots)}
    ${mentions ? `<div class="p-section"><h3>Community buzz</h3><div class="p-list">${mentions}</div></div>` : ''}
    ${owner ? `<div class="p-section"><h3>The builder behind it</h3><div class="p-list">${owner}</div></div>` : ''}
  `;
}

async function openBuilderProfile(id) {
  openProfilePanel();
  const res = await fetch(`/api/builder/${id}`);
  const b = await res.json();

  const links = [
    `<a href="${esc(b.url)}" target="_blank" rel="noopener">GitHub →</a>`,
    b.twitter ? `<a href="https://x.com/${esc(b.twitter)}" target="_blank" rel="noopener">X / Twitter →</a>` : '',
    b.blog ? `<a href="${esc(/^https?:/.test(b.blog) ? b.blog : 'https://' + b.blog)}" target="_blank" rel="noopener">Website →</a>` : '',
  ].filter(Boolean).join('');

  const stats = [
    b.followers != null ? [fmtNum(b.followers), 'followers'] : null,
    b.public_repos != null ? [b.public_repos, 'public projects'] : null,
    [Math.round(b.score ?? 0), 'momentum'],
  ].filter(Boolean).map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');

  const projects = (b.projects || []).map((p) => `
    <div class="p-item">
      <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>
      ${p.score != null ? `<span class="meta"> · momentum ${Math.round(p.score)}</span>` : ''}
      <div class="meta">${esc(p.description ?? '')}</div>
    </div>`).join('');

  const mentions = (b.mentions || []).map((m) => `
    <div class="p-item">
      <a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>
      <div class="meta">${mentionSourceLabel(m)}${m.points} points</div>
    </div>`).join('');

  const badges = [
    b.university ? `<span class="chip uni">🎓 ${esc(b.university)}${b.is_student ? ' student' : ''}</span>` : '',
    b.target_employer ? `<span class="chip employer">🏢 ${esc(b.target_employer)}${b.employer_source === 'org_member' ? ' (confirmed)' : ''}</span>` : '',
    b.location ? `<span class="chip ${b.region === 'north_america' ? 'info' : ''}">📍 ${esc(b.location)}</span>` : '',
  ].filter(Boolean).join(' ');

  profileBody.innerHTML = `
    <div class="p-header">
      <img class="avatar" src="${esc(b.avatar_url)}" alt="" />
      <div>
        <div class="p-title">${esc(b.name || b.login)}</div>
        <div class="p-sub">${esc([b.login, b.company].filter(Boolean).join(' · '))}</div>
      </div>
    </div>
    ${badges ? `<div class="chips" style="margin:8px 0;">${badges}</div>` : ''}
    ${b.profile_summary ? `<div class="p-desc"><strong>Why they're interesting:</strong> ${esc(b.profile_summary)}</div>` : ''}
    ${b.bio ? `<div class="p-desc" style="color:var(--text-faint);">"${esc(b.bio)}"</div>` : ''}
    <div class="p-links">${links}</div>
    <div class="p-section"><h3>At a glance</h3><div class="stat-grid">${stats}</div></div>
    ${projects ? `<div class="p-section"><h3>What they're building</h3><div class="p-list">${projects}</div></div>` : ''}
    ${mentions ? `<div class="p-section"><h3>Community buzz</h3><div class="p-list">${mentions}</div></div>` : ''}
  `;
}

// Simple star-history sparkline from snapshots (needs 2+ points to be useful).
function sparklineSection(snapshots) {
  if (!snapshots || snapshots.length < 2) return '';
  const stars = snapshots.map((s) => s.stars);
  const min = Math.min(...stars), max = Math.max(...stars);
  if (max === min) return '';
  const W = 480, H = 56;
  const pts = stars.map((v, i) => {
    const x = (i / (stars.length - 1)) * W;
    const y = H - 4 - ((v - min) / (max - min)) * (H - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `
    <div class="p-section"><h3>Star growth we've observed</h3>
      <svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <polyline points="${pts}" fill="none" stroke="#0d8a53" stroke-width="2.5" stroke-linejoin="round" />
      </svg>
      <div class="meta" style="color:var(--text-faint);font-size:13px;">${fmtNum(min)} → ${fmtNum(max)} stars across ${snapshots.length} check-ins</div>
    </div>`;
}

pollStatus();
loadFeed();
