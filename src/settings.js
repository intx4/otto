import { PROVIDERS } from './llm.js';

export const DEFAULT_SETTINGS = {
  provider: 'anthropic',
  apiKey: '',
  model: PROVIDERS.anthropic.defaultModel,
  baseUrl: '',
  sendFullUrls: false,
  maxGroups: 8,
  autoOrganize: true,
};

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function isConfigured(settings) {
  const provider = PROVIDERS[settings.provider];
  return Boolean(provider && settings.model && (!provider.needsKey || settings.apiKey));
}
