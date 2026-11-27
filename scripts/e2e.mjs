// End-to-end smoke test: loads the unpacked extension into Chrome for Testing (via puppeteer),
// points it at a local mock that speaks the OpenAI and Anthropic Messages APIs, and checks that real tab groups appear.
// Run: npm run e2e   (set HEADFUL=1 to watch)
import http from 'node:http';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { signV4 } from '../src/sigv4.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requests = [];
const inflight = { now: 0, max: 0 };

// The mock groups every numbered tab line by the first path segment of its URL and, like the real
// prompt rule, never starts a new group with a single tab.
const GROUPS = { news: { name: 'News', color: 'red' }, recipes: { name: 'Recipes', color: 'green' }, pillows: { name: 'Pillows', color: 'blue' }, cuscini: { name: 'Cuscini', color: 'purple' }, books: { name: 'Books', color: 'yellow' } };

function cannedPlan(userText) {
  const groups = {};
  for (const [, index, path] of userText.matchAll(/^(\d+)\. ".*?" https?:\/\/[^/]+\/([a-z]+)/gm)) {
    if (!GROUPS[path]) continue;
    (groups[path] ??= { ...GROUPS[path], tabs: [] }).tabs.push(Number(index));
  }
  const keep = (g) => g.tabs.length > 1 || userText.includes(`Existing group ${JSON.stringify(g.name)}`);
  return { groups: Object.values(groups).filter(keep), duplicates: [] };
}

const server = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? '*');
  if (req.method === 'OPTIONS') return res.end();
  if (req.method === 'GET') {
    res.setHeader('content-type', 'text/html');
    return res.end(`<title>${req.url.split('?')[0]}</title><h1>${req.url}</h1>`);
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const payload = JSON.parse(body);
    requests.push({ url: req.url, headers: req.headers, body, payload });
    inflight.max = Math.max(inflight.max, ++inflight.now);
    await new Promise((r) => setTimeout(r, req.url.startsWith('/slow/') ? 2500 : 300));
    inflight.now -= 1;
    if (req.url.startsWith('/broken/')) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: { message: 'mock failure' } }));
    }
    const plan = JSON.stringify(cannedPlan(payload.messages.find((m) => m.role === 'user').content));
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/v1/messages')) return res.end(JSON.stringify({ content: [{ type: 'text', text: plan }], stop_reason: 'end_turn' }));
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '```json\n' + plan + '\n```' } }] }));
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
  const openWindow = async () => {
    const windowId = await ext(async (urls) => (await chrome.windows.create({ url: urls })).id, urls);
    await ext(async (windowId) => {
      for (let i = 0; i < 50; i++) {
        const tabs = await chrome.tabs.query({ windowId });
        if (tabs.every((t) => t.status === 'complete')) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    }, windowId);
    return windowId;
  };
  const windowId = await openWindow();

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

  const EXPECTED_GROUPS = [
    { title: 'News', color: 'red', paths: ['/news/1', '/news/1', '/news/2'] },
    { title: 'Recipes', color: 'green', paths: ['/recipes/pasta', '/recipes/soup'] },
  ];
  assert.deepEqual(await snapshot(windowId), EXPECTED_GROUPS);
  console.log('PASS manual organize created News and Recipes groups from legacy flat settings');

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
  const beforeClick = requests.length;
  await popup.click('#organize');
  await popup.waitForFunction(() => !document.querySelector('#organize').disabled && /^Organized/.test(document.querySelector('#status').textContent));
  assert.equal(requests.length - beforeClick, 1, 'clicking Organize sends one model request');
  await popup.close();
  console.log('PASS popup renders the configured view without errors, and its Organize button runs');

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

  const openAndSettle = async (path) => {
    await ext(async ({ windowId, url }) => chrome.tabs.create({ windowId, url, active: false }), { windowId, url: `${origin}${path}` });
    await new Promise((r) => setTimeout(r, 6000));
  };
  await openAndSettle('/pillows/1');
  assert.equal((await snapshot(windowId)).some((g) => g.title === 'Pillows'), false, 'a lone new tab starts no group');
  await openAndSettle('/pillows/2');
  assert.deepEqual((await snapshot(windowId)).find((g) => g.title === 'Pillows')?.paths, ['/pillows/1', '/pillows/2']);
  console.log('PASS two same-topic tabs opened in separate auto runs end up grouped together');

  const before2 = requests.length;
  const misc = await ext(async ({ windowId, url }) => (await chrome.tabs.create({ windowId, url, active: false })).id, { windowId, url: `${origin}/misc/1` });
  await new Promise((r) => setTimeout(r, 6000));
  await openAndSettle('/cuscini/1');
  await ext(async ({ id, url }) => chrome.tabs.update(id, { url }), { id: misc, url: `${origin}/cuscini/2` });
  await new Promise((r) => setTimeout(r, 6000));
  assert.deepEqual((await snapshot(windowId)).find((g) => g.title === 'Cuscini')?.paths, ['/cuscini/1', '/cuscini/2']);
  console.log('PASS a tab that navigates to a new page in place is grouped with a matching tab');

  const settled = requests.length;
  await ext(async ({ id, url }) => chrome.tabs.update(id, { url }), { id: misc, url: `${origin}/cuscini/2` });
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal(requests.length, settled, 'a reload of a grouped tab sends nothing');
  assert.ok(requests.length - before2 >= 2);

  let autoRuns = requests.length;
  const navigate = (from, to) =>
    ext(async ({ windowId, from, to }) => {
      const tab = (await chrome.tabs.query({ windowId })).find((t) => t.url === from);
      await chrome.tabs.update(tab.id, { url: to });
      for (let i = 0; i < 50 && (await chrome.tabs.get(tab.id)).status !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
    }, { windowId, from: origin + from, to: origin + to });
  await navigate('/news/2', '/books/1');
  await navigate('/pillows/2', '/books/2');
  await navigate('/news/3', '/recipes/cake');
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(requests.length, autoRuns, 'a grouped tab that navigates starts no auto run');
  assert.equal((await ext((windowId) => chrome.runtime.sendMessage({ type: 'organize', windowId }), windowId)).ok, true);
  const regrouped = await snapshot(windowId);
  assert.deepEqual(regrouped.find((g) => g.title === 'Books')?.paths, ['/books/1', '/books/2']);
  assert.deepEqual(regrouped.find((g) => g.title === 'Recipes')?.paths, ['/recipes/cake', '/recipes/pasta', '/recipes/soup']);
  assert.deepEqual(regrouped.find((g) => g.title === 'News')?.paths, ['/news/1', '/news/1']);
  console.log('PASS manual organize moves edited grouped tabs into an existing group or a new one');

  const collapsedState = () => ext(async (windowId) => (await chrome.tabGroups.query({ windowId })).map((g) => g.collapsed), windowId);
  const activeGroupCollapse = await ext(async (windowId) => {
    const group = (await chrome.tabGroups.query({ windowId }))[0];
    const [first] = await chrome.tabs.query({ windowId, groupId: group.id });
    await chrome.tabs.update(first.id, { active: true });
    const outcome = await chrome.tabGroups.update(group.id, { collapsed: true }).then(() => 'ok', (e) => e.message);
    const [active] = await chrome.tabs.query({ windowId, active: true });
    const collapsed = (await chrome.tabGroups.get(group.id)).collapsed;
    await chrome.tabGroups.update(group.id, { collapsed: false });
    return { outcome, collapsed, activeMoved: active.id !== first.id };
  }, windowId);
  console.log('collapsing the active tab group:', activeGroupCollapse);
  const popupTarget = browser.waitForTarget((t) => t.url().endsWith('/popup/popup.html'));
  await ext(({ windowId, url }) => chrome.tabs.create({ windowId, url }), { windowId, url: `chrome-extension://${extensionId}/popup/popup.html` });
  const groupPopup = await (await popupTarget).page();
  await groupPopup.waitForSelector('#collapse-all', { visible: true });
  await groupPopup.click('#collapse-all');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok((await collapsedState()).every(Boolean), 'Collapse all closes every group');
  await groupPopup.click('#expand-all');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok((await collapsedState()).every((c) => !c), 'Expand all opens every group');
  const beforeExtPage = requests.length;
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(requests.length, beforeExtPage, "opening one of Otto's own pages in a tab starts no auto run");
  await groupPopup.close();
  console.log('PASS popup Collapse all and Expand all toggle every group; an extension page tab starts no auto run');

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

  await ext((s) => chrome.storage.local.set({ settings: { ...s, baseUrl: s.baseUrl.replace('/v1', '/slow/v1') } }), settings);
  const getState = () => ext((windowId) => chrome.runtime.sendMessage({ type: 'getState', windowId }), windowId);
  const slowRun = ext((windowId) => chrome.runtime.sendMessage({ type: 'organize', windowId }), windowId);
  await new Promise((r) => setTimeout(r, 1200));
  const during = await getState();
  await slowRun;
  const after = await getState();
  assert.equal(during.spinning, true, 'spinner animates while the model request is in flight');
  assert.equal(after.spinning, false, 'spinner stops when the run ends');
  assert.match(after.activity[0].message, /^Organized \d+ tabs into \d+ groups\.$/);
  const autoEntry = after.activity.find((e) => e.kind === 'incremental' && e.tabs?.some((t) => t.group === 'Cuscini'));
  assert.ok(autoEntry, 'activity log records where each auto-run tab went');
  const popupPage = await browser.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popupPage.waitForSelector('#activity:not([hidden])');
  assert.ok((await popupPage.$$eval('#activity-list .outcome', (els) => els.map((e) => e.textContent))).some((t) => t.endsWith('→ Cuscini')));
  await popupPage.close();
  console.log('PASS toolbar spinner runs during a model request; popup lists recent activity');

  await ext((s) => chrome.storage.local.set({ settings: { ...s, baseUrl: s.baseUrl.replace('/v1', '/broken/v1') } }), settings);
  const failure = await ext((windowId) => chrome.runtime.sendMessage({ type: 'organize', windowId }), windowId);
  assert.equal(failure.ok, false);
  assert.match(failure.message, /HTTP 500.*mock failure/);
  assert.equal(await ext(() => chrome.action.getBadgeText({})), '!');
  console.log(`PASS provider error surfaced: "${failure.message}", badge "!"`);

  const { settings: stored } = await ext(() => chrome.storage.local.get('settings'));
  await ext((s) => chrome.storage.local.set({ settings: s }), { ...stored, autoOrganize: false, staleDays: 2 / 86400 });
  const staleWindow = await openWindow();
  await new Promise((r) => setTimeout(r, 2500));
  const stalePopupTarget = browser.waitForTarget((t) => t.url().endsWith('/popup/popup.html'));
  await ext(({ windowId, url }) => chrome.tabs.create({ windowId, url }), { windowId: staleWindow, url: `chrome-extension://${extensionId}/popup/popup.html` });
  const stalePopup = await (await stalePopupTarget).page();
  await stalePopup.waitForSelector('#stale:not([hidden])');
  const staleTitles = () => stalePopup.$$eval('#stale-list .title', (els) => els.map((e) => e.textContent).sort());
  assert.deepEqual(await staleTitles(), ['/misc/page', '/news/1', '/news/2', '/recipes/pasta', '/recipes/soup']);
  assert.equal(await stalePopup.$eval('#duplicates-count', (el) => el.textContent), '1', 'the duplicate is listed once, under Duplicates only');
  await stalePopup.click('#stale summary h2');
  assert.equal(await stalePopup.$eval('#stale', (el) => el.open), false);
  await stalePopup.waitForFunction(() => localStorage.getItem('panel:stale') === 'closed');
  await stalePopup.reload();
  await stalePopup.waitForSelector('#stale:not([hidden])');
  assert.equal(await stalePopup.$eval('#stale', (el) => el.open), false, 'a collapsed panel stays collapsed');
  await stalePopup.click('#stale summary h2');
  await stalePopup.click('#stale-list li:first-child button');
  await stalePopup.waitForFunction(() => document.querySelectorAll('#stale-list li').length === 4);
  await stalePopup.click('#stale-close-all');
  await stalePopup.waitForFunction(() => document.querySelectorAll('#stale-list li').length === 1);
  assert.deepEqual(await staleTitles(), ['/news/1'], 'with its keeper closed, the leftover duplicate is stale itself');
  const left = await ext(async (windowId) => (await chrome.tabs.query({ windowId })).map((t) => new URL(t.url).pathname + new URL(t.url).search), staleWindow);
  assert.deepEqual(left.sort(), ['/news/1?utm_source=newsletter', '/popup/popup.html']);
  await ext(async (windowId) => chrome.windows.remove(windowId), staleWindow);
  console.log('PASS stale tabs listed oldest first, closable one by one or all at once; panels collapse and remember it');

  const organizeWith = async (provider, config) => {
    await ext((s) => chrome.storage.local.set({ settings: s }), { provider, providers: { [provider]: config }, autoOrganize: false });
    const before = requests.length;
    const windowId = await openWindow();
    const result = await ext((windowId) => chrome.runtime.sendMessage({ type: 'organize', windowId }), windowId);
    assert.equal(result.ok, true, `${provider} organize failed: ${result.message}`);
    assert.deepEqual(await snapshot(windowId), EXPECTED_GROUPS);
    const sentNow = requests.slice(before);
    assert.equal(sentNow.length, 1);
    return sentNow[0];
  };

  const anthropic = await organizeWith('anthropic', { apiKey: 'sk-ant-test', baseUrl: `${origin}/gateway/`, model: 'claude-haiku-5-5' });
  assert.equal(anthropic.url, '/gateway/v1/messages');
  assert.equal(anthropic.headers['x-api-key'], 'sk-ant-test');
  assert.equal(anthropic.headers['anthropic-version'], '2026-10-21');
  assert.equal(anthropic.payload.output_config.format.type, 'json_schema');
  console.log('PASS anthropic via custom base URL hit /gateway/v1/messages with x-api-key and anthropic-version');

  const sigv4 = await organizeWith('bedrock', {
    auth: 'sigv4',
    region: 'eu-central-1',
    baseUrl: `${origin}/anthropic`,
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    sessionToken: 'session-token-example',
  });
  assert.equal(sigv4.url, '/anthropic/v1/messages');
  assert.match(
    sigv4.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/bedrock-mantle\/aws4_request, SignedHeaders=anthropic-version;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
  );
  assert.match(sigv4.headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
  assert.equal(sigv4.headers['x-amz-security-token'], 'session-token-example');
  assert.equal(sigv4.payload.model, 'anthropic.claude-haiku-5-5');
  const resigned = await signV4({
    method: 'POST',
    url: `http://${sigv4.headers.host}${sigv4.url}`,
    headers: { 'anthropic-version': sigv4.headers['anthropic-version'], 'content-type': sigv4.headers['content-type'] },
    body: sigv4.body,
    region: 'eu-central-1',
    service: 'bedrock-mantle',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    sessionToken: 'session-token-example',
    now: new Date(sigv4.headers['x-amz-date'].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')),
  });
  assert.equal(sigv4.headers.authorization, resigned.authorization, 'signature matches the host, headers and body the server received');
  console.log(`PASS bedrock SigV4 request signed: ${sigv4.headers.authorization.slice(0, 96)}...`);

  const bearer = await organizeWith('bedrock', { auth: 'apiKey', apiKey: 'bedrock-api-key', baseUrl: `${origin}/anthropic` });
  assert.equal(bearer.headers.authorization, 'Bearer bedrock-api-key');
  assert.equal(bearer.headers['x-amz-date'], undefined);
  const bedrockPopup = await browser.newPage();
  await bedrockPopup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await bedrockPopup.waitForSelector('#organize', { visible: true });
  assert.equal(await bedrockPopup.$eval('#setup', (el) => el.hidden), true);
  await bedrockPopup.close();
  console.log('PASS bedrock API key mode sends Authorization: Bearer, popup shows the configured view');

  await page.reload();
  await page.waitForSelector('#provider');
  const visibleFields = () => page.$$eval('[data-field]', (rows) => rows.filter((r) => !r.hidden).map((r) => r.dataset.field));
  assert.deepEqual(await visibleFields(), ['region', 'baseUrl', 'auth', 'apiKey', 'model']);
  assert.equal(await page.$eval('#baseUrl', (el) => el.placeholder), 'https://bedrock-mantle.us-east-1.api.aws/anthropic');
  await page.select('#auth', 'sigv4');
  assert.deepEqual(await visibleFields(), ['region', 'baseUrl', 'auth', 'accessKeyId', 'secretAccessKey', 'sessionToken', 'model']);
  await page.select('#provider', 'anthropic');
  assert.deepEqual(await visibleFields(), ['baseUrl', 'apiKey', 'model']);
  assert.deepEqual(await page.$eval('#baseUrl', (el) => [el.value, el.placeholder]), ['', 'https://api.anthropic.com']);
  await page.type('#apiKey', 'sk-ant-saved');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Saved.');
  const saved = (await ext(() => chrome.storage.local.get('settings'))).settings;
  assert.equal(saved.provider, 'anthropic');
  assert.equal(saved.providers.anthropic.apiKey, 'sk-ant-saved');
  assert.equal(saved.providers.bedrock.auth, 'sigv4');
  assert.equal(saved.providers.bedrock.apiKey, 'bedrock-api-key');
  assert.equal(saved.apiKey, undefined);
  console.log('PASS options page shows per-provider fields and saves the nested shape');
} catch (err) {
  failed = true;
  console.error('FAIL', err);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
