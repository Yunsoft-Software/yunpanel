import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExternalLifecycleRegistryError } from '../src/external-lifecycle-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-domain-lifecycle-'));
  const filePath = path.join(root, 'mail-domains.json');
  const options = { filePath, now: () => Date.parse('2026-09-12T12:00:00.000Z') };
  const registry = createMailDomainRegistry(options);
  await registry.init();
  t.after(() => rm(root, { recursive: true, force: true }));
  return { registry, options };
}

test('local mail domain status transitions are revisioned and survive reopen', async (t) => {
  const { registry, options } = await fixture(t);
  const created = await registry.createMailDomain({
    domainName: 'example.com',
    webDomainId: null,
    managementMode: 'local',
  });
  assert.equal(created.status, 'disabled');
  assert.equal(created.revision, 1);

  const enabled = await registry.transitionLocalStatus(created.id, {
    expectedRevision: 1,
    status: 'enabled',
  });
  assert.equal(enabled.status, 'enabled');
  assert.equal(enabled.revision, 2);
  assert.equal(enabled.lastObservedAt, null);
  assert.equal(enabled.lastErrorCode, null);

  const reopened = createMailDomainRegistry(options);
  await reopened.init();
  assert.deepEqual(await reopened.getMailDomain(created.id), enabled);

  const disabled = await reopened.transitionLocalStatus(created.id, {
    expectedRevision: 2,
    status: 'disabled',
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.revision, 3);
});

test('local mail domain status transition fails closed on stale, invalid and no-op requests', async (t) => {
  const { registry } = await fixture(t);
  const created = await registry.createMailDomain({
    domainName: 'example.com',
    webDomainId: null,
    managementMode: 'local',
  });
  await registry.transitionLocalStatus(created.id, { expectedRevision: 1, status: 'enabled' });

  await assert.rejects(
    registry.transitionLocalStatus(created.id, { expectedRevision: 1, status: 'disabled' }),
    (error) => error instanceof ExternalLifecycleRegistryError
      && error.code === 'mail_domain_revision_conflict'
      && error.status === 409,
  );
  await assert.rejects(
    registry.transitionLocalStatus(created.id, { expectedRevision: 2, status: 'enabled' }),
    (error) => error instanceof ExternalLifecycleRegistryError
      && error.code === 'mail_domain_status_no_change'
      && error.status === 409,
  );
  await assert.rejects(
    registry.transitionLocalStatus(created.id, { expectedRevision: 2, status: 'ready' }),
    (error) => error instanceof ExternalLifecycleRegistryError
      && error.code === 'invalid_mail_domain_status',
  );
});

test('external mail domains cannot enter the local enabled or disabled lifecycle', async (t) => {
  const { registry } = await fixture(t);
  const external = await registry.createMailDomain({
    domainName: 'example.com',
    webDomainId: null,
    managementMode: 'external',
  });

  await assert.rejects(
    registry.transitionLocalStatus(external.id, { expectedRevision: 1, status: 'enabled' }),
    (error) => error instanceof ExternalLifecycleRegistryError
      && error.code === 'mail_domain_local_status_not_applicable'
      && error.status === 409,
  );
});
