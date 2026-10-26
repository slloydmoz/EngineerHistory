// Pure aggregation: counts and durations only. No scoring, ranking or labels.
// Phabricator transaction type names live here so they can be corrected in one place.
// Only KEPT_TX_TYPES are stored when fetching; all others are discarded (see fetchers.js).
export const PHAB = {
  stateTypes: { accept: 'accepted', 'request-changes': 'needsChanges', 'plan-changes': 'changesPlanned', resign: 'resigned' },
  commentTypes: ['comment', 'inline'],
  // Used for review turnaround: reviewer additions/removals, and the author asking for review again.
  requestTypes: ['reviewers', 'request-review'],
  landedStatuses: ['published', 'closed'],
};
export const COUNTED_TX_TYPES = new Set([...Object.keys(PHAB.stateTypes), ...PHAB.commentTypes]);
export const KEPT_TX_TYPES = new Set([...COUNTED_TX_TYPES, ...PHAB.requestTypes]);
export const BUG_CLOSED = ['RESOLVED', 'VERIFIED', 'CLOSED'];
export const NO_TEAM = '(no team)', NOT_IN_ROSTER = 'Not in roster';

export const monthKey = ts => (typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts)).toISOString().slice(0, 7);
const toSec = v => (typeof v === 'number' ? v : Math.floor(new Date(v).getTime() / 1000));
const inWin = (ts, w) => { const s = toSec(ts); return s >= w.start && s <= w.end; };
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function emptyStats() {
  return {
    reviews: {
      events: 0, distinctRevisions: 0, states: { accepted: 0, needsChanges: 0, changesPlanned: 0, resigned: 0 }, commentOnly: 0, byMonth: {},
      requests: 0, answered: 0, turnaroundSecs: [],
    },
    revisions: { authored: 0, landed: 0, byMonth: {} },
    bugs: { closed: 0, byResolution: {}, restricted: 0, byMonth: {} },
    needinfo: { received: 0, answered: 0, clearedByOthers: 0, open: 0, answerSecs: [], byMonth: {} },
    github: { total: 0, byKind: {}, byRepo: {}, byMonth: {} },
    activeMonths: [],
  };
}

export const isReviewTx = t => COUNTED_TX_TYPES.has(t.type);

// Phabricator records one review submission as several transactions (e.g. accept + comment + each
// inline comment). They share a groupID; data cached before groupID was stored falls back to
// author + timestamp, which is identical within one submission.
const submissionKey = t => t.groupID || `${t.authorPHID}:${t.dateCreated}`;
// If one submission carries more than one state change, the most decisive one is reported.
const STATE_ORDER = ['needsChanges', 'accepted', 'changesPlanned', 'resigned'];

function phidMap(people, data) {
  const m = {};
  for (const p of people) {
    const phid = data.phab?.users?.[(p.phabricator || '').toLowerCase()];
    if (phid) m[phid] = p.id;
  }
  return m;
}

// Review submissions on one revision by mapped people who are not its author, oldest first.
function submissions(r, data, byPhid, botPhids) {
  const subs = new Map();
  for (const t of data.phab?.transactions?.[r.id]?.items || []) {
    const pid = byPhid[t.authorPHID];
    if (!pid || t.authorPHID === r.authorPHID || botPhids.has(t.authorPHID) || !isReviewTx(t)) continue;
    const k = submissionKey(t);
    const sub = subs.get(k) || { pid, phid: t.authorPHID, at: t.dateCreated, states: new Set() };
    if (PHAB.stateTypes[t.type]) sub.states.add(PHAB.stateTypes[t.type]);
    subs.set(k, sub);
  }
  return [...subs.values()].map(s => ({ ...s, state: STATE_ORDER.find(x => s.states.has(x)) || null })).sort((a, b) => a.at - b.at);
}

// Review rounds for one reviewer on one revision. A round starts when the person is added as a reviewer,
// or when the author requests review again while they are a reviewer; it ends at their next review
// submission. Requests made to a review group are not attributed to individuals.
function reviewRounds(r, data, phid, subs) {
  const ev = [];
  let listed = false;
  for (const t of data.phab?.transactions?.[r.id]?.items || []) {
    if (t.type === 'reviewers') {
      if (t.added?.includes(phid)) ev.push({ at: t.dateCreated, kind: 'req', order: 2 });
      if (t.removed?.includes(phid)) ev.push({ at: t.dateCreated, kind: 'rem', order: 0 });
    } else if (t.type === 'request-review' && t.authorPHID === r.authorPHID) {
      ev.push({ at: t.dateCreated, kind: 'rereq', order: 2 });
    }
  }
  for (const s of subs) if (s.phid === phid) ev.push({ at: s.at, kind: 'resp', order: 1 });
  ev.sort((a, b) => a.at - b.at || a.order - b.order);
  const rounds = [];
  let open = null;
  for (const e of ev) {
    if (e.kind === 'req') { listed = true; if (!open) open = { requestedAt: e.at }; }
    else if (e.kind === 'rereq') { if (listed && !open) open = { requestedAt: e.at }; }
    else if (e.kind === 'rem') { listed = false; if (open) { open.removed = true; rounds.push(open); open = null; } }
    else if (open) { open.answeredAt = e.at; rounds.push(open); open = null; }
  }
  if (open) rounds.push(open);
  return rounds;
}

// Needinfo requests to one person, from Bugzilla flag history (see fetchers.js).
function needinfoStats(s, items, win) {
  for (const n of items) {
    if (n.setAt && inWin(n.setAt, win)) {
      s.received++;
      bump(s.byMonth, monthKey(n.setAt));
      if (!n.clearedAt) s.open++;
    }
    if (n.clearedAt && inWin(n.clearedAt, win)) {
      if (n.clearedBy === 'self') {
        s.answered++;
        if (n.setAt) s.answerSecs.push(toSec(n.clearedAt) - toSec(n.setAt));
      } else s.clearedByOthers++;
    }
  }
}

// people: [{id, team, phabricator, bugzilla, github}]; data: {phab, bugzilla, github}; win: {start, end} in epoch seconds.
// botPhids: Phabricator PHIDs whose transactions are ignored.
export function aggregate(people, data, win, botPhids = new Set()) {
  const out = {};
  for (const p of people) out[p.id] = emptyStats();
  const byPhid = phidMap(people, data), byBz = {}, byGh = {};
  for (const p of people) {
    if (p.bugzilla) byBz[p.bugzilla.toLowerCase()] = p.id;
    if (p.github) byGh[p.github.toLowerCase()] = p.id;
  }
  const revs = data.phab?.revisions || [];

  // Phabricator: revisions authored (created in window) and landed (published, last modified in window).
  for (const r of revs) {
    const pid = byPhid[r.authorPHID];
    if (!pid) continue;
    if (inWin(r.dateCreated, win)) { out[pid].revisions.authored++; bump(out[pid].revisions.byMonth, monthKey(r.dateCreated)); }
    if (PHAB.landedStatuses.includes(r.status) && inWin(r.dateModified, win)) out[pid].revisions.landed++;
  }

  // Phabricator: review events, one per submission, and review turnaround. Each reviewer is credited
  // independently; repeated reviews of one revision by the same person are separate events, and that
  // revision counts once in distinctRevisions.
  const distinct = {};
  for (const r of revs) {
    const subs = submissions(r, data, byPhid, botPhids);
    for (const sub of subs) {
      if (!inWin(sub.at, win)) continue;
      const s = out[sub.pid].reviews;
      s.events++;
      bump(s.byMonth, monthKey(sub.at));
      if (sub.state) s.states[sub.state]++; else s.commentOnly++;
      (distinct[sub.pid] ||= new Set()).add(r.id);
    }
    for (const [phid, pid] of Object.entries(byPhid)) {
      if (phid === r.authorPHID || botPhids.has(phid)) continue;
      for (const round of reviewRounds(r, data, phid, subs)) {
        if (round.removed || !inWin(round.requestedAt, win)) continue;
        const s = out[pid].reviews;
        s.requests++;
        if (round.answeredAt) { s.answered++; s.turnaroundSecs.push(round.answeredAt - round.requestedAt); }
      }
    }
  }
  for (const pid in distinct) out[pid].reviews.distinctRevisions = distinct[pid].size;

  // Bugzilla: closed bugs by current assignee, dated by last resolution. Restricted bugs are counted only.
  for (const b of data.bugzilla?.bugs || []) {
    const pid = byBz[(b.assigned_to || '').toLowerCase()];
    if (!pid || !BUG_CLOSED.includes(b.status) || !b.cf_last_resolved || !inWin(b.cf_last_resolved, win)) continue;
    const s = out[pid].bugs;
    s.closed++;
    bump(s.byResolution, b.resolution || 'unknown');
    bump(s.byMonth, monthKey(b.cf_last_resolved));
    if (b.groups?.length) s.restricted++;
  }

  // Bugzilla: needinfo requests.
  const ni = {};
  for (const n of data.bugzilla?.needinfo || []) {
    const pid = byBz[(n.requestee || '').toLowerCase()];
    if (pid) (ni[pid] ||= []).push(n);
  }
  for (const pid in ni) needinfoStats(out[pid].needinfo, ni[pid], win);

  // GitHub: events are already limited to mapped logins at fetch time.
  for (const e of data.github?.events || []) {
    const pid = byGh[(e.login || '').toLowerCase()];
    if (!pid || !inWin(e.created_at, win)) continue;
    const s = out[pid].github;
    s.total++;
    bump(s.byKind, e.kind);
    bump(s.byRepo, e.repo);
    bump(s.byMonth, monthKey(e.created_at));
  }

  for (const id in out) {
    const m = new Set();
    for (const k of ['reviews', 'revisions', 'bugs', 'needinfo', 'github']) Object.keys(out[id][k].byMonth).forEach(x => m.add(x));
    out[id].activeMonths = [...m].sort();
  }
  return out;
}

// One engineer's review submissions in the window, counted by the revision author's team.
// Authors are looked up in the whole roster; authors not in it are counted as NOT_IN_ROSTER.
export function reviewsByAuthorTeam(person, allPeople, data, win, botPhids = new Set()) {
  const byPhid = phidMap([person], data), allByPhid = phidMap(allPeople, data);
  const out = {};
  for (const r of data.phab?.revisions || []) {
    const author = allPeople.find(p => p.id === allByPhid[r.authorPHID]);
    const team = author ? author.team || NO_TEAM : NOT_IN_ROSTER;
    for (const s of submissions(r, data, byPhid, botPhids)) if (inWin(s.at, win)) bump(out, team);
  }
  return out;
}
