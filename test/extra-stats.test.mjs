import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, reviewMatrix, median, sumStats } from '../js/aggregate.js';
import { parseNeedinfoHistory } from '../js/fetchers.js';

const H = 3600, D = 86400;
const T0 = Date.parse('2026-05-01T00:00:00Z') / 1000;
const win = { start: Date.parse('2026-04-01T00:00:00Z') / 1000, end: Date.parse('2026-09-30T23:59:59Z') / 1000 };
const people = [
  { id: 'a', name: 'Alex', team: 'Graphics', phabricator: 'alex', bugzilla: 'alex@example.com' },
  { id: 'b', name: 'Bo', team: 'Graphics', phabricator: 'bo' },
  { id: 'c', name: 'Cam', team: 'DOM', phabricator: 'cam' },
  { id: 'x', name: 'Xan', team: 'DOM', phabricator: 'xan' },
];
const users = { alex: 'PHID-A', bo: 'PHID-B', cam: 'PHID-C', xan: 'PHID-X' };
const tx = (type, authorPHID, at, extra = {}) => ({ type, authorPHID, dateCreated: at, ...extra });

const data = {
  phab: {
    users,
    revisions: [
      { id: 1, authorPHID: 'PHID-X', status: 'published', dateCreated: T0, dateModified: T0 + 3 * D },
      { id: 2, authorPHID: 'PHID-OUT', status: 'needs-review', dateCreated: T0, dateModified: T0 + D },
    ],
    transactions: {
      1: { items: [
        tx('reviewers', 'PHID-X', T0, { added: ['PHID-A', 'PHID-B', 'PHID-C'], removed: [] }),
        tx('comment', 'PHID-A', T0 + 2 * H),                        // Alex answers round 1 after 2h
        tx('request-review', 'PHID-X', T0 + D),                     // author asks again: new round for Alex and Cam
        tx('request-review', 'PHID-X', T0 + D + H),                 // asked again before an answer: clock not restarted
        tx('accept', 'PHID-A', T0 + D + 5 * H),                     // Alex answers round 2 after 5h
        tx('reviewers', 'PHID-X', T0 + 2 * D, { added: [], removed: ['PHID-C'] }), // Cam removed: not counted
        // Bo never responds: round 1 stays open; Bo is not asked again since the open round continues.
      ] },
      2: { items: [
        tx('reviewers', 'PHID-OUT', T0, { added: ['PHID-A'], removed: [] }),
        tx('inline', 'PHID-A', T0 + 3 * D),
      ] },
    },
  },
  bugzilla: { needinfo: [
    { requestee: 'alex@example.com', setAt: '2026-05-01T00:00:00Z', clearedAt: '2026-05-02T00:00:00Z', clearedBy: 'self' },
    { requestee: 'alex@example.com', setAt: '2026-05-03T00:00:00Z', clearedAt: '2026-05-04T00:00:00Z', clearedBy: 'other' },
    { requestee: 'alex@example.com', setAt: '2026-05-05T00:00:00Z', clearedAt: null, clearedBy: null },
    { requestee: 'alex@example.com', setAt: null, clearedAt: '2026-04-02T00:00:00Z', clearedBy: 'self' },  // set before history window
    { requestee: 'alex@example.com', setAt: '2026-01-01T00:00:00Z', clearedAt: '2026-01-02T00:00:00Z', clearedBy: 'self' }, // outside window
  ] },
};
const stats = aggregate(people, data, win);

test('review turnaround: rounds start on add or re-request and end at the next submission', () => {
  const r = stats.a.reviews;
  assert.equal(r.requests, 3);           // D1 round 1, D1 round 2, D2
  assert.equal(r.answered, 3);
  assert.deepEqual([...r.turnaroundSecs].sort((x, y) => x - y), [2 * H, 5 * H, 3 * D]);
  assert.equal(median(r.turnaroundSecs), 5 * H);
});

test('unanswered requests count as requests only; removed reviewers are not counted', () => {
  assert.equal(stats.b.reviews.requests, 1);
  assert.equal(stats.b.reviews.answered, 0);
  assert.equal(stats.c.reviews.requests, 0);
});

test('pooled median across people', () => {
  assert.equal(median(sumStats([stats.a, stats.b]).reviews.turnaroundSecs), 5 * H);
  assert.equal(median([]), null);
});

test('cross-team matrix by reviewer team and author team', () => {
  const m = reviewMatrix(people.filter(p => p.team === 'Graphics'), people, data, win);
  assert.deepEqual(m.rows, ['Graphics']);
  assert.deepEqual(m.cols, ['DOM', 'Not in roster']);
  assert.deepEqual(m.cells.Graphics, { DOM: 2, 'Not in roster': 1 });
});

test('needinfo stats', () => {
  const n = stats.a.needinfo;
  assert.equal(n.received, 3);
  assert.equal(n.answered, 2);
  assert.equal(n.clearedByOthers, 1);
  assert.equal(n.open, 1);
  assert.deepEqual(n.answerSecs, [D]);   // the request with no set time has no duration
});

test('needinfo history parsing', () => {
  const me = 'alex@example.com', other = 'someone@example.com';
  const bugs = [{ id: 7, history: [
    { when: '2026-05-04T00:00:00Z', who: other, changes: [{ field_name: 'flagtypes.name', removed: `needinfo?(${me})`, added: '' }] },
    { when: '2026-05-01T00:00:00Z', who: other, changes: [{ field_name: 'flagtypes.name', removed: '', added: `needinfo?(${me}), review+` }] },
    { when: '2026-05-02T00:00:00Z', who: 'Alex@Example.com', changes: [{ field_name: 'flagtypes.name', removed: `needinfo?(${me})`, added: '' }] },
    { when: '2026-05-03T00:00:00Z', who: other, changes: [{ field_name: 'flagtypes.name', removed: '', added: `needinfo?(${me}), needinfo?(${other})` }] },
    { when: '2026-05-05T00:00:00Z', who: other, changes: [{ field_name: 'flagtypes.name', removed: '', added: `needinfo?(${me})` }, { field_name: 'status', removed: 'NEW', added: 'ASSIGNED' }] },
    { when: '2026-04-01T00:00:00Z', who: me, changes: [{ field_name: 'cc', removed: '', added: me }] },
  ] }];
  assert.deepEqual(parseNeedinfoHistory(bugs, new Set([me])), [
    { bug: 7, requestee: me, setAt: '2026-05-01T00:00:00Z', clearedAt: '2026-05-02T00:00:00Z', clearedBy: 'self' },
    { bug: 7, requestee: me, setAt: '2026-05-03T00:00:00Z', clearedAt: '2026-05-04T00:00:00Z', clearedBy: 'other' },
    { bug: 7, requestee: me, setAt: '2026-05-05T00:00:00Z', clearedAt: null, clearedBy: null },
  ]);
});
