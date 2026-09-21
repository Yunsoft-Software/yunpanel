import assert from 'node:assert/strict';
import test from 'node:test';
import { aiHttpInternals, mountAiRoutes } from '../src/ai-http.js';

test('AI HTTP policy bodies reject implicit or malformed revision/confirmation state', () => {
  assert.deepEqual(
    aiHttpInternals.policyPreviewBody({ expectedRevision: 2, tool: { 'website.restart': 'deny' } }),
    { expectedRevision: 2, tool: { 'website.restart': 'deny' }, risk: {} },
  );
  assert.throws(
    () => aiHttpInternals.policyPreviewBody({ expectedRevision: 0 }),
    (error) => error.code === 'invalid_ai_policy_revision',
  );
  assert.throws(
    () => aiHttpInternals.policyApplyBody({
      expectedRevision: 2,
      previewDigest: 'x',
      confirmation: 'confirm',
    }),
    (error) => error.code === 'invalid_ai_policy_request',
  );
});

test('AI HTTP mounts policy routes only when a policy store is configured', () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path, handlers.length]); },
    post(path, ...handlers) { routes.push(['POST', path, handlers.length]); },
  };
  const registry = { list() { return []; }, get() {}, prepare() {}, execute() {} };
  const audit = { record() {} };
  const policyStore = {
    async getSnapshot() { return { overrides: { tool: {}, risk: {} } }; },
    async previewUpdate() { return {}; },
    async applyUpdate() { return {}; },
  };
  mountAiRoutes(app, { registry, audit, policyStore });
  assert.ok(routes.some(([method, path]) => method === 'GET' && path === '/api/ai/policy'));
  assert.ok(routes.some(([method, path]) => method === 'POST' && path === '/api/ai/policy/preview'));
  assert.ok(routes.some(([method, path]) => method === 'POST' && path === '/api/ai/policy'));
});
