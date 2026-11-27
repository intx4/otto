import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, isConfigured } from '../src/settings.js';

const BEDROCK_DEFAULTS = {
  region: 'us-east-1',
  baseUrl: '',
  auth: 'apiKey',
  apiKey: '',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  model: 'anthropic.claude-haiku-5-5',
};

test('normalizeSettings moves the flat shape into the selected provider', () => {
  const stored = { provider: 'openai', apiKey: 'sk-1', model: 'llama3', baseUrl: 'http://localhost:11434/v1', sendFullUrls: true, maxGroups: 5, autoOrganize: false };
  assert.deepEqual(normalizeSettings(stored), {
    provider: 'openai',
    providers: {
      anthropic: { baseUrl: '', apiKey: '', model: 'claude-haiku-5-5' },
      bedrock: BEDROCK_DEFAULTS,
      openai: { baseUrl: 'http://localhost:11434/v1', apiKey: 'sk-1', model: 'llama3' },
    },
    sendFullUrls: true,
    maxGroups: 5,
    autoOrganize: false,
    staleDays: 7,
  });
});

test('normalizeSettings fills defaults for empty storage and keeps the nested shape', () => {
  const empty = normalizeSettings(undefined);
  assert.equal(empty.provider, 'anthropic');
  assert.deepEqual(empty.providers.anthropic, { baseUrl: '', apiKey: '', model: 'claude-haiku-5-5' });

  const nested = { provider: 'bedrock', providers: { bedrock: { auth: 'sigv4', accessKeyId: 'AKID', secretAccessKey: 's' } } };
  assert.deepEqual(normalizeSettings(nested).providers.bedrock, { ...BEDROCK_DEFAULTS, auth: 'sigv4', accessKeyId: 'AKID', secretAccessKey: 's' });
  assert.deepEqual(normalizeSettings(normalizeSettings(nested)), normalizeSettings(nested));
});

test('isConfigured checks the credentials of the selected provider only', () => {
  const s = (provider, providers) => normalizeSettings({ provider, providers });
  assert.equal(isConfigured(s('anthropic', {})), false);
  assert.equal(isConfigured(s('anthropic', { anthropic: { apiKey: 'k' } })), true);
  assert.equal(isConfigured(s('openai', {})), true);
  assert.equal(isConfigured(s('openai', { openai: { model: '' } })), false);
  assert.equal(isConfigured(s('bedrock', { anthropic: { apiKey: 'k' } })), false);
  assert.equal(isConfigured(s('bedrock', { bedrock: { apiKey: 'k' } })), true);
  assert.equal(isConfigured(s('bedrock', { bedrock: { auth: 'sigv4', apiKey: 'k' } })), false);
  assert.equal(isConfigured(s('bedrock', { bedrock: { auth: 'sigv4', accessKeyId: 'a', secretAccessKey: 'b' } })), true);
  assert.equal(isConfigured(s('nope', {})), false);
});
