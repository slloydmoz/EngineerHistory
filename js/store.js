// All storage is per user, in this browser. Nothing is sent to or stored in Quick.
const SET = 'tdd.settings', KEYS = 'tdd.keys';
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

export const DEFAULT_SETTINGS = {
  bugzillaUrl: 'https://bugzilla.mozilla.org',
  phabricatorUrl: 'https://phabricator.services.mozilla.com',
  githubUrl: 'https://api.github.com',
  specRepos: [],
  botUsernames: [],
  windowMonths: 6,
  phabTxCap: 300,      // max transaction.search calls per fetch; the rest are picked up next time
  phabDelayMs: 300,    // pause between Phabricator calls
  people: [],
};
export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...read(SET, {}) });
export const saveSettings = s => write(SET, s);
export const getKeys = () => read(KEYS, {});
export const saveKeys = k => write(KEYS, k);
export const clearKeys = () => { try { localStorage.removeItem(KEYS); } catch { /* storage unavailable */ } };

// Export never includes keys unless explicitly requested.
export function exportSettings(includeKeys = false) {
  return JSON.stringify({ settings: getSettings(), ...(includeKeys ? { keys: getKeys() } : {}) }, null, 2);
}
export function importSettings(text) {
  const o = JSON.parse(text);
  if (!o.settings && !o.keys) throw new Error('Not a settings export');
  if (o.settings) saveSettings({ ...DEFAULT_SETTINGS, ...o.settings });
  if (o.keys) saveKeys(o.keys);
}

// IndexedDB key-value cache for fetched activity data.
const open = () => new Promise((res, rej) => {
  const r = indexedDB.open('tdd-cache', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const run = async (mode, fn) => {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', mode);
    const q = fn(t.objectStore('kv'));
    t.oncomplete = () => res(q?.result);
    t.onerror = () => rej(t.error);
  });
};
export const cacheGet = k => run('readonly', s => s.get(k)).catch(() => undefined);
export const cacheSet = (k, v) => run('readwrite', s => s.put(v, k)).catch(() => {});
export const cacheClear = () => run('readwrite', s => s.clear()).catch(() => {});

export function parsePeopleCsv(text) {
  const [head, ...rows] = text.trim().split(/\r?\n/).map(l => l.split(',').map(c => c.trim()));
  const cols = head.map(h => h.toLowerCase());
  return rows.filter(r => r.some(Boolean)).map(r => {
    const o = Object.fromEntries(cols.map((c, i) => [c, r[i] || '']));
    return { id: crypto.randomUUID(), name: o.name || '', team: o.team || '', manager: o.manager || '', bugzilla: o.bugzilla || '', phabricator: o.phabricator || '', github: o.github || '' };
  });
}
