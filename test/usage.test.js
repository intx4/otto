import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, summarize, dayKey } from '../src/usage.js';

const at = (iso) => new Date(iso).getTime();
const u = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

test('addUsage sums calls and tokens per day, provider and model', () => {
  let b = {};
  b = addUsage(b, { at: at('2026-11-20T09:00:00'), provider: 'bedrock', model: 'haiku', usage: u(100, 20) });
  b = addUsage(b, { at: at('2026-11-20T18:00:00'), provider: 'bedrock', model: 'haiku', usage: u(50, 10, 5) });
  b = addUsage(b, { at: at('2026-11-21T09:00:00'), provider: 'openai', model: 'gpt', usage: u(7, 3) });
  assert.deepEqual(b, {
    '2026-11-20|bedrock|haiku': { calls: 2, input: 150, output: 30, cacheRead: 5, cacheWrite: 0 },
    '2026-11-21|openai|gpt': { calls: 1, input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
  });
});

test('addUsage drops days older than 400 days', () => {
  const b = addUsage({ '2025-01-01|openai|gpt': { calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }, { at: at('2026-11-27T10:00:00'), provider: 'openai', model: 'gpt', usage: u(1, 1) });
  assert.deepEqual(Object.keys(b), ['2026-11-27|openai|gpt']);
});

test('summarize returns totals, models by size, and every day of the period', () => {
  const b = {
    '2026-11-10|openai|gpt': { calls: 9, input: 900, output: 90, cacheRead: 0, cacheWrite: 0 },
    '2026-11-25|bedrock|haiku': { calls: 2, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    '2026-11-27|bedrock|haiku': { calls: 1, input: 10, output: 2, cacheRead: 4, cacheWrite: 0 },
    '2026-11-27|anthropic|sonnet': { calls: 1, input: 300, output: 40, cacheRead: 0, cacheWrite: 0 },
  };
  const now = at('2026-11-27T15:00:00');
  const week = summarize(b, { days: 3, now });
  assert.deepEqual(week.totals, { calls: 4, input: 410, output: 62, cacheRead: 4, cacheWrite: 0 });
  assert.deepEqual(week.byModel.map((m) => [m.provider, m.model, m.calls]), [['anthropic', 'sonnet', 1], ['bedrock', 'haiku', 3]]);
  assert.deepEqual(week.byDay.map((d) => [d.day, d.calls]), [['2026-11-25', 2], ['2026-11-26', 0], ['2026-11-27', 2]]);
  const all = summarize(b, { days: null, now });
  assert.equal(all.totals.calls, 13);
  assert.equal(all.byDay[0].day, '2026-11-10');
  assert.equal(all.byDay.length, 18);
  assert.equal(dayKey(now), '2026-11-27');
});
