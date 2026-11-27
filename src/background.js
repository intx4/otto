import {
  PLAN_SCHEMA,
  buildFullPrompt,
  buildIncrementalPrompt,
  parsePlan,
  findExactDuplicateClusters,
  findStaleTabs,
  resolveDuplicates,
} from './plan.js';
import { complete } from './llm.js';
import { applyPlan } from './apply.js';
import { loadSettings, isConfigured } from './settings.js';

const DEBOUNCE_MS = 3000;
const SAMPLES_PER_GROUP = 3;
const MAX_UNGROUPED = 40;
// Auto runs only consider web pages; new tab, chrome:// and extension pages (Otto's own included) stay put.
const WEB_URL = /^(https?|file):/;

const ACTIVITY_LIMIT = 20;
const SPINNER_COLOR = '#77dd77';

const debounceTimers = new Map();

// Per-window run lock. A request arriving while a run is in flight is queued once;
// a queued incremental run is upgraded to full if a full run is requested.
const RUN_RANK = { incremental: 0, full: 1 };
const runners = new Map();

function requestRun(windowId, kind) {
  const runner = runners.get(windowId);
  if (!runner) {
    const current = execute(windowId, kind).finally(() => drain(windowId));
    runners.set(windowId, { current, next: null });
    return current;
  }
  if (!runner.next) {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    runner.next = { kind, promise, resolve };
  } else if (RUN_RANK[kind] > RUN_RANK[runner.next.kind]) {
    runner.next.kind = kind;
  }
  return runner.next.promise;
}

function drain(windowId) {
  const runner = runners.get(windowId);
  if (!runner.next) {
    runners.delete(windowId);
    return;
  }
  const { kind, resolve } = runner.next;
  runner.next = null;
  runner.current = execute(windowId, kind).finally(() => drain(windowId));
  resolve(runner.current);
}

function prepare(kind, windowId, tabs, groups, settings) {
  const options = { maxGroups: Number(settings.maxGroups) || 0, sendFullUrls: settings.sendFullUrls };
  if (kind === 'full') {
    return { tabsToSend: tabs, prompt: buildFullPrompt({ ...options, tabs, existingGroupTitles: groups.map((g) => g.title) }) };
  }
  // Every ungrouped tab is a candidate, so a tab can start a group with one that loaded in an earlier run.
  const newTabs = tabs
    .filter((t) => t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE && WEB_URL.test(t.url ?? ''))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .slice(0, MAX_UNGROUPED);
  const withSamples = groups.map((g) => ({ title: g.title, samples: tabs.filter((t) => t.groupId === g.id).slice(0, SAMPLES_PER_GROUP) }));
  return { tabsToSend: newTabs, prompt: buildIncrementalPrompt({ ...options, newTabs, groups: withSamples }) };
}

async function execute(windowId, kind) {
  try {
    const settings = await loadSettings();
    if (!isConfigured(settings)) return await finish(windowId, { ok: false, message: 'Set up a provider and API key in Options first.' });

    const tabs = await chrome.tabs.query({ windowId, pinned: false });
    const groups = await chrome.tabGroups.query({ windowId });
    const { tabsToSend, prompt } = prepare(kind, windowId, tabs, groups, settings);
    if (tabsToSend.length === 0) return { ok: true, message: 'Nothing new to organize.', skipped: true };
    // Skip an auto run when the ungrouped tabs are exactly the ones the model already declined to group.
    const sentKey = `lastSent:${windowId}`;
    const signature = tabsToSend.map((t) => `${t.id} ${t.url}`).sort().join('\n');
    if (kind === 'incremental' && (await chrome.storage.session.get(sentKey))[sentKey] === signature) {
      await logActivity({ kind, message: 'Skipped: the ungrouped tabs have not changed since the last run.' });
      return { ok: true, message: 'Nothing new to organize.', skipped: true };
    }

    const { plan, applied } = await withSpinner(async () => {
      const raw = await complete(settings, { system: prompt.system, user: prompt.user, schema: PLAN_SCHEMA });
      const plan = parsePlan(raw, prompt);
      const assigned = new Set(plan.groups.flatMap((g) => g.tabIds));
      const ungroupTabIds =
        kind === 'full' ? tabs.filter((t) => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !assigned.has(t.id)).map((t) => t.id) : [];
      return { plan, applied: await applyPlan(windowId, plan, { existingGroups: groups, ungroupTabIds }) };
    });
    await chrome.storage.session.set({ [sentKey]: signature });
    const groupOf = new Map(plan.groups.flatMap((g) => g.tabIds.map((id) => [id, g.name])));
    const outcomes = tabsToSend.map((t) => ({ title: t.title || t.url, group: groupOf.get(t.id) ?? null }));

    await chrome.storage.session.set({ [`llmDuplicates:${windowId}`]: plan.duplicateClusters });
    const { duplicates } = await cleanupFor(windowId);
    const closable = duplicates.reduce((n, d) => n + d.close.length, 0);
    const summary =
      kind === 'full'
        ? `Organized ${applied.moved} tabs into ${plan.groups.length} groups.`
        : applied.moved
          ? `Placed ${applied.moved} new tab${applied.moved === 1 ? '' : 's'}.`
          : 'New tabs left ungrouped.';
    await logActivity({ kind, message: summary, tabs: outcomes });
    return await finish(windowId, { ok: true, message: summary, duplicateCount: closable });
  } catch (err) {
    const message = err?.message || String(err);
    await logActivity({ kind, message: `Failed: ${message}` });
    return await finish(windowId, { ok: false, message });
  }
}

async function logActivity(entry) {
  const { activity = [] } = await chrome.storage.session.get('activity');
  await chrome.storage.session.set({ activity: [{ ...entry, at: Date.now() }, ...activity].slice(0, ACTIVITY_LIMIT) });
}

// Toolbar spinner: the icon dims and a rotating arc is drawn over it while any model request is in flight.
let spinning = 0;
let spinTimer = null;
let iconBitmap = null;

async function withSpinner(work) {
  spinning += 1;
  if (spinning === 1) startSpinner();
  try {
    return await work();
  } finally {
    spinning -= 1;
    if (spinning === 0) {
      clearInterval(spinTimer);
      spinTimer = null;
      await chrome.action.setIcon({ path: { 16: '/icons/icon16.png', 32: '/icons/icon32.png' } });
    }
  }
}

async function startSpinner() {
  try {
    iconBitmap ??= await createImageBitmap(await (await fetch(chrome.runtime.getURL('icons/icon32.png'))).blob());
  } catch {
    return;
  }
  if (spinning === 0 || spinTimer) return;
  let frame = 0;
  drawSpinnerFrame(frame);
  spinTimer = setInterval(() => drawSpinnerFrame(++frame), 100);
}

function drawSpinnerFrame(frame) {
  const imageData = {};
  for (const size of [16, 32]) {
    const ctx = new OffscreenCanvas(size, size).getContext('2d');
    ctx.globalAlpha = 0.35;
    ctx.drawImage(iconBitmap, 0, 0, size, size);
    ctx.globalAlpha = 1;
    const start = (frame * Math.PI) / 5;
    ctx.lineWidth = size / 7;
    ctx.lineCap = 'round';
    ctx.strokeStyle = SPINNER_COLOR;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - ctx.lineWidth, start, start + Math.PI * 1.4);
    ctx.stroke();
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  chrome.action.setIcon({ imageData }).catch(() => {});
}

async function finish(windowId, result) {
  const stamped = { ...result, at: Date.now() };
  await chrome.storage.session.set({ [`lastResult:${windowId}`]: stamped });
  if (result.ok) {
    await chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
    await chrome.action.setBadgeText({ text: result.duplicateCount ? String(result.duplicateCount) : '' });
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    await chrome.action.setBadgeText({ text: '!' });
  }
  return stamped;
}

// Tabs Otto proposes to close in a window: duplicates of another tab, then stale tabs not already listed as duplicates.
async function cleanupFor(windowId) {
  const [tabs, settings] = await Promise.all([chrome.tabs.query({ windowId, pinned: false }), loadSettings()]);
  const key = `llmDuplicates:${windowId}`;
  const { [key]: llmClusters = [] } = await chrome.storage.session.get(key);
  const resolved = resolveDuplicates([...findExactDuplicateClusters(tabs), ...llmClusters], tabs);
  const byId = new Map(tabs.map((t) => [t.id, { id: t.id, title: t.title, url: t.url }]));
  const duplicates = resolved.map((d) => ({ keep: byId.get(d.keep), close: d.close.map((id) => byId.get(id)) }));
  const closing = new Set(resolved.flatMap((d) => d.close));
  const stale = findStaleTabs(tabs, { days: Number(settings.staleDays) || 0, now: Date.now() })
    .filter((t) => !closing.has(t.id))
    .map((t) => ({ ...byId.get(t.id), lastAccessed: t.lastAccessed }));
  return { duplicates, stale };
}

function scheduleAuto(windowId) {
  clearTimeout(debounceTimers.get(windowId));
  debounceTimers.set(
    windowId,
    setTimeout(() => {
      debounceTimers.delete(windowId);
      requestRun(windowId, 'incremental');
    }, DEBOUNCE_MS),
  );
}

// Stateless trigger: any ungrouped tab finishing a page load schedules an auto run for its window.
// Holding no per-tab state means nothing is lost when Chrome stops the idle service worker.
chrome.tabs.onUpdated.addListener(async (_tabId, info, tab) => {
  if (info.status !== 'complete' || tab.pinned || tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE || !WEB_URL.test(tab.url ?? '')) return;
  const settings = await loadSettings();
  if (!settings.autoOrganize || !isConfigured(settings)) return;
  scheduleAuto(tab.windowId);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'organize-window') return;
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  requestRun(win.id, 'full');
});

const HANDLERS = {
  organize: ({ windowId }) => requestRun(windowId, 'full'),
  getState: async ({ windowId }) => {
    const settings = await loadSettings();
    const key = `lastResult:${windowId}`;
    const { [key]: lastResult = null } = await chrome.storage.session.get(key);
    return {
      configured: isConfigured(settings),
      autoOrganize: settings.autoOrganize,
      running: runners.has(windowId),
      spinning: spinTimer !== null,
      activity: (await chrome.storage.session.get('activity')).activity ?? [],
      lastResult,
      ...(await cleanupFor(windowId)),
    };
  },
  closeTabs: async ({ windowId, tabIds }) => {
    await chrome.tabs.remove(tabIds);
    const cleanup = await cleanupFor(windowId);
    const count = cleanup.duplicates.reduce((n, d) => n + d.close.length, 0);
    if ((await chrome.action.getBadgeText({})) !== '!') await chrome.action.setBadgeText({ text: count ? String(count) : '' });
    return cleanup;
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message))
    .then(sendResponse, (err) => sendResponse({ ok: false, message: err?.message || String(err) }));
  return true;
});
