// End-to-end smoke test: loads the unpacked extension into Chrome for Testing (via puppeteer),
// points it at a local OpenAI-compatible mock, and checks that real tab groups appear.
// Run: npm run e2e   (set HEADFUL=1 to watch)
import http from 'node:http';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requests = [];
const inflight = { now: 0, max: 0 };

// The mock groups every numbered tab line by the first path segment of its URL.
const GROUPS = { news: { name: 'News', color: 'red' }, recipes: { name: 'Recipes', color: 'green' } };

function cannedPlan(userText) {
  const groups = {};
  for (const [, index, path] of userText.matchAll(/^(\d+)\. ".*?" https?:\/\/[^/]+\/([a-z]+)/gm)) {
    if (!GROUPS[path]) continue;
    (groups[path] ??= { ...GROUPS[path], tabs: [] }).tabs.push(Number(index));
  }
  return { groups: Object.values(groups), duplicates: [] };
}

const server = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') return res.end();
  if (req.method === 'GET') {
    res.setHeader('content-type', 'text/html');
    return res.end(`<title>${req.url.split('?')[0]}</title><h1>${req.url}</h1>`);
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const payload = JSON.parse(body);
    requests.push({ url: req.url, payload });
    inflight.max = Math.max(inflight.max, ++inflight.now);
    await new Promise((r) => setTimeout(r, 300));
    inflight.now -= 1;
    if (req.url.startsWith('/broken/')) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: { message: 'mock failure' } }));
    }
    const user = payload.messages.find((m) => m.role === 'user').content;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '```json\n' + JSON.stringify(cannedPlan(user)) + '\n```' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  pipe: true,
  enableExtensions: [root],
  args: ['--no-first-run', '--no-default-browser-check'],
});

let failed = false;
try {
  const workerTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/src/background.js'), { timeout: 15000 });
  const extensionId = new URL(workerTarget.url()).host;
  console.log(`extension loaded: ${extensionId}`);

  // An extension page gives us chrome.* APIs and a sender the service worker answers.
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  const ext = (fn, ...args) => page.evaluate(fn, ...args);

  const settings = { provider: 'openai', baseUrl: `${origin}/v1`, apiKey: '', model: 'mock-model', sendFullUrls: false, maxGroups: 8, autoOrganize: false };
  await ext((s) => chrome.storage.local.set({ settings: s }), settings);

  const urls = ['/news/1', '/recipes/pasta', '/news/2', '/recipes/soup', '/news/1?utm_source=newsletter#top', '/misc/page'].map((p) => origin + p);
  const windowId = await ext(async (urls) => (await chrome.windows.create({ url: urls })).id, urls);
  await ext(async (windowId) => {
    for (let i = 0; i < 50; i++) {
      const tabs = await chrome.tabs.query({ windowId });
      if (tabs.every((t) => t.status === 'complete')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, windowId);

  const result = await ext((windowId) => chrome.runtime.sendMessage({ type: 'organize', windowId }), windowId);
  console.log('organize result:', result.message);
  assert.equal(result.ok, true, `organize failed: ${result.message}`);

  const snapshot = (windowId) =>
    ext(async (windowId) => {
      const groups = await chrome.tabGroups.query({ windowId });
      const tabs = await chrome.tabs.query({ windowId });
      return groups
        .map((g) => ({ title: g.title, color: g.color, paths: tabs.filter((t) => t.groupId === g.id).map((t) => new URL(t.url).pathname).sort() }))
        .sort((a, b) => a.title.localeCompare(b.title));
    }, windowId);

  assert.deepEqual(await snapshot(windowId), [
    { title: 'News', color: 'red', paths: ['/news/1', '/news/1', '/news/2'] },
    { title: 'Recipes', color: 'green', paths: ['/recipes/pasta', '/recipes/soup'] },
  ]);
  console.log('PASS manual organize created News and Recipes groups');

  const sent = requests.at(-1).payload.messages.find((m) => m.role === 'user').content;
  assert.ok(!sent.includes('utm_source'), 'query strings are not sent by default');
  console.log('PASS query strings stripped from prompt');

  const state = await ext((windowId) => chrome.runtime.sendMessage({ type: 'getState', windowId }), windowId);
  assert.deepEqual(
    state.duplicates.map((d) => d.close.map((t) => new URL(t.url).pathname + new URL(t.url).search)),
    [['/news/1?utm_source=newsletter']],
  );
  assert.equal(await ext(() => chrome.action.getBadgeText({})), '1');
  console.log('PASS exact duplicate detected, badge shows 1');

  const popup = await browser.newPage();
  const popupErrors = [];
  popup.on('pageerror', (err) => popupErrors.push(err.message));
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForSelector('#organize', { visible: true });
  assert.deepEqual(popupErrors, []);
  assert.equal(await popup.$eval('#setup', (el) => el.hidden), true);
  await popup.close();
  console.log('PASS popup renders the configured view without errors');

  await ext((s) => chrome.storage.local.set({ settings: { ...s, autoOrganize: true } }), settings);
  const before = requests.length;
  await ext(async ({ windowId, url }) => chrome.tabs.create({ windowId, url, active: false }), { windowId, url: `${origin}/news/3` });
  await new Promise((r) => setTimeout(r, 6000));
  const incremental = requests.slice(before);
  assert.equal(incremental.length, 1, `expected one debounced auto run, got ${incremental.length}`);
  assert.match(incremental[0].payload.messages[1].content, /Existing group "News"/);
  const afterAuto = await snapshot(windowId);
  assert.deepEqual(afterAuto.find((g) => g.title === 'News').paths, ['/news/1', '/news/1', '/news/2', '/news/3']);
  assert.equal(afterAuto.length, 2, 'auto run reused the existing group');
  console.log('PASS auto-organize placed the new tab into the existing News group');

  const beforeBurst = requests.length;
  inflight.max = 0;
  const burst = await ext(
    (windowId) => Promise.all([1, 2, 3].map(() => chrome.runtime.sendMessage({ type: 'organize', windowId }))),
    windowId,
  );
  assert.deepEqual(burst.map((r) => r.ok), [true, true, true]);
  assert.equal(inflight.max, 1, 'runs for one window never overlap');
  assert.equal(requests.length - beforeBurst, 2, 'three requests collapse into one run plus one queued run');
  console.log('PASS concurrent organize requests serialized: 1 run + 1 queued');

  await ext((s) => chrome.storage.local.set({ settings: { ...s, baseUrl: s.baseUrl.replace('/v1', '/broken/v1') } }), settings);
  const failure = await ext((windowId) => chrome.runtime.sendMessage({ type: 'organize', windowId }), windowId);
  assert.equal(failure.ok, false);
  assert.match(failure.message, /HTTP 500.*mock failure/);
  assert.equal(await ext(() => chrome.action.getBadgeText({})), '!');
  console.log(`PASS provider error surfaced: "${failure.message}", badge "!"`);
} catch (err) {
  failed = true;
  console.error('FAIL', err);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
