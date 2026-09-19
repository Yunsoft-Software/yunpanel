import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { renderCronTaskFile } from '@yunpanel/config-templates';
import {
  createWebsiteCronReconciliationProvider,
  WebsiteCronReconciliationError,
} from '../src/website-cron-reconciliation.js';

const localServerId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const taskId = '32345678-1234-4234-8234-123456789012';
const unixUser = 'yunapp-0123456789ab';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createFixtures({ tasks = [], hostFiles = [], cronServiceActive = true } = {}) {
  const websiteCronRegistry = {
    listTasks: async ({ websiteId: filterWebsiteId, serverId }) => {
      return tasks.filter((t) => (!filterWebsiteId || t.websiteId === filterWebsiteId)
        && (!serverId || t.serverId === serverId));
    },
  };

  const websiteCronManager = {
    listManagedFiles: async () => ({
      files: hostFiles,
      cronServiceActive,
    }),
  };

  return { websiteCronRegistry, websiteCronManager };
}

test('WebsiteCronReconciliationProvider reconciles matching website crons as ready', async () => {
  const task = {
    id: taskId,
    websiteId,
    serverId: localServerId,
    applicationId: '42345678-1234-4234-8234-123456789012',
    unixUser,
    name: 'Backup',
    schedule: '0 2 * * *',
    command: '/usr/bin/backup.sh',
    enabled: true,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const rendered = renderCronTaskFile({
    taskId: task.id,
    user: task.unixUser,
    schedule: task.schedule,
    command: task.command,
    enabled: task.enabled,
  });
  const contentSha256 = sha256(rendered);

  const { websiteCronRegistry, websiteCronManager } = createFixtures({
    tasks: [task],
    hostFiles: [{ taskId: task.id, fileName: `yunpanel-${task.id}.cron`, contentSha256 }],
    cronServiceActive: true,
  });

  const provider = createWebsiteCronReconciliationProvider({
    websiteCronRegistry,
    websiteCronManager,
    localServerId,
  });

  const result = await provider.reconcileWebsite(websiteId);
  assert.equal(result.reconciled, true);
  assert.equal(result.cronServiceActive, true);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.ready, 1);
  assert.equal(result.tasks[0].status, 'ready');
  assert.equal(result.tasks[0].hostFileExact, true);
});

test('WebsiteCronReconciliationProvider detects missing_host_file and drifted tasks', async () => {
  const task1 = {
    id: taskId,
    websiteId,
    serverId: localServerId,
    applicationId: '42345678-1234-4234-8234-123456789012',
    unixUser,
    name: 'Backup',
    schedule: '0 2 * * *',
    command: '/usr/bin/backup.sh',
    enabled: true,
    revision: 1,
  };
  const task2 = {
    id: '99999999-1234-4234-8234-123456789012',
    websiteId,
    serverId: localServerId,
    applicationId: '42345678-1234-4234-8234-123456789012',
    unixUser,
    name: 'Sync',
    schedule: '*/5 * * * *',
    command: '/usr/bin/sync.sh',
    enabled: true,
    revision: 1,
  };

  const { websiteCronRegistry, websiteCronManager } = createFixtures({
    tasks: [task1, task2],
    // task1 has drifted content, task2 has no host file
    hostFiles: [{ taskId: task1.id, fileName: `yunpanel-${task1.id}.cron`, contentSha256: 'drifted-sha' }],
    cronServiceActive: true,
  });

  const provider = createWebsiteCronReconciliationProvider({
    websiteCronRegistry,
    websiteCronManager,
    localServerId,
  });

  const result = await provider.reconcileWebsite(websiteId);
  assert.equal(result.reconciled, false);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.ready, 0);
  assert.equal(result.summary.drifted, 1);
  assert.equal(result.summary.missingHostFile, 1);
  assert.equal(result.tasks.find((t) => t.taskId === task1.id).status, 'drifted');
  assert.equal(result.tasks.find((t) => t.taskId === task2.id).status, 'missing_host_file');
});

test('WebsiteCronReconciliationProvider detects inactive service', async () => {
  const task = {
    id: taskId,
    websiteId,
    serverId: localServerId,
    applicationId: '42345678-1234-4234-8234-123456789012',
    unixUser,
    name: 'Backup',
    schedule: '0 2 * * *',
    command: '/usr/bin/backup.sh',
    enabled: true,
    revision: 1,
  };

  const { websiteCronRegistry, websiteCronManager } = createFixtures({
    tasks: [task],
    hostFiles: [],
    cronServiceActive: false,
  });

  const provider = createWebsiteCronReconciliationProvider({
    websiteCronRegistry,
    websiteCronManager,
    localServerId,
  });

  const result = await provider.reconcileWebsite(websiteId);
  assert.equal(result.reconciled, false);
  assert.equal(result.summary.serviceInactive, 1);
  assert.equal(result.tasks[0].status, 'service_inactive');
});

test('WebsiteCronReconciliationProvider detects server-level orphan files', async () => {
  const { websiteCronRegistry, websiteCronManager } = createFixtures({
    tasks: [],
    hostFiles: [{ taskId: taskId, fileName: `yunpanel-${taskId}.cron`, contentSha256: 'abc' }],
    cronServiceActive: true,
  });

  const provider = createWebsiteCronReconciliationProvider({
    websiteCronRegistry,
    websiteCronManager,
    localServerId,
  });

  const serverResult = await provider.reconcileServer();
  assert.equal(serverResult.clean, false);
  assert.equal(serverResult.orphanFiles.length, 1);
  assert.equal(serverResult.orphanFiles[0].taskId, taskId);
});
