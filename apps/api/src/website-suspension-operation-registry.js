import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE_VERSION = 1;
const STATUSES = new Set([
  'pending',
  'suspending',
  'suspended',
  'partial',
  'failed',
  'resuming',
  'resumed',
  'resume_partial',
  'resume_failed',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export class WebsiteSuspensionOperationRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteSuspensionOperationRegistryError';
    this.code = code;
    this.status = status;
  }
}

function safeId(value, field) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_state_invalid',
      `${field} is invalid`,
      409,
    );
  }
  return value;
}

function safeDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_state_invalid',
      `${field} is invalid`,
      409,
    );
  }
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_state_invalid',
      'Website suspension timestamp is invalid',
      409,
    );
  }
  return value;
}

function safeError(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.code)
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 500) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_state_invalid',
      'Website suspension failure evidence is invalid',
      409,
    );
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function domainOperationEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.domainId !== 'string' || !SAFE_ID.test(entry.domainId)
    || (entry.operationId !== null && (typeof entry.operationId !== 'string' || !SAFE_ID.test(entry.operationId)))
    || !['pending', 'suspending', 'suspended', 'failed', 'resuming', 'resumed', 'resume_failed'].includes(entry.status)) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_state_invalid',
      'Domain operation entry in website suspension is invalid',
      409,
    );
  }
  return Object.freeze({
    domainId: entry.domainId,
    operationId: entry.operationId ?? null,
    status: entry.status,
    error: safeError(entry.error ?? null),
  });
}

function domainOperationsList(list) {
  if (!Array.isArray(list)) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_state_invalid',
      'Domain operations list must be an array',
      409,
    );
  }
  return Object.freeze(list.map(domainOperationEntry));
}

function validateOperation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_state_invalid',
      'Website suspension operation is invalid',
      409,
    );
  }
  const id = safeId(operation.id, 'id');
  const websiteId = safeId(operation.websiteId, 'websiteId');
  const serverId = safeId(operation.serverId, 'serverId');
  if (!Number.isSafeInteger(operation.websiteRevision) || operation.websiteRevision < 1) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_state_invalid',
      'websiteRevision is invalid',
      409,
    );
  }
  const previewDigest = safeDigest(operation.previewDigest, 'previewDigest');
  if (typeof operation.confirmation !== 'string' || !operation.confirmation) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_state_invalid',
      'confirmation is invalid',
      409,
    );
  }
  if (!STATUSES.has(operation.status)) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_state_invalid',
      'status is invalid',
      409,
    );
  }
  const domainOperations = domainOperationsList(operation.domainOperations);
  const error = safeError(operation.error ?? null);
  const createdAt = timestamp(operation.createdAt);
  const updatedAt = timestamp(operation.updatedAt);
  const completedAt = operation.completedAt ? timestamp(operation.completedAt) : null;

  return Object.freeze({
    id,
    websiteId,
    serverId,
    websiteRevision: operation.websiteRevision,
    previewDigest,
    confirmation: operation.confirmation,
    status: operation.status,
    domainOperations,
    error,
    createdAt,
    updatedAt,
    completedAt,
  });
}

export function websiteSuspensionOperationPublicView(operation) {
  if (!operation) return null;
  return Object.freeze({
    id: operation.id,
    websiteId: operation.websiteId,
    serverId: operation.serverId,
    websiteRevision: operation.websiteRevision,
    status: operation.status,
    domainOperations: operation.domainOperations,
    error: operation.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
  });
}

export function createWebsiteSuspensionOperationRegistry({ filePath } = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new WebsiteSuspensionOperationRegistryError(
      'website_suspension_operation_registry_path_invalid',
      'filePath is required',
    );
  }

  let operations = new Map();
  let initialized = false;

  async function ensureInitialized() {
    if (initialized) return;
    try {
      const content = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.operations)) {
        throw new WebsiteSuspensionOperationRegistryError(
          'website_suspension_operation_store_invalid',
          'Website suspension operations store format is invalid',
          500,
        );
      }
      const loaded = new Map();
      for (const raw of parsed.operations) {
        const validated = validateOperation(raw);
        if (loaded.has(validated.id)) {
          throw new WebsiteSuspensionOperationRegistryError(
            'website_suspension_operation_store_invalid',
            'Duplicate operation ID found in store',
            500,
          );
        }
        loaded.set(validated.id, validated);
      }
      operations = loaded;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        operations = new Map();
      } else if (error instanceof WebsiteSuspensionOperationRegistryError) {
        throw error;
      } else {
        throw new WebsiteSuspensionOperationRegistryError(
          'website_suspension_operation_store_invalid',
          'Could not read website suspension operations store',
          500,
        );
      }
    }
    initialized = true;
  }

  async function persist() {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700).catch(() => {});
    const tempFile = `${filePath}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({
      version: STORE_VERSION,
      operations: [...operations.values()],
    }, null, 2);
    await writeFile(tempFile, payload, { encoding: 'utf8', mode: 0o600 });
    await rename(tempFile, filePath);
  }

  async function create({
    id = randomUUID(),
    websiteId,
    serverId,
    websiteRevision,
    previewDigest,
    confirmation,
    domainOperations = [],
  } = {}) {
    await ensureInitialized();
    const now = new Date().toISOString();
    const operation = validateOperation({
      id,
      websiteId,
      serverId,
      websiteRevision,
      previewDigest,
      confirmation,
      status: 'pending',
      domainOperations,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    if (operations.has(operation.id)) {
      throw new WebsiteSuspensionOperationRegistryError(
        'website_suspension_operation_conflict',
        'Website suspension operation already exists',
        409,
      );
    }
    operations.set(operation.id, operation);
    await persist();
    return operation;
  }

  async function get(id) {
    await ensureInitialized();
    return operations.get(id) ?? null;
  }

  async function listForWebsite(websiteId) {
    await ensureInitialized();
    return [...operations.values()]
      .filter((op) => op.websiteId === websiteId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function listInterrupted() {
    await ensureInitialized();
    return [...operations.values()]
      .filter((op) => ['suspending', 'resuming'].includes(op.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function update(id, changes = {}) {
    await ensureInitialized();
    const current = operations.get(id);
    if (!current) {
      throw new WebsiteSuspensionOperationRegistryError(
        'website_suspension_operation_not_found',
        'Website suspension operation not found',
        404,
      );
    }
    const now = new Date().toISOString();
    const updated = validateOperation({
      ...current,
      ...changes,
      id: current.id,
      websiteId: current.websiteId,
      serverId: current.serverId,
      createdAt: current.createdAt,
      updatedAt: now,
    });
    operations.set(id, updated);
    await persist();
    return updated;
  }

  return Object.freeze({
    init: ensureInitialized,
    create,
    get,
    listForWebsite,
    listInterrupted,
    update,
  });
}
