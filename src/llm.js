import { extractJson } from './plan.js';
import { signV4 } from './sigv4.js';

export class LlmError extends Error {}

const TIMEOUT_MS = 60_000;

function trimSlash(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

async function httpError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message ?? body?.message ?? '';
  } catch {}
  const hint = { 401: 'check the API key', 403: 'key not allowed for this model', 404: 'check the model name or base URL', 429: 'rate limited, try again shortly' }[res.status];
  return new LlmError(`HTTP ${res.status}${hint ? ` (${hint})` : ''}${detail ? `: ${detail}` : ''}`);
}

const ANTHROPIC_VERSION = '2026-10-21';

const messagesBody = ({ model }, { system, user, schema }) => ({
  model,
  max_tokens: 16000,
  system,
  messages: [{ role: 'user', content: user }],
  output_config: { format: { type: 'json_schema', schema } },
});

function readMessages(data) {
  if (data.stop_reason === 'refusal') throw new LlmError('The model declined this request.');
  if (data.stop_reason === 'max_tokens') throw new LlmError('The reply was cut off (too many tabs?).');
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return extractJson(text);
}

// Each provider owns a config (its `defaults` keys), turns {system, user, schema} into a request body,
// builds headers from the final URL and serialized body, and pulls the JSON object out of the reply.
// `fields` lists the config keys the options page shows; `missing` names a required credential that is empty.
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    defaults: { baseUrl: '', apiKey: '', model: 'claude-haiku-5-5' },
    defaultBaseUrl: () => 'https://api.anthropic.com',
    path: '/v1/messages',
    fields: () => ['baseUrl', 'apiKey', 'model'],
    missing: (c) => (c.apiKey ? '' : 'API key'),
    headers: async (c) => ({
      'content-type': 'application/json',
      'x-api-key': c.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: messagesBody,
    read: readMessages,
  },
  bedrock: {
    label: 'Amazon Bedrock (Claude)',
    defaults: { region: 'us-east-1', baseUrl: '', auth: 'apiKey', apiKey: '', accessKeyId: '', secretAccessKey: '', sessionToken: '', model: 'anthropic.claude-haiku-5-5' },
    defaultBaseUrl: (c) => `https://bedrock-mantle.${c.region || 'us-east-1'}.api.aws/anthropic`,
    path: '/v1/messages',
    fields: (c) => ['region', 'baseUrl', 'auth', ...(c.auth === 'sigv4' ? ['accessKeyId', 'secretAccessKey', 'sessionToken'] : ['apiKey']), 'model'],
    missing: (c) => (c.auth === 'sigv4' ? (c.accessKeyId && c.secretAccessKey ? '' : 'AWS access key') : c.apiKey ? '' : 'Bedrock API key'),
    headers: async (c, { url, body }) => {
      const headers = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION };
      if (c.auth !== 'sigv4') return { ...headers, authorization: `Bearer ${c.apiKey}` };
      const { accessKeyId, secretAccessKey, sessionToken } = c;
      return signV4({ method: 'POST', url, headers, body, region: c.region || 'us-east-1', service: 'bedrock-mantle', accessKeyId, secretAccessKey, sessionToken });
    },
    body: messagesBody,
    read: readMessages,
  },
  openai: {
    label: 'OpenAI-compatible',
    defaults: { baseUrl: '', apiKey: '', model: 'gpt-4.1-mini' },
    defaultBaseUrl: () => 'https://api.openai.com/v1',
    path: '/chat/completions',
    fields: () => ['baseUrl', 'apiKey', 'model'],
    missing: () => '',
    headers: async (c) => ({
      'content-type': 'application/json',
      ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}),
    }),
    body: ({ model }, { system, user, schema }) => ({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'tab_plan', strict: true, schema } },
    }),
    read: (data) => {
      const message = data.choices?.[0]?.message;
      if (message?.refusal) throw new LlmError(`The model declined: ${message.refusal}`);
      return extractJson(message?.content);
    },
  },
};

export const baseUrlFor = (provider, config) => trimSlash(config.baseUrl) || provider.defaultBaseUrl(config);

export async function complete(settings, request) {
  const provider = PROVIDERS[settings.provider];
  if (!provider) throw new LlmError(`Unknown provider "${settings.provider}".`);
  const config = settings.providers[settings.provider];
  const missing = provider.missing(config);
  if (missing) throw new LlmError(`No ${missing} set. Open Options to add one.`);
  if (!config.model) throw new LlmError('No model set. Open Options to choose one.');

  const url = baseUrlFor(provider, config) + provider.path;
  const body = JSON.stringify(provider.body(config, request));
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: await provider.headers(config, { url, body }),
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? 'timed out' : 'could not connect';
    throw new LlmError(`Request to ${provider.label} ${reason}. Check the base URL and your network.`);
  }
  if (!res.ok) throw await httpError(res);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new LlmError('The provider returned a response that is not JSON.');
  }
  const result = provider.read(data);
  if (!result || typeof result !== 'object') throw new LlmError('The model reply did not contain a JSON plan.');
  return result;
}
