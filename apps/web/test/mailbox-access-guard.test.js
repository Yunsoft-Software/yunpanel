import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailboxAccessPreparation } from '../src/workspace/mailbox-access-preparation.js';
import { createMailboxRemoval } from '../src/workspace/mailbox-removal-controller.js';

const target = {
  id: '11111111-1111-4111-8111-111111111111',
  mailDomainId: '22222222-2222-4222-8222-222222222222',
  address: 'user@example.test',
};

test('client mailbox access flow enforces access preparation before removal', async () => {
  const states = [];
  const client = createMailboxAccessPreparation({
    target,
    request: async (path) => {
      if (path === `/mailboxes/${target.id}`) {
        return {
          id: target.id,
          mailDomainId: target.mailDomainId,
          address: target.address,
          enabled: true,
          revision: 1,
        };
      }
      if (path === `/mail-domains/${target.mailDomainId}`) {
        return {
          id: target.mailDomainId,
          domainName: 'example.test',
          status: 'enabled',
          managementMode: 'local',
          revision: 2,
        };
      }
      throw new Error(`Unexpected path ${path}`);
    },
    onState: (state) => states.push(state),
    isCurrent: () => true,
    canManage: () => true,
  });

  await client.load();
  const state = client.getState();
  assert.equal(state.status, 'ready');
  assert.equal(state.snapshot.enabled, true);
  assert.equal(state.applied, false);
});

test('mailbox removal controller blocks data deletion when mailbox is not confirmed disabled', async () => {
  const controller = createMailboxRemoval({
    target,
    canManage: () => true,
    isCurrent: () => true,
    request: async (path) => {
      if (path === `/mailboxes/${target.id}`) {
        return {
          id: target.id,
          mailDomainId: target.mailDomainId,
          address: target.address,
          enabled: true, // Still enabled
          revision: 1,
        };
      }
      if (path === `/mail-domains/${target.mailDomainId}`) {
        return {
          id: target.mailDomainId,
          domainName: 'example.test',
          managementMode: 'local',
          status: 'enabled',
          revision: 2,
        };
      }
      if (path === `/mailboxes/${target.id}/delete-impact`) {
        return {
          version: 1,
          resourceType: 'mailbox',
          resourceId: target.id,
          address: target.address,
          revision: 1,
          enabled: true,
          sideEffects: false,
          confirmation: `delete-mailbox:${target.address}`,
          safeToDelete: false,
          blockers: [{ code: 'mailbox_enabled', count: 1 }],
          dependencies: {
            quotaConfigured: false,
            forwardingConfigured: false,
            aliasReferences: { count: 0 },
            activeJobs: { count: 0 },
          },
          mailData: {
            present: false,
            bytes: 0,
            snapshotSha256: 'a'.repeat(64),
          },
          requiresDataBackup: false,
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  await controller.refresh();
  const state = controller.getState();
  assert.equal(state.snapshot.enabled, true);
  await controller.prepare('backup');
  assert.equal(controller.getState().approval, null);
});

test('mailbox access preparation keeps delete closed on unverified or uncertain state', async () => {
  const client = createMailboxAccessPreparation({
    target,
    request: async (path, options) => {
      if (options?.method === 'PATCH') {
        throw Object.assign(new Error('Network failure'), { status: 503 });
      }
      if (path === `/mailboxes/${target.id}`) {
        return {
          id: target.id,
          mailDomainId: target.mailDomainId,
          address: target.address,
          enabled: true,
          revision: 1,
        };
      }
      if (path === `/mail-domains/${target.mailDomainId}`) {
        return {
          id: target.mailDomainId,
          domainName: 'example.test',
          status: 'enabled',
          managementMode: 'local',
          revision: 2,
        };
      }
      throw new Error(`Unexpected path ${path}`);
    },
    isCurrent: () => true,
    canManage: () => true,
  });

  await client.load();
  await client.prepare('disable');
  const approval = client.getState().approval;
  assert.ok(approval);

  // Attempt perform which fails
  await client.perform(approval, approval.confirmation);
  const state = client.getState();
  assert.equal(state.applied, false);
  assert.equal(state.status, 'error');
});
