import * as S from './store.js';
import { fetchPhabricator, fetchBugzilla, fetchGitHub, loadCached, testConnection, TX_VERSION } from './fetchers.js';
import { aggregate, reviewsByAuthorTeam, median, PHAB } from './aggregate.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = sec => (sec ? new Date(sec * 1000).toLocaleString() : 'never');
const ui = { person: null, from: null, to: null, fetching: null, log: [] };
let data = { phab: null, bugzilla: null, github: null };

// ---------- Window ----------
const ym = d => d.toISOString().slice(0, 7);
function defaultWindow() {
  const n = S.getSettings().windowMonths || 6, now = new Date();
  return { from: ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1))), to: ym(now) };
}
function windowSec() {
  const [fy, fm] = ui.from.split('-').map(Number), [ty, tm] = ui.to.split('-').map(Number);
  return { start: Date.UTC(fy, fm - 1, 1) / 1000, end: Math.min(Date.UTC(ty, tm, 1) / 1000 - 1, Math.floor(Date.now() / 1000)) };
}
function monthsIn() {
  const out = [], [fy, fm] = ui.from.split('-').map(Number), [ty, tm] = ui.to.split('-').map(Number);
  for (let d = new Date(Date.UTC(fy, fm - 1, 1)); d <= new Date(Date.UTC(ty, tm - 1, 1)); d.setUTCMonth(d.getUTCMonth() + 1)) out.push(ym(d));
  return out;
}

// ---------- Who is shown: one engineer at a time ----------
// The dashboard deliberately never shows several people side by side.
const byName = (a, b) => a.name.localeCompare(b.name);
const PERSON_KEY = 'tdd.ui.person';
function currentPerson(people) {
  if (!ui.person) { try { ui.person = localStorage.getItem(PERSON_KEY); } catch { /* storage unavailable */ } }
  return people.find(p => p.id === ui.person) || [...people].sort(byName)[0];
}
function choosePerson(id) {
  ui.person = id;
  try { localStorage.setItem(PERSON_KEY, id); } catch { /* storage unavailable */ }
}

// ---------- Dashboard ----------
// Durations are calendar time (weekends and holidays included).
function fmtDuration(secs) {
  if (secs == null) return '–';
  const h = secs / 3600;
  if (h < 1) return `${Math.max(1, Math.round(secs / 60))} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}
const medianOf = xs => fmtDuration(median(xs));

// [heading, definition, value(stats)] per section.
const SECTIONS = [
  ['Reviews (Phabricator)', [
    ['Review events', 'Each review submission counted once (a state change with its comments is one event), including repeat reviews of the same revision', s => s.reviews.events],
    ['Revisions reviewed', 'Distinct revisions with at least one review event from this person', s => s.reviews.distinctRevisions],
    ['Accepted', 'Review events that accepted the revision', s => s.reviews.states.accepted],
    ['Needs changes', 'Review events that requested changes', s => s.reviews.states.needsChanges],
    ['Changes planned', 'Review events that marked the revision as changes planned', s => s.reviews.states.changesPlanned],
    ['Resigned', 'Review events where the person resigned as reviewer', s => s.reviews.states.resigned],
    ['Comment only', 'Review submissions with comments but no review state change', s => s.reviews.commentOnly],
    ['Review requests', 'Times the person was asked to review (added as reviewer, or asked again by the author) in the period', s => s.reviews.requests],
    ['Requests answered', 'Of those requests, how many the person has responded to with a review submission', s => s.reviews.answered],
    ['Median turnaround', 'Median calendar time from a review request to the person\'s next review submission, for answered requests', s => medianOf(s.reviews.turnaroundSecs)],
  ]],
  ['Authoring and bugs', [
    ['Revisions authored', 'Phabricator revisions created by this person in the period', s => s.revisions.authored],
    ['Revisions landed', 'Authored revisions now closed, last modified in the period', s => s.revisions.landed],
    ['Bugs closed', 'Bugs currently assigned to this person and resolved in the period', s => s.bugs.closed],
    ['Needinfo received', 'Needinfo requests to this person set in the period', s => s.needinfo.received],
    ['Needinfo answered', 'Needinfo requests the person cleared themselves in the period', s => s.needinfo.answered],
    ['Cleared by others', 'Needinfo requests to this person that someone else cleared in the period', s => s.needinfo.clearedByOthers],
    ['Still open', 'Needinfo requests set in the period that are still open', s => s.needinfo.open],
    ['Median answer time', 'Median calendar time from a needinfo request to the person clearing it', s => medianOf(s.needinfo.answerSecs)],
  ]],
  ['Spec repositories and overall', [
    ['Spec activity', 'Issues, PRs, comments, replies and review comments on the configured spec repositories', s => s.github.total],
    ['Active months', 'Months in the period with any recorded activity from these sources', s => s.activeMonths.length],
  ]],
];
const ALL_STATS = SECTIONS.flatMap(([, stats]) => stats);

// Bar chart over [label, value] pairs.
function barChart(title, entries, ariaSuffix = '') {
  const w = 300, h = 140, pad = 22, max = Math.max(1, ...entries.map(([, v]) => v));
  const bw = (w - pad) / Math.max(1, entries.length);
  const bars = entries.map(([label, v], i) => {
    const bh = ((h - 2 * pad) * v) / max, x = pad / 2 + i * bw, y = h - pad - bh;
    return `<rect x="${x + 2}" y="${y}" width="${Math.max(1, bw - 4)}" height="${bh}"><title>${esc(label)}: ${v}</title></rect>
      <text x="${x + bw / 2}" y="${y - 3}" text-anchor="middle">${v}</text>
      <text x="${x + bw / 2}" y="${h - 6}" text-anchor="middle">${esc(label)}</text>`;
  }).join('');
  return `<div class="panel chart"><h3>${esc(title)}</h3><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title + ariaSuffix)}">${bars}</svg></div>`;
}
const monthChart = (title, byMonth, months) => barChart(title, months.map(m => [m.slice(2), byMonth[m] || 0]), ' by month');

const DURATION_BUCKETS = [['<4h', 4 * 3600], ['4–24h', 86400], ['1–3d', 3 * 86400], ['3–7d', 7 * 86400], ['>7d', Infinity]];
function durationChart(title, secs) {
  const counts = DURATION_BUCKETS.map(([label]) => [label, 0]);
  for (const s of secs) counts[DURATION_BUCKETS.findIndex(([, max]) => s < max)][1]++;
  return barChart(title, counts, ' by duration');
}

const breakdown = (title, obj) => {
  const rows = Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0]));
  return `<div class="panel"><h3>${esc(title)}</h3>${rows.length ? `<div class="kv">${rows.map(([k, v]) => `<span>${esc(k)}</span><span>${v}</span>`).join('')}</div>` : '<p class="muted">None in this period.</p>'}</div>`;
};

function renderDashboard() {
  const st = S.getSettings(), el = $('#view-dashboard');
  if (!ui.from) Object.assign(ui, defaultWindow());
  if (!st.people.length) {
    el.innerHTML = `<div class="card"><h2>Get started</h2><p>Add people, spec repositories and your API keys on the <a href="#settings">Settings</a> page, then fetch data here.</p></div>`;
    return;
  }
  const person = currentPerson(st.people), win = windowSec(), months = monthsIn();
  const bots = new Set(st.botUsernames.map(u => data.phab?.users?.[u.toLowerCase()]).filter(Boolean));
  const s = aggregate([person], data, win, bots)[person.id];
  const byTeam = reviewsByAuthorTeam(person, st.people, data, win, bots);
  const statList = stats => `<dl class="stats">${stats.map(([h, d, f]) => `<div title="${esc(d)}"><dt>${esc(h)}</dt><dd>${f(s)}</dd></div>`).join('')}</dl>`;
  const [reviews, authoring, spec] = SECTIONS;
  const fetchedRow = (label, d, extra = '') => `<span>${label}</span><span>${d ? fmtDate(d.fetchedAt) : 'not fetched'}${extra}</span>`;
  const pending = data.phab?.pending ? ` (${data.phab.pending} revisions still to fetch review history for; fetch again to continue)` : '';
  const options = [...st.people].sort(byName)
    .map(p => `<option value="${esc(p.id)}" ${p.id === person.id ? 'selected' : ''}>${esc(p.name || '(unnamed)')}</option>`).join('');
  const about = [person.team, person.manager && `manager: ${person.manager}`].filter(Boolean).map(esc).join(' · ');

  el.innerHTML = `
    <div class="card">
      <div class="row">
        <label>Engineer <select id="person">${options}</select></label>
        <label>From <input type="month" id="from" value="${ui.from}"></label>
        <label>To <input type="month" id="to" value="${ui.to}"></label>
        <button class="primary" id="fetch" ${ui.fetching ? 'disabled aria-busy="true"' : ''}>${ui.fetching ? 'Fetching…' : 'Fetch / refresh data'}</button>
        ${ui.fetching ? '<button id="cancel">Cancel</button>' : ''}
        <button id="csv">Export as CSV</button>
      </div>
      ${ui.fetching ? `<div class="fetch-status" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span id="fetch-status">${esc(statusText())}</span></div>` : ''}
      <h3>Last fetched</h3>
      <div class="kv">${fetchedRow('Phabricator', data.phab, pending)}${fetchedRow('Bugzilla', data.bugzilla)}${fetchedRow('GitHub', data.github)}</div>
      ${ui.fetching || ui.log.length ? `<h3>Fetch log</h3><div class="log" id="log">${esc(ui.log.join('\n'))}</div>` : ''}
    </div>

    <div class="person-head">
      <h2>${esc(person.name || '(unnamed)')}</h2>
      <p class="muted">${about ? `${about} · ` : ''}${esc(ui.from)} to ${esc(ui.to)}</p>
    </div>
    <p class="muted">Counts of recorded activity only. They do not measure effort, quality or impact, and some work (meetings, mentoring, investigation, private repos) is not captured. Hover a figure for its definition, or see <a href="#definitions">How it's calculated</a>.</p>

    <section class="card">
      <h2>${esc(reviews[0])}</h2>
      ${statList(reviews[1])}
      <div class="charts">
        ${monthChart('Review events', s.reviews.byMonth, months)}
        ${durationChart('Review turnaround', s.reviews.turnaroundSecs)}
        ${breakdown("Review events by revision author's team", byTeam)}
      </div>
    </section>

    <section class="card">
      <h2>${esc(authoring[0])}</h2>
      ${statList(authoring[1])}
      <div class="charts">
        ${monthChart('Revisions authored', s.revisions.byMonth, months)}
        ${monthChart('Bugs closed', s.bugs.byMonth, months)}
        ${breakdown('Bug resolutions', s.bugs.byResolution)}
        ${monthChart('Needinfo received', s.needinfo.byMonth, months)}
        ${durationChart('Needinfo answer time', s.needinfo.answerSecs)}
      </div>
      ${s.bugs.restricted ? `<p class="muted">${s.bugs.restricted} of the closed bugs are security-restricted. They are counted, but no details are stored.</p>` : ''}
    </section>

    <section class="card">
      <h2>${esc(spec[0])}</h2>
      ${statList(spec[1])}
      <div class="charts">
        ${monthChart('Spec activity', s.github.byMonth, months)}
        ${breakdown('Spec activity by kind', s.github.byKind)}
        ${breakdown('Spec activity by repository', s.github.byRepo)}
      </div>
    </section>
    <p class="muted">Response-time charts count answered requests in each range of calendar time; weekends, holidays and time zones are not taken into account.</p>`;

  $('#person').onchange = e => { choosePerson(e.target.value); renderDashboard(); };
  $('#from').onchange = e => { ui.from = e.target.value || ui.from; if (ui.from > ui.to) ui.to = ui.from; renderDashboard(); };
  $('#to').onchange = e => { ui.to = e.target.value || ui.to; if (ui.to < ui.from) ui.from = ui.to; renderDashboard(); };
  $('#fetch').onclick = runFetch;
  if ($('#cancel')) $('#cancel').onclick = () => ui.fetching?.abort();
  $('#csv').onclick = () => {
    const lines = [['Engineer', person.name], ['Period', `${ui.from} to ${ui.to}`], ['Measure', 'Value'], ...ALL_STATS.map(([h, , f]) => [h, f(s)])];
    const slug = (person.name || 'engineer').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    download(`activity-${slug}-${ui.from}-to-${ui.to}.csv`, lines.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  };
  const log = $('#log');
  if (log) log.scrollTop = log.scrollHeight;
}

// One line summarising progress: latest step, API calls so far and elapsed time.
function statusText() {
  const p = ui.progress;
  if (!p) return 'Starting…';
  const calls = Object.values(p.ctx.calls).reduce((a, b) => a + b, 0);
  const secs = Math.floor((Date.now() - p.started) / 1000);
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  return `${ui.log.at(-1) || 'Starting…'} · ${calls} API call${calls === 1 ? '' : 's'} · ${elapsed}`;
}
function updateStatus() {
  const s = $('#fetch-status');
  if (s) s.textContent = statusText();
}

async function runFetch() {
  const st = S.getSettings(), keys = S.getKeys(), people = st.people;
  const startSec = windowSec().start;
  const ctrl = new AbortController();
  ui.fetching = ctrl;
  ui.log = [];
  const ctx = { calls: {}, signal: ctrl.signal, log: m => {
    ui.log.push(m);
    const l = $('#log');
    if (l) { l.textContent = ui.log.join('\n'); l.scrollTop = l.scrollHeight; }
    updateStatus();
  } };
  ui.progress = { ctx, started: Date.now() };
  const timer = setInterval(updateStatus, 1000);
  renderDashboard();
  const jobs = [
    ['Phabricator', 'phabricator', () => keys.phabricator && people.some(p => p.phabricator), fetchPhabricator, 'needs a Phabricator token and at least one Phabricator username'],
    ['Bugzilla', 'bugzilla', () => people.some(p => p.bugzilla), fetchBugzilla, 'needs at least one Bugzilla email'],
    ['GitHub', 'github', () => st.specRepos.length && people.some(p => p.github), fetchGitHub, 'needs spec repositories and at least one GitHub login'],
  ];
  for (const [label, src, ready, fn, why] of jobs) {
    if (ctrl.signal.aborted) break;
    if (!ready()) { ctx.log(`${label}: skipped (${why})`); continue; }
    try { await fn(st, keys, people, startSec, ctx); ctx.log(`${label}: done, ${ctx.calls[src] || 0} API calls`); }
    catch (e) { ctx.log(`${label}: ${e.name === 'AbortError' ? 'cancelled' : `failed: ${e.message}`}`); }
  }
  clearInterval(timer);
  ui.fetching = null;
  ui.progress = null;
  data = await loadCached();
  renderDashboard();
}

// ---------- Settings ----------
const PEOPLE_FIELDS = [['name', 'Name'], ['team', 'Team'], ['manager', 'Manager (name)'], ['bugzilla', 'Bugzilla email'], ['phabricator', 'Phabricator username'], ['github', 'GitHub login']];

function renderSettings() {
  const st = S.getSettings(), keys = S.getKeys(), el = $('#view-settings');
  const keyRow = (src, label, help) => `
    <div class="row" style="margin-bottom:.6rem">
      <label style="flex:1 1 20rem">${label}<input type="password" autocomplete="off" data-key="${src}" value="${esc(keys[src] || '')}" placeholder="${keys[src] ? '' : 'not set'}"></label>
      <button data-test="${src}">Test connection</button>
      <span class="muted" id="test-${src}">${esc(help)}</span>
    </div>`;
  el.innerHTML = `
    <h2>API keys</h2>
    <div class="card">
      <p class="muted">Stored in this browser only (localStorage) and sent only to the service each key belongs to. Never paste keys into chat or shared documents.</p>
      ${keyRow('phabricator', 'Phabricator API token', 'Required for Phabricator.')}
      ${keyRow('bugzilla', 'Bugzilla API key', 'Optional: needed to count security-restricted bugs.')}
      ${keyRow('github', 'GitHub token', 'Optional: raises the rate limit from 60 to 5,000 requests an hour.')}
      <button id="clear-keys">Clear keys</button>
    </div>

    <h2>Systems</h2>
    <div class="card">
      <div class="row">
        <label>Bugzilla URL <input data-set="bugzillaUrl" value="${esc(st.bugzillaUrl)}" size="32"></label>
        <label>Phabricator URL <input data-set="phabricatorUrl" value="${esc(st.phabricatorUrl)}" size="36"></label>
        <label>GitHub API URL <input data-set="githubUrl" value="${esc(st.githubUrl)}" size="24"></label>
      </div>
      <div class="row" style="margin-top:.75rem">
        <label>Default period (months) <input type="number" min="1" max="36" data-set="windowMonths" data-num value="${st.windowMonths}"></label>
        <label>Phabricator review-history calls per fetch <input type="number" min="10" max="5000" data-set="phabTxCap" data-num value="${st.phabTxCap}"></label>
        <label>Pause between Phabricator calls (ms) <input type="number" min="0" max="10000" data-set="phabDelayMs" data-num value="${st.phabDelayMs}"></label>
      </div>
      <div class="row" style="margin-top:.75rem">
        <label style="flex:1 1 20rem">Spec repositories, one <code>owner/repo</code> per line <textarea data-set="specRepos" data-list placeholder="whatwg/html&#10;w3c/csswg-drafts&#10;mozilla/standards-positions">${esc(st.specRepos.join('\n'))}</textarea></label>
        <label style="flex:1 1 20rem">Phabricator bot usernames to ignore, one per line <textarea data-set="botUsernames" data-list>${esc(st.botUsernames.join('\n'))}</textarea></label>
      </div>
    </div>

    <h2>People</h2>
    <div class="card">
      <p class="muted">The dashboard shows one engineer at a time and never lists people side by side. Team and manager are shown as context on each engineer's page; team is also used to group the review authors an engineer reviews for.</p>
      <div class="scroll"><table class="edit">
        <thead><tr>${PEOPLE_FIELDS.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead>
        <tbody>${st.people.map((p, i) => `<tr>${PEOPLE_FIELDS.map(([f]) => `<td><input data-person="${i}" data-field="${f}" value="${esc(p[f])}" ${f === 'manager' ? 'list="names"' : ''}></td>`).join('')}<td><button data-remove="${i}" aria-label="Remove ${esc(p.name)}">Remove</button></td></tr>`).join('')}</tbody>
      </table></div>
      <datalist id="names">${st.people.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>
      <div class="row" style="margin-top:.75rem">
        <button id="add-person">Add person</button>
        <label>Import CSV (columns: ${PEOPLE_FIELDS.map(f => f[0]).join(', ')}) <input type="file" id="csv-import" accept=".csv,text/csv"></label>
      </div>
    </div>

    <h2>Back up or move settings</h2>
    <div class="card">
      <div class="row">
        <label style="flex-direction:row;align-items:center;gap:.4rem"><input type="checkbox" id="export-keys"> Include API keys in the export</label>
        <button id="export">Export settings</button>
        <label>Import settings <input type="file" id="import" accept=".json,application/json"></label>
      </div>
      <p class="muted">Exports are plain JSON files on your machine. With keys included, treat the file as a secret.</p>
    </div>

    <h2>Stored data</h2>
    <div class="card">
      <div class="row">
        <button id="clear-cache">Clear fetched data</button>
        <button id="clear-all">Clear everything (keys, settings and data)</button>
      </div>
      <p class="muted" id="store-msg"></p>
    </div>`;

  el.querySelectorAll('[data-key]').forEach(inp => inp.onchange = () => { const k = S.getKeys(); k[inp.dataset.key] = inp.value.trim(); S.saveKeys(k); });
  el.querySelectorAll('[data-test]').forEach(b => b.onclick = async () => {
    const out = $(`#test-${b.dataset.test}`);
    out.className = 'muted';
    out.textContent = 'Testing…';
    try { out.textContent = await testConnection(b.dataset.test, S.getSettings(), S.getKeys()); out.className = 'ok'; }
    catch (e) { out.textContent = e.message; out.className = 'err'; }
  });
  el.querySelectorAll('[data-set]').forEach(inp => inp.onchange = () => {
    const s = S.getSettings(), f = inp.dataset.set;
    s[f] = 'list' in inp.dataset ? inp.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean)
      : 'num' in inp.dataset ? Number(inp.value) || S.DEFAULT_SETTINGS[f] : inp.value.trim();
    S.saveSettings(s);
  });
  el.querySelectorAll('[data-person]').forEach(inp => inp.onchange = () => {
    const s = S.getSettings();
    s.people[inp.dataset.person][inp.dataset.field] = inp.value.trim();
    S.saveSettings(s);
    if (inp.dataset.field === 'name') renderSettings();
  });
  el.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => {
    const s = S.getSettings();
    s.people.splice(Number(b.dataset.remove), 1);
    S.saveSettings(s);
    renderSettings();
  });
  $('#add-person').onclick = () => {
    const s = S.getSettings();
    s.people.push({ id: crypto.randomUUID(), name: '', team: '', manager: '', bugzilla: '', phabricator: '', github: '' });
    S.saveSettings(s);
    renderSettings();
  };
  $('#csv-import').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    const s = S.getSettings();
    s.people.push(...S.parsePeopleCsv(await f.text()));
    S.saveSettings(s);
    renderSettings();
  };
  $('#clear-keys').onclick = () => { S.clearKeys(); renderSettings(); };
  $('#export').onclick = () => download('engineer-history-settings.json', S.exportSettings($('#export-keys').checked), 'application/json');
  $('#import').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try { S.importSettings(await f.text()); renderSettings(); }
    catch (err) { $('#store-msg').textContent = `Import failed: ${err.message}`; }
  };
  $('#clear-cache').onclick = async () => { await S.cacheClear(); data = await loadCached(); $('#store-msg').textContent = 'Fetched data cleared.'; };
  $('#clear-all').onclick = async () => {
    if (!confirm('Delete all keys, settings and fetched data from this browser?')) return;
    await S.cacheClear();
    try { localStorage.clear(); } catch { /* storage unavailable */ }
    data = await loadCached();
    renderSettings();
    $('#store-msg').textContent = 'Everything cleared.';
  };
}

// ---------- Definitions ----------
function txTypeSummary() {
  const types = Object.fromEntries([...Object.keys(PHAB.stateTypes), ...PHAB.commentTypes, ...PHAB.requestTypes].map(k => [k, 0]));
  let discarded = 0, fetched = false, withAdds = 0, outdated = 0;
  for (const e of Object.values(data.phab?.transactions || {})) {
    fetched = true;
    discarded += e.discarded || 0;
    if (e.v !== TX_VERSION) outdated++;
    for (const t of e.items) {
      if (t.type in types) types[t.type]++;
      if (t.type === 'reviewers' && t.added?.length) withAdds++;
    }
  }
  const countedAs = k => PHAB.stateTypes[k] ? `state change: ${PHAB.stateTypes[k]}`
    : PHAB.commentTypes.includes(k) ? 'comment'
    : k === 'reviewers' ? `review requests (${withAdds} with reviewer additions read)` : 'review requests (asked again)';
  return { fetched, discarded, outdated, rows: Object.entries(types).map(([type, n]) => ({ type, n, countedAs: countedAs(type) })) };
}

function renderDefinitions() {
  const tx = txTypeSummary();
  $('#view-definitions').innerHTML = `
    <h2>How each figure is calculated</h2>
    <div class="card"><dl class="defs">
      <dt>Review event</dt><dd>One review submission by the person on a revision they did not author: a review state change (accept, request changes, plan changes, resign) and/or review comments (general or inline). Phabricator records a submission as several transactions, for example an accept, a comment and each inline comment; these count as one event. A submission with a state change is reported under that state; one with only comments is "comment only". Bot accounts listed in Settings are excluded.</dd>
      <dt>Repeat reviews</dt><dd>Reviewing the same revision several times gives several review events. "Revisions reviewed" counts each revision once per person, so both figures are shown side by side.</dd>
      <dt>Several reviewers</dt><dd>When two or more people review a revision, each is credited for their own events.</dd>
      <dt>Review requests and turnaround</dt><dd>A review request starts when the person is added as a reviewer, or when the author asks for review again while the person is a reviewer. It is answered by the person's next review submission of any kind (including resigning); further requests before that answer do not restart the clock. Being removed as reviewer closes the request without counting it. Requests made to a review group, rather than to the person, are not attributed to anyone. Turnaround is the calendar time from request to answer, counted for requests made in the period; weekends, holidays and time zones are not taken into account.</dd>
      <dt>Review events by revision author's team</dt><dd>This engineer's review events, counted by the team of each revision's author. Teams come from the People settings. Authors who are not in the roster are grouped as "Not in roster"; people with no team as "(no team)".</dd>
      <dt>Needinfo</dt><dd>From Bugzilla flag history. "Received" counts needinfo requests to the person set in the period. "Answered" counts those the person cleared themselves in the period, which normally happens when they reply. "Cleared by others" counts requests someone else cleared, for example a requester withdrawing it. "Still open" counts requests set in the period that are not yet cleared. Answer time is the calendar time from the request being set to the person clearing it.</dd>
      <dt>Revisions considered</dt><dd>Revisions where the person is a listed reviewer or the author and that were modified in the period. A comment from someone not listed as a reviewer is not counted.</dd>
      <dt>Revisions landed</dt><dd>Authored revisions whose status is closed (published), with the last modification in the period. This approximates the landing date.</dd>
      <dt>Bugs closed</dt><dd>Bugs in RESOLVED, VERIFIED or CLOSED status whose current assignee is the person and whose most recent resolution date (cf_last_resolved) falls in the period. Security-restricted bugs are counted without storing any details.</dd>
      <dt>Spec activity</dt><dd>On the configured GitHub repositories: issues opened, PRs opened, comments on the person's own issue or PR, replies on other people's issues or PRs, and inline PR review comments. PR review submissions without an inline comment are not included.</dd>
      <dt>Active months</dt><dd>Months in the period with at least one counted item from any source.</dd>
      <dt>What is not measured</dt><dd>These are counts of recorded activity only. They do not reflect effort, difficulty, quality or impact, and the dashboard makes no judgement about anyone's workload.</dd>
    </dl></div>

    <h2>Phabricator transaction types</h2>
    <div class="card">
      <p class="muted">Only these transaction types are kept when fetching; for reviewer changes, only which reviewers were added or removed. All other types (revision updates, subscriber, project and title changes, untyped bookkeeping and so on) are discarded and never stored.</p>
      ${tx.fetched ? `<div class="scroll"><table>
        <thead><tr><th>Type</th><th>Transactions stored</th><th>Counted as</th></tr></thead>
        <tbody>${tx.rows.map(s => `<tr><td>${esc(s.type)}</td><td>${s.n}</td><td>${esc(s.countedAs)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Other types</td><td>${tx.discarded}</td><td>discarded, not stored</td></tr></tfoot>
      </table></div>
      ${tx.outdated ? `<p class="muted">${tx.outdated} revisions were cached before review requests were stored; their review history is fetched again on the next fetches, so review requests and turnaround are incomplete until then.</p>` : ''}` : '<p class="muted">No Phabricator data fetched yet.</p>'}
    </div>

    <h2>Where data is stored</h2>
    <div class="card"><div class="kv">
      <span>API keys</span><span>This browser's localStorage</span>
      <span>Settings, people, repositories</span><span>This browser's localStorage</span>
      <span>Fetched activity data</span><span>This browser's IndexedDB. Only IDs, dates, statuses, user IDs and review actions are kept: no titles, summaries or comment text, and no Phabricator transactions other than review actions.</span>
      <span>Quick</span><span>Nothing is stored in Quick's shared stores.</span>
    </div></div>`;
}

// ---------- Shell ----------
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function route() {
  const view = ['dashboard', 'settings', 'definitions'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== `view-${view}`);
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
  ({ dashboard: renderDashboard, settings: renderSettings, definitions: renderDefinitions })[view]();
}

window.addEventListener('hashchange', route);
data = await loadCached();
route();
