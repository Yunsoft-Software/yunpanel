import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeEnvironmentMasterKey } from './application-environment-registry.js';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SUPPORTED_TYPES = new Set(['anthropic', 'openai', 'gemini', 'ollama']);
const DEFAULT_BASE_URLS = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
  ollama: 'http://127.0.0.1:11434',
});
const DEFAULT_MODELS = Object.freeze({
  anthropic: 'claude-3-7-sonnet-20250219',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  ollama: 'llama3.2',
});

export class AiProviderRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AiProviderRegistryError';
    this.code = code;
    this.status = status;
  }
}

function normalizeId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new AiProviderRegistryError('invalid_ai_provider_id', 'AI provider id is invalid');
  }
  return value;
}

function normalizeType(value) {
  if (typeof value !== 'string' || !SUPPORTED_TYPES.has(value)) {
    throw new AiProviderRegistryError('unsupported_ai_provider_type', `AI provider type must be one of: ${[...SUPPORTED_TYPES].join(', ')}`);
  }
  return value;
}

function normalizeBaseUrl(value, type) {
  if (value == null || value === '') return DEFAULT_BASE_URLS[type] ?? null;
  if (typeof value !== 'string') {
    throw new AiProviderRegistryError('invalid_ai_provider_base_url', 'AI provider baseUrl must be a string');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AiProviderRegistryError('invalid_ai_provider_base_url', 'AI provider baseUrl is not a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AiProviderRegistryError('invalid_ai_provider_base_url', 'AI provider baseUrl must use http or https protocol');
  }
  return parsed.origin + (parsed.pathname.replace(/\/+$/, '') || '');
}

function normalizeModel(value, type) {
  if (value == null || value === '') return DEFAULT_MODELS[type] ?? null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\r\n\t]/.test(value)) {
    throw new AiProviderRegistryError('invalid_ai_provider_model', 'AI provider default model is invalid');
  }
  return value.trim();
}

function normalizeApiKey(value, type) {
  if (type === 'ollama' && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 4096 || /[\r\n\t]/.test(value)) {
    throw new AiProviderRegistryError('invalid_ai_provider_api_key', 'AI provider apiKey is invalid');
  }
  return value.trim();
}

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 8) return '********';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function encryptionKey(value) {
  try {
    return normalizeEnvironmentMasterKey(value);
  } catch {
    throw new AiProviderRegistryError('invalid_secret_master_key', 'Secret master key is invalid', 500);
  }
}

function aad(id, type) {
  return Buffer.from(`ai-provider:${id}:${type}`, 'utf8');
}

function encryptToken(key, id, type, value) {
  if (!key) throw new AiProviderRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  if (!value) return { ciphertext: '', iv: '', tag: '' };
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(id, type));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptToken(key, id, type, envelope) {
  if (!envelope || !envelope.ciphertext) return '';
  if (!key) throw new AiProviderRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  try {
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || typeof envelope.ciphertext !== 'string') {
      throw new Error('invalid envelope');
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aad(id, type));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof AiProviderRegistryError) throw error;
    throw new AiProviderRegistryError('secret_decryption_failed', 'Stored AI provider credential could not be decrypted', 500);
  }
}

export function createAiProviderRegistry({
  filePath = '/etc/yunpanel/control-plane/ai-providers.json',
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY,
  now = () => new Date().toISOString(),
} = {}) {
  const resolvedKey = masterKey ? encryptionKey(masterKey) : null;
  const state = new Map();
  let activeProviderId = null;
  let initialized = false;

  function publicProvider(record) {
    return Object.freeze({
      id: record.id,
      type: record.type,
      baseUrl: record.baseUrl,
      defaultModel: record.defaultModel,
      configured: true,
      hasApiKey: Boolean(record.hasApiKey),
      maskedApiKey: record.maskedApiKey ?? '',
      active: record.id === activeProviderId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async function init() {
    if (initialized) return;
    try {
      const raw = await readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && Array.isArray(data.providers)) {
        for (const item of data.providers) {
          if (item && typeof item.id === 'string' && SUPPORTED_TYPES.has(item.type)) {
            state.set(item.id, {
              id: item.id,
              type: item.type,
              baseUrl: item.baseUrl,
              defaultModel: item.defaultModel,
              hasApiKey: item.hasApiKey ?? Boolean(item.encryptedApiKey?.ciphertext),
              maskedApiKey: item.maskedApiKey ?? '',
              encryptedApiKey: item.encryptedApiKey,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            });
          }
        }
        if (typeof data.activeProviderId === 'string' && state.has(data.activeProviderId)) {
          activeProviderId = data.activeProviderId;
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new AiProviderRegistryError('ai_provider_store_corrupt', 'AI provider store could not be read', 500);
      }
    }
    initialized = true;
  }

  async function persist() {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({
      version: STORE_VERSION,
      activeProviderId,
      providers: Array.from(state.values()),
    }, null, 2);
    const tempPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, filePath);
  }

  async function listProviders() {
    await init();
    return Array.from(state.values()).map(publicProvider);
  }

  async function getProvider(id) {
    await init();
    const cleanId = normalizeId(id);
    const record = state.get(cleanId);
    if (!record) return null;
    return publicProvider(record);
  }

  async function setProvider({
    id,
    type,
    apiKey = null,
    baseUrl = null,
    defaultModel = null,
    makeActive = false,
  } = {}) {
    await init();
    const cleanId = normalizeId(id);
    const cleanType = normalizeType(type);
    const cleanBaseUrl = normalizeBaseUrl(baseUrl, cleanType);
    const cleanModel = normalizeModel(defaultModel, cleanType);

    const existing = state.get(cleanId);
    let encryptedKey;
    let hasKey;
    let maskedKey;

    if (apiKey !== null && apiKey !== undefined) {
      const cleanApiKey = normalizeApiKey(apiKey, cleanType);
      encryptedKey = encryptToken(resolvedKey, cleanId, cleanType, cleanApiKey);
      hasKey = Boolean(cleanApiKey);
      maskedKey = maskApiKey(cleanApiKey);
    } else if (existing) {
      encryptedKey = existing.encryptedApiKey;
      hasKey = existing.hasApiKey;
      maskedKey = existing.maskedApiKey;
    } else if (cleanType === 'ollama') {
      encryptedKey = { ciphertext: '', iv: '', tag: '' };
      hasKey = false;
      maskedKey = '';
    } else {
      throw new AiProviderRegistryError('missing_ai_provider_api_key', 'API key is required when adding a new provider');
    }

    const timestamp = now();
    const record = {
      id: cleanId,
      type: cleanType,
      baseUrl: cleanBaseUrl,
      defaultModel: cleanModel,
      hasApiKey: hasKey,
      maskedApiKey: maskedKey,
      encryptedApiKey: encryptedKey,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    state.set(cleanId, record);
    if (makeActive || (!activeProviderId && state.size === 1)) {
      activeProviderId = cleanId;
    }
    await persist();
    return publicProvider(record);
  }

  async function deleteProvider(id) {
    await init();
    const cleanId = normalizeId(id);
    if (!state.has(cleanId)) return false;
    state.delete(cleanId);
    if (activeProviderId === cleanId) {
      activeProviderId = state.keys().next().value ?? null;
    }
    await persist();
    return true;
  }

  async function setActiveProvider(id) {
    await init();
    const cleanId = normalizeId(id);
    if (!state.has(cleanId)) {
      throw new AiProviderRegistryError('provider_not_found', 'AI provider not found', 404);
    }
    activeProviderId = cleanId;
    await persist();
    return publicProvider(state.get(cleanId));
  }

  async function getActiveProvider() {
    await init();
    if (!activeProviderId || !state.has(activeProviderId)) return null;
    const record = state.get(activeProviderId);
    return publicProvider(record);
  }

  async function getDecryptedProvider(id) {
    await init();
    const cleanId = normalizeId(id);
    const record = state.get(cleanId);
    if (!record) return null;
    const plainApiKey = decryptToken(resolvedKey, record.id, record.type, record.encryptedApiKey);
    return Object.freeze({
      id: record.id,
      type: record.type,
      baseUrl: record.baseUrl,
      defaultModel: record.defaultModel,
      apiKey: plainApiKey,
    });
  }

  async function getDecryptedActiveProvider() {
    await init();
    if (!activeProviderId) return null;
    return getDecryptedProvider(activeProviderId);
  }

  return Object.freeze({
    init,
    listProviders,
    getProvider,
    setProvider,
    deleteProvider,
    setActiveProvider,
    getActiveProvider,
    getDecryptedProvider,
    getDecryptedActiveProvider,
  });
}

export const aiProviderRegistryInternals = Object.freeze({
  SUPPORTED_TYPES,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  normalizeId,
  normalizeType,
  normalizeBaseUrl,
  normalizeModel,
  normalizeApiKey,
  maskApiKey,
});
