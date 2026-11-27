import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { complete } from '../src/llm.js';
import { normalizeSettings } from '../src/settings.js';

const request = { system: 'sys', user: 'tabs', schema: { type: 'object' } };
const plan = { groups: [], duplicates: [] };
const messagesReply = { content: [{ type: 'text', text: JSON.stringify(plan) }], stop_reason: 'end_turn' };
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

function capture(reply) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return calls;
}

test('anthropic uses the default host, or a custom base URL', async () => {
  const calls = capture(messagesReply);
  assert.deepEqual(await complete(normalizeSettings({ provider: 'anthropic', providers: { anthropic: { apiKey: 'k' } } }), request), plan);
  await complete(normalizeSettings({ provider: 'anthropic', providers: { anthropic: { apiKey: 'k', baseUrl: 'https://gateway.example.com/anthropic/' } } }), request);
  assert.deepEqual(calls.map((c) => c.url), ['https://api.anthropic.com/v1/messages', 'https://gateway.example.com/anthropic/v1/messages']);
  assert.equal(calls[0].headers['x-api-key'], 'k');
  assert.equal(calls[0].body.model, 'claude-haiku-5-5');
});

test('bedrock with an API key sends a bearer token to the regional endpoint', async () => {
  const calls = capture(messagesReply);
  await complete(normalizeSettings({ provider: 'bedrock', providers: { bedrock: { apiKey: 'bk', region: 'eu-west-1' } } }), request);
  assert.equal(calls[0].url, 'https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages');
  assert.deepEqual(calls[0].headers, { 'content-type': 'application/json', 'anthropic-version': '2026-10-21', authorization: 'Bearer bk' });
  assert.equal(calls[0].body.model, 'anthropic.claude-haiku-5-5');
  assert.deepEqual(calls[0].body.output_config, { format: { type: 'json_schema', schema: { type: 'object' } } });
});

test('bedrock with access keys signs the request with SigV4', async () => {
  const calls = capture(messagesReply);
  const bedrock = { auth: 'sigv4', accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'tok', region: 'us-west-2' };
  await complete(normalizeSettings({ provider: 'bedrock', providers: { bedrock } }), request);
  const { headers } = calls[0];
  assert.equal(headers['x-amz-security-token'], 'tok');
  assert.match(headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
  assert.match(
    headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-west-2\/bedrock-mantle\/aws4_request, SignedHeaders=anthropic-version;content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
  );
});

test('missing credentials are named before any request', async () => {
  const calls = capture(messagesReply);
  await assert.rejects(complete(normalizeSettings({ provider: 'bedrock', providers: { bedrock: { auth: 'sigv4', accessKeyId: 'a' } } }), request), /No AWS access key set/);
  await assert.rejects(complete(normalizeSettings({ provider: 'anthropic' }), request), /No API key set/);
  assert.equal(calls.length, 0);
});

test('a base URL ending in /v1 does not double the /v1 on messages providers', async () => {
  const calls = capture(messagesReply);
  const base = 'https://bedrock-runtime.eu-central-1.amazonaws.com/anthropic/v1';
  await complete(normalizeSettings({ provider: 'anthropic', providers: { anthropic: { apiKey: 'k', baseUrl: base } } }), request);
  await complete(normalizeSettings({ provider: 'bedrock', providers: { bedrock: { apiKey: 'k', baseUrl: `${base}/` } } }), request);
  assert.deepEqual(calls.map((c) => c.url), [`${base}/messages`, `${base}/messages`]);
});

test('a 200 reply that is not a Messages response names the problem', async () => {
  capture({ Output: { __type: 'com.amazon.coral.service#UnknownOperationException' }, Version: '1.0' });
  await assert.rejects(
    complete(normalizeSettings({ provider: 'anthropic', providers: { anthropic: { apiKey: 'k' } } }), request),
    { message: 'Unexpected reply from the provider, check the base URL: {"Output":{"__type":"com.amazon.coral.service#UnknownOperationException"},"Version":"1.0"}' },
  );
});

test('messages providers turn thinking off, and retry with it on when the model rejects that', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.thinking) return new Response(JSON.stringify({ error: { message: 'thinking.type disabled is not supported for this model' } }), { status: 400 });
    return new Response(JSON.stringify(messagesReply), { status: 200 });
  };
  assert.deepEqual(await complete(normalizeSettings({ provider: 'anthropic', providers: { anthropic: { apiKey: 'k', model: 'claude-opus-5-5' } } }), request), plan);
  assert.deepEqual(calls.map((c) => c.thinking), [{ type: 'disabled' }, undefined]);
});

test('a 400 unrelated to thinking is reported without a retry', async () => {
  let count = 0;
  globalThis.fetch = async () => (count++, new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 400 }));
  await assert.rejects(complete(normalizeSettings({ provider: 'anthropic', providers: { anthropic: { apiKey: 'k' } } }), request), { message: 'HTTP 400: model not found' });
  assert.equal(count, 1);
});
