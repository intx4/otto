import { saveSettings } from '../src/settings.js';

const $ = (id) => document.getElementById(id);
const CLOSE_ICON = '<svg class="px-icon" viewBox="0 0 7 7" width="14" height="14" aria-hidden="true"><path d="M0 0h1v1h-1zM6 0h1v1h-1zM1 1h1v1h-1zM5 1h1v1h-1zM2 2h1v1h-1zM4 2h1v1h-1zM3 3h1v1h-1zM2 4h1v1h-1zM4 4h1v1h-1zM1 5h1v1h-1zM5 5h1v1h-1zM0 6h1v1h-1zM6 6h1v1h-1z"/></svg>';
const { id: windowId } = await chrome.windows.getCurrent();

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, windowId, ...extra });
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

function showResult(result) {
  if (!result) return setStatus('');
  const dupes = result.duplicateCount ? ` ${result.duplicateCount} duplicate${result.duplicateCount === 1 ? '' : 's'} found.` : '';
  setStatus(result.ok ? `${result.message}${dupes}` : result.message, !result.ok);
}

function tabRow(tab, { tooltip, age }) {
  const li = document.createElement('li');
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = tab.title || tab.url;
  title.title = tooltip;
  li.append(title);
  if (age) {
    const when = document.createElement('span');
    when.className = 'age';
    when.textContent = age;
    li.append(when);
  }
  const button = document.createElement('button');
  button.className = 'ghost icon';
  button.title = 'Close tab';
  button.setAttribute('aria-label', `Close ${tab.title || tab.url}`);
  button.innerHTML = CLOSE_ICON;
  button.addEventListener('click', () => closeTabs([tab.id]));
  li.append(button);
  return li;
}

function renderPanel(id, rows) {
  $(`${id}-list`).replaceChildren(...rows.map(({ tab, ...meta }) => tabRow(tab, meta)));
  $(id).hidden = rows.length === 0;
  $(`${id}-count`).textContent = rows.length;
  $(`${id}-close-all`).onclick = (event) => {
    event.preventDefault();
    closeTabs(rows.map((r) => r.tab.id));
  };
}

function daysAgo(time) {
  const days = Math.floor((Date.now() - time) / 86_400_000);
  return days >= 1 ? `${days}d` : '<1d';
}

function renderCleanup({ duplicates, stale }) {
  renderPanel(
    'duplicates',
    duplicates.flatMap(({ keep, close }) => close.map((tab) => ({ tab, tooltip: `${tab.url}\nKeeping: ${keep.title || keep.url}` }))),
  );
  renderPanel(
    'stale',
    stale.map((tab) => ({ tab, tooltip: `${tab.url}\nLast used ${new Date(tab.lastAccessed).toLocaleString()}`, age: daysAgo(tab.lastAccessed) })),
  );
}

// Each panel remembers whether it was collapsed; storage can be unavailable, so this is best effort.
function rememberOpenState(id) {
  try {
    const saved = localStorage.getItem(`panel:${id}`);
    if (saved !== null) $(id).open = saved === 'open';
  } catch {}
  $(id).addEventListener('toggle', () => {
    try {
      localStorage.setItem(`panel:${id}`, $(id).open ? 'open' : 'closed');
    } catch {}
  });
}

function renderActivity(activity) {
  const list = $('activity-list');
  list.replaceChildren();
  for (const entry of activity) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'entry-head';
    const time = document.createElement('time');
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const kind = document.createElement('span');
    kind.className = 'pill';
    kind.textContent = entry.kind === 'full' ? 'Organize' : 'Auto';
    const message = document.createElement('span');
    message.className = 'message';
    message.textContent = entry.message;
    head.append(time, kind, message);
    li.append(head);
    for (const tab of entry.tabs ?? []) {
      const line = document.createElement('div');
      line.className = 'outcome';
      line.textContent = `${tab.title} → ${tab.group ?? 'left ungrouped'}`;
      li.append(line);
    }
    list.append(li);
  }
  $('activity').hidden = activity.length === 0;
}

async function refresh() {
  const state = await send('getState');
  renderCleanup(state);
  renderActivity(state.activity);
  return state;
}

async function closeTabs(tabIds) {
  renderCleanup(await send('closeTabs', { tabIds }));
}

async function organize() {
  $('organize').disabled = true;
  setStatus('Organizing...');
  try {
    showResult(await send('organize'));
    await refresh();
  } finally {
    $('organize').disabled = false;
  }
}

async function setAllCollapsed(collapsed) {
  const groups = await chrome.tabGroups.query({ windowId });
  await Promise.all(groups.map((g) => chrome.tabGroups.update(g.id, { collapsed }).catch(() => {})));
}

function openOptions(event) {
  event?.preventDefault();
  chrome.runtime.openOptionsPage();
}

const state = await send('getState');
$('setup').hidden = state.configured;
$('main').hidden = !state.configured;
$('auto').checked = state.autoOrganize;
showResult(state.lastResult);
if (state.running) setStatus('Organizing...');
renderCleanup(state);
renderActivity(state.activity);
for (const id of ['duplicates', 'stale', 'activity']) rememberOpenState(id);

const command = (await chrome.commands.getAll()).find((c) => c.name === 'organize-window');
if (command?.shortcut) {
  $('shortcut').textContent = command.shortcut;
  $('shortcut').hidden = false;
}

$('organize').addEventListener('click', organize);
$('collapse-all').addEventListener('click', () => setAllCollapsed(true));
$('expand-all').addEventListener('click', () => setAllCollapsed(false));
$('auto').addEventListener('change', (e) => saveSettings({ autoOrganize: e.target.checked }));
$('options-link').addEventListener('click', openOptions);
$('open-options').addEventListener('click', openOptions);
