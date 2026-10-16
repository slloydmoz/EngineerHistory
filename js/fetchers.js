// Browser-side fetchers. Requests go directly from this browser to each service with the
// viewer's own keys; results are cached in this browser's IndexedDB only.
// Only the fields needed for counts are kept: no titles, comment text or bug summaries.
import { cacheGet, cacheSet } from './store.js';
import { KEPT_TX_TYPES } from './aggregate.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const trimSlash = u => u.replace(/\/+$/, '');

// ctx: { calls: {source: n}, log(msg), signal }
async function request(source, url, opts, ctx, tries = 4) {
  for (let i = 0; ; i++) {
    ctx.calls[source] = (ctx.calls[source] || 0) + 1;
    let r;
    try { r = await fetch(url, { ...opts, signal: ctx.signal }); }
    catch (e) {
      if (e.name === 'AbortError' || i >= tries - 1) throw e;
      await sleep(1000 * 2 ** i);
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      if (i >= tries - 1) throw new Error(`${source}: HTTP ${r.status}`);
      const wait = Number(r.headers.get('Retry-After')) * 1000 || 2000 * 2 ** i;
      ctx.log(`${source}: HTTP ${r.status}, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    return r;
  }
}

// ---------- Phabricator (Conduit) ----------
// Form-encoded POST keeps these "simple" requests (no CORS preflight).
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') flatten(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function conduit(settings, keys, method, params, ctx) {
  if (!keys.phabricator) throw new Error('No Phabricator API token set');
  for (let i = 0; ; i++) {
    await sleep(settings.phabDelayMs);
    const body = flatten(params, '', new URLSearchParams({ 'api.token': keys.phabricator }));
    const r = await request('phabricator', `${trimSlash(settings.phabricatorUrl)}/api/${method}`, { method: 'POST', body }, ctx);
    const j = await r.json();
    if (!j.error_code) return j.result;
    // Conduit reports throttling as an error payload rather than an HTTP status.
    if (/rate|limit|throttl/i.test(`${j.error_code} ${j.error_info}`) && i < 4) {
      const wait = 5000 * 2 ** i;
      ctx.log(`Phabricator rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Phabricator ${method}: ${j.error_info || j.error_code}`);
  }
}

async function conduitAll(settings, keys, method, params, ctx) {
  const out = [];
  let after = null;
  do {
    const res = await conduit(settings, keys, method, { ...params, limit: 100, ...(after ? { after } : {}) }, ctx);
    out.push(...res.data);
    after = res.cursor?.after;
  } while (after);
  return out;
}

async function phabUsers(settings, keys, usernames, ctx) {
  const map = {};
  for (let i = 0; i < usernames.length; i += 100) {
    const batch = usernames.slice(i, i + 100);
    const res = await conduitAll(settings, keys, 'user.search', { constraints: { usernames: batch } }, ctx);
    for (const u of res) map[u.fields.username.toLowerCase()] = u.phid;
  }
  return map;
}

const slimRev = r => ({
  id: r.id, phid: r.phid, authorPHID: r.fields.authorPHID, status: r.fields.status?.value,
  dateCreated: r.fields.dateCreated, dateModified: r.fields.dateModified,
  reviewerPHIDs: (r.attachments?.reviewers?.reviewers || []).map(x => x.reviewerPHID),
});
// Only review and review-request transactions are kept, with just the fields counting needs:
// no comment content. For reviewer changes only the added/removed reviewer PHIDs are kept.
// `discarded` records how many other transactions the revision had, for the Definitions view.
// Bump TX_VERSION when the kept shape changes, so cached revisions are re-fetched.
export const TX_VERSION = 2;
const reviewerOps = (t, op) => (t.fields?.operations || []).filter(o => o.operation === op).map(o => o.phid);
const slimTx = t => {
  const s = { type: t.type, groupID: t.groupID, authorPHID: t.authorPHID, dateCreated: t.dateCreated };
  if (t.type === 'reviewers') { s.added = t.added || reviewerOps(t, 'add'); s.removed = t.removed || reviewerOps(t, 'remove'); }
  return s;
};
const slimTxs = (txs, dateModified) => {
  const items = txs.filter(t => KEPT_TX_TYPES.has(t.type)).map(slimTx);
  return { v: TX_VERSION, dateModified, items, discarded: txs.length - items.length };
};

// Prunes caches written before only kept transaction types were stored. Returns true if anything changed.
// Pruned entries keep their old version, so they are still re-fetched when the version is behind.
function pruneTransactions(cache) {
  let changed = false;
  for (const [id, e] of Object.entries(cache.transactions || {})) {
    if (e.items.every(t => KEPT_TX_TYPES.has(t.type) && !('nComments' in t))) continue;
    const pruned = slimTxs(e.items, e.dateModified);
    cache.transactions[id] = { ...pruned, v: e.v, discarded: (e.discarded || 0) + pruned.discarded };
    changed = true;
  }
  delete cache.typesSeen;
  return changed;
}

export async function fetchPhabricator(settings, keys, people, startSec, ctx) {
  const usernames = [...new Set([...people.map(p => p.phabricator), ...settings.botUsernames].filter(Boolean).map(s => s.toLowerCase()))];
  const cache = (await cacheGet('phab')) || { users: {}, revisions: {}, transactions: {} };
  pruneTransactions(cache);
  const missing = usernames.filter(u => !cache.users[u]);
  if (missing.length) {
    ctx.log(`Phabricator: looking up ${missing.length} usernames`);
    Object.assign(cache.users, await phabUsers(settings, keys, missing, ctx));
    const notFound = missing.filter(u => !cache.users[u]);
    if (notFound.length) ctx.log(`Phabricator: not found: ${notFound.join(', ')}`);
  }
  const phids = people.map(p => cache.users[(p.phabricator || '').toLowerCase()]).filter(Boolean);
  if (!phids.length) { await cacheSet('phab', cache); return cache; }

  // Incremental: if the same people were fetched from the same or an earlier start, only ask for what changed since.
  const peopleKey = [...phids].sort().join(',');
  const incremental = cache.peopleKey === peopleKey && cache.fetchedFrom <= startSec && cache.fetchedAt;
  const since = incremental ? Math.max(startSec, cache.fetchedAt - 3600) : startSec;
  const reqStart = Math.floor(Date.now() / 1000);

  ctx.log(`Phabricator: searching revisions modified since ${new Date(since * 1000).toISOString().slice(0, 10)}`);
  const attachments = { reviewers: 1 };
  const reviewed = await conduitAll(settings, keys, 'differential.revision.search',
    { constraints: { reviewerPHIDs: phids, modifiedStart: since }, attachments, order: 'updated' }, ctx);
  const authored = await conduitAll(settings, keys, 'differential.revision.search',
    { constraints: { authorPHIDs: phids, modifiedStart: since }, attachments, order: 'updated' }, ctx);
  for (const r of [...reviewed, ...authored]) cache.revisions[r.id] = slimRev(r);

  // Transactions are needed only where a mapped person is a reviewer and the revision changed since last fetched.
  const phidSet = new Set(phids);
  const stale = Object.values(cache.revisions)
    .filter(r => r.dateModified >= startSec && r.reviewerPHIDs.some(p => phidSet.has(p)))
    .filter(r => { const e = cache.transactions[r.id]; return !e || e.v !== TX_VERSION || e.dateModified < r.dateModified; })
    .sort((a, b) => b.dateModified - a.dateModified);
  const todo = stale.slice(0, settings.phabTxCap);
  ctx.log(`Phabricator: ${stale.length} revisions need review history; fetching ${todo.length} this run`);
  for (const [i, r] of todo.entries()) {
    if (i % 10 === 0) ctx.log(`Phabricator: review history ${i + 1}/${todo.length}`);
    const tx = await conduitAll(settings, keys, 'transaction.search', { objectIdentifier: r.phid }, ctx);
    cache.transactions[r.id] = slimTxs(tx, r.dateModified);
    if (i % 25 === 24) await cacheSet('phab', cache); // keep progress if the run is interrupted
  }
  cache.pending = stale.length - todo.length;
  cache.peopleKey = peopleKey;
  cache.fetchedFrom = incremental ? cache.fetchedFrom : startSec;
  cache.fetchedAt = reqStart;
  await cacheSet('phab', cache);
  return cache;
}

// ---------- Bugzilla ----------
const BZ_FIELDS = 'id,status,resolution,cf_last_resolved,assigned_to,groups,product,component';

export async function fetchBugzilla(settings, keys, people, startSec, ctx) {
  const emails = [...new Set(people.map(p => p.bugzilla).filter(Boolean))];
  const headers = keys.bugzilla ? { 'X-BUGZILLA-API-KEY': keys.bugzilla } : {};
  const from = new Date(startSec * 1000).toISOString().slice(0, 10);
  const bugs = {};
  for (let i = 0; i < emails.length; i += 25) {
    const batch = emails.slice(i, i + 25);
    const q = new URLSearchParams({ include_fields: BZ_FIELDS, f1: 'cf_last_resolved', o1: 'greaterthaneq', v1: from, f2: 'OP', j2: 'OR' });
    batch.forEach((e, j) => { q.set(`f${j + 3}`, 'assigned_to'); q.set(`o${j + 3}`, 'equals'); q.set(`v${j + 3}`, e); });
    q.set(`f${batch.length + 3}`, 'CP');
    for (const s of ['RESOLVED', 'VERIFIED', 'CLOSED']) q.append('bug_status', s);
    for (let offset = 0; ; offset += 500) {
      q.set('limit', '500'); q.set('offset', String(offset));
      ctx.log(`Bugzilla: assignees ${i + 1}-${i + batch.length}, offset ${offset}`);
      const r = await request('bugzilla', `${trimSlash(settings.bugzillaUrl)}/rest/bug?${q}`, { headers }, ctx);
      const j = await r.json();
      if (j.error) throw new Error(`Bugzilla: ${j.message}`);
      for (const b of j.bugs) bugs[b.id] = b;
      if (j.bugs.length < 500) break;
    }
  }
  const needinfo = await fetchNeedinfo(settings, headers, emails, startSec, ctx);
  const out = { bugs: Object.values(bugs), needinfo, fetchedAt: Math.floor(Date.now() / 1000), fetchedFrom: startSec };
  await cacheSet('bugzilla', out);
  return out;
}

// Needinfo requests to mapped people, from flag history. Kept per request: bug id, requestee, when it
// was set, when it was cleared, and whether the requestee cleared it themselves ('self') or someone
// else did ('other'). History is read from 60 days before the window so earlier requests answered in
// the window still get a set time.
const NI = /^needinfo\?\((.+)\)$/;
const flagTokens = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
async function fetchNeedinfo(settings, headers, emails, startSec, ctx) {
  const base = trimSlash(settings.bugzillaUrl), from = new Date(startSec * 1000).toISOString().slice(0, 10);
  const mapped = new Set(emails.map(e => e.toLowerCase()));
  const ids = new Set();
  // Bugs where, since the window start, a needinfo to the person was set or the person changed a flag.
  for (let i = 0; i < emails.length; i += 25) {
    const batch = emails.slice(i, i + 25);
    const q = new URLSearchParams({ include_fields: 'id', f1: 'flagtypes.name', o1: 'changedafter', v1: from, f2: 'OP', j2: 'OR' });
    let n = 3;
    for (const e of batch) {
      q.set(`f${n}`, 'flagtypes.name'); q.set(`o${n}`, 'changedto'); q.set(`v${n++}`, `needinfo?(${e})`);
      q.set(`f${n}`, 'flagtypes.name'); q.set(`o${n}`, 'changedby'); q.set(`v${n++}`, e);
    }
    q.set(`f${n}`, 'CP');
    for (let offset = 0; ; offset += 500) {
      q.set('limit', '500'); q.set('offset', String(offset));
      ctx.log(`Bugzilla needinfo: finding bugs for people ${i + 1}-${i + batch.length}, offset ${offset}`);
      const j = await (await request('bugzilla', `${base}/rest/bug?${q}`, { headers }, ctx)).json();
      if (j.error) throw new Error(`Bugzilla: ${j.message}`);
      j.bugs.forEach(b => ids.add(b.id));
      if (j.bugs.length < 500) break;
    }
  }
  const out = [], list = [...ids], since = new Date((startSec - 60 * 86400) * 1000).toISOString();
  for (let i = 0; i < list.length; i += 50) {
    const [first, ...rest] = list.slice(i, i + 50);
    const q = new URLSearchParams({ new_since: since });
    rest.forEach(id => q.append('ids', String(id)));
    ctx.log(`Bugzilla needinfo: reading flag history, bugs ${i + 1}-${Math.min(i + 50, list.length)} of ${list.length}`);
    const j = await (await request('bugzilla', `${base}/rest/bug/${first}/history?${q}`, { headers }, ctx)).json();
    if (j.error) throw new Error(`Bugzilla: ${j.message}`);
    out.push(...parseNeedinfoHistory(j.bugs, mapped));
  }
  return out;
}

// bugs: Bugzilla history response ([{id, history: [{when, who, changes}]}]); mapped: Set of lower-case emails.
export function parseNeedinfoHistory(bugs, mapped) {
  const out = [];
  for (const b of bugs) {
    const open = {};
    for (const h of [...b.history].sort((a, c) => a.when.localeCompare(c.when))) {
      for (const c of h.changes) {
        if (c.field_name !== 'flagtypes.name') continue;
        for (const tok of flagTokens(c.removed)) {
          const req = NI.exec(tok)?.[1]?.toLowerCase();
          if (!req || !mapped.has(req)) continue;
          let item = open[req]?.shift();
          if (!item) { item = { bug: b.id, requestee: req, setAt: null }; out.push(item); }
          item.clearedAt = h.when;
          item.clearedBy = (h.who || '').toLowerCase() === req ? 'self' : 'other';
        }
        for (const tok of flagTokens(c.added)) {
          const req = NI.exec(tok)?.[1]?.toLowerCase();
          if (!req || !mapped.has(req)) continue;
          const item = { bug: b.id, requestee: req, setAt: h.when, clearedAt: null, clearedBy: null };
          out.push(item);
          (open[req] ||= []).push(item);
        }
      }
    }
  }
  return out;
}

// ---------- GitHub ----------
function nextLink(r) {
  const m = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('Link') || '');
  return m && m[1];
}
async function ghAll(settings, keys, path, ctx) {
  const headers = { Accept: 'application/vnd.github+json', ...(keys.github ? { Authorization: `Bearer ${keys.github}` } : {}) };
  const out = [];
  let url = `${trimSlash(settings.githubUrl)}${path}`;
  while (url) {
    const r = await request('github', url, { headers }, ctx);
    if (r.status === 403 && r.headers.get('X-RateLimit-Remaining') === '0') {
      const reset = new Date(Number(r.headers.get('X-RateLimit-Reset')) * 1000);
      throw new Error(`GitHub rate limit reached; resets at ${reset.toLocaleTimeString()}${keys.github ? '' : '. Adding a token raises the limit.'}`);
    }
    if (!r.ok) throw new Error(`GitHub ${path}: HTTP ${r.status}`);
    out.push(...await r.json());
    url = nextLink(r);
  }
  return out;
}
const numFromUrl = u => Number((u || '').split('/').pop());

// Kinds: issue-opened, pr-opened, comment (on own issue/PR), reply (on someone else's), review-comment.
export async function fetchGitHub(settings, keys, people, startSec, ctx) {
  const logins = new Set(people.map(p => (p.github || '').toLowerCase()).filter(Boolean));
  const loginsKey = [...logins].sort().join(',');
  const cache = (await cacheGet('github')) || { repos: {} };
  const reqStart = Math.floor(Date.now() / 1000);
  for (const repo of settings.specRepos) {
    const prev = cache.repos[repo];
    const incremental = prev && prev.loginsKey === loginsKey && prev.fetchedFrom <= startSec;
    const since = new Date((incremental ? Math.max(startSec, prev.fetchedAt - 3600) : startSec) * 1000).toISOString();
    ctx.log(`GitHub: ${repo} since ${since.slice(0, 10)}`);
    const sinceQ = `since=${encodeURIComponent(since)}&per_page=100`;
    const issues = await ghAll(settings, keys, `/repos/${repo}/issues?state=all&${sinceQ}`, ctx);
    const comments = await ghAll(settings, keys, `/repos/${repo}/issues/comments?${sinceQ}`, ctx);
    const reviewComments = await ghAll(settings, keys, `/repos/${repo}/pulls/comments?${sinceQ}`, ctx);

    // Issue authors are used only to classify comment vs reply, then discarded.
    const author = new Map(issues.map(i => [i.number, (i.user?.login || '').toLowerCase()]));
    const events = new Map((incremental ? prev.events : []).map(e => [e.key, e]));
    const add = e => { if (logins.has(e.login)) events.set(e.key, e); };
    for (const i of issues) {
      const login = (i.user?.login || '').toLowerCase();
      add({ key: `i${i.id}`, repo, login, created_at: i.created_at, kind: i.pull_request ? 'pr-opened' : 'issue-opened' });
    }
    for (const c of comments) {
      const login = (c.user?.login || '').toLowerCase();
      const owner = author.get(numFromUrl(c.issue_url));
      add({ key: `c${c.id}`, repo, login, created_at: c.created_at, kind: owner && owner !== login ? 'reply' : 'comment' });
    }
    for (const c of reviewComments) {
      const login = (c.user?.login || '').toLowerCase();
      add({ key: `r${c.id}`, repo, login, created_at: c.created_at, kind: 'review-comment' });
    }
    cache.repos[repo] = { loginsKey, fetchedFrom: incremental ? prev.fetchedFrom : startSec, fetchedAt: reqStart, events: [...events.values()] };
  }
  for (const r of Object.keys(cache.repos)) if (!settings.specRepos.includes(r)) delete cache.repos[r];
  cache.fetchedAt = reqStart;
  await cacheSet('github', cache);
  return cache;
}

// ---------- Cached data, in the shape aggregate() expects ----------
export async function loadCached() {
  const [phab, bugzilla, github] = await Promise.all([cacheGet('phab'), cacheGet('bugzilla'), cacheGet('github')]);
  if (phab && pruneTransactions(phab)) await cacheSet('phab', phab);
  return {
    phab: phab ? { ...phab, revisions: Object.values(phab.revisions) } : null,
    bugzilla: bugzilla || null,
    github: github ? { fetchedAt: github.fetchedAt, events: Object.values(github.repos).flatMap(r => r.events) } : null,
  };
}

// ---------- Connection tests ----------
export async function testConnection(source, settings, keys) {
  const ctx = { calls: {}, log() {} };
  if (source === 'phabricator') {
    const me = await conduit(settings, keys, 'user.whoami', {}, ctx);
    return `Signed in as ${me.userName}`;
  }
  if (source === 'bugzilla') {
    if (!keys.bugzilla) return 'No key set: public bugs only';
    const r = await request('bugzilla', `${trimSlash(settings.bugzillaUrl)}/rest/whoami`, { headers: { 'X-BUGZILLA-API-KEY': keys.bugzilla } }, ctx);
    const j = await r.json();
    if (j.error) throw new Error(j.message);
    return `Signed in as ${j.name}`;
  }
  if (source === 'github') {
    const headers = keys.github ? { Authorization: `Bearer ${keys.github}` } : {};
    const r = await request('github', `${trimSlash(settings.githubUrl)}/${keys.github ? 'user' : 'rate_limit'}`, { headers }, ctx);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return keys.github ? `Signed in as ${j.login}` : `No token: ${j.rate.remaining}/${j.rate.limit} requests left this hour`;
  }
}
