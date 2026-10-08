import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {
  createAiProviderAdapter,
  AiProviderError,
} from '../src/ai-provider.js';
import {
  createOpenAiCompatibleAdapter,
  createAnthropicAdapter,
  createGeminiAdapter,
  createOpenRouterAdapter,
  createProviderFromConfig,
  sanitizeApiKey,
} from '../src/ai-provider-adapters.js';
import {
  createAiProviderRegistry,
} from '../src/ai-provider-registry.js';
import { createAiConversationService } from '../src/ai-conversation-service.js';
import { createAiToolRegistry } from '../src/ai-tool-registry.js';
import { DEFAULT_AI_TOOL_DEFINITIONS } from '../src/ai-tool-catalog.js';
import { mountAiRoutes } from '../src/ai-http.js';

const TEST_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Real-format credentials stored outside the repository
const REAL_CREDENTIALS = {
  openai: 'sk-proj-abc1234567890abcdefghijklmnopqrstuvwxyz-OPENAI-TEST-KEY',
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890-ANTHROPIC-TEST-KEY',
  gemini: 'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456-GEMINI-TEST-KEY',
};

// Helper to create an SSE stream response from string chunks
function createSseResponse(chunks, status = 200) {
  const asyncIterable = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Map([['content-type', 'text/event-stream']]),
    body: asyncIterable,
    text: async () => chunks.join(''),
    json: async () => JSON.parse(chunks.join('')),
  };
}

// -----------------------------------------------------------------------------
// SECTION 1: Credentials Stored Outside Repository via Encrypted Registry
// -----------------------------------------------------------------------------
test('Provider credentials stored outside repository in encrypted registry without plaintext leakage', async () => {
  const externalDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-external-secrets-'));
  const externalFilePath = path.join(externalDir, 'ai-providers.json');

  try {
    const registry = createAiProviderRegistry({
      filePath: externalFilePath,
      masterKey: TEST_MASTER_KEY,
    });

    // Store OpenAI credential
    const openaiRecord = await registry.setProvider({
      id: 'openai-prod',
      type: 'openai',
      apiKey: REAL_CREDENTIALS.openai,
      defaultModel: 'gpt-4o',
      makeActive: true,
    });

    // Store Anthropic credential
    const anthropicRecord = await registry.setProvider({
      id: 'anthropic-prod',
      type: 'anthropic',
      apiKey: REAL_CREDENTIALS.anthropic,
      defaultModel: 'claude-3-7-sonnet-20250219',
      makeActive: false,
    });

    // Store Gemini credential
    const geminiRecord = await registry.setProvider({
      id: 'gemini-prod',
      type: 'gemini',
      apiKey: REAL_CREDENTIALS.gemini,
      defaultModel: 'gemini-2.0-flash',
      makeActive: false,
    });

    // Verify public view masks keys and does NOT expose plaintext
    assert.equal(openaiRecord.apiKey, undefined);
    assert.equal(openaiRecord.hasApiKey, true);
    assert.ok(openaiRecord.maskedApiKey.includes('...'));
    assert.ok(!openaiRecord.maskedApiKey.includes('OPENAI-TEST-KEY'));

    assert.equal(anthropicRecord.apiKey, undefined);
    assert.equal(anthropicRecord.hasApiKey, true);
    assert.ok(anthropicRecord.maskedApiKey.includes('...'));
    assert.ok(!anthropicRecord.maskedApiKey.includes('ANTHROPIC-TEST-KEY'));

    assert.equal(geminiRecord.apiKey, undefined);
    assert.equal(geminiRecord.hasApiKey, true);
    assert.ok(geminiRecord.maskedApiKey.includes('...'));

    // Check listProviders() never exposes plaintext
    const providers = await registry.listProviders();
    assert.equal(providers.length, 3);
    for (const p of providers) {
      assert.equal(p.apiKey, undefined);
      assert.equal(p.encryptedApiKey, undefined);
      assert.ok(p.maskedApiKey.includes('...'));
    }

    // Inspect the raw file on disk: verify ciphertext only, zero occurrences of plaintext keys
    const rawFile = await readFile(externalFilePath, 'utf8');
    assert.ok(!rawFile.includes(REAL_CREDENTIALS.openai), 'Plaintext OpenAI key must not exist in storage');
    assert.ok(!rawFile.includes(REAL_CREDENTIALS.anthropic), 'Plaintext Anthropic key must not exist in storage');
    assert.ok(!rawFile.includes(REAL_CREDENTIALS.gemini), 'Plaintext Gemini key must not exist in storage');

    // Internal execution can decrypt when needed
    const decryptedOpenAi = await registry.getDecryptedProvider('openai-prod');
    assert.equal(decryptedOpenAi.apiKey, REAL_CREDENTIALS.openai);

    const decryptedAnthropic = await registry.getDecryptedProvider('anthropic-prod');
    assert.equal(decryptedAnthropic.apiKey, REAL_CREDENTIALS.anthropic);

    const decryptedGemini = await registry.getDecryptedProvider('gemini-prod');
    assert.equal(decryptedGemini.apiKey, REAL_CREDENTIALS.gemini);
  } finally {
    await rm(externalDir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// SECTION 2: Provider Adapter 1 (OpenAI-compatible) Roundtrip Behaviors
// -----------------------------------------------------------------------------
test('OpenAI-compatible adapter: tool-call roundtrip', async () => {
  const requests = [];
  let turn = 0;

  const mockFetch = async (url, options) => {
    turn += 1;
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });

    // Turn 1: Upstream model requests tool call
    if (turn === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                tool_calls: [
                  {
                    id: 'call_openai_inspect_01',
                    type: 'function',
                    function: {
                      name: 'website.inspect',
                      arguments: JSON.stringify({ websiteId: 'site-alpha' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      };
    }

    // Turn 2: Upstream model receives tool result and provides final answer
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Website site-alpha is active running Node.js 22.',
            },
          },
        ],
      }),
    };
  };

  const adapter = createOpenAiCompatibleAdapter({
    id: 'openai-test',
    apiKey: REAL_CREDENTIALS.openai,
    fetchClient: mockFetch,
  });

  // Step 1: Initial user query asking for status
  const res1 = await adapter.invoke({
    messages: [{ role: 'user', text: 'Inspect site-alpha' }],
    tools: [
      {
        name: 'website.inspect',
        description: 'Inspect website status',
        inputSchema: { type: 'object', properties: { websiteId: { type: 'string' } } },
      },
    ],
  });

  assert.equal(res1.type, 'tool_calls');
  assert.equal(res1.calls.length, 1);
  assert.equal(res1.calls[0].id, 'call_openai_inspect_01');
  assert.equal(res1.calls[0].name, 'website.inspect');
  assert.deepEqual(res1.calls[0].input, { websiteId: 'site-alpha' });

  // Verify headers sent to upstream
  assert.equal(requests[0].options.headers.authorization, `Bearer ${REAL_CREDENTIALS.openai}`);

  // Step 2: Simulate tool execution result fed back to provider
  const toolResult = { websiteId: 'site-alpha', status: 'active', runtime: 'nodejs-22' };
  const res2 = await adapter.invoke({
    messages: [
      { role: 'user', text: 'Inspect site-alpha' },
      { role: 'tool', callId: 'call_openai_inspect_01', name: 'website.inspect', result: toolResult },
    ],
  });

  assert.equal(res2.type, 'message');
  assert.equal(res2.text, 'Website site-alpha is active running Node.js 22.');

  // Verify tool message was properly formatted in OpenAI protocol
  assert.equal(requests[1].body.messages[1].role, 'tool');
  assert.equal(requests[1].body.messages[1].tool_call_id, 'call_openai_inspect_01');
  assert.equal(requests[1].body.messages[1].content, JSON.stringify(toolResult));
});

test('OpenAI-compatible adapter: streaming text roundtrip and onChunk callback', async () => {
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"Server "},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"health "},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":"is optimal."},"finish_reason":null}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const mockFetch = async () => createSseResponse(sseChunks);

  const adapter = createOpenAiCompatibleAdapter({
    id: 'openai-test',
    apiKey: REAL_CREDENTIALS.openai,
    fetchClient: mockFetch,
  });

  // Test generator streaming via adapter.stream()
  const receivedChunks = [];
  for await (const chunk of adapter.stream({
    messages: [{ role: 'user', text: 'Check health' }],
  })) {
    receivedChunks.push(chunk.text);
  }

  assert.deepEqual(receivedChunks, ['Server ', 'health ', 'is optimal.']);

  // Test streaming via complete() with onChunk
  const callbackChunks = [];
  const result = await adapter.complete({
    messages: [{ role: 'user', text: 'Check health' }],
    onChunk: (c) => callbackChunks.push(c.text),
  });

  assert.equal(result.type, 'message');
  assert.equal(result.text, 'Server health is optimal.');
  assert.deepEqual(callbackChunks, ['Server ', 'health ', 'is optimal.']);
});

test('OpenAI-compatible adapter: streaming tool-call roundtrip', async () => {
  const sseChunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_delta_01","type":"function","function":{"name":"server.health","arguments":"{\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"check\\":\\"cpu\\"}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const mockFetch = async () => createSseResponse(sseChunks);

  const adapter = createOpenAiCompatibleAdapter({
    id: 'openai-test',
    apiKey: REAL_CREDENTIALS.openai,
    fetchClient: mockFetch,
  });

  const res = await adapter.complete({
    messages: [{ role: 'user', text: 'Check CPU' }],
    tools: [{ name: 'server.health', description: 'Server health', inputSchema: {} }],
    onChunk: () => {},
  });

  assert.equal(res.type, 'tool_calls');
  assert.equal(res.calls.length, 1);
  assert.equal(res.calls[0].id, 'call_delta_01');
  assert.equal(res.calls[0].name, 'server.health');
  assert.deepEqual(res.calls[0].input, { check: 'cpu' });
});

test('OpenAI-compatible adapter: timeout roundtrip handling', async () => {
  const mockFetchHanging = async (_url, options) => {
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const adapter = createOpenAiCompatibleAdapter({
    id: 'openai-test',
    apiKey: REAL_CREDENTIALS.openai,
    fetchClient: mockFetchHanging,
  });

  await assert.rejects(
    async () => adapter.invoke({
      messages: [{ role: 'user', text: 'timeout test' }],
      timeoutMs: 25,
    }),
    (err) => {
      assert.ok(err instanceof AiProviderError);
      assert.equal(err.code, 'ai_provider_timeout');
      assert.equal(err.status, 504);
      assert.ok(!err.message.includes(REAL_CREDENTIALS.openai));
      return true;
    },
  );

  // Also test upstream 504 status response
  const mockFetch504 = async () => ({
    ok: false,
    status: 504,
    statusText: 'Gateway Timeout',
    json: async () => ({ error: { message: 'Upstream gateway timed out' } }),
  });

  const adapter504 = createOpenAiCompatibleAdapter({
    id: 'openai-test',
    apiKey: REAL_CREDENTIALS.openai,
    fetchClient: mockFetch504,
  });

  await assert.rejects(
    async () => adapter504.invoke({ messages: [{ role: 'user', text: 'hi' }] }),
    (err) => err instanceof AiProviderError && err.code === 'ai_provider_timeout' && err.status === 504,
  );
});

test('OpenAI-compatible adapter: rate-limit and provider-error roundtrip handling', async () => {
  // Rate limit 429
  const mockFetch429 = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    json: async () => ({ error: { message: `Quota exceeded for key ${REAL_CREDENTIALS.openai}` } }),
  });

  const adapter429 = createOpenAiCompatibleAdapter({
    id: 'openai-test',
    apiKey: REAL_CREDENTIALS.openai,
    fetchClient: mockFetch429,
  });

  await assert.rejects(
    async () => adapter429.invoke({ messages: [{ role: 'user', text: 'hello' }] }),
    (err) => {
      assert.ok(err instanceof AiProviderError);
      assert.equal(err.code, 'ai_provider_rate_limited');
      assert.equal(err.status, 429);
      // Key must be redacted from error message!
      assert.ok(!err.message.includes(REAL_CREDENTIALS.openai));
      assert.ok(err.message.includes('[REDACTED]'));
      return true;
    },
  );

  // Upstream 502 Bad Gateway
  const mockFetch502 = async () => ({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    json: async () => ({ error: { message: 'Cloudflare bad gateway' } }),
  });

  const adapter502 = createOpenAiCompatibleAdapter({
    id: 'openai-test',
    apiKey: REAL_CREDENTIALS.openai,
    fetchClient: mockFetch502,
  });

  await assert.rejects(
    async () => adapter502.invoke({ messages: [{ role: 'user', text: 'hello' }] }),
    (err) => err instanceof AiProviderError && err.code === 'ai_provider_upstream_error' && err.status === 502,
  );
});

// -----------------------------------------------------------------------------
// SECTION 3: Provider Adapter 2 (Anthropic) Roundtrip Behaviors
// -----------------------------------------------------------------------------
test('Anthropic adapter: tool-call roundtrip with system separation', async () => {
  const requests = [];
  let turn = 0;

  const mockFetch = async (url, options) => {
    turn += 1;
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });

    if (turn === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_anthropic_health_01',
              name: 'server.health',
              input: { component: 'database' },
            },
          ],
        }),
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: 'Database service MariaDB is running normally.',
          },
        ],
      }),
    };
  };

  const adapter = createAnthropicAdapter({
    id: 'anthropic-test',
    apiKey: REAL_CREDENTIALS.anthropic,
    fetchClient: mockFetch,
  });

  // Turn 1: Propose tool call
  const res1 = await adapter.invoke({
    messages: [
      { role: 'system', text: 'You are YunPanel assistant.' },
      { role: 'user', text: 'Check database status' },
    ],
    tools: [
      {
        name: 'server.health',
        description: 'Server health check',
        inputSchema: { type: 'object', properties: { component: { type: 'string' } } },
      },
    ],
  });

  assert.equal(res1.type, 'tool_calls');
  assert.equal(res1.calls[0].id, 'toolu_anthropic_health_01');
  assert.equal(res1.calls[0].name, 'server.health');
  assert.deepEqual(res1.calls[0].input, { component: 'database' });

  // Verify headers and system separation
  assert.equal(requests[0].options.headers['x-api-key'], REAL_CREDENTIALS.anthropic);
  assert.equal(requests[0].body.system, 'You are YunPanel assistant.');

  // Turn 2: Feed back tool_result
  const res2 = await adapter.invoke({
    messages: [
      { role: 'system', text: 'You are YunPanel assistant.' },
      { role: 'user', text: 'Check database status' },
      {
        role: 'tool',
        callId: 'toolu_anthropic_health_01',
        name: 'server.health',
        result: { status: 'ok', service: 'mariadb' },
      },
    ],
  });

  assert.equal(res2.type, 'message');
  assert.equal(res2.text, 'Database service MariaDB is running normally.');

  // Verify Anthropic tool_result format
  const userMsgWithToolResult = requests[1].body.messages[1];
  assert.equal(userMsgWithToolResult.role, 'user');
  assert.equal(userMsgWithToolResult.content[0].type, 'tool_result');
  assert.equal(userMsgWithToolResult.content[0].tool_use_id, 'toolu_anthropic_health_01');
});

test('Anthropic adapter: streaming text roundtrip and onChunk callback', async () => {
  const sseChunks = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Memory "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"usage is 42%."}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  const mockFetch = async () => createSseResponse(sseChunks);

  const adapter = createAnthropicAdapter({
    id: 'anthropic-test',
    apiKey: REAL_CREDENTIALS.anthropic,
    fetchClient: mockFetch,
  });

  const streamed = [];
  for await (const chunk of adapter.stream({
    messages: [{ role: 'user', text: 'Check memory' }],
  })) {
    streamed.push(chunk.text);
  }

  assert.deepEqual(streamed, ['Memory ', 'usage is 42%.']);

  const callbackChunks = [];
  const res = await adapter.complete({
    messages: [{ role: 'user', text: 'Check memory' }],
    onChunk: (c) => callbackChunks.push(c.text),
  });

  assert.equal(res.type, 'message');
  assert.equal(res.text, 'Memory usage is 42%.');
  assert.deepEqual(callbackChunks, ['Memory ', 'usage is 42%.']);
});

test('Anthropic adapter: timeout, rate-limit, and provider-error roundtrip handling', async () => {
  // Timeout
  const mockFetchHanging = async (_url, options) => {
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const adapterTimeout = createAnthropicAdapter({
    id: 'anthropic-test',
    apiKey: REAL_CREDENTIALS.anthropic,
    fetchClient: mockFetchHanging,
  });

  await assert.rejects(
    async () => adapterTimeout.invoke({
      messages: [{ role: 'user', text: 'slow' }],
      timeoutMs: 25,
    }),
    (err) => err instanceof AiProviderError && err.code === 'ai_provider_timeout' && err.status === 504,
  );

  // Rate limit 429 with sensitive key redaction
  const mockFetch429 = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    json: async () => ({ error: { message: `Rate limit exceeded for ${REAL_CREDENTIALS.anthropic}` } }),
  });

  const adapter429 = createAnthropicAdapter({
    id: 'anthropic-test',
    apiKey: REAL_CREDENTIALS.anthropic,
    fetchClient: mockFetch429,
  });

  await assert.rejects(
    async () => adapter429.invoke({ messages: [{ role: 'user', text: 'ping' }] }),
    (err) => {
      assert.ok(err instanceof AiProviderError);
      assert.equal(err.code, 'ai_provider_rate_limited');
      assert.equal(err.status, 429);
      assert.ok(!err.message.includes(REAL_CREDENTIALS.anthropic));
      assert.ok(err.message.includes('[REDACTED]'));
      return true;
    },
  );

  // Upstream 500
  const mockFetch500 = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    json: async () => ({ error: { message: 'Overloaded' } }),
  });

  const adapter500 = createAnthropicAdapter({
    id: 'anthropic-test',
    apiKey: REAL_CREDENTIALS.anthropic,
    fetchClient: mockFetch500,
  });

  await assert.rejects(
    async () => adapter500.invoke({ messages: [{ role: 'user', text: 'ping' }] }),
    (err) => err instanceof AiProviderError && err.code === 'ai_provider_upstream_error' && err.status === 502,
  );
});

// -----------------------------------------------------------------------------
// SECTION 4: Provider Adapter 3 (Gemini) Roundtrip Behaviors
// -----------------------------------------------------------------------------
test('Gemini adapter: tool-call, streaming, timeout, rate-limit roundtrips with key safety', async () => {
  // 4.1: Tool call roundtrip
  let turn = 0;
  const mockFetch = async () => {
    turn += 1;
    if (turn === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'website.list',
                      args: {},
                    },
                  },
                ],
              },
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: 'Found 3 active websites.' }],
            },
          },
        ],
      }),
    };
  };

  const adapter = createGeminiAdapter({
    id: 'gemini-test',
    apiKey: REAL_CREDENTIALS.gemini,
    fetchClient: mockFetch,
  });

  const res1 = await adapter.invoke({
    messages: [{ role: 'user', text: 'List sites' }],
    tools: [{ name: 'website.list', description: 'List websites', inputSchema: {} }],
  });
  assert.equal(res1.type, 'tool_calls');
  assert.equal(res1.calls[0].name, 'website.list');

  const res2 = await adapter.invoke({
    messages: [
      { role: 'user', text: 'List sites' },
      { role: 'tool', callId: res1.calls[0].id, name: 'website.list', result: ['a.com', 'b.com', 'c.com'] },
    ],
  });
  assert.equal(res2.type, 'message');
  assert.equal(res2.text, 'Found 3 active websites.');

  // 4.2: Streaming text
  const sseChunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Gemini "}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"streaming works."}]}}]}\n\n',
  ];

  const streamAdapter = createGeminiAdapter({
    id: 'gemini-test',
    apiKey: REAL_CREDENTIALS.gemini,
    fetchClient: async () => createSseResponse(sseChunks),
  });

  const chunks = [];
  const streamRes = await streamAdapter.complete({
    messages: [{ role: 'user', text: 'Stream test' }],
    onChunk: (c) => chunks.push(c.text),
  });
  assert.equal(streamRes.text, 'Gemini streaming works.');
  assert.deepEqual(chunks, ['Gemini ', 'streaming works.']);

  // 4.3: Rate limit with key redaction
  const mock429 = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    json: async () => ({ error: { message: `Resource exhausted for key ${REAL_CREDENTIALS.gemini}` } }),
  });
  const rateLimitAdapter = createGeminiAdapter({
    id: 'gemini-test',
    apiKey: REAL_CREDENTIALS.gemini,
    fetchClient: mock429,
  });

  await assert.rejects(
    async () => rateLimitAdapter.invoke({ messages: [{ role: 'user', text: 'hi' }] }),
    (err) => {
      assert.equal(err.code, 'ai_provider_rate_limited');
      assert.ok(!err.message.includes(REAL_CREDENTIALS.gemini));
      assert.ok(err.message.includes('[REDACTED]'));
      return true;
    },
  );
});

// -----------------------------------------------------------------------------
// SECTION 5: End-to-End Credential Plaintext Safety Verification
// (Frontend Response, Conversation Persistence, Generic Job/Audit/Log)
// -----------------------------------------------------------------------------
test('End-to-end credential safety: plaintext never in frontend response, conversation persistence, or audit logs', async () => {
  const externalDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-e2e-safety-'));
  const providersPath = path.join(externalDir, 'ai-providers.json');
  const conversationsPath = path.join(externalDir, 'ai-conversations.json');

  try {
    // 1. Create registry stored outside repo
    const providerRegistry = createAiProviderRegistry({
      filePath: providersPath,
      masterKey: TEST_MASTER_KEY,
    });

    await providerRegistry.setProvider({
      id: 'openai-secure',
      type: 'openai',
      apiKey: REAL_CREDENTIALS.openai,
      defaultModel: 'gpt-4o',
      makeActive: true,
    });

    await providerRegistry.setProvider({
      id: 'anthropic-secure',
      type: 'anthropic',
      apiKey: REAL_CREDENTIALS.anthropic,
      defaultModel: 'claude-3-7-sonnet-20250219',
      makeActive: false,
    });

    // 2. Setup mock tool registry
    const toolRegistry = createAiToolRegistry({ definitions: DEFAULT_AI_TOOL_DEFINITIONS });
    toolRegistry.bind('website.inspect', async ({ input }) => ({
      status: 'online',
      site: input.websiteId,
    }));

    // Mock fetch for provider execution
    const mockUpstreamFetch = async (url, options) => {
      const body = JSON.parse(options.body);
      const isToolTurn = body.messages.some((m) => m.role === 'tool');
      if (!isToolTurn) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call_sec_01',
                      type: 'function',
                      function: {
                        name: 'website.inspect',
                        arguments: JSON.stringify({ websiteId: 'site-prod' }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Analysis complete: site-prod is online.',
              },
            },
          ],
        }),
      };
    };

    // Instantiate active provider adapter
    const decryptedActive = await providerRegistry.getDecryptedActiveProvider();
    const adapter = createProviderFromConfig(decryptedActive, { fetchClient: mockUpstreamFetch });

    // 3. Conversation service
    const conversationService = createAiConversationService({
      filePath: conversationsPath,
      providerRegistry,
      providerAdapter: adapter,
      toolRegistry,
    });

    const ownerAuth = Object.freeze({
      user: Object.freeze({ id: 'owner-uuid-1', role: 'owner' }),
      access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
      security: Object.freeze({ managementAllowed: true }),
    });

    // Create conversation and run multi-turn message with tool execution
    const conv = await conversationService.createConversation({
      title: 'Security Inspection',
      auth: ownerAuth,
    });

    const assistantMsg = await conversationService.sendMessage({
      conversationId: conv.id,
      text: 'Inspect site-prod security',
      auth: ownerAuth,
    });

    assert.equal(assistantMsg.text, 'Analysis complete: site-prod is online.');
    assert.equal(assistantMsg.toolExecutions?.length, 1);

    // 4. VERIFY FRONTEND RESPONSE SAFETY:
    // Assistant message must not contain any credentials
    const assistantMsgString = JSON.stringify(assistantMsg);
    assert.ok(!assistantMsgString.includes(REAL_CREDENTIALS.openai), 'Frontend message must not contain OpenAI key');
    assert.ok(!assistantMsgString.includes(REAL_CREDENTIALS.anthropic), 'Frontend message must not contain Anthropic key');
    assert.ok(!assistantMsgString.includes(REAL_CREDENTIALS.gemini), 'Frontend message must not contain Gemini key');

    // Test GET /api/ai/providers endpoint response
    const app = express();
    app.use(express.json());
    // Attach fake auth middleware
    app.use((req, _res, next) => {
      req.auth = ownerAuth;
      req.session = { id: 'test-session-1' };
      next();
    });

    const recordedAuditEvents = [];
    const auditStore = {
      record: (evt) => {
        recordedAuditEvents.push(evt);
        return evt;
      },
    };

    mountAiRoutes(app, {
      registry: toolRegistry,
      audit: auditStore,
      providerRegistry,
      conversationService,
    });

    const server = http.createServer(app);
    await once(server.listen(0, '127.0.0.1'), 'listening');
    const port = server.address().port;

    let listResponseData = null;
    try {
      const listRes = await fetch(`http://127.0.0.1:${port}/api/ai/providers`);
      assert.equal(listRes.status, 200);
      listResponseData = await listRes.json();
    } finally {
      server.close();
    }

    const listString = JSON.stringify(listResponseData);
    assert.ok(!listString.includes(REAL_CREDENTIALS.openai), 'Provider list API response must not contain OpenAI key');
    assert.ok(!listString.includes(REAL_CREDENTIALS.anthropic), 'Provider list API response must not contain Anthropic key');

    // 5. VERIFY CONVERSATION PERSISTENCE SAFETY:
    // Read the raw conversation JSON file from disk
    const rawConversationsFile = await readFile(conversationsPath, 'utf8');
    assert.ok(!rawConversationsFile.includes(REAL_CREDENTIALS.openai), 'Conversation persistence file must not contain OpenAI key');
    assert.ok(!rawConversationsFile.includes(REAL_CREDENTIALS.anthropic), 'Conversation persistence file must not contain Anthropic key');
    assert.ok(!rawConversationsFile.includes(REAL_CREDENTIALS.gemini), 'Conversation persistence file must not contain Gemini key');

    // 6. VERIFY AUDIT LOG SAFETY:
    const auditString = JSON.stringify(recordedAuditEvents);
    assert.ok(!auditString.includes(REAL_CREDENTIALS.openai), 'Audit logs must not contain OpenAI key');
    assert.ok(!auditString.includes(REAL_CREDENTIALS.anthropic), 'Audit logs must not contain Anthropic key');
    assert.ok(!auditString.includes(REAL_CREDENTIALS.gemini), 'Audit logs must not contain Gemini key');

    // 7. VERIFY SANITIZE API KEY HELPER:
    const leakAttempt = `Error connecting with Bearer ${REAL_CREDENTIALS.openai} to url https://api.openai.com?key=${REAL_CREDENTIALS.openai}`;
    const sanitized = sanitizeApiKey(leakAttempt, REAL_CREDENTIALS.openai);
    assert.ok(!sanitized.includes(REAL_CREDENTIALS.openai), 'Sanitized string must not leak API key');
    assert.ok(sanitized.includes('[REDACTED]'), 'Sanitized string must contain [REDACTED]');
  } finally {
    await rm(externalDir, { recursive: true, force: true });
  }
});
