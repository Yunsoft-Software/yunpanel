import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAiConversationService } from '../src/ai-conversation-service.js';
import { createAiToolRegistry } from '../src/ai-tool-registry.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai-tool-catalog.js';

const ownerAuth = Object.freeze({
  user: Object.freeze({ id: 'owner-1', role: 'owner' }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
  security: Object.freeze({ managementAllowed: true }),
});

test('AiConversationService manages persistent conversations', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-conversation-test-'));
  const filePath = path.join(tempDir, 'conversations.json');

  try {
    const service = createAiConversationService({ filePath });
    const emptyList = await service.listConversations();
    assert.deepEqual(emptyList, []);

    const created = await service.createConversation({ title: 'Deploy Help', websiteId: 'site-1' });
    assert.equal(created.title, 'Deploy Help');
    assert.equal(created.websiteId, 'site-1');

    const list = await service.listConversations();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);

    const retrieved = await service.getConversation(created.id);
    assert.equal(retrieved.id, created.id);
    assert.deepEqual(retrieved.messages, []);

    const deleted = await service.deleteConversation(created.id);
    assert.equal(deleted, true);
    assert.equal(await service.getConversation(created.id), null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('AiConversationService multi-turn agent executes read tools and returns final response', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-agent-turn-test-'));
  const filePath = path.join(tempDir, 'conversations.json');

  try {
    const toolRegistry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
    toolRegistry.bind('website.list', async () => [
      { id: 'site-1', domain: 'example.com', status: 'active' },
      { id: 'site-2', domain: 'api.example.com', status: 'active' },
    ]);

    let callCount = 0;
    const mockAdapter = {
      id: 'mock-ai',
      defaultModel: 'test-model',
      async complete({ messages }) {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: 'tool_calls',
            calls: [
              {
                id: 'call_1',
                name: 'website.list',
                input: {},
              },
            ],
          };
        }
        const toolMsg = messages.find((m) => m.role === 'tool');
        assert.ok(toolMsg);
        assert.equal(toolMsg.name, 'website.list');
        return {
          type: 'message',
          text: 'You have 2 websites: example.com and api.example.com.',
        };
      },
    };

    const events = [];
    const service = createAiConversationService({
      filePath,
      providerAdapter: mockAdapter,
      toolRegistry,
    });

    const conv = await service.createConversation({ title: 'Check sites' });
    const response = await service.sendMessage({
      conversationId: conv.id,
      text: 'What sites do I have?',
      auth: ownerAuth,
      onEvent: (event) => events.push(event),
    });

    assert.equal(response.role, 'assistant');
    assert.equal(response.text, 'You have 2 websites: example.com and api.example.com.');
    assert.equal(response.toolExecutions?.length, 1);
    assert.equal(response.toolExecutions[0].name, 'website.list');
    assert.equal(callCount, 2);

    // Verify events fired
    assert.ok(events.some((e) => e.type === 'thinking'));
    assert.ok(events.some((e) => e.type === 'tool_call' && e.name === 'website.list'));
    assert.ok(events.some((e) => e.type === 'tool_result' && e.name === 'website.list'));
    assert.ok(events.some((e) => e.type === 'done'));

    // Check conversation history
    const updated = await service.getConversation(conv.id);
    assert.equal(updated.messages.length, 2);
    assert.equal(updated.messages[0].role, 'user');
    assert.equal(updated.messages[0].text, 'What sites do I have?');
    assert.equal(updated.messages[1].role, 'assistant');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('AiConversationService intercepts write operations and returns action proposals without auto-executing', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-write-proposal-test-'));
  const filePath = path.join(tempDir, 'conversations.json');

  try {
    const toolRegistry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
    let restartCalled = false;
    toolRegistry.bind('website.restart', async () => {
      restartCalled = true;
      return { restarted: true };
    });

    const mockAdapter = {
      id: 'mock-ai',
      defaultModel: 'test-model',
      async complete() {
        return {
          type: 'tool_calls',
          calls: [
            {
              id: 'call_restart_1',
              name: 'website.restart',
              input: { websiteId: 'site-alpha' },
            },
          ],
        };
      },
    };

    const service = createAiConversationService({
      filePath,
      providerAdapter: mockAdapter,
      toolRegistry,
    });

    const conv = await service.createConversation({ title: 'Restart site' });
    const response = await service.sendMessage({
      conversationId: conv.id,
      text: 'Please restart website site-alpha',
      auth: ownerAuth,
    });

    assert.equal(response.role, 'assistant');
    assert.ok(response.proposals?.length === 1);
    assert.equal(response.proposals[0].toolName, 'website.restart');
    assert.deepEqual(response.proposals[0].input, { websiteId: 'site-alpha' });
    assert.ok(response.proposals[0].plan);

    // Crucial safety invariant: write tool MUST NOT have executed automatically!
    assert.equal(restartCalled, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('AiConversationService builds contextual system prompt with website details', async () => {
  const service = createAiConversationService({});
  const prompt = service.buildSystemPrompt({
    website: { id: 'web-prod', domain: 'production.com' },
    domains: [{ domainName: 'production.com' }, { domainName: 'www.production.com' }],
    application: { type: 'node', runtime: '22', currentReleaseId: 'rel-99', activeDeploymentId: null },
  });

  assert.ok(prompt.includes('YunPanel AI'));
  assert.ok(prompt.includes('web-prod'));
  assert.ok(prompt.includes('production.com'));
  assert.ok(prompt.includes('node'));
});
