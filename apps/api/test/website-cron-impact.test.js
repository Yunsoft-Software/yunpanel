import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  WebsiteCronImpactError,
  createWebsiteCronImpactProvider,
} from '../src/website-cron-impact.js';
import { renderCronTaskFile } from '@yunpanel/config-templates';

const localServerId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const otherWebsiteId = '32345678-1234-4234-8234-123456789012';
const taskId1 = '42345678-1234-4234-8234-123456789012';
const taskId2 = '52345678-1234-4234-8234-123456789012';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function task(overrides = {}) {
  return {
    id: taskId1,
    websiteId,
    serverId: localServerId,
    applicationId: 'app-1',
    unixUser: 'yunapp-123456789012',
    name: 'Backup task',
    schedule: '0 2 * * *',
    command: '/usr/local/bin/backup.sh',
    enabled: true,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function hostFile(taskRecord, overrides = {}) {
  const content = renderCronTaskFile({
    taskId: taskRecord.id,
    user: taskRecord.unixUser,
    schedule: taskRecord.schedule,
    command: taskRecord.command,
    enabled: taskRecord.enabled,
  });
  return {
    taskId: taskRecord.id,
    fileName: `yunpanel-${taskRecord.id}`,
    contentSha256: sha256(content),
    ...overrides,
  };
}

test('createWebsiteCronImpactProvider validates required dependencies', () => {
  assert.throws(
    () => createWebsiteCronImpactProvider(),
    (err) => err instanceof WebsiteCronImpactError && err.code === 'website_cron_dependencies_invalid',
  );
  assert.throws(
    () => createWebsiteCronImpactProvider({ websiteCronRegistry: {} }),
    (err) => err instanceof WebsiteCronImpactError && err.code === 'website_cron_dependencies_invalid',
  );
});

test('websiteCronImpactProvider rejects non-local server context', async () => {
  const provider = createWebsiteCronImpactProvider({
    websiteCronRegistry: { listTasks: async () => [] },
    websiteCronManager: { listManagedFiles: async () => ({ files: [], cronServiceActive: true }) },
    localServerId,
  });

  await assert.rejects(
    provider({ serverId: 'wrong-server-id' }),
    (err) => err instanceof WebsiteCronImpactError && err.code === 'website_cron_local_server_required',
  );
});

test('websiteCronImpactProvider fails closed when cron system service is inactive', async () => {
  const provider = createWebsiteCronImpactProvider({
    websiteCronRegistry: { listTasks: async () => [] },
    websiteCronManager: { listManagedFiles: async () => ({ files: [], cronServiceActive: false }) },
    localServerId,
  });

  await assert.rejects(
    provider({ serverId: localServerId, resourceType: 'website', resourceId: websiteId }),
    (err) => err instanceof WebsiteCronImpactError && err.code === 'website_cron_service_unavailable',
  );
});

test('websiteCronImpactProvider fails closed when an orphan cron file exists on host', async () => {
  const t = task();
  const provider = createWebsiteCronImpactProvider({
    websiteCronRegistry: { listTasks: async () => [] }, // Registry has no tasks
    websiteCronManager: {
      listManagedFiles: async () => ({
        files: [hostFile(t)], // Host has a file
        cronServiceActive: true,
      }),
    },
    localServerId,
  });

  await assert.rejects(
    provider({ serverId: localServerId, resourceType: 'website', resourceId: websiteId }),
    (err) => err instanceof WebsiteCronImpactError && err.code === 'website_cron_orphan_file_detected',
  );
});

test('websiteCronImpactProvider fails closed when host cron file content has drifted', async () => {
  const t = task();
  const provider = createWebsiteCronImpactProvider({
    websiteCronRegistry: { listTasks: async () => [t] },
    websiteCronManager: {
      listManagedFiles: async () => ({
        files: [hostFile(t, { contentSha256: 'a'.repeat(64) })], // Drifted SHA
        cronServiceActive: true,
      }),
    },
    localServerId,
  });

  await assert.rejects(
    provider({ serverId: localServerId, resourceType: 'website', resourceId: websiteId }),
    (err) => err instanceof WebsiteCronImpactError && err.code === 'website_cron_inventory_drift',
  );
});

test('websiteCronImpactProvider fails closed when registry task is missing from host', async () => {
  const t = task();
  const provider = createWebsiteCronImpactProvider({
    websiteCronRegistry: { listTasks: async () => [t] },
    websiteCronManager: {
      listManagedFiles: async () => ({
        files: [], // Missing file
        cronServiceActive: true,
      }),
    },
    localServerId,
  });

  await assert.rejects(
    provider({ serverId: localServerId, resourceType: 'website', resourceId: websiteId }),
    (err) => err instanceof WebsiteCronImpactError && err.code === 'website_cron_host_file_missing',
  );
});

test('websiteCronImpactProvider returns matching tasks for target website and empty for unlinked domain', async () => {
  const t1 = task({ id: taskId1, websiteId, enabled: true });
  const t2 = task({ id: taskId2, websiteId: otherWebsiteId, enabled: false });
  const provider = createWebsiteCronImpactProvider({
    websiteCronRegistry: { listTasks: async () => [t1, t2] },
    websiteCronManager: {
      listManagedFiles: async () => ({
        files: [hostFile(t1), hostFile(t2)],
        cronServiceActive: true,
      }),
    },
    localServerId,
  });

  // Website context
  const websiteResult = await provider({
    serverId: localServerId,
    resourceType: 'website',
    resourceId: websiteId,
  });
  assert.deepEqual(websiteResult, [{ id: taskId1, state: 'enabled' }]);

  // Domain with linked website
  const domainWithSiteResult = await provider({
    serverId: localServerId,
    resourceType: 'domain',
    resourceId: 'domain-1',
    websiteId: otherWebsiteId,
  });
  assert.deepEqual(domainWithSiteResult, [{ id: taskId2, state: 'disabled' }]);

  // Domain without linked website
  const unlinkedDomainResult = await provider({
    serverId: localServerId,
    resourceType: 'domain',
    resourceId: 'domain-2',
    websiteId: null,
  });
  assert.deepEqual(unlinkedDomainResult, []);
});
