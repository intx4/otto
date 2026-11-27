import { saveSettings } from '../src/settings.js';

const $ = (id) => document.getElementById(id);
const CLOSE_ICON = '<svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>';
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

function renderDuplicates(duplicates) {
  const list = $('dup-list');
  list.replaceChildren();
  const closeIds = [];
  for (const { keep, close } of duplicates) {
    for (const tab of close) {
      closeIds.push(tab.id);
      const li = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = tab.title || tab.url;
      title.title = `${tab.url}\nKeeping: ${keep.title || keep.url}`;
      const button = document.createElement('button');
      button.className = 'ghost icon';
      button.title = 'Close tab';
      button.setAttribute('aria-label', `Close ${tab.title || tab.url}`);
      button.innerHTML = CLOSE_ICON;
      button.addEventListener('click', () => closeTabs([tab.id]));
      li.append(title, button);
      list.append(li);
    }
  }
  $('duplicates').hidden = closeIds.length === 0;
  $('dup-count').textContent = closeIds.length;
  $('close-all').onclick = () => closeTabs(closeIds);
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
  renderDuplicates(state.duplicates);
  renderActivity(state.activity);
  return state;
}

async function closeTabs(tabIds) {
  const { duplicates } = await send('closeTabs', { tabIds });
  renderDuplicates(duplicates);
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
renderDuplicates(state.duplicates);
renderActivity(state.activity);

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
