import { extractJson } from './plan.js';

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

// Each provider turns {system, user, schema} into a fetch request and pulls the JSON object out of the reply.
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-haiku-5-5',
    needsKey: true,
    endpoint: () => 'https://api.anthropic.com/v1/messages',
    headers: ({ apiKey }) => ({
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2026-10-21',
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: ({ model }, { system, user, schema }) => ({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    }),
    read: (data) => {
      if (data.stop_reason === 'refusal') throw new LlmError('The model declined this request.');
      if (data.stop_reason === 'max_tokens') throw new LlmError('The reply was cut off (too many tabs?).');
      const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return extractJson(text);
    },
  },
  openai: {
    label: 'OpenAI-compatible',
    defaultModel: 'gpt-4.1-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsKey: false,
    endpoint: ({ baseUrl }) => `${trimSlash(baseUrl) || 'https://api.openai.com/v1'}/chat/completions`,
    headers: ({ apiKey }) => ({
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
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

export async function complete(settings, request) {
  const provider = PROVIDERS[settings.provider];
  if (!provider) throw new LlmError(`Unknown provider "${settings.provider}".`);
  if (provider.needsKey && !settings.apiKey) throw new LlmError('No API key set. Open Options to add one.');
  if (!settings.model) throw new LlmError('No model set. Open Options to choose one.');

  let res;
  try {
    res = await fetch(provider.endpoint(settings), {
      method: 'POST',
      headers: provider.headers(settings),
      body: JSON.stringify(provider.body(settings, request)),
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
