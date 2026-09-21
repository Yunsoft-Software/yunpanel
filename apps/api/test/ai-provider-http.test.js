import assert from 'node:assert/strict';
import test from 'node:test';
import { aiHttpInternals, mountAiRoutes } from '../src/ai-http.js';

test('AI HTTP providerBody parser normalizes and validates provider requests', () => {
  const valid = {
    id: 'openai-prod',
    type: 'openai',
    apiKey: 'sk-12345678901234',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    makeActive: true,
  };
  const parsed = aiHttpInternals.providerBody(valid);
  assert.equal(parsed.id, 'openai-prod');
  assert.equal(parsed.type, 'openai');
  assert.equal(parsed.apiKey, 'sk-12345678901234');
  assert.equal(parsed.makeActive, true);

  // Reject unknown fields
  assert.throws(
    () => aiHttpInternals.providerBody({ ...valid, maliciousField: 'eval()' }),
    (err) => err.code === 'invalid_ai_request',
  );

  // Reject non-string fields
  assert.throws(
    () => aiHttpInternals.providerBody({ ...valid, apiKey: 12345 }),
    (err) => err.code === 'invalid_ai_provider_request',
  );
});

test('AI HTTP mounts provider routes when providerRegistry is configured', () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers.length]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers.length]); },
    delete(path, ...handlers) { routes.push(['DELETE', path, handlers.length]); },
  };
  const registry = { list() { return []; }, get() {}, prepare() {}, execute() {} };
  const audit = { record() {} };
  const providerRegistry = {
    listProviders() { return []; },
    getProvider() {},
    setProvider() {},
    deleteProvider() {},
    setActiveProvider() {},
    getActiveProvider() {},
  };

  mountAiRoutes(app, { registry, audit, providerRegistry });

  assert.ok(routes.some(([method, path]) => method === 'GET' && path === '/api/ai/providers'));
  assert.ok(routes.some(([method, path]) => method === 'POST' && path === '/api/ai/providers'));
  assert.ok(routes.some(([method, path]) => method === 'DELETE' && path === '/api/ai/providers/:providerId'));
  assert.ok(routes.some(([method, path]) => method === 'POST' && path === '/api/ai/providers/:providerId/active'));
  assert.ok(routes.some(([method, path]) => method === 'POST' && path === '/api/ai/providers/:providerId/test'));
});
