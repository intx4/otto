import { saveSettings } from '../src/settings.js';

const $ = (id) => document.getElementById(id);
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
      button.textContent = 'Close';
      button.addEventListener('click', () => closeTabs([tab.id]));
      li.append(title, button);
      list.append(li);
    }
  }
  $('duplicates').hidden = closeIds.length === 0;
  $('close-all').onclick = () => closeTabs(closeIds);
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
    renderDuplicates((await send('getState')).duplicates);
  } finally {
    $('organize').disabled = false;
  }
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

$('organize').addEventListener('click', organize);
$('auto').addEventListener('change', (e) => saveSettings({ autoOrganize: e.target.checked }));
$('options-link').addEventListener('click', openOptions);
$('open-options').addEventListener('click', openOptions);
