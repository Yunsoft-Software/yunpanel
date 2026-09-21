import assert from 'node:assert/strict';
import test from 'node:test';
import { mountAiRoutes } from '../src/ai-http.js';

test('AI HTTP mounts conversation routes when conversationService is provided', () => {
  const routes = [];
  const app = {
    get(path, ...handlers) { routes.push(['GET', path]); },
    post(path, ...handlers) { routes.push(['POST', path]); },
    delete(path, ...handlers) { routes.push(['DELETE', path]); },
  };

  const registry = { list() { return []; }, get() {}, prepare() {}, execute() {} };
  const audit = { record() {} };
  const conversationService = {
    listConversations() { return []; },
    createConversation() {},
    getConversation() {},
    deleteConversation() {},
    sendMessage() {},
  };

  mountAiRoutes(app, { registry, audit, conversationService });

  assert.ok(routes.some(([method, path]) => method === 'GET' && path === '/api/ai/conversations'));
  assert.ok(routes.some(([method, path]) => method === 'POST' && path === '/api/ai/conversations'));
  assert.ok(routes.some(([method, path]) => method === 'GET' && path === '/api/ai/conversations/:conversationId'));
  assert.ok(routes.some(([method, path]) => method === 'DELETE' && path === '/api/ai/conversations/:conversationId'));
  assert.ok(routes.some(([method, path]) => method === 'POST' && path === '/api/ai/conversations/:conversationId/messages'));
  assert.ok(routes.some(([method, path]) => method === 'POST' && path === '/api/ai/conversations/:conversationId/messages/stream'));
});
