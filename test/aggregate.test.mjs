import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../js/aggregate.js';

const T = iso => Date.parse(iso) / 1000;
const win = { start: T('2026-04-01T00:00:00Z'), end: T('2026-09-30T23:59:59Z') };
const people = [
  { id: 'a', name: 'Alex', phabricator: 'alex', bugzilla: 'alex@example.com', github: 'AlexGH' },
  { id: 'b', name: 'Bo', phabricator: 'bo', bugzilla: 'bo@example.com', github: 'bogh' },
];
const tx = (type, authorPHID, iso, nComments = 0) => ({ type, authorPHID, dateCreated: T(iso), nComments });
const data = {
  phab: {
    users: { alex: 'PHID-A', bo: 'PHID-B', bot: 'PHID-BOT' },
    revisions: [
      { id: 1, authorPHID: 'PHID-X', status: 'published', dateCreated: T('2026-04-02T00:00:00Z'), dateModified: T('2026-05-01T00:00:00Z') },
      { id: 2, authorPHID: 'PHID-A', status: 'published', dateCreated: T('2026-05-03T00:00:00Z'), dateModified: T('2026-06-01T00:00:00Z') },
      { id: 3, authorPHID: 'PHID-X', status: 'needs-review', dateCreated: T('2026-01-01T00:00:00Z'), dateModified: T('2026-07-01T00:00:00Z') },
    ],
    transactions: {
      // Alex reviews D1 three times: requests changes with a comment and two inlines (one submission),
      // then comments only, then accepts with a comment (one submission). Bo also accepts D1.
      1: { items: [
        { ...tx('request-changes', 'PHID-A', '2026-04-03T00:00:00Z'), groupID: 'g1' },
        { ...tx('comment', 'PHID-A', '2026-04-03T00:00:00Z', 1), groupID: 'g1' },
        { ...tx('inline', 'PHID-A', '2026-04-03T00:00:00Z', 1), groupID: 'g1' },
        { ...tx('inline', 'PHID-A', '2026-04-03T00:00:00Z', 1), groupID: 'g1' },
        tx('inline', 'PHID-A', '2026-04-04T00:00:00Z', 2),
        tx('accept', 'PHID-A', '2026-04-10T00:00:00Z'),
        tx('comment', 'PHID-A', '2026-04-10T00:00:00Z', 1), // no groupID: grouped by author + timestamp
        tx('accept', 'PHID-B', '2026-04-11T00:00:00Z'),
        tx(null, 'PHID-B', '2026-04-12T00:00:00Z', 1), // untyped: not counted
        tx('update', 'PHID-X', '2026-04-05T00:00:00Z'),
        tx('comment', 'PHID-BOT', '2026-04-06T00:00:00Z', 1),
      ] },
      // Alex comments on their own revision: not a review. Bo plans changes.
      2: { items: [tx(null, 'PHID-A', '2026-05-04T00:00:00Z', 1), tx('plan-changes', 'PHID-B', '2026-05-05T00:00:00Z')] },
      // Outside the window: not counted.
      3: { items: [tx('accept', 'PHID-B', '2026-02-01T00:00:00Z'), tx('resign', 'PHID-B', '2026-07-01T00:00:00Z')] },
    },
  },
  bugzilla: { bugs: [
    { id: 10, assigned_to: 'alex@example.com', status: 'RESOLVED', resolution: 'FIXED', cf_last_resolved: '2026-05-01T00:00:00Z', groups: [] },
    { id: 11, assigned_to: 'Alex@example.com', status: 'VERIFIED', resolution: 'DUPLICATE', cf_last_resolved: '2026-06-01T00:00:00Z', groups: ['core-security'] },
    { id: 12, assigned_to: 'alex@example.com', status: 'REOPENED', resolution: '', cf_last_resolved: '2026-06-01T00:00:00Z', groups: [] },
    { id: 13, assigned_to: 'bo@example.com', status: 'RESOLVED', resolution: 'FIXED', cf_last_resolved: '2026-03-01T00:00:00Z', groups: [] },
  ] },
  github: { events: [
    { login: 'alexgh', repo: 'whatwg/html', kind: 'reply', created_at: '2026-04-20T00:00:00Z' },
    { login: 'alexgh', repo: 'whatwg/html', kind: 'issue-opened', created_at: '2026-04-21T00:00:00Z' },
    { login: 'bogh', repo: 'w3c/csswg-drafts', kind: 'review-comment', created_at: '2026-10-05T00:00:00Z' },
  ] },
};

const stats = aggregate(people, data, win, new Set(['PHID-BOT']));

test('one submission (state change + comments + inlines) is one event; repeat reviews are separate events but one distinct revision', () => {
  const r = stats.a.reviews;
  assert.equal(r.events, 3);
  assert.equal(r.distinctRevisions, 1);
  assert.deepEqual(r.states, { accepted: 1, needsChanges: 1, changesPlanned: 0, resigned: 0 });
  assert.equal(r.commentOnly, 1);
});

test('each reviewer is credited independently; author comments and out-of-window events excluded', () => {
  const r = stats.b.reviews;
  assert.equal(r.events, 3); // accept D1, plan-changes D2, resign D3
  assert.equal(r.distinctRevisions, 3);
  assert.equal(r.states.changesPlanned, 1);
  assert.equal(r.states.resigned, 1);
});

test('revisions authored and landed', () => {
  assert.equal(stats.a.revisions.authored, 1);
  assert.equal(stats.a.revisions.landed, 1);
});

test('bugs closed: resolved in window, case-insensitive assignee, restricted counted only', () => {
  assert.equal(stats.a.bugs.closed, 2);
  assert.deepEqual(stats.a.bugs.byResolution, { FIXED: 1, DUPLICATE: 1 });
  assert.equal(stats.a.bugs.restricted, 1);
  assert.equal(stats.b.bugs.closed, 0);
});

test('github activity by kind and repo, window applied', () => {
  assert.equal(stats.a.github.total, 2);
  assert.deepEqual(stats.a.github.byKind, { reply: 1, 'issue-opened': 1 });
  assert.equal(stats.b.github.total, 0);
});

test('active months', () => {
  assert.deepEqual(stats.a.activeMonths, ['2026-04', '2026-05', '2026-06']);
});
