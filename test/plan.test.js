import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUrl,
  promptUrl,
  findExactDuplicateClusters,
  resolveDuplicates,
  buildFullPrompt,
  buildIncrementalPrompt,
  parsePlan,
  extractJson, findStaleTabs } from '../src/plan.js';

test('normalizeUrl strips hash, tracking params, trailing slash and lowercases host', () => {
  assert.equal(
    normalizeUrl('https://Example.COM/Docs/Page/?utm_source=x&b=2&fbclid=abc&a=1&gclid=z#section'),
    'https://example.com/Docs/Page?a=1&b=2',
  );
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/a//'), 'https://example.com/a');
  assert.equal(normalizeUrl('http://localhost:3000/x?utm_medium=y'), 'http://localhost:3000/x');
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('promptUrl drops query and hash unless full URLs are allowed', () => {
  const url = 'https://mail.example.com/inbox/42?token=secret#msg';
  assert.equal(promptUrl(url, false), 'https://mail.example.com/inbox/42');
  assert.equal(promptUrl(url, true), url);
  assert.equal(promptUrl('chrome://extensions/?id=abc', false), 'chrome://extensions/');
});

const tabs = [
  { id: 10, url: 'https://news.site/story?utm_source=tw', title: 'Story', lastAccessed: 100 },
  { id: 11, url: 'https://news.site/story/#comments', title: 'Story', lastAccessed: 300 },
  { id: 12, url: 'https://news.site/story', title: 'Story', lastAccessed: 200 },
  { id: 13, url: 'https://other.site/', title: 'Other', lastAccessed: 50 },
  { id: 14, url: 'https://m.other.site/', title: 'Other (mobile)', lastAccessed: 10, active: true },
];

test('findExactDuplicateClusters groups tabs by normalized URL', () => {
  assert.deepEqual(findExactDuplicateClusters(tabs), [[10, 11, 12]]);
});

test('resolveDuplicates keeps the most recently accessed tab', () => {
  assert.deepEqual(resolveDuplicates([[10, 11, 12]], tabs), [{ keep: 11, close: [10, 12] }]);
});

test('resolveDuplicates keeps the active tab and merges overlapping clusters', () => {
  assert.deepEqual(resolveDuplicates([[13, 14], [10, 12], [12, 11], [99, 13]], tabs), [
    { keep: 11, close: [10, 12] },
    { keep: 14, close: [13] },
  ]);
});

test('buildFullPrompt numbers tabs and maps indices back to tab ids', () => {
  const { user, tabIndex, movable } = buildFullPrompt({
    tabs: tabs.slice(0, 2),
    existingGroupTitles: ['News'],
    maxGroups: 5,
    sendFullUrls: false,
  });
  assert.equal(
    user,
    'Existing group names (reuse where they fit): "News"\n\nTabs:\n1. "Story" https://news.site/story\n2. "Story" https://news.site/story/\nUse at most 5 groups in total.',
  );
  assert.deepEqual([...tabIndex], [[1, 10], [2, 11]]);
  assert.deepEqual([...movable], [1, 2]);
});

test('buildIncrementalPrompt only lets new tabs move', () => {
  const { user, tabIndex, movable } = buildIncrementalPrompt({
    newTabs: [{ id: 50, title: 'New', url: 'https://new.site/a?q=1' }],
    groups: [{ title: 'Other', samples: [tabs[3]] }],
    maxGroups: 0,
    sendFullUrls: false,
  });
  assert.equal(
    user,
    'Existing group "Other":\n1. "Other" https://other.site/\n\nUngrouped tabs (only these may be placed in groups; put each in an existing group by its exact name, in a new group with other ungrouped tabs on the same topic, or leave it out):\n2. "New" https://new.site/a',
  );
  assert.deepEqual([...tabIndex], [[1, 13], [2, 50]]);
  assert.deepEqual([...movable], [2]);
});

const context = { tabIndex: new Map([[1, 101], [2, 102], [3, 103], [4, 104]]), movable: new Set([1, 2, 3]) };

test('parsePlan validates groups and duplicates against the index', () => {
  const plan = parsePlan(
    {
      groups: [
        { name: '  Dev  ', color: 'Blue', tabs: [1, '2', 99, 4] },
        { name: 'dev', color: 'red', tabs: [3, 1] },
        { name: 'Empty', color: 'green', tabs: [] },
        { name: 'Bad color', color: 'magenta', tabs: [7] },
        null,
      ],
      duplicates: [{ keep: 4, close: [1, 42] }, { keep: 2, close: [] }, 'junk'],
    },
    context,
  );
  assert.deepEqual(plan, {
    groups: [{ name: 'Dev', color: 'blue', tabIds: [101, 102, 103] }],
    duplicateClusters: [[104, 101]],
  });
});

test('parsePlan coerces bad colors and survives garbage input', () => {
  assert.deepEqual(parsePlan({ groups: [{ name: 'X', color: 'magenta', tabs: [1, 2] }] }, context), {
    groups: [{ name: 'X', color: 'grey', tabIds: [101, 102] }],
    duplicateClusters: [],
  });
  assert.deepEqual(parsePlan('nonsense', context), { groups: [], duplicateClusters: [] });
  assert.deepEqual(parsePlan({ groups: 'x', duplicates: { keep: 1 } }, context), { groups: [], duplicateClusters: [] });
});

test('extractJson tolerates code fences and surrounding prose', () => {
  assert.deepEqual(extractJson('```json\n{"groups":[]}\n```'), { groups: [] });
  assert.deepEqual(extractJson('Sure! Here you go: {"a":1} hope that helps'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
});

test('findStaleTabs lists tabs unused for the threshold, oldest first, never active or pinned ones', () => {
  const day = 86_400_000;
  const now = 100 * day;
  const tabs = [
    { id: 1, lastAccessed: now - 8 * day },
    { id: 2, lastAccessed: now - 2 * day },
    { id: 3, lastAccessed: now - 30 * day },
    { id: 4, lastAccessed: now - 7 * day },
    { id: 5, lastAccessed: now - 40 * day, active: true },
    { id: 6, lastAccessed: now - 40 * day, pinned: true },
    { id: 7 },
  ];
  assert.deepEqual(findStaleTabs(tabs, { days: 7, now }).map((t) => t.id), [3, 1, 4]);
  assert.deepEqual(findStaleTabs(tabs, { days: 0, now }), []);
});
