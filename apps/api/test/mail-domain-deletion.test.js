import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExternalLifecycleRegistryError } from '../src/external-lifecycle-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';

test('local mail domain deletion requires disabled state, exact revision and typed confirmation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-domain-delete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createMailDomainRegistry({
    filePath: path.join(root, 'mail-domains.json'),
    getWebDomain: async () => null,
  });
  await registry.init();
  const created = await registry.createMailDomain({
    domainName: 'example.com',
    webDomainId: null,
    managementMode: 'local',
  });

  await assert.rejects(
    registry.deleteMailDomain(created.id, {
      expectedRevision: created.revision + 1,
      confirmation: `delete-mail-domain:${created.id}:${created.revision + 1}`,
    }),
    (error) => error instanceof ExternalLifecycleRegistryError
      && error.code === 'mail_domain_revision_conflict'
      && error.status === 409,
  );
  await assert.rejects(
    registry.deleteMailDomain(created.id, {
      expectedRevision: created.revision,
      confirmation: 'delete-mail-domain:wrong:1',
    }),
    (error) => error instanceof ExternalLifecycleRegistryError
      && error.code === 'mail_domain_confirmation_mismatch'
      && error.status === 409,
  );

  const deleted = await registry.deleteMailDomain(created.id, {
    expectedRevision: created.revision,
    confirmation: `delete-mail-domain:${created.id}:${created.revision}`,
  });
  assert.deepEqual(deleted, { id: created.id, resourceType: 'mail_domain', deleted: true });
  assert.equal(await registry.getMailDomain(created.id), null);
});

test('enabled local mail domain cannot be deleted by the registry primitive', async () => {
  const registry = createMailDomainRegistry({ getWebDomain: async () => null });
  const created = await registry.createMailDomain({
    domainName: 'enabled.example',
    webDomainId: null,
    managementMode: 'local',
  });
  const enabled = await registry.transitionLocalStatus(created.id, {
    expectedRevision: created.revision,
    status: 'enabled',
  });
  await assert.rejects(
    registry.deleteMailDomain(enabled.id, {
      expectedRevision: enabled.revision,
      confirmation: `delete-mail-domain:${enabled.id}:${enabled.revision}`,
    }),
    (error) => error instanceof ExternalLifecycleRegistryError
      && error.code === 'mail_domain_disable_required'
      && error.status === 409,
  );
});
