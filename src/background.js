import {
  PLAN_SCHEMA,
  buildFullPrompt,
  buildIncrementalPrompt,
  parsePlan,
  findExactDuplicateClusters,
  resolveDuplicates,
} from './plan.js';
import { complete } from './llm.js';
import { applyPlan } from './apply.js';
import { loadSettings, isConfigured } from './settings.js';

const DEBOUNCE_MS = 3000;
const SAMPLES_PER_GROUP = 3;
const BLANK_URL = /^(chrome:\/\/(newtab|new-tab-page)\/?|about:blank|chrome-search:\/\/)/;

// Tabs created but not yet loaded with real content, and loaded tabs waiting for the next auto run.
const pendingTabs = new Set();
const freshTabs = new Map();
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
  const fresh = freshTabs.get(windowId) ?? new Set();
  freshTabs.delete(windowId);
  const newTabs = tabs.filter((t) => fresh.has(t.id) && t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);
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

    const raw = await complete(settings, { system: prompt.system, user: prompt.user, schema: PLAN_SCHEMA });
    const plan = parsePlan(raw, prompt);

    const assigned = new Set(plan.groups.flatMap((g) => g.tabIds));
    const ungroupTabIds =
      kind === 'full' ? tabs.filter((t) => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !assigned.has(t.id)).map((t) => t.id) : [];
    const applied = await applyPlan(windowId, plan, { existingGroups: groups, ungroupTabIds });

    await chrome.storage.session.set({ [`llmDuplicates:${windowId}`]: plan.duplicateClusters });
    const duplicates = await duplicatesFor(windowId);
    const closable = duplicates.reduce((n, d) => n + d.close.length, 0);
    const summary =
      kind === 'full'
        ? `Organized ${applied.moved} tabs into ${plan.groups.length} groups.`
        : applied.moved
          ? `Placed ${applied.moved} new tab${applied.moved === 1 ? '' : 's'}.`
          : 'New tabs left ungrouped.';
    return await finish(windowId, { ok: true, message: summary, duplicateCount: closable });
  } catch (err) {
    return await finish(windowId, { ok: false, message: err?.message || String(err) });
  }
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

async function duplicatesFor(windowId) {
  const tabs = await chrome.tabs.query({ windowId, pinned: false });
  const key = `llmDuplicates:${windowId}`;
  const { [key]: llmClusters = [] } = await chrome.storage.session.get(key);
  const resolved = resolveDuplicates([...findExactDuplicateClusters(tabs), ...llmClusters], tabs);
  const byId = new Map(tabs.map((t) => [t.id, { id: t.id, title: t.title, url: t.url }]));
  return resolved.map((d) => ({ keep: byId.get(d.keep), close: d.close.map((id) => byId.get(id)) }));
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

chrome.tabs.onCreated.addListener((tab) => pendingTabs.add(tab.id));

chrome.tabs.onRemoved.addListener((tabId) => pendingTabs.delete(tabId));

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !pendingTabs.has(tabId) || BLANK_URL.test(tab.url ?? '')) return;
  pendingTabs.delete(tabId);
  if (tab.pinned) return;
  const settings = await loadSettings();
  if (!settings.autoOrganize || !isConfigured(settings)) return;
  const fresh = freshTabs.get(tab.windowId) ?? new Set();
  fresh.add(tabId);
  freshTabs.set(tab.windowId, fresh);
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
      lastResult,
      duplicates: await duplicatesFor(windowId),
    };
  },
  closeTabs: async ({ windowId, tabIds }) => {
    await chrome.tabs.remove(tabIds);
    const duplicates = await duplicatesFor(windowId);
    const count = duplicates.reduce((n, d) => n + d.close.length, 0);
    if ((await chrome.action.getBadgeText({})) !== '!') await chrome.action.setBadgeText({ text: count ? String(count) : '' });
    return { duplicates };
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
