import { PROVIDERS } from './llm.js';

export const DEFAULT_SETTINGS = {
  provider: 'anthropic',
  providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, p.defaults])),
  sendFullUrls: false,
  maxGroups: 8,
  autoOrganize: true,
  staleDays: 7,
};

// Fills defaults and moves the original flat shape ({provider, apiKey, model, baseUrl}) into providers[provider].
export function normalizeSettings(stored = {}) {
  const { apiKey, model, baseUrl, providers = {}, ...rest } = stored;
  const settings = { ...DEFAULT_SETTINGS, ...rest };
  const legacy = Object.fromEntries(Object.entries({ apiKey, model, baseUrl }).filter(([, v]) => v !== undefined));
  settings.providers = Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, p]) => {
      const migrated = id === settings.provider && !stored.providers ? legacy : {};
      return [id, { ...p.defaults, ...migrated, ...providers[id] }];
    }),
  );
  return settings;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return normalizeSettings(settings);
}

export async function saveSettings(patch) {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function isConfigured(settings) {
  const provider = PROVIDERS[settings.provider];
  const config = settings.providers?.[settings.provider];
  return Boolean(provider && config?.model && !provider.missing(config));
}
