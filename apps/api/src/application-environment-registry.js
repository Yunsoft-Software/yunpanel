import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ApplicationValidationError,
  assertUuid,
  normalizeGitDeploymentCredential,
  normalizeEnvironmentKey,
  normalizeEnvironmentValue,
} from '@yunpanel/shared';

const STORE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const GIT_CREDENTIAL_KEY = 'YUNPANEL_GIT_CREDENTIAL';

export class ApplicationEnvironmentRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ApplicationEnvironmentRegistryError';
    this.code = code;
    this.status = status;
  }
}

function emptyState() {
  return { version: STORE_VERSION, variables: [] };
}

export function normalizeEnvironmentMasterKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw new ApplicationEnvironmentRegistryError('invalid_secret_master_key', 'Secret master key must be exactly 32 bytes', 500);
    return Buffer.from(value);
  }
  if (typeof value !== 'string' || !value) return null;

  let decoded;
  if (/^[a-f0-9]{64}$/i.test(value)) decoded = Buffer.from(value, 'hex');
  else {
    try {
      decoded = Buffer.from(value, 'base64');
    } catch {
      decoded = null;
    }
  }
  if (!decoded || decoded.length !== 32) {
    throw new ApplicationEnvironmentRegistryError('invalid_secret_master_key', 'YUNPANEL_SECRET_MASTER_KEY must encode exactly 32 bytes', 500);
  }
  return decoded;
}

function normalizeApplicationId(value) {
  try {
    return assertUuid(value, 'applicationId');
  } catch {
    throw new ApplicationEnvironmentRegistryError('invalid_application_id', 'applicationId is invalid');
  }
}

function normalizeVariableInput({ applicationId, key, value, secret }) {
  try {
    return {
      applicationId: normalizeApplicationId(applicationId),
      key: normalizeEnvironmentKey(key),
      value: normalizeEnvironmentValue(value),
      secret: secret === true,
    };
  } catch (error) {
    if (error instanceof ApplicationEnvironmentRegistryError) throw error;
    if (error instanceof ApplicationValidationError) throw new ApplicationEnvironmentRegistryError(error.code, error.message);
    throw error;
  }
}

function publicVariable(record) {
  return {
    applicationId: record.applicationId,
    key: record.key,
    secret: record.secret === true,
    value: record.secret === true ? undefined : record.value,
    hasValue: true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function publicDeploymentCredential(record) {
  return record ? {
    applicationId: record.applicationId,
    configured: true,
    type: record.credentialType,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  } : {
    configured: false,
    type: null,
    createdAt: null,
    updatedAt: null,
  };
}

function encryptValue(masterKey, applicationId, key, value) {
  if (!masterKey) {
    throw new ApplicationEnvironmentRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  cipher.setAAD(Buffer.from(`${applicationId}:${key}`, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptValue(masterKey, record) {
  if (!masterKey) {
    throw new ApplicationEnvironmentRegistryError('secret_store_unavailable', 'Secret master key is not configured', 503);
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, masterKey, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${record.applicationId}:${record.key}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ApplicationEnvironmentRegistryError('secret_decryption_failed', 'Stored application secret could not be decrypted', 500);
  }
}

export function createApplicationEnvironmentRegistry({
  filePath = null,
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
  now = () => Date.now(),
  applicationExists = async () => true,
} = {}) {
  const encryptionKey = normalizeEnvironmentMasterKey(masterKey);
  let state = emptyState();
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const snapshot = JSON.stringify(state, null, 2);
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    });
    return writeChain;
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.variables)) throw new Error('unsupported or invalid application environment state');
        state = parsed;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function ensureApplication(applicationId) {
    if (!(await applicationExists(applicationId))) {
      throw new ApplicationEnvironmentRegistryError('application_not_found', 'Application not found', 404);
    }
  }

  async function setVariable(input) {
    await ensureInitialized();
    const normalized = normalizeVariableInput(input);
    await ensureApplication(normalized.applicationId);
    const timestamp = new Date(now()).toISOString();
    let record = state.variables.find((candidate) => candidate.applicationId === normalized.applicationId && candidate.key === normalized.key);
    if (!record) {
      record = {
        applicationId: normalized.applicationId,
        key: normalized.key,
        secret: false,
        value: null,
        ciphertext: null,
        iv: null,
        tag: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.variables.push(record);
    }

    record.secret = normalized.secret;
    record.updatedAt = timestamp;
    if (normalized.secret) {
      const encrypted = encryptValue(encryptionKey, normalized.applicationId, normalized.key, normalized.value);
      record.value = null;
      record.ciphertext = encrypted.ciphertext;
      record.iv = encrypted.iv;
      record.tag = encrypted.tag;
    } else {
      record.value = normalized.value;
      record.ciphertext = null;
      record.iv = null;
      record.tag = null;
    }

    await persist();
    return publicVariable(record);
  }

  async function setDeploymentCredential({ applicationId, credential } = {}) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    let normalized;
    try { normalized = normalizeGitDeploymentCredential(credential, { nullable: false }); }
    catch (error) {
      if (error instanceof ApplicationValidationError) throw new ApplicationEnvironmentRegistryError(error.code, error.message);
      throw error;
    }
    await ensureApplication(normalizedApplicationId);
    const encrypted = encryptValue(encryptionKey, normalizedApplicationId, GIT_CREDENTIAL_KEY, JSON.stringify(normalized));
    const timestamp = new Date(now()).toISOString();
    let record = state.variables.find((candidate) => candidate.applicationId === normalizedApplicationId
      && candidate.key === GIT_CREDENTIAL_KEY);
    if (!record) {
      record = {
        applicationId: normalizedApplicationId,
        key: GIT_CREDENTIAL_KEY,
        secret: true,
        value: null,
        ciphertext: null,
        iv: null,
        tag: null,
        credentialType: normalized.type,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.variables.push(record);
    }
    record.secret = true;
    record.value = null;
    record.ciphertext = encrypted.ciphertext;
    record.iv = encrypted.iv;
    record.tag = encrypted.tag;
    record.credentialType = normalized.type;
    record.updatedAt = timestamp;
    await persist();
    return publicDeploymentCredential(record);
  }

  async function deploymentCredential(applicationId) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    const record = state.variables.find((candidate) => candidate.applicationId === normalizedApplicationId
      && candidate.key === GIT_CREDENTIAL_KEY) ?? null;
    if (record && !['github_token', 'ssh_deploy_key'].includes(record.credentialType)) {
      throw new ApplicationEnvironmentRegistryError('git_credential_state_invalid', 'Stored Git deployment credential metadata is invalid', 500);
    }
    return publicDeploymentCredential(record);
  }

  async function materializeDeploymentCredential(applicationId) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    const record = state.variables.find((candidate) => candidate.applicationId === normalizedApplicationId
      && candidate.key === GIT_CREDENTIAL_KEY) ?? null;
    if (!record) return null;
    try {
      const value = normalizeGitDeploymentCredential(JSON.parse(decryptValue(encryptionKey, record)), { nullable: false });
      if (value.type !== record.credentialType) throw new Error('credential type mismatch');
      return value;
    } catch (error) {
      if (error instanceof ApplicationEnvironmentRegistryError) throw error;
      throw new ApplicationEnvironmentRegistryError('git_credential_decryption_failed', 'Stored Git deployment credential could not be decrypted', 500);
    }
  }

  async function deleteDeploymentCredential(applicationId) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    const index = state.variables.findIndex((candidate) => candidate.applicationId === normalizedApplicationId
      && candidate.key === GIT_CREDENTIAL_KEY);
    if (index < 0) throw new ApplicationEnvironmentRegistryError('git_credential_not_found', 'Git deployment credential is not configured', 404);
    state.variables.splice(index, 1);
    await persist();
  }

  async function deleteVariable(applicationId, key) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    let normalizedKey;
    try {
      normalizedKey = normalizeEnvironmentKey(key);
    } catch (error) {
      if (error instanceof ApplicationValidationError) throw new ApplicationEnvironmentRegistryError(error.code, error.message);
      throw error;
    }
    await ensureApplication(normalizedApplicationId);
    const index = state.variables.findIndex((candidate) => candidate.applicationId === normalizedApplicationId && candidate.key === normalizedKey);
    if (index < 0) throw new ApplicationEnvironmentRegistryError('environment_variable_not_found', 'Environment variable not found', 404);
    state.variables.splice(index, 1);
    await persist();
  }

  async function listVariables(applicationId) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    return state.variables
      .filter((record) => record.applicationId === normalizedApplicationId && record.key !== GIT_CREDENTIAL_KEY)
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(publicVariable);
  }

  async function materialize(applicationId) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    const values = {};
    for (const record of state.variables.filter((candidate) => candidate.applicationId === normalizedApplicationId
      && candidate.key !== GIT_CREDENTIAL_KEY)) {
      values[record.key] = record.secret ? decryptValue(encryptionKey, record) : record.value;
    }
    return values;
  }

  return {
    init,
    setVariable,
    setDeploymentCredential,
    deploymentCredential,
    materializeDeploymentCredential,
    deleteDeploymentCredential,
    deleteVariable,
    listVariables,
    materialize,
    secretStoreConfigured: Boolean(encryptionKey),
  };
}

export const applicationEnvironmentRegistryInternals = Object.freeze({ gitCredentialKey: GIT_CREDENTIAL_KEY });
