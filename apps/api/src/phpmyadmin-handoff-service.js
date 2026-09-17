import { createHash, randomBytes } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';
import { assertUuid } from '@yunpanel/shared';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_LIMIT = 100;
const CREDENTIAL_OPERATIONS = new Set([
  OPERATIONS.DATABASE_CREDENTIAL_APPLY,
  OPERATIONS.DATABASE_CREDENTIAL_DELETE,
]);

export class PhpMyAdminHandoffError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PhpMyAdminHandoffError';
    this.code = code;
    this.status = status;
  }
}

function boundedIdentity(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PhpMyAdminHandoffError('phpmyadmin_handoff_identity_invalid', `${field} is invalid`);
  }
  return value;
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new PhpMyAdminHandoffError(
      'phpmyadmin_handoff_identity_invalid',
      `${field} is invalid`,
    );
  }
}

function timestamp(job) {
  for (const field of ['finishedAt', 'startedAt', 'createdAt']) {
    if (typeof job?.[field] === 'string') {
      const parsed = Date.parse(job[field]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return Number.NEGATIVE_INFINITY;
}

function latestCredentialJob(jobs, state) {
  if (!Array.isArray(jobs)) {
    throw new PhpMyAdminHandoffError(
      'phpmyadmin_handoff_job_state_unavailable',
      'Database credential job state is unavailable',
      503,
    );
  }
  return jobs
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => job?.serverId === state.serverId
      && job.resourceType === 'database'
      && job.resourceId === state.databaseName
      && CREDENTIAL_OPERATIONS.has(job.operation))
    .sort((left, right) => timestamp(right.job) - timestamp(left.job) || right.index - left.index)
    .at(0)?.job ?? null;
}

function assertAppliedEvidence(job, state) {
  const result = job?.result;
  if (job?.status !== 'succeeded'
    || job.operation !== OPERATIONS.DATABASE_CREDENTIAL_APPLY
    || !result || typeof result !== 'object' || Array.isArray(result)
    || result.databaseCredentialId !== state.databaseCredentialId
    || result.databaseBindingId !== state.databaseBindingId
    || result.credentialRevision !== state.credentialRevision
    || result.bindingRevision !== state.bindingRevision
    || result.databaseName !== state.databaseName
    || result.username !== state.username
    || result.host !== state.host
    || result.desiredStateSha256 !== state.desiredStateSha256
    || result.applied !== true || result.sideEffects !== true) {
    throw new PhpMyAdminHandoffError(
      'phpmyadmin_handoff_credential_not_applied',
      'The Website database credential is not in a verified applied state',
      409,
    );
  }
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

export function createPhpMyAdminHandoffService({
  databaseBindingRegistry,
  databaseCredentialRegistry,
  databaseCredentialApplyService,
  jobRegistry,
  liveSessions = null,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxHandoffs = DEFAULT_LIMIT,
} = {}) {
  if (!databaseBindingRegistry || typeof databaseBindingRegistry.getBinding !== 'function'
    || !databaseCredentialRegistry || typeof databaseCredentialRegistry.getCredential !== 'function'
    || typeof databaseCredentialRegistry.materializeCredential !== 'function'
    || !databaseCredentialApplyService || typeof databaseCredentialApplyService.previewApply !== 'function'
    || !jobRegistry || typeof jobRegistry.listJobs !== 'function') {
    throw new PhpMyAdminHandoffError(
      'phpmyadmin_handoff_dependencies_invalid',
      'phpMyAdmin handoff dependencies are unavailable',
      503,
    );
  }
  if (liveSessions !== null && typeof liveSessions?.register !== 'function') {
    throw new TypeError('phpMyAdmin handoff live session registry is invalid');
  }
  if (typeof now !== 'function'
    || !Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 60_000
    || !Number.isSafeInteger(maxHandoffs) || maxHandoffs < 1 || maxHandoffs > 1_000) {
    throw new TypeError('phpMyAdmin handoff policy is invalid');
  }

  const handoffs = new Map();

  function remove(key) {
    const record = handoffs.get(key);
    if (!record) return false;
    handoffs.delete(key);
    record.unregister?.();
    return true;
  }

  function prune() {
    const current = now();
    for (const [key, record] of handoffs) if (record.expiresAt <= current) remove(key);
    while (handoffs.size >= maxHandoffs) remove(handoffs.keys().next().value);
  }

  async function resolveState({ serverId, websiteId, credentialId }) {
    const normalizedServerId = uuid(serverId, 'serverId');
    const normalizedWebsiteId = uuid(websiteId, 'websiteId');
    const normalizedCredentialId = uuid(credentialId, 'databaseCredentialId');

    let credential;
    try { credential = await databaseCredentialRegistry.getCredential(normalizedCredentialId); }
    catch {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_credential_unavailable',
        'Database credential could not be read',
        503,
      );
    }
    if (!credential || credential.serverId !== normalizedServerId || credential.websiteId !== normalizedWebsiteId) {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_credential_not_found',
        'Website database credential was not found',
        404,
      );
    }

    let binding;
    try { binding = await databaseBindingRegistry.getBinding(credential.databaseBindingId); }
    catch {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_binding_unavailable',
        'Database binding could not be read',
        503,
      );
    }
    if (!binding || binding.id !== credential.databaseBindingId
      || binding.serverId !== normalizedServerId || binding.websiteId !== normalizedWebsiteId
      || binding.databaseName !== credential.databaseName
      || binding.applicationId !== credential.applicationId
      || binding.unixUser !== credential.siteUnixUser) {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_binding_drift',
        'Database credential ownership no longer matches the Website binding',
        409,
      );
    }

    let preview;
    try { preview = await databaseCredentialApplyService.previewApply(credential.id); }
    catch (error) {
      if (error?.status === 404 || error?.status === 409) throw error;
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_apply_state_unavailable',
        'Database credential apply state could not be verified',
        503,
      );
    }
    if (!preview || preview.databaseCredentialId !== credential.id
      || preview.databaseBindingId !== binding.id || preview.serverId !== normalizedServerId
      || preview.databaseName !== binding.databaseName || preview.username !== credential.username
      || preview.host !== credential.host || preview.expectedCredentialRevision !== credential.revision
      || preview.expectedBindingRevision !== binding.revision
      || typeof preview.desiredStateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(preview.desiredStateSha256)) {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_apply_state_invalid',
        'Database credential apply state is inconsistent',
        503,
      );
    }

    const state = Object.freeze({
      serverId: normalizedServerId,
      websiteId: normalizedWebsiteId,
      databaseCredentialId: credential.id,
      databaseBindingId: binding.id,
      credentialRevision: credential.revision,
      bindingRevision: binding.revision,
      databaseName: binding.databaseName,
      username: credential.username,
      host: credential.host,
      desiredStateSha256: preview.desiredStateSha256,
    });

    let jobs;
    try { jobs = await jobRegistry.listJobs({ serverId: normalizedServerId }); }
    catch {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_job_state_unavailable',
        'Database credential job state could not be read',
        503,
      );
    }
    assertAppliedEvidence(latestCredentialJob(jobs, state), state);
    return state;
  }

  async function issue({ sessionId, userId, serverId, websiteId, credentialId } = {}) {
    const normalizedSessionId = boundedIdentity(sessionId, 'sessionId');
    const normalizedUserId = boundedIdentity(userId, 'userId');
    const state = await resolveState({ serverId, websiteId, credentialId });
    prune();

    const capability = randomBytes(32).toString('base64url');
    const key = digest(capability);
    const expiresAt = now() + ttlMs;
    const record = {
      sessionId: normalizedSessionId,
      userId: normalizedUserId,
      state,
      expiresAt,
      unregister: null,
    };
    handoffs.set(key, record);
    if (liveSessions) {
      record.unregister = liveSessions.register({
        sessionId: normalizedSessionId,
        userId: normalizedUserId,
        terminate: () => remove(key),
      }).unregister;
    }

    return Object.freeze({
      capability,
      expiresAt,
      protocol: 'yunpanel-phpmyadmin-signon-v1',
      target: Object.freeze({
        serverId: state.serverId,
        websiteId: state.websiteId,
        databaseCredentialId: state.databaseCredentialId,
        databaseName: state.databaseName,
      }),
    });
  }

  async function consume(capability) {
    if (typeof capability !== 'string' || !TOKEN_PATTERN.test(capability)) {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_invalid',
        'phpMyAdmin handoff is invalid',
        401,
      );
    }
    const key = digest(capability);
    const record = handoffs.get(key);
    if (!record) {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_invalid',
        'phpMyAdmin handoff is invalid',
        401,
      );
    }
    remove(key);
    if (record.expiresAt <= now()) {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_expired',
        'phpMyAdmin handoff expired',
        401,
      );
    }

    const current = await resolveState({
      serverId: record.state.serverId,
      websiteId: record.state.websiteId,
      credentialId: record.state.databaseCredentialId,
    });
    for (const field of [
      'serverId', 'websiteId', 'databaseCredentialId', 'databaseBindingId',
      'credentialRevision', 'bindingRevision', 'databaseName', 'username', 'host', 'desiredStateSha256',
    ]) {
      if (current[field] !== record.state[field]) {
        throw new PhpMyAdminHandoffError(
          'phpmyadmin_handoff_stale',
          'phpMyAdmin handoff became stale before use',
          409,
        );
      }
    }

    let privateCredential;
    try {
      privateCredential = await databaseCredentialRegistry.materializeCredential(
        current.databaseCredentialId,
        { expectedRevision: current.credentialRevision },
      );
    } catch {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_secret_unavailable',
        'Database credential could not be materialized for phpMyAdmin',
        503,
      );
    }
    if (!privateCredential || privateCredential.id !== current.databaseCredentialId
      || privateCredential.databaseBindingId !== current.databaseBindingId
      || privateCredential.serverId !== current.serverId || privateCredential.websiteId !== current.websiteId
      || privateCredential.databaseName !== current.databaseName
      || privateCredential.username !== current.username || privateCredential.host !== current.host
      || privateCredential.revision !== current.credentialRevision
      || typeof privateCredential.password !== 'string' || privateCredential.password.length < 1) {
      throw new PhpMyAdminHandoffError(
        'phpmyadmin_handoff_secret_invalid',
        'Database credential materialization for phpMyAdmin is invalid',
        503,
      );
    }

    return Object.freeze({
      version: 1,
      protocol: 'yunpanel-phpmyadmin-signon-v1',
      serverId: current.serverId,
      websiteId: current.websiteId,
      databaseCredentialId: current.databaseCredentialId,
      databaseBindingId: current.databaseBindingId,
      credentialRevision: current.credentialRevision,
      bindingRevision: current.bindingRevision,
      databaseName: current.databaseName,
      username: current.username,
      password: privateCredential.password,
      host: current.host,
      expiresAt: record.expiresAt,
    });
  }

  return Object.freeze({ issue, consume, size: () => handoffs.size });
}

export const phpMyAdminHandoffInternals = Object.freeze({
  defaultTtlMs: DEFAULT_TTL_MS,
  defaultLimit: DEFAULT_LIMIT,
  latestCredentialJob,
  assertAppliedEvidence,
});
