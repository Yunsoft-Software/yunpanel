import { createDatabaseCredentialEvidenceInspector } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { databaseCredentialRegistryInternals } from './database-credential-registry.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const INTENT_FIELDS = new Set([
  'adapter', 'serverId', 'databaseName', 'websiteId', 'applicationId', 'unixUser', 'privileges',
]);

export class WebsiteDatabaseProvisioningError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteDatabaseProvisioningError';
    this.code = code;
    this.status = status;
  }
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function databaseIntent(value, websiteId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== INTENT_FIELDS.size
    || Object.keys(value).some((field) => !INTENT_FIELDS.has(field))
    || value.adapter !== 'website-database'
    || !UUID_PATTERN.test(value.serverId ?? '')
    || !DATABASE_NAME_PATTERN.test(value.databaseName ?? '')
    || !UUID_PATTERN.test(value.websiteId ?? '') || value.websiteId !== websiteId
    || !UUID_PATTERN.test(value.applicationId ?? '')
    || !APP_USER_PATTERN.test(value.unixUser ?? '')
    || !same(value.privileges, databaseCredentialRegistryInternals.defaultPrivileges)) {
    throw new WebsiteDatabaseProvisioningError(
      'website_database_intent_invalid',
      'Website database provisioning intent is invalid',
      400,
    );
  }
  return Object.freeze({
    adapter: value.adapter,
    serverId: value.serverId.toLowerCase(),
    databaseName: value.databaseName,
    websiteId: value.websiteId.toLowerCase(),
    applicationId: value.applicationId.toLowerCase(),
    unixUser: value.unixUser,
    privileges: Object.freeze([...value.privileges]),
  });
}

function assertBinding(binding, intent) {
  if (!binding) return null;
  if (binding.serverId !== intent.serverId || binding.databaseName !== intent.databaseName
    || binding.websiteId !== intent.websiteId || binding.applicationId !== intent.applicationId
    || binding.unixUser !== intent.unixUser || !UUID_PATTERN.test(binding.id ?? '')
    || !Number.isSafeInteger(binding.revision) || binding.revision < 1) {
    throw new WebsiteDatabaseProvisioningError(
      'website_database_binding_conflict',
      'Database ownership does not match the Website provisioning operation',
    );
  }
  return binding;
}

function assertCredential(credential, binding, intent) {
  if (!credential) return null;
  if (!binding || credential.databaseBindingId !== binding.id
    || credential.serverId !== intent.serverId || credential.databaseName !== intent.databaseName
    || credential.websiteId !== intent.websiteId || credential.applicationId !== intent.applicationId
    || credential.siteUnixUser !== intent.unixUser || credential.host !== 'localhost'
    || !UUID_PATTERN.test(credential.id ?? '') || typeof credential.username !== 'string'
    || !same(credential.privileges, intent.privileges)
    || !Number.isSafeInteger(credential.revision) || credential.revision < 1) {
    throw new WebsiteDatabaseProvisioningError(
      'website_database_credential_conflict',
      'Database credential does not match the Website provisioning operation',
    );
  }
  return credential;
}

function inspectInventory(value, intent) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.databases)
    || value.databases.some((entry) => !entry || typeof entry.name !== 'string')) {
    throw new WebsiteDatabaseProvisioningError(
      'website_database_inventory_unavailable',
      'Live database inventory is unavailable',
      503,
    );
  }
  return value.databases.some((entry) => entry.name === intent.databaseName);
}

function assertSecurity(value) {
  if (!value || typeof value !== 'object' || value.ready !== true
    || value.connection?.protocol !== 'socket' || value.connection?.nativeSocketAuth !== true
    || value.hygiene?.anonymousAccountsAbsent !== true
    || value.hygiene?.remoteRootAccountsAbsent !== true
    || value.hygiene?.testSchemaAbsent !== true) {
    throw new WebsiteDatabaseProvisioningError(
      'website_database_security_not_ready',
      'Database security baseline is not ready for Website provisioning',
      503,
    );
  }
  return value;
}

function databaseJobIdentity(job, intent, operation) {
  if (!job || !UUID_PATTERN.test(job.id ?? '') || job.serverId !== intent.serverId
    || job.operation !== operation || job.type !== operation
    || job.resourceType !== 'database' || job.resourceId !== intent.databaseName) {
    throw new WebsiteDatabaseProvisioningError(
      'website_database_job_identity_invalid',
      'Database child job identity is invalid',
      503,
    );
  }
  return job;
}

function successfulDatabaseJob(job, intent, operation) {
  databaseJobIdentity(job, intent, operation);
  const flag = operation === OPERATIONS.DATABASE_CREATE ? 'created' : 'deleted';
  if (job.status !== 'succeeded' || job.result?.database?.name !== intent.databaseName
    || job.result?.[flag] !== true) {
    throw new WebsiteDatabaseProvisioningError(
      'website_database_child_job_failed',
      'Database child job did not complete successfully',
      503,
    );
  }
  return job;
}

function successfulCredentialJob(job, intent, credential, binding, operation) {
  databaseJobIdentity(job, intent, operation);
  const flag = operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY ? 'applied' : 'deleted';
  if (job.status !== 'succeeded' || job.result?.databaseCredentialId !== credential.id
    || job.result?.databaseBindingId !== binding.id
    || job.result?.credentialRevision !== credential.revision
    || job.result?.bindingRevision !== binding.revision
    || job.result?.databaseName !== intent.databaseName || job.result?.[flag] !== true
    || job.result?.sideEffects !== true) {
    throw new WebsiteDatabaseProvisioningError(
      'website_database_credential_job_failed',
      'Database credential child job did not complete successfully',
      503,
    );
  }
  return job;
}

async function defaultWaitForTerminalJob(jobRegistry, job, { timeoutMs = 30_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let current = job;
  while (!TERMINAL_JOB_STATES.has(current.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = await jobRegistry.getJob(job.id);
    if (!current) {
      throw new WebsiteDatabaseProvisioningError(
        'website_database_job_missing',
        'Database child job disappeared before completion',
        503,
      );
    }
  }
  if (!TERMINAL_JOB_STATES.has(current.status)) {
    throw new WebsiteDatabaseProvisioningError(
      'website_database_job_pending',
      'Database child job is still running; retry the provisioning step',
      503,
    );
  }
  return current;
}

function credentialPayload(preview, credential, binding) {
  return Object.freeze({
    databaseCredentialId: credential.id,
    databaseBindingId: binding.id,
    expectedCredentialRevision: preview.expectedCredentialRevision,
    expectedBindingRevision: preview.expectedBindingRevision,
    expectedDesiredStateSha256: preview.desiredStateSha256,
    confirmation: preview.confirmation,
  });
}

function evidenceFrom(bundle, jobs = {}) {
  return Object.freeze({
    satisfied: true,
    adapter: 'website-database',
    databaseName: bundle.databaseName,
    databaseCredentialId: bundle.databaseCredentialId,
    databaseBindingId: bundle.databaseBindingId,
    credentialRevision: bundle.credentialRevision,
    bindingRevision: bundle.bindingRevision,
    desiredStateSha256: bundle.desiredStateSha256,
    username: bundle.username,
    host: bundle.host,
    privileges: Object.freeze([...bundle.privileges]),
    databaseCreateJobId: jobs.databaseCreateJobId ?? null,
    credentialApplyJobId: jobs.credentialApplyJobId ?? null,
  });
}

function bundleFromEvidence(value, intent) {
  if (!value || value.satisfied !== true || value.adapter !== 'website-database'
    || value.databaseName !== intent.databaseName
    || !UUID_PATTERN.test(value.databaseCredentialId ?? '')
    || !UUID_PATTERN.test(value.databaseBindingId ?? '')
    || !Number.isSafeInteger(value.credentialRevision) || value.credentialRevision < 1
    || !Number.isSafeInteger(value.bindingRevision) || value.bindingRevision < 1
    || typeof value.desiredStateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.desiredStateSha256)
    || typeof value.username !== 'string' || value.host !== 'localhost'
    || !same(value.privileges, intent.privileges)) return null;
  return Object.freeze({
    version: 1,
    databaseCredentialId: value.databaseCredentialId,
    databaseBindingId: value.databaseBindingId,
    credentialRevision: value.credentialRevision,
    bindingRevision: value.bindingRevision,
    desiredStateSha256: value.desiredStateSha256,
    databaseName: value.databaseName,
    username: value.username,
    host: value.host,
    privileges: Object.freeze([...value.privileges]),
  });
}

export function createWebsiteDatabaseProvisioningHandler({
  jobRegistry,
  databaseBindingRegistry,
  databaseCredentialRegistry,
  databaseCredentialApplyService,
  databaseCredentialMaterializer,
  databaseInventoryProvider,
  databaseHealthProvider,
  evidenceInspector = createDatabaseCredentialEvidenceInspector(),
  waitForTerminalJob = (job) => defaultWaitForTerminalJob(jobRegistry, job),
} = {}) {
  if (!jobRegistry || typeof jobRegistry.enqueue !== 'function' || typeof jobRegistry.getJob !== 'function'
    || !databaseBindingRegistry || typeof databaseBindingRegistry.getByDatabase !== 'function'
    || typeof databaseBindingRegistry.bindDatabase !== 'function'
    || typeof databaseBindingRegistry.unbindDatabase !== 'function'
    || !databaseCredentialRegistry || typeof databaseCredentialRegistry.getForBinding !== 'function'
    || typeof databaseCredentialRegistry.createCredential !== 'function'
    || typeof databaseCredentialRegistry.deleteCredential !== 'function'
    || typeof databaseCredentialRegistry.listCredentials !== 'function'
    || !databaseCredentialApplyService || typeof databaseCredentialApplyService.previewApply !== 'function'
    || typeof databaseCredentialApplyService.queueApply !== 'function'
    || typeof databaseCredentialApplyService.previewDelete !== 'function'
    || typeof databaseCredentialApplyService.queueDelete !== 'function'
    || !databaseCredentialMaterializer || typeof databaseCredentialMaterializer.materializePublic !== 'function'
    || typeof databaseInventoryProvider !== 'function' || typeof databaseHealthProvider !== 'function'
    || !evidenceInspector || typeof evidenceInspector.inspectApplied !== 'function'
    || typeof evidenceInspector.inspectDeleted !== 'function'
    || typeof waitForTerminalJob !== 'function') {
    throw new WebsiteDatabaseProvisioningError(
      'website_database_dependencies_invalid',
      'Website database provisioning dependencies are invalid',
      503,
    );
  }

  async function state(intent) {
    const [inventory, binding] = await Promise.all([
      databaseInventoryProvider(intent.serverId),
      databaseBindingRegistry.getByDatabase({ serverId: intent.serverId, databaseName: intent.databaseName }),
    ]);
    const normalizedBinding = assertBinding(binding, intent);
    const credential = normalizedBinding
      ? await databaseCredentialRegistry.getForBinding(normalizedBinding.id)
      : null;
    return Object.freeze({
      exists: inspectInventory(inventory, intent),
      binding: normalizedBinding,
      credential: assertCredential(credential, normalizedBinding, intent),
    });
  }

  async function enqueueDatabase(intent, operationId, operation) {
    const action = operation === OPERATIONS.DATABASE_CREATE ? 'create' : 'delete';
    const job = await jobRegistry.enqueue({
      serverId: intent.serverId,
      type: operation,
      operation,
      payload: { name: intent.databaseName },
      resourceType: 'database',
      resourceId: intent.databaseName,
      idempotencyKey: `website.database.${action}:${operationId}`,
    });
    return successfulDatabaseJob(
      await waitForTerminalJob(databaseJobIdentity(job, intent, operation)),
      intent,
      operation,
    );
  }

  async function desiredBundle(intent, credential, binding, operation) {
    const preview = operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY
      ? await databaseCredentialApplyService.previewApply(credential.id)
      : await databaseCredentialApplyService.previewDelete(credential.id);
    const payload = credentialPayload(preview, credential, binding);
    const bundle = await databaseCredentialMaterializer.materializePublic({
      databaseCredentialId: payload.databaseCredentialId,
      databaseBindingId: payload.databaseBindingId,
      expectedCredentialRevision: payload.expectedCredentialRevision,
      expectedBindingRevision: payload.expectedBindingRevision,
      desiredStateSha256: payload.expectedDesiredStateSha256,
    }, operation);
    return Object.freeze({ preview, payload, bundle });
  }

  async function queueCredential(intent, credential, binding, operation) {
    const desired = await desiredBundle(intent, credential, binding, operation);
    const queued = operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY
      ? await databaseCredentialApplyService.queueApply({ credentialId: credential.id, ...desired.payload })
      : await databaseCredentialApplyService.queueDelete({ credentialId: credential.id, ...desired.payload });
    const job = successfulCredentialJob(
      await waitForTerminalJob(databaseJobIdentity(queued.job, intent, operation)),
      intent,
      credential,
      binding,
      operation,
    );
    return Object.freeze({ ...desired, job });
  }

  async function inspect(context = {}) {
    const intent = databaseIntent(context.intent, context.websiteId);
    const current = await state(intent);
    if (!current.exists) return Object.freeze({ satisfied: false, reason: 'website_database_missing' });
    if (!current.binding) return Object.freeze({ satisfied: false, reason: 'website_database_binding_missing' });
    if (!current.credential) return Object.freeze({ satisfied: false, reason: 'website_database_credential_missing' });
    let desired;
    try {
      desired = await desiredBundle(
        intent,
        current.credential,
        current.binding,
        OPERATIONS.DATABASE_CREDENTIAL_APPLY,
      );
    } catch (error) {
      if (error?.code === 'database_job_conflict') {
        return Object.freeze({ satisfied: false, reason: 'website_database_job_pending' });
      }
      throw error;
    }
    const host = await evidenceInspector.inspectApplied(desired.bundle);
    if (host?.applied !== true || host.databaseCredentialId !== current.credential.id
      || host.databaseBindingId !== current.binding.id || host.databaseName !== intent.databaseName
      || host.desiredStateSha256 !== desired.bundle.desiredStateSha256) {
      return Object.freeze({ satisfied: false, reason: 'website_database_grants_not_applied' });
    }
    return evidenceFrom(desired.bundle, {
      databaseCreateJobId: context.evidence?.databaseCreateJobId,
      credentialApplyJobId: context.evidence?.credentialApplyJobId,
    });
  }

  async function apply(context = {}) {
    const intent = databaseIntent(context.intent, context.websiteId);
    assertSecurity(await databaseHealthProvider(intent.serverId));
    const createJob = await enqueueDatabase(intent, context.operationId, OPERATIONS.DATABASE_CREATE);
    let current = await state(intent);
    if (!current.exists) {
      throw new WebsiteDatabaseProvisioningError(
        'website_database_create_unconfirmed',
        'Database create job succeeded but the schema is absent from live inventory',
        503,
      );
    }
    let binding = current.binding;
    if (!binding) {
      binding = await databaseBindingRegistry.bindDatabase({
        serverId: intent.serverId,
        databaseName: intent.databaseName,
        websiteId: intent.websiteId,
        applicationId: intent.applicationId,
        confirmation: `bind-database:${intent.serverId}:${intent.databaseName}:${intent.websiteId}`,
      });
    }
    binding = assertBinding(binding, intent);
    let credential = await databaseCredentialRegistry.getForBinding(binding.id);
    if (!credential) {
      const username = databaseCredentialRegistryInternals.usernameFor(binding.id);
      credential = await databaseCredentialRegistry.createCredential({
        databaseBindingId: binding.id,
        privileges: intent.privileges,
        confirmation: `create-database-credential:${binding.id}:${username}`,
      });
    }
    credential = assertCredential(credential, binding, intent);
    const applied = await queueCredential(
      intent,
      credential,
      binding,
      OPERATIONS.DATABASE_CREDENTIAL_APPLY,
    );
    const host = await evidenceInspector.inspectApplied(applied.bundle);
    if (host?.applied !== true || host.desiredStateSha256 !== applied.bundle.desiredStateSha256) {
      throw new WebsiteDatabaseProvisioningError(
        'website_database_grants_unconfirmed',
        'Database grant application could not be confirmed from live host state',
        503,
      );
    }
    current = await state(intent);
    if (!current.exists || current.binding?.id !== binding.id || current.credential?.id !== credential.id) {
      throw new WebsiteDatabaseProvisioningError(
        'website_database_state_drift',
        'Website database state changed during provisioning',
      );
    }
    return evidenceFrom(applied.bundle, {
      databaseCreateJobId: createJob.id,
      credentialApplyJobId: applied.job.id,
    });
  }

  async function inspectCompensation(context = {}) {
    const intent = databaseIntent(context.intent, context.websiteId);
    const current = await state(intent);
    const related = await databaseCredentialRegistry.listCredentials({
      serverId: intent.serverId,
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
    });
    if (!Array.isArray(related)) {
      throw new WebsiteDatabaseProvisioningError(
        'website_database_credential_state_invalid',
        'Website database credential state is invalid',
        503,
      );
    }
    const dangling = related.some((credential) => credential.databaseName === intent.databaseName);
    const bundle = bundleFromEvidence(context.evidence, intent);
    if (bundle) {
      const host = await evidenceInspector.inspectDeleted(bundle);
      if (host?.deleted !== true) {
        return Object.freeze({ satisfied: false, reason: 'website_database_credential_delete_pending' });
      }
    }
    return Object.freeze({
      satisfied: !current.exists && !current.binding && !current.credential && !dangling,
      ...(current.exists ? { reason: 'website_database_delete_pending' }
        : current.binding || current.credential || dangling
          ? { reason: 'website_database_metadata_cleanup_pending' }
          : {}),
      adapter: 'website-database',
      databaseName: intent.databaseName,
    });
  }

  async function compensate(context = {}) {
    const intent = databaseIntent(context.intent, context.websiteId);
    let current = await state(intent);
    const ownershipProven = Boolean(current.binding) || bundleFromEvidence(context.evidence, intent) !== null;
    if (current.credential) {
      const deleted = await queueCredential(
        intent,
        current.credential,
        current.binding,
        OPERATIONS.DATABASE_CREDENTIAL_DELETE,
      );
      const host = await evidenceInspector.inspectDeleted(deleted.bundle);
      if (host?.deleted !== true) {
        throw new WebsiteDatabaseProvisioningError(
          'website_database_credential_delete_unconfirmed',
          'Database credential deletion could not be confirmed from live host state',
          503,
        );
      }
      await databaseCredentialRegistry.deleteCredential(current.credential.id, {
        expectedRevision: current.credential.revision,
        confirmation: `delete-database-credential:${current.credential.id}:${current.credential.revision}`,
      });
    }
    current = await state(intent);
    if (current.binding) {
      await databaseBindingRegistry.unbindDatabase(current.binding.id, {
        expectedRevision: current.binding.revision,
        confirmation: `unbind-database:${current.binding.id}:${current.binding.revision}`,
      });
    }
    current = await state(intent);
    if (current.exists) {
      if (!ownershipProven) {
        return Object.freeze({
          satisfied: false,
          reason: 'website_database_ownership_evidence_required',
          adapter: 'website-database',
          databaseName: intent.databaseName,
        });
      }
      await enqueueDatabase(intent, context.operationId, OPERATIONS.DATABASE_DELETE);
    }
    return inspectCompensation(context);
  }

  return Object.freeze({ apply, inspect, compensate, inspectCompensation });
}

export const websiteDatabaseProvisioningInternals = Object.freeze({
  databaseIntent,
  assertBinding,
  assertCredential,
  inspectInventory,
  assertSecurity,
  databaseJobIdentity,
  successfulDatabaseJob,
  successfulCredentialJob,
  defaultWaitForTerminalJob,
  credentialPayload,
  evidenceFrom,
  bundleFromEvidence,
});
