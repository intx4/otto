import { PROVIDERS, complete } from '../src/llm.js';
import { loadSettings, saveSettings } from '../src/settings.js';
import { PLAN_SCHEMA, buildFullPrompt, parsePlan } from '../src/plan.js';

const $ = (id) => document.getElementById(id);
const BUILT_IN_HOSTS = new Set(['api.anthropic.com', 'api.openai.com']);

for (const [id, provider] of Object.entries(PROVIDERS)) {
  $('provider').append(new Option(provider.label, id));
}

function readForm() {
  return {
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    maxGroups: Number($('maxGroups').value) || 0,
    sendFullUrls: $('sendFullUrls').checked,
    autoOrganize: $('autoOrganize').checked,
  };
}

function fillForm(s) {
  $('provider').value = s.provider;
  $('baseUrl').value = s.baseUrl;
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('maxGroups').value = s.maxGroups;
  $('sendFullUrls').checked = s.sendFullUrls;
  $('autoOrganize').checked = s.autoOrganize;
  syncProviderFields();
}

function syncProviderFields() {
  const provider = PROVIDERS[$('provider').value];
  $('base-url-row').hidden = !provider.defaultBaseUrl;
  $('baseUrl').placeholder = provider.defaultBaseUrl ?? '';
}

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

// Custom hosts (Ollama, LM Studio, OpenRouter, ...) need host access to bypass CORS.
// chrome.permissions.request must run inside the click that triggered it.
async function ensureHostAccess(settings) {
  if (!PROVIDERS[settings.provider].defaultBaseUrl || !settings.baseUrl) return true;
  let url;
  try {
    url = new URL(settings.baseUrl);
  } catch {
    throw new Error('Base URL is not a valid URL.');
  }
  if (BUILT_IN_HOSTS.has(url.hostname)) return true;
  const origins = [`${url.protocol}//${url.hostname}/*`];
  return chrome.permissions.request({ origins });
}

$('provider').addEventListener('change', () => {
  const previous = Object.values(PROVIDERS).map((p) => p.defaultModel);
  if (!$('model').value || previous.includes($('model').value)) $('model').value = PROVIDERS[$('provider').value].defaultModel;
  syncProviderFields();
});

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = readForm();
  try {
    const granted = await ensureHostAccess(settings);
    await saveSettings(settings);
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
    const plan = parsePlan(await complete(settings, { system: prompt.system, user: prompt.user, schema: PLAN_SCHEMA }), prompt);
    const names = plan.groups.map((g) => `"${g.name}"`).join(', ') || 'no groups';
    setStatus(`Connected. The model replied with ${names}.`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

fillForm(await loadSettings());
