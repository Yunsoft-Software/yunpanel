import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiProviderRegistry, AiProviderRegistryError } from '../src/ai-provider-registry.js';

const TEST_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('AiProviderRegistry stores, encrypts, and lists providers with masked keys', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-provider-test-'));
  const filePath = path.join(tempDir, 'ai-providers.json');

  try {
    const registry = createAiProviderRegistry({
      filePath,
      masterKey: TEST_MASTER_KEY,
    });

    // Initially empty
    const initialList = await registry.listProviders();
    assert.deepEqual(initialList, []);
    assert.equal(await registry.getActiveProvider(), null);

    // Add Anthropic provider
    const anthropic = await registry.setProvider({
      id: 'claude-main',
      type: 'anthropic',
      apiKey: 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz-AAAA',
      defaultModel: 'claude-3-7-sonnet-20250219',
      makeActive: true,
    });

    assert.equal(anthropic.id, 'claude-main');
    assert.equal(anthropic.type, 'anthropic');
    assert.equal(anthropic.active, true);
    assert.equal(anthropic.hasApiKey, true);
    assert.ok(anthropic.maskedApiKey.includes('...'));
    assert.equal(anthropic.maskedApiKey.startsWith('sk-a'), true);
    assert.equal(anthropic.maskedApiKey.endsWith('AAAA'), true);
    assert.equal(anthropic.apiKey, undefined); // plaintext key never exposed on public view

    // Decrypted provider retrieval for runtime execution
    const decrypted = await registry.getDecryptedActiveProvider();
    assert.equal(decrypted.id, 'claude-main');
    assert.equal(decrypted.apiKey, 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz-AAAA');

    // Add second provider: OpenAI
    await registry.setProvider({
      id: 'openai-backup',
      type: 'openai',
      apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      defaultModel: 'gpt-4o-mini',
      makeActive: false,
    });

    const providers = await registry.listProviders();
    assert.equal(providers.length, 2);
    const active = await registry.getActiveProvider();
    assert.equal(active.id, 'claude-main');

    // Switch active provider
    const activated = await registry.setActiveProvider('openai-backup');
    assert.equal(activated.id, 'openai-backup');
    assert.equal(activated.active, true);

    const newActive = await registry.getActiveProvider();
    assert.equal(newActive.id, 'openai-backup');

    const decryptedNewActive = await registry.getDecryptedActiveProvider();
    assert.equal(decryptedNewActive.apiKey, 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');

    // Delete first provider
    const deleted = await registry.deleteProvider('claude-main');
    assert.equal(deleted, true);

    const remaining = await registry.listProviders();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, 'openai-backup');

    // Persistence reload test: create a fresh registry pointing to same file
    const reloadedRegistry = createAiProviderRegistry({
      filePath,
      masterKey: TEST_MASTER_KEY,
    });
    const reloadedProviders = await reloadedRegistry.listProviders();
    assert.equal(reloadedProviders.length, 1);
    assert.equal(reloadedProviders[0].id, 'openai-backup');
    const reloadedDecrypted = await reloadedRegistry.getDecryptedActiveProvider();
    assert.equal(reloadedDecrypted.apiKey, 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('AiProviderRegistry handles Ollama without requiring API key', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-provider-ollama-'));
  const filePath = path.join(tempDir, 'ai-providers.json');

  try {
    const registry = createAiProviderRegistry({
      filePath,
      masterKey: TEST_MASTER_KEY,
    });

    const ollama = await registry.setProvider({
      id: 'local-ollama',
      type: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'llama3.2',
      makeActive: true,
    });

    assert.equal(ollama.id, 'local-ollama');
    assert.equal(ollama.type, 'ollama');
    assert.equal(ollama.hasApiKey, false);

    const decrypted = await registry.getDecryptedActiveProvider();
    assert.equal(decrypted.apiKey, '');
    assert.equal(decrypted.baseUrl, 'http://127.0.0.1:11434');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('AiProviderRegistry enforces validation rules', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ai-provider-validation-'));
  const filePath = path.join(tempDir, 'ai-providers.json');

  try {
    const registry = createAiProviderRegistry({
      filePath,
      masterKey: TEST_MASTER_KEY,
    });

    // Invalid ID
    await assert.rejects(
      async () => registry.setProvider({ id: 'INVALID ID', type: 'openai', apiKey: 'sk-123456789' }),
      (err) => err instanceof AiProviderRegistryError && err.code === 'invalid_ai_provider_id',
    );

    // Unsupported type
    await assert.rejects(
      async () => registry.setProvider({ id: 'test', type: 'unknown_vendor', apiKey: 'sk-123456789' }),
      (err) => err instanceof AiProviderRegistryError && err.code === 'unsupported_ai_provider_type',
    );

    // Missing API key for OpenAI
    await assert.rejects(
      async () => registry.setProvider({ id: 'test', type: 'openai' }),
      (err) => err instanceof AiProviderRegistryError && err.code === 'missing_ai_provider_api_key',
    );

    // Invalid baseUrl
    await assert.rejects(
      async () => registry.setProvider({ id: 'test', type: 'openai', apiKey: 'sk-123456789', baseUrl: 'ftp://bad' }),
      (err) => err instanceof AiProviderRegistryError && err.code === 'invalid_ai_provider_base_url',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
