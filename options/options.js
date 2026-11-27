import { PROVIDERS, baseUrlFor, complete } from '../src/llm.js';
import { loadSettings, saveSettings } from '../src/settings.js';
import { PLAN_SCHEMA, buildFullPrompt, parsePlan } from '../src/plan.js';

const $ = (id) => document.getElementById(id);
const BUILT_IN_HOSTS = new Set(['api.anthropic.com', 'api.openai.com']);
const GENERAL = ['maxGroups', 'sendFullUrls', 'autoOrganize', 'staleDays'];

for (const [id, provider] of Object.entries(PROVIDERS)) {
  $('provider').append(new Option(provider.label, id));
}

// Every provider's config lives here while the page is open, so switching providers never mixes their values.
let draft = await loadSettings();
let shown = draft.provider;

const read = (el) => (el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) || 0 : el.value.trim());
const write = (el, value) => (el.type === 'checkbox' ? (el.checked = value) : (el.value = value));

function stashProvider() {
  const config = draft.providers[shown];
  for (const key of Object.keys(config)) config[key] = read($(key));
}

function showProvider(id) {
  shown = id;
  const provider = PROVIDERS[id];
  const config = draft.providers[id];
  for (const key of Object.keys(config)) write($(key), config[key]);
  const visible = new Set(provider.fields(config));
  for (const row of document.querySelectorAll('[data-field]')) row.hidden = !visible.has(row.dataset.field);
  $('baseUrl').placeholder = provider.defaultBaseUrl(config);
}

function readForm() {
  stashProvider();
  draft.provider = shown;
  for (const key of GENERAL) draft[key] = read($(key));
  return structuredClone(draft);
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

// Hosts outside the manifest's host_permissions (Bedrock regions, gateways, Ollama, ...) need host access to bypass CORS.
// chrome.permissions.request must run inside the click that triggered it, so nothing may be awaited before it.
function ensureHostAccess(settings) {
  const provider = PROVIDERS[settings.provider];
  let url;
  try {
    url = new URL(baseUrlFor(provider, settings.providers[settings.provider]));
  } catch {
    throw new Error('The base URL or region does not form a valid URL.');
  }
  if (BUILT_IN_HOSTS.has(url.hostname)) return true;
  return chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
}

$('provider').addEventListener('change', () => {
  stashProvider();
  showProvider($('provider').value);
});

for (const id of ['auth', 'region']) {
  $(id).addEventListener('change', () => {
    stashProvider();
    showProvider(shown);
  });
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = readForm();
  try {
    const granted = await ensureHostAccess(settings);
    draft = await saveSettings(settings);
    setStatus(granted ? 'Saved.' : 'Saved, but without access to that host requests may be blocked.', granted ? 'ok' : 'error');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

$('test').addEventListener('click', async () => {
  const settings = readForm();
  setStatus('Testing...');
  try {
    await ensureHostAccess(settings);
    const prompt = buildFullPrompt({
      tabs: [
        { id: 1, title: 'Array.prototype.map() - JavaScript | MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map' },
        { id: 2, title: 'Array.prototype.filter() - JavaScript | MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/filter' },
      ],
      existingGroupTitles: [],
      maxGroups: 0,
      sendFullUrls: false,
    });
    const onUsage = (usage) => chrome.runtime.sendMessage({ type: 'recordUsage', source: { provider: settings.provider, model: settings.providers[settings.provider].model }, usage });
    const plan = parsePlan(await complete(settings, { system: prompt.system, user: prompt.user, schema: PLAN_SCHEMA }, { onUsage }), prompt);
    const names = plan.groups.map((g) => `"${g.name}"`).join(', ') || 'no groups';
    setStatus(`Connected. The model replied with ${names}.`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

$('provider').value = shown;
for (const key of GENERAL) write($(key), draft[key]);
showProvider(shown);

const command = (await chrome.commands.getAll()).find((c) => c.name === 'organize-window');
if (command?.shortcut) $('shortcut').textContent = command.shortcut;
