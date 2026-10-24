import { createHash } from 'node:crypto';
import { createDatabaseCredentialEvidenceInspector } from '@yunpanel/host-runtime';
import { OPERATIONS } from '@yunpanel/protocol';
import { isInfrastructureDatabase } from '@yunpanel/shared';

const fail = (message, code = 'website_removal_database_unverified') => Object.assign(new Error(message), { code, status: 409 });
const sameIds = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const snapshot = binding => Object.fromEntries(['id', 'serverId', 'websiteId', 'applicationId', 'unixUser', 'databaseName', 'revision'].map(key => [key, binding[key]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The Website removal journal is the durable owner of each physical deletion.
// Registry records are kept until native SQL user/schema absence is verified.
export function createWebsiteRemovalDatabaseCleanup({ registry, websiteRegistry, databaseBindingRegistry,
  databaseCredentialRegistry, databaseManager, databaseCredentialOperation,
  evidenceInspector = createDatabaseCredentialEvidenceInspector() } = {}) {
  function bindingScope(binding, operation) {
    if (!binding || binding.websiteId !== operation.websiteId || binding.serverId !== operation.serverId
      || binding.applicationId !== operation.applicationId || binding.unixUser !== operation.systemUser
      || !/^[A-Za-z0-9_]{1,64}$/.test(binding.databaseName ?? '') || isInfrastructureDatabase(binding.databaseName)
      || !Number.isSafeInteger(binding.revision) || binding.revision < 1) throw fail('Database binding is outside the removal scope');
    return snapshot(binding);
  }
  function payloadFor(binding, credential) {
    if (credential.databaseBindingId !== binding.id || credential.websiteId !== binding.websiteId
      || credential.applicationId !== binding.applicationId || credential.serverId !== binding.serverId
      || credential.databaseName !== binding.databaseName || credential.siteUnixUser !== binding.unixUser) throw fail('Database credential is outside the removal scope');
    const identity = { version: 1, operation: OPERATIONS.DATABASE_CREDENTIAL_DELETE, databaseCredentialId: credential.id,
      databaseBindingId: binding.id, serverId: binding.serverId, databaseName: binding.databaseName,
      username: credential.username, host: credential.host, privileges: [...credential.privileges],
      expectedCredentialRevision: credential.revision, expectedBindingRevision: binding.revision, passwordUpdatedAt: credential.passwordUpdatedAt };
    return { databaseCredentialId: credential.id, databaseBindingId: binding.id,
      expectedCredentialRevision: credential.revision, expectedBindingRevision: binding.revision,
      desiredStateSha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
  }
  async function currentWebsite(operation) {
    const website = await websiteRegistry.getWebsite(operation.websiteId);
    if (!website || website.id !== operation.websiteId || website.serverId !== operation.serverId
      || website.applicationId !== operation.applicationId || website.unixUser !== operation.systemUser) throw fail('Website identity changed before database retirement');
  }
  async function sources(operation) {
    await currentWebsite(operation);
    const bindings = await databaseBindingRegistry.listBindings({ websiteId: operation.websiteId });
    if (!Array.isArray(bindings) || new Set(bindings.map(binding => binding.id)).size !== bindings.length
      || !sameIds(bindings.map(binding => binding.id), operation.plan?.additional?.databases?.ids ?? [])) throw fail('Database inventory changed after removal preview');
    const entries = [];
    for (const binding of bindings) {
      const owned = bindingScope(binding, operation);
      const credential = await databaseCredentialRegistry.getForBinding(binding.id);
      entries.push({ binding: owned, credential: credential ? payloadFor(binding, credential) : null, evidence: credential ? { version: 1, ...payloadFor(binding, credential), credentialRevision: credential.revision, bindingRevision: binding.revision,
        databaseName: binding.databaseName, username: credential.username, host: credential.host, privileges: [...credential.privileges] } : null, physicalVerified: false, finalized: false });
    }
    for (const entry of entries) if (entry.evidence) { delete entry.evidence.expectedCredentialRevision; delete entry.evidence.expectedBindingRevision; }
    return entries;
  }
  async function inspect({ websiteId, applicationId, serverId, systemUser, plan }) {
    const operation = { websiteId, applicationId, serverId, systemUser, plan };
    await sources(operation);
    if (![databaseManager?.inspect, databaseManager?.dropDatabase, databaseCredentialOperation?.execute, registry?.checkpointStep, evidenceInspector?.inspectDeleted].every(method => typeof method === 'function')) throw fail('Native database retirement is unavailable', 'website_removal_database_unavailable');
    return { ready: true, websiteId };
  }
  async function run({ operation, stepId, authorize = async () => {} }) {
    await currentWebsite(operation);
    const step = operation.steps.find(entry => entry.id === stepId);
    if (!step) throw fail('Database cleanup step is absent');
    let checkpoint = step.result?.databaseCleanup;
    if (!checkpoint) {
      checkpoint = { version: 1, entries: await sources(operation) };
      await registry.checkpointStep(operation.id, stepId, { databaseCleanup: checkpoint });
    }
    if (checkpoint.version !== 1 || !Array.isArray(checkpoint.entries)
      || !sameIds(checkpoint.entries.map(entry => entry.binding?.id), operation.plan?.additional?.databases?.ids ?? [])) throw fail('Database cleanup checkpoint is inconsistent');
    checkpoint = structuredClone(checkpoint);
    const save = () => registry.checkpointStep(operation.id, stepId, { databaseCleanup: checkpoint });
    async function present(name) {
      const inventory = await databaseManager.inspect();
      if (!Array.isArray(inventory?.databases)) throw fail('Native database inventory is unavailable');
      return inventory.databases.some(database => database.name === name);
    }
    async function verifyAccount(entry) {
      if (!entry.credential && !entry.evidence) return;
      const evidence = entry.evidence;
      if (!evidence || evidence.databaseCredentialId !== entry.credential?.databaseCredentialId
        || evidence.databaseBindingId !== entry.binding.id || evidence.databaseName !== entry.binding.databaseName
        || evidence.desiredStateSha256 !== entry.credential.desiredStateSha256
        || evidence.credentialRevision !== entry.credential.expectedCredentialRevision || evidence.bindingRevision !== entry.binding.revision) throw fail('SQL account checkpoint is inconsistent');
      const inspected = await evidenceInspector.inspectDeleted(evidence);
      if (inspected?.deleted !== true || inspected.databaseCredentialId !== evidence.databaseCredentialId
        || inspected.desiredStateSha256 !== evidence.desiredStateSha256) throw fail('Retired SQL account absence is not verified');
    }
    for (const entry of checkpoint.entries) {
      bindingScope(entry.binding, operation);
      if (typeof entry.physicalVerified !== 'boolean' || typeof entry.finalized !== 'boolean' || entry.finalized && !entry.physicalVerified) throw fail('Invalid database deletion checkpoint');
      await authorize(); await currentWebsite(operation);
      const current = await databaseBindingRegistry.getBinding(entry.binding.id);
      if (current && !same(snapshot(current), entry.binding) || !current && !entry.physicalVerified) throw fail('Database binding changed during removal');
      if (!entry.physicalVerified) {
        const credential = await databaseCredentialRegistry.getForBinding(entry.binding.id);
        if (entry.credential) {
          if (!credential || !same(payloadFor(entry.binding, credential), entry.credential)) throw fail('Database credential changed during removal');
          await authorize();
          const result = await databaseCredentialOperation.execute(OPERATIONS.DATABASE_CREDENTIAL_DELETE, entry.credential,
            { jobId: `${operation.id}:${entry.binding.id}`, serverId: operation.serverId, resourceType: 'database', resourceId: entry.binding.databaseName });
          if (result?.deleted !== true || result.databaseCredentialId !== entry.credential.databaseCredentialId
            || result.databaseBindingId !== entry.binding.id || result.desiredStateSha256 !== entry.credential.desiredStateSha256) throw fail('Native SQL account retirement was not verified');
        } else if (credential) throw fail('Unexpected database credential appeared');
        if (await present(entry.binding.databaseName)) {
          await authorize(); await databaseManager.dropDatabase(entry.binding.databaseName);
        }
        if (await present(entry.binding.databaseName)) throw fail('SQL schema still exists');
        await verifyAccount(entry);
        entry.physicalVerified = true; await save();
      } else if (await present(entry.binding.databaseName)) throw fail('A retired database reappeared; do not replay deletion');
      await verifyAccount(entry);
      if (current) {
        const credential = await databaseCredentialRegistry.getForBinding(entry.binding.id);
        if (credential) {
          if (!entry.credential || !same(payloadFor(entry.binding, credential), entry.credential)) throw fail('Credential changed after physical retirement');
          await authorize();
          await databaseCredentialRegistry.deleteCredential(credential.id, { expectedRevision: credential.revision, confirmation: `delete-database-credential:${credential.id}:${credential.revision}` });
        }
        await authorize();
        await databaseBindingRegistry.unbindDatabase(entry.binding.id, { expectedRevision: entry.binding.revision, confirmation: `unbind-database:${entry.binding.id}:${entry.binding.revision}` });
      }
      entry.finalized = true; await save();
    }
    if ((await databaseBindingRegistry.listBindings({ websiteId: operation.websiteId })).length) throw fail('Database bindings remain after retirement');
    return { databaseBindingsCleaned: true, unboundBindings: checkpoint.entries.map(entry => ({ id: entry.binding.id,
      databaseName: entry.binding.databaseName, revision: entry.binding.revision, unbound: true, physicalVerified: true })) };
  }
  return { inspect, run };
}
