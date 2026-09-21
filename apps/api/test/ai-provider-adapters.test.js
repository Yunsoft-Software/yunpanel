import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAiCompatibleAdapter,
  createAnthropicAdapter,
  createGeminiAdapter,
  createProviderFromConfig,
} from '../src/ai-provider-adapters.js';
import { AiProviderError } from '../src/ai-provider.js';

test('OpenAiCompatibleAdapter parses message and tool_calls responses', async () => {
  let capturedRequest = null;
  const mockFetch = async (url, options) => {
    capturedRequest = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Hello! How can I help you manage your server today?',
            },
          },
        ],
      }),
    };
  };

  const adapter = createOpenAiCompatibleAdapter({
    id: 'openai-test',
    apiKey: 'sk-test-key-12345',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    fetchClient: mockFetch,
  });

  const response = await adapter.invoke({
    messages: [{ role: 'user', text: 'Hello' }],
  });

  assert.equal(response.type, 'message');
  assert.equal(response.text, 'Hello! How can I help you manage your server today?');
  assert.equal(capturedRequest.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(capturedRequest.options.headers.authorization, 'Bearer sk-test-key-12345');

  // Test tool_calls response
  const toolFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_abc123',
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
  });

  const toolAdapter = createOpenAiCompatibleAdapter({
    id: 'openai-tool-test',
    apiKey: 'sk-test',
    fetchClient: toolFetch,
  });

  const toolResponse = await toolAdapter.invoke({
    messages: [{ role: 'user', text: 'Inspect site-alpha' }],
    tools: [
      {
        name: 'website.inspect',
        description: 'Inspect website',
        inputSchema: { type: 'object' },
      },
    ],
  });

  assert.equal(toolResponse.type, 'tool_calls');
  assert.equal(toolResponse.calls.length, 1);
  assert.equal(toolResponse.calls[0].id, 'call_abc123');
  assert.equal(toolResponse.calls[0].name, 'website.inspect');
  assert.deepEqual(toolResponse.calls[0].input, { websiteId: 'site-alpha' });
});

test('AnthropicAdapter parses text and tool_use blocks with system separation', async () => {
  let capturedBody = null;
  const mockFetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01A',
            name: 'server.health',
            input: {},
          },
        ],
      }),
    };
  };

  const adapter = createAnthropicAdapter({
    id: 'anthropic-test',
    apiKey: 'sk-ant-test',
    fetchClient: mockFetch,
  });

  const response = await adapter.invoke({
    messages: [
      { role: 'system', text: 'You are YunPanel AI.' },
      { role: 'user', text: 'How is the server?' },
    ],
    tools: [{ name: 'server.health', description: 'Server health', inputSchema: {} }],
  });

  assert.equal(capturedBody.system, 'You are YunPanel AI.');
  assert.equal(capturedBody.messages.length, 1);
  assert.equal(capturedBody.messages[0].content, 'How is the server?');
  assert.equal(response.type, 'tool_calls');
  assert.equal(response.calls[0].name, 'server.health');
  assert.equal(response.calls[0].id, 'toolu_01A');
});

test('GeminiAdapter formats functionResponse and parses functionCall', async () => {
  const mockFetch = async () => ({
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
  });

  const adapter = createGeminiAdapter({
    id: 'gemini-test',
    apiKey: 'gemini-test-key',
    fetchClient: mockFetch,
  });

  const response = await adapter.invoke({
    messages: [{ role: 'user', text: 'List all websites' }],
    tools: [{ name: 'website.list', description: 'List websites', inputSchema: {} }],
  });

  assert.equal(response.type, 'tool_calls');
  assert.equal(response.calls[0].name, 'website.list');
});

test('createProviderFromConfig instantiates correct adapter and maps errors', async () => {
  const mockFetchFail = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => ({ error: { message: 'Invalid API key' } }),
  });

  const adapter = createProviderFromConfig(
    {
      id: 'test-fail',
      type: 'openai',
      apiKey: 'sk-bad',
    },
    { fetchClient: mockFetchFail },
  );

  await assert.rejects(
    async () => adapter.invoke({ messages: [{ role: 'user', text: 'hi' }] }),
    (err) => err instanceof AiProviderError && err.code === 'ai_provider_authentication_failed' && err.status === 401,
  );
});
