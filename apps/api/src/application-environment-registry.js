import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ApplicationValidationError,
  assertUuid,
  normalizeGitDeploymentCredential,
  normalizeEnvironmentKey,
  normalizeEnvironmentValue,
  parseApplicationEnvironmentImport,
} from '@yunpanel/shared';

const STORE_VERSION = 2;
const ALGORITHM = 'aes-256-gcm';
const GIT_CREDENTIAL_KEY = 'YUNPANEL_GIT_CREDENTIAL';
const GITHUB_WEBHOOK_SECRET_KEY = 'YUNPANEL_GITHUB_WEBHOOK_SECRET';
const INTERNAL_KEYS = new Set([GIT_CREDENTIAL_KEY, GITHUB_WEBHOOK_SECRET_KEY]);
const CHANGE_SOURCES = new Set(['single', 'import_merge', 'import_replace', 'migration']);

export class ApplicationEnvironmentRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ApplicationEnvironmentRegistryError';
    this.code = code;
    this.status = status;
  }
}

function emptyState() {
  return { version: STORE_VERSION, variables: [], environments: [] };
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

function publicWebhookSecret(record) {
  return record ? {
    applicationId: record.applicationId,
    configured: true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  } : {
    configured: false,
    createdAt: null,
    updatedAt: null,
  };
}

function normalizeWebhookSecret(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{32,128}$/.test(value)) {
    throw new ApplicationEnvironmentRegistryError(
      'invalid_github_webhook_secret',
      'GitHub webhook secret must be 32 to 128 printable ASCII characters without spaces',
    );
  }
  return value;
}

function validateEnvironmentRevision(value, field = 'environment revision') {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApplicationEnvironmentRegistryError('invalid_environment_revision', `${field} is invalid`);
  }
  return value;
}

function validateTimestamp(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw new Error(`${field} is invalid`);
  return value;
}

function validateEnvironmentState(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid application environment metadata');
  const applicationId = normalizeApplicationId(record.applicationId);
  const revision = validateEnvironmentRevision(record.revision);
  const appliedRevision = record.appliedRevision === null ? null : validateEnvironmentRevision(record.appliedRevision, 'applied environment revision');
  if (appliedRevision !== null && appliedRevision > revision) throw new Error('applied application environment revision exceeds saved revision');
  const appliedReleaseId = record.appliedReleaseId === null ? null : normalizeApplicationId(record.appliedReleaseId);
  if ((appliedRevision === null) !== (appliedReleaseId === null)) throw new Error('application environment applied metadata is incomplete');
  const lastChange = record.lastChange;
  if (lastChange !== null && (!lastChange || typeof lastChange !== 'object' || Array.isArray(lastChange)
    || !CHANGE_SOURCES.has(lastChange.source)
    || !['added', 'updated', 'deleted'].every((field) => Number.isSafeInteger(lastChange[field]) && lastChange[field] >= 0))) {
    throw new Error('application environment change metadata is invalid');
  }
  const lastChangedAt = validateTimestamp(record.lastChangedAt, 'application environment change timestamp');
  const lastAppliedAt = validateTimestamp(record.lastAppliedAt, 'application environment apply timestamp');
  if ((revision === 0 && (lastChange !== null || lastChangedAt !== null))
    || (revision > 0 && (lastChange === null || lastChangedAt === null))
    || (appliedRevision === null && lastAppliedAt !== null)
    || (appliedRevision !== null && lastAppliedAt === null)) {
    throw new Error('application environment timestamps do not match revision state');
  }
  return {
    applicationId,
    revision,
    appliedRevision,
    appliedReleaseId,
    lastChangedAt,
    lastAppliedAt,
    lastChange: lastChange ? {
      source: lastChange.source,
      added: lastChange.added,
      updated: lastChange.updated,
      deleted: lastChange.deleted,
    } : null,
  };
}

function environmentState(state, applicationId) {
  return state.environments.find((candidate) => candidate.applicationId === applicationId) ?? null;
}

function publicEnvironmentState(record, applicationId, currentReleaseId = null) {
  const revision = record?.revision ?? 0;
  const appliedRevision = record?.appliedRevision ?? null;
  const appliedReleaseId = record?.appliedReleaseId ?? null;
  const appliedToRunningProcess = currentReleaseId !== null
    && appliedReleaseId === currentReleaseId
    && appliedRevision === revision;
  return {
    applicationId,
    savedRevision: revision,
    appliedRevision,
    appliedReleaseId,
    savedOnDisk: true,
    appliedToRunningProcess,
    state: appliedToRunningProcess ? 'applied_to_running_process' : 'saved_on_disk',
    lastChangedAt: record?.lastChangedAt ?? null,
    lastAppliedAt: record?.lastAppliedAt ?? null,
    lastChange: record?.lastChange ? { ...record.lastChange } : null,
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
        if (![1, STORE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.variables)
          || (parsed.version === STORE_VERSION && !Array.isArray(parsed.environments))) {
          throw new Error('unsupported or invalid application environment state');
        }
        if (parsed.version === 1) {
          const byApplication = new Map();
          for (const record of parsed.variables) {
            if (INTERNAL_KEYS.has(record?.key)) continue;
            const applicationId = normalizeApplicationId(record?.applicationId);
            const current = byApplication.get(applicationId) ?? { count: 0, timestamp: null };
            current.count += 1;
            if (typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
              && (!current.timestamp || Date.parse(record.updatedAt) > Date.parse(current.timestamp))) current.timestamp = record.updatedAt;
            byApplication.set(applicationId, current);
          }
          state = {
            version: STORE_VERSION,
            variables: parsed.variables,
            environments: [...byApplication].map(([applicationId, details]) => ({
              applicationId,
              revision: 1,
              appliedRevision: null,
              appliedReleaseId: null,
              lastChangedAt: details.timestamp ?? new Date(now()).toISOString(),
              lastAppliedAt: null,
              lastChange: { source: 'migration', added: details.count, updated: 0, deleted: 0 },
            })),
          };
          await persist();
        } else {
          const environments = parsed.environments.map(validateEnvironmentState);
          if (new Set(environments.map((record) => record.applicationId)).size !== environments.length) {
            throw new Error('duplicate application environment metadata');
          }
          state = { version: STORE_VERSION, variables: parsed.variables, environments };
        }
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

  function recordEnvironmentChange(applicationId, timestamp, change) {
    let metadata = environmentState(state, applicationId);
    if (!metadata) {
      metadata = {
        applicationId,
        revision: 0,
        appliedRevision: null,
        appliedReleaseId: null,
        lastChangedAt: null,
        lastAppliedAt: null,
        lastChange: null,
      };
      state.environments.push(metadata);
    }
    metadata.revision += 1;
    metadata.lastChangedAt = timestamp;
    metadata.lastChange = { ...change };
    return metadata;
  }

  async function setVariable(input) {
    await ensureInitialized();
    const normalized = normalizeVariableInput(input);
    await ensureApplication(normalized.applicationId);
    const timestamp = new Date(now()).toISOString();
    const encrypted = normalized.secret
      ? encryptValue(encryptionKey, normalized.applicationId, normalized.key, normalized.value)
      : null;
    let record = state.variables.find((candidate) => candidate.applicationId === normalized.applicationId && candidate.key === normalized.key);
    const added = !record;
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

    recordEnvironmentChange(normalized.applicationId, timestamp, {
      source: 'single', added: added ? 1 : 0, updated: added ? 0 : 1, deleted: 0,
    });
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

  async function setWebhookSecret({ applicationId, secret } = {}) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    const normalizedSecret = normalizeWebhookSecret(secret);
    await ensureApplication(normalizedApplicationId);
    const encrypted = encryptValue(encryptionKey, normalizedApplicationId, GITHUB_WEBHOOK_SECRET_KEY, normalizedSecret);
    const timestamp = new Date(now()).toISOString();
    let record = state.variables.find((candidate) => candidate.applicationId === normalizedApplicationId
      && candidate.key === GITHUB_WEBHOOK_SECRET_KEY);
    if (!record) {
      record = {
        applicationId: normalizedApplicationId,
        key: GITHUB_WEBHOOK_SECRET_KEY,
        secret: true,
        value: null,
        ciphertext: null,
        iv: null,
        tag: null,
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
    record.updatedAt = timestamp;
    await persist();
    return publicWebhookSecret(record);
  }

  async function webhookSecret(applicationId) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    const record = state.variables.find((candidate) => candidate.applicationId === normalizedApplicationId
      && candidate.key === GITHUB_WEBHOOK_SECRET_KEY) ?? null;
    return publicWebhookSecret(record);
  }

  async function materializeWebhookSecret(applicationId) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    const record = state.variables.find((candidate) => candidate.applicationId === normalizedApplicationId
      && candidate.key === GITHUB_WEBHOOK_SECRET_KEY) ?? null;
    return record ? normalizeWebhookSecret(decryptValue(encryptionKey, record)) : null;
  }

  async function deleteWebhookSecret(applicationId) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    const index = state.variables.findIndex((candidate) => candidate.applicationId === normalizedApplicationId
      && candidate.key === GITHUB_WEBHOOK_SECRET_KEY);
    if (index < 0) {
      throw new ApplicationEnvironmentRegistryError('github_webhook_secret_not_found', 'GitHub webhook secret is not configured', 404);
    }
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
    recordEnvironmentChange(normalizedApplicationId, new Date(now()).toISOString(), {
      source: 'single', added: 0, updated: 0, deleted: 1,
    });
    await persist();
  }

  async function importVariables({ applicationId, content, mode, secret, expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    const currentRevision = environmentState(state, normalizedApplicationId)?.revision ?? 0;
    if (validateEnvironmentRevision(expectedRevision, 'expected environment revision') !== currentRevision) {
      throw new ApplicationEnvironmentRegistryError('environment_revision_conflict', 'Application environment changed after the import was prepared', 409);
    }
    if (!['merge', 'replace'].includes(mode) || typeof secret !== 'boolean') {
      throw new ApplicationEnvironmentRegistryError('invalid_environment_import', 'Environment import mode and visibility are invalid');
    }
    const expectedConfirmation = mode === 'replace'
      ? `replace-environment:${normalizedApplicationId}:${currentRevision}`
      : null;
    if (confirmation !== expectedConfirmation) {
      throw new ApplicationEnvironmentRegistryError('environment_import_confirmation_required', mode === 'replace'
        ? `Confirm replacement with ${expectedConfirmation}`
        : 'Merge imports require a null confirmation');
    }
    let imported;
    try { imported = parseApplicationEnvironmentImport(content); }
    catch (error) {
      if (error instanceof ApplicationValidationError) throw new ApplicationEnvironmentRegistryError(error.code, error.message);
      throw error;
    }

    const existing = state.variables.filter((record) => record.applicationId === normalizedApplicationId
      && !INTERNAL_KEYS.has(record.key));
    const existingByKey = new Map(existing.map((record) => [record.key, record]));
    const timestamp = new Date(now()).toISOString();
    const nextByKey = mode === 'merge' ? new Map(existingByKey) : new Map();
    let added = 0;
    let updated = 0;
    for (const [key, value] of Object.entries(imported)) {
      const previous = existingByKey.get(key) ?? null;
      let unchanged = false;
      if (previous && previous.secret === secret) {
        const previousValue = previous.secret ? decryptValue(encryptionKey, previous) : previous.value;
        unchanged = previousValue === value;
      }
      if (unchanged) {
        nextByKey.set(key, previous);
        continue;
      }
      const encrypted = secret ? encryptValue(encryptionKey, normalizedApplicationId, key, value) : null;
      nextByKey.set(key, {
        applicationId: normalizedApplicationId,
        key,
        secret,
        value: secret ? null : value,
        ciphertext: encrypted?.ciphertext ?? null,
        iv: encrypted?.iv ?? null,
        tag: encrypted?.tag ?? null,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      if (previous) updated += 1;
      else added += 1;
    }
    const deleted = mode === 'replace'
      ? existing.filter((record) => !Object.hasOwn(imported, record.key)).length
      : 0;
    if (nextByKey.size > 100) {
      throw new ApplicationEnvironmentRegistryError('environment_limit_exceeded', 'Application environment supports at most 100 variables');
    }
    if (added + updated + deleted > 0) {
      state.variables = state.variables.filter((record) => record.applicationId !== normalizedApplicationId
        || INTERNAL_KEYS.has(record.key));
      state.variables.push(...nextByKey.values());
      recordEnvironmentChange(normalizedApplicationId, timestamp, {
        source: mode === 'merge' ? 'import_merge' : 'import_replace', added, updated, deleted,
      });
      await persist();
    }
    return {
      variables: await listVariables(normalizedApplicationId),
      environment: await environmentStatus(normalizedApplicationId),
    };
  }

  async function environmentStatus(applicationId, { currentReleaseId = null } = {}) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    const normalizedReleaseId = currentReleaseId === null ? null : normalizeApplicationId(currentReleaseId);
    return publicEnvironmentState(environmentState(state, normalizedApplicationId), normalizedApplicationId, normalizedReleaseId);
  }

  async function markApplied({ applicationId, revision, releaseId } = {}) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    const normalizedReleaseId = normalizeApplicationId(releaseId);
    const normalizedRevision = validateEnvironmentRevision(revision);
    await ensureApplication(normalizedApplicationId);
    const current = environmentState(state, normalizedApplicationId);
    const savedRevision = current?.revision ?? 0;
    if (normalizedRevision > savedRevision || (current && current.appliedRevision !== null && current.appliedRevision > normalizedRevision)) {
      throw new ApplicationEnvironmentRegistryError('environment_revision_conflict', 'Applied environment revision does not match saved state', 409);
    }
    const timestamp = new Date(now()).toISOString();
    const metadata = current ?? {
      applicationId: normalizedApplicationId,
      revision: 0,
      appliedRevision: null,
      appliedReleaseId: null,
      lastChangedAt: null,
      lastAppliedAt: null,
      lastChange: null,
    };
    if (!current) state.environments.push(metadata);
    if (metadata.appliedRevision === normalizedRevision && metadata.appliedReleaseId === normalizedReleaseId) {
      return publicEnvironmentState(metadata, normalizedApplicationId, normalizedReleaseId);
    }
    metadata.appliedRevision = normalizedRevision;
    metadata.appliedReleaseId = normalizedReleaseId;
    metadata.lastAppliedAt = timestamp;
    await persist();
    return publicEnvironmentState(metadata, normalizedApplicationId, normalizedReleaseId);
  }

  async function listVariables(applicationId) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    return state.variables
      .filter((record) => record.applicationId === normalizedApplicationId && !INTERNAL_KEYS.has(record.key))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(publicVariable);
  }

  async function materialize(applicationId, { expectedRevision = null } = {}) {
    await ensureInitialized();
    const normalizedApplicationId = normalizeApplicationId(applicationId);
    await ensureApplication(normalizedApplicationId);
    const savedRevision = environmentState(state, normalizedApplicationId)?.revision ?? 0;
    if (expectedRevision !== null && validateEnvironmentRevision(expectedRevision, 'expected environment revision') !== savedRevision) {
      throw new ApplicationEnvironmentRegistryError('environment_revision_conflict', 'Application environment changed after the job was queued', 409);
    }
    const values = {};
    for (const record of state.variables.filter((candidate) => candidate.applicationId === normalizedApplicationId
      && !INTERNAL_KEYS.has(candidate.key))) {
      values[record.key] = record.secret ? decryptValue(encryptionKey, record) : record.value;
    }
    return values;
  }

  return {
    init,
    setVariable,
    importVariables,
    environmentStatus,
    markApplied,
    setDeploymentCredential,
    deploymentCredential,
    materializeDeploymentCredential,
    deleteDeploymentCredential,
    setWebhookSecret,
    webhookSecret,
    materializeWebhookSecret,
    deleteWebhookSecret,
    deleteVariable,
    listVariables,
    materialize,
    secretStoreConfigured: Boolean(encryptionKey),
  };
}

export const applicationEnvironmentRegistryInternals = Object.freeze({
  gitCredentialKey: GIT_CREDENTIAL_KEY,
  githubWebhookSecretKey: GITHUB_WEBHOOK_SECRET_KEY,
});
