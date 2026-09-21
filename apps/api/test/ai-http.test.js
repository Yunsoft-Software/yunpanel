import assert from 'node:assert/strict';
import test from 'node:test';
import { aiHttpInternals, mountAiRoutes } from '../src/ai-http.js';

test('AI HTTP request parsers reject extra fields and non-string confirmation material', () => {
  assert.deepEqual(aiHttpInternals.previewBody({ input: { websiteId: 'site-1' } }), { input: { websiteId: 'site-1' } });
  assert.throws(() => aiHttpInternals.previewBody({ input: {}, overrides: {} }), (error) => error.code === 'invalid_ai_request');
  assert.throws(() => aiHttpInternals.executeBody({ input: {}, previewDigest: 123 }), (error) => error.code === 'invalid_ai_request');
});

test('AI HTTP mounts only tool list, preview and execution routes', () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers.length]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers.length]); },
  };
  const registry = { list() { return []; }, get() {}, prepare() {}, execute() {} };
  const audit = { record() {} };
  mountAiRoutes(app, { registry, audit });
  assert.deepEqual(routes, [
    ['GET', '/api/ai/tools', 2],
    ['POST', '/api/ai/tools/:toolName/preview', 2],
    ['POST', '/api/ai/tools/:toolName/execute', 2],
  ]);
});

test('AI audit helper records metadata but never request input or model text', () => {
  const events = [];
  aiHttpInternals.auditEvent({ record(event) { events.push(event); return event; } }, {
    actorId: 'owner-1', toolName: 'website.inspect', outcome: 'succeeded',
  });
  assert.deepEqual(events, [{
    actorId: 'owner-1', action: 'ai.tool.website.inspect', resourceType: 'ai_tool', resourceId: 'website.inspect', outcome: 'succeeded', code: null,
  }]);
});
