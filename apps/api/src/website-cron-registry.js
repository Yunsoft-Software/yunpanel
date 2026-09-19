import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid } from '@yunpanel/shared';

const STORE_VERSION = 1;
const MAX_TASKS_PER_WEBSITE = 100;
const HOSTED_RUNTIME_TYPES = new Set(['static', 'node', 'php']);
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const FIELD_RANGES = Object.freeze([
  Object.freeze({ name: 'minute', min: 0, max: 59 }),
  Object.freeze({ name: 'hour', min: 0, max: 23 }),
  Object.freeze({ name: 'dayOfMonth', min: 1, max: 31 }),
  Object.freeze({ name: 'month', min: 1, max: 12 }),
  Object.freeze({ name: 'dayOfWeek', min: 0, max: 7 }),
]);

export class WebsiteCronRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsiteCronRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new WebsiteCronRegistryError(
      `invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      `${field} is invalid`,
    );
  }
}

function printable(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new WebsiteCronRegistryError(`cron_${field}_invalid`, `${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new WebsiteCronRegistryError(
      `cron_${field}_invalid`,
      `${field} must be a printable string up to ${maxLength} characters`,
    );
  }
  return normalized;
}

function positiveInteger(value, field = 'expectedRevision') {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WebsiteCronRegistryError(
      'cron_revision_invalid',
      `${field} must be a positive integer`,
    );
  }
  return value;
}

function boundedNumber(value, range) {
  if (!/^\d{1,2}$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed >= range.min && parsed <= range.max ? parsed : null;
}

function cronAtom(value, range) {
  const [base, stepText, ...extra] = value.split('/');
  if (extra.length > 0 || !base) return false;
  if (stepText !== undefined) {
    if (!/^\d{1,2}$/u.test(stepText)) return false;
    const step = Number.parseInt(stepText, 10);
    if (step < 1 || step > (range.max - range.min + 1)) return false;
  }
  if (base === '*') return true;
  if (base.includes('-')) {
    const parts = base.split('-');
    if (parts.length !== 2) return false;
    const left = boundedNumber(parts[0], range);
    const right = boundedNumber(parts[1], range);
    return left !== null && right !== null && left <= right;
  }
  return stepText === undefined && boundedNumber(base, range) !== null;
}

function cronField(value, range) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return false;
  const atoms = value.split(',');
  return atoms.length >= 1 && atoms.length <= 32
    && atoms.every((atom) => cronAtom(atom, range));
}

function cronExpression(value) {
  if (typeof value !== 'string' || value.length > 320 || /[\r\n\u0000]/u.test(value)) {
    throw new WebsiteCronRegistryError('cron_schedule_invalid', 'schedule must be a five-field cron expression');
  }
  const fields = value.trim().split(/\s+/u);
  if (fields.length !== FIELD_RANGES.length
    || fields.some((field, index) => !cronField(field, FIELD_RANGES[index]))) {
    throw new WebsiteCronRegistryError(
      'cron_schedule_invalid',
      'schedule must be a valid numeric five-field cron expression',
    );
  }
  return fields.join(' ');
}

function command(value) {
  return printable(value, 'command', 4096);
}

function taskName(value) {
  return printable(value, 'name', 80);
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new WebsiteCronRegistryError('cron_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function websiteBinding(website, websiteId = null) {
  if (!website || typeof website !== 'object' || Array.isArray(website)
    || (websiteId !== null && website.id !== websiteId)
    || !HOSTED_RUNTIME_TYPES.has(website.runtimeType)
    || typeof website.applicationId !== 'string'
    || typeof website.unixUser !== 'string' || !APP_USER_PATTERN.test(website.unixUser)) {
    throw new WebsiteCronRegistryError(
      'cron_website_unsupported',
      'Cron tasks require a hosted Website with a managed site Unix identity',
      409,
    );
  }
  return Object.freeze({
    websiteId: uuid(website.id, 'websiteId'),
    serverId: uuid(website.serverId, 'serverId'),
    applicationId: uuid(website.applicationId, 'applicationId'),
    unixUser: website.unixUser,
  });
}

function publicTask(record) {
  return Object.freeze({ ...record });
}

function normalizePersisted(record) {
  const fields = new Set([
    'id', 'websiteId', 'serverId', 'applicationId', 'unixUser', 'name',
    'schedule', 'command', 'enabled', 'revision', 'createdAt', 'updatedAt',
  ]);
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== fields.size
    || Object.keys(record).some((field) => !fields.has(field))
    || typeof record.enabled !== 'boolean'
    || typeof record.unixUser !== 'string' || !APP_USER_PATTERN.test(record.unixUser)
    || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new WebsiteCronRegistryError('cron_state_invalid', 'Persisted cron task state is invalid', 409);
  }
  let normalizedName;
  let normalizedSchedule;
  let normalizedCommand;
  try {
    normalizedName = taskName(record.name);
    normalizedSchedule = cronExpression(record.schedule);
    normalizedCommand = command(record.command);
  } catch {
    throw new WebsiteCronRegistryError('cron_state_invalid', 'Persisted cron task state is invalid', 409);
  }
  if (normalizedName !== record.name
    || normalizedSchedule !== record.schedule
    || normalizedCommand !== record.command) {
    throw new WebsiteCronRegistryError('cron_state_invalid', 'Persisted cron task state is not canonical', 409);
  }
  return {
    id: uuid(record.id, 'cronTaskId'),
    websiteId: uuid(record.websiteId, 'websiteId'),
    serverId: uuid(record.serverId, 'serverId'),
    applicationId: uuid(record.applicationId, 'applicationId'),
    unixUser: record.unixUser,
    name: normalizedName,
    schedule: normalizedSchedule,
    command: normalizedCommand,
    enabled: record.enabled,
    revision: record.revision,
    createdAt: timestamp(record.createdAt, 'createdAt'),
    updatedAt: timestamp(record.updatedAt, 'updatedAt'),
  };
}

export function createWebsiteCronRegistry({
  filePath = null,
  now = () => Date.now(),
  randomId = randomUUID,
  getWebsite,
} = {}) {
  if (filePath !== null && (typeof filePath !== 'string' || filePath.length < 1)) {
    throw new WebsiteCronRegistryError('cron_store_path_invalid', 'Cron task store path is invalid');
  }
  if (typeof now !== 'function' || typeof randomId !== 'function' || typeof getWebsite !== 'function') {
    throw new WebsiteCronRegistryError('cron_dependencies_invalid', 'Cron task registry dependencies are unavailable', 503);
  }

  let state = { version: STORE_VERSION, tasks: [] };
  let initialized = filePath === null;
  let mutationTail = Promise.resolve();

  function nowIso() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WebsiteCronRegistryError('cron_clock_invalid', 'Cron task registry clock is invalid', 503);
    }
    return new Date(value).toISOString();
  }

  async function persist(nextState) {
    if (filePath !== null) {
      const directory = path.dirname(filePath);
      const temporary = `${filePath}.${process.pid}.tmp`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await rm(temporary, { force: true }).catch(() => {});
      try {
        await writeFile(temporary, `${JSON.stringify(nextState, null, 2)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temporary, filePath);
        await chmod(filePath, 0o600);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    }
    state = nextState;
  }

  async function init() {
    if (initialized) return;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.tasks)
        || Object.keys(parsed).length !== 2
        || Object.keys(parsed).some((field) => !['version', 'tasks'].includes(field))) {
        throw new WebsiteCronRegistryError('cron_store_invalid', 'Cron task store is invalid', 409);
      }
      const tasks = parsed.tasks.map(normalizePersisted);
      if (new Set(tasks.map((entry) => entry.id)).size !== tasks.length) {
        throw new WebsiteCronRegistryError('cron_store_invalid', 'Cron task store contains duplicate identities', 409);
      }
      const counts = new Map();
      for (const task of tasks) {
        counts.set(task.websiteId, (counts.get(task.websiteId) ?? 0) + 1);
        if (counts.get(task.websiteId) > MAX_TASKS_PER_WEBSITE) {
          throw new WebsiteCronRegistryError('cron_store_invalid', 'Cron task store exceeds Website task limits', 409);
        }
      }
      state = { version: STORE_VERSION, tasks };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof WebsiteCronRegistryError) throw error;
        throw new WebsiteCronRegistryError('cron_store_invalid', 'Cron task store could not be read', 409);
      }
      await persist(state);
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  function mutate(transform) {
    const task = mutationTail.catch(() => {}).then(async () => {
      await ensureInitialized();
      const next = structuredClone(state);
      const result = await transform(next);
      await persist(next);
      return result;
    });
    mutationTail = task;
    return task;
  }

  async function currentBinding(websiteId) {
    const id = uuid(websiteId, 'websiteId');
    let website;
    try { website = await getWebsite(id); }
    catch {
      throw new WebsiteCronRegistryError('cron_website_unavailable', 'Website could not be verified', 503);
    }
    if (!website) {
      throw new WebsiteCronRegistryError('cron_website_not_found', 'Website was not found', 404);
    }
    return websiteBinding(website, id);
  }

  function assertBinding(record, binding) {
    if (record.websiteId !== binding.websiteId
      || record.serverId !== binding.serverId
      || record.applicationId !== binding.applicationId
      || record.unixUser !== binding.unixUser) {
      throw new WebsiteCronRegistryError(
        'cron_website_binding_drift',
        'Website execution identity changed after the cron task was created',
        409,
      );
    }
  }

  async function createTask({
    websiteId,
    name,
    schedule,
    command: commandValue,
    enabled = true,
  } = {}) {
    if (typeof enabled !== 'boolean') {
      throw new WebsiteCronRegistryError('cron_enabled_invalid', 'enabled must be a boolean');
    }
    const binding = await currentBinding(websiteId);
    const normalizedName = taskName(name);
    const normalizedSchedule = cronExpression(schedule);
    const normalizedCommand = command(commandValue);
    return mutate(async (next) => {
      const existing = next.tasks.filter((entry) => entry.websiteId === binding.websiteId);
      if (existing.length >= MAX_TASKS_PER_WEBSITE) {
        throw new WebsiteCronRegistryError(
          'cron_task_limit_exceeded',
          `A Website may have at most ${MAX_TASKS_PER_WEBSITE} cron tasks`,
          409,
        );
      }
      const timestampValue = nowIso();
      const record = normalizePersisted({
        id: randomId(),
        ...binding,
        name: normalizedName,
        schedule: normalizedSchedule,
        command: normalizedCommand,
        enabled,
        revision: 1,
        createdAt: timestampValue,
        updatedAt: timestampValue,
      });
      if (next.tasks.some((entry) => entry.id === record.id)) {
        throw new WebsiteCronRegistryError('cron_identity_conflict', 'Cron task identity already exists', 409);
      }
      next.tasks.push(record);
      next.tasks.sort((left, right) => left.id.localeCompare(right.id));
      return publicTask(record);
    });
  }

  async function getTask(taskId) {
    await ensureInitialized();
    const id = uuid(taskId, 'cronTaskId');
    const record = state.tasks.find((entry) => entry.id === id);
    return record ? publicTask(record) : null;
  }

  async function listTasks({ websiteId = null, serverId = null } = {}) {
    await ensureInitialized();
    const normalizedWebsiteId = websiteId === null ? null : uuid(websiteId, 'websiteId');
    const normalizedServerId = serverId === null ? null : uuid(serverId, 'serverId');
    return state.tasks
      .filter((entry) => (normalizedWebsiteId === null || entry.websiteId === normalizedWebsiteId)
        && (normalizedServerId === null || entry.serverId === normalizedServerId))
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(publicTask);
  }

  async function updateTask(taskId, {
    expectedRevision,
    name = undefined,
    schedule = undefined,
    command: commandValue = undefined,
    enabled = undefined,
  } = {}) {
    const id = uuid(taskId, 'cronTaskId');
    const expected = positiveInteger(expectedRevision);
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new WebsiteCronRegistryError('cron_enabled_invalid', 'enabled must be a boolean');
    }
    if (name === undefined && schedule === undefined && commandValue === undefined && enabled === undefined) {
      throw new WebsiteCronRegistryError('cron_update_empty', 'At least one cron task change is required');
    }
    return mutate(async (next) => {
      const index = next.tasks.findIndex((entry) => entry.id === id);
      if (index < 0) throw new WebsiteCronRegistryError('cron_task_not_found', 'Cron task was not found', 404);
      const current = next.tasks[index];
      if (current.revision !== expected) {
        throw new WebsiteCronRegistryError('cron_revision_conflict', 'Cron task changed after it was read', 409);
      }
      const binding = await currentBinding(current.websiteId);
      assertBinding(current, binding);
      const updated = normalizePersisted({
        ...current,
        name: name === undefined ? current.name : taskName(name),
        schedule: schedule === undefined ? current.schedule : cronExpression(schedule),
        command: commandValue === undefined ? current.command : command(commandValue),
        enabled: enabled === undefined ? current.enabled : enabled,
        revision: current.revision + 1,
        updatedAt: nowIso(),
      });
      next.tasks[index] = updated;
      return publicTask(updated);
    });
  }

  async function deleteTask(taskId, { expectedRevision } = {}) {
    const id = uuid(taskId, 'cronTaskId');
    const expected = positiveInteger(expectedRevision);
    return mutate(async (next) => {
      const index = next.tasks.findIndex((entry) => entry.id === id);
      if (index < 0) throw new WebsiteCronRegistryError('cron_task_not_found', 'Cron task was not found', 404);
      const current = next.tasks[index];
      if (current.revision !== expected) {
        throw new WebsiteCronRegistryError('cron_revision_conflict', 'Cron task changed after it was read', 409);
      }
      const binding = await currentBinding(current.websiteId);
      assertBinding(current, binding);
      next.tasks.splice(index, 1);
      return Object.freeze({ deleted: true, taskId: id });
    });
  }

  return Object.freeze({
    init,
    createTask,
    getTask,
    listTasks,
    updateTask,
    deleteTask,
  });
}

export const websiteCronRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  maxTasksPerWebsite: MAX_TASKS_PER_WEBSITE,
  hostedRuntimeTypes: Object.freeze([...HOSTED_RUNTIME_TYPES]),
  fieldRanges: FIELD_RANGES,
  cronExpression,
  websiteBinding,
});
