import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWebsiteCronRegistry,
  WebsiteCronRegistryError,
  websiteCronRegistryInternals,
} from '../src/website-cron-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const otherWebsiteId = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const applicationId = '2dd93f8e-23aa-4e2e-b65c-f53eb29558dd';
const otherApplicationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const taskId = '07b0be89-f855-4c61-8132-3a73eb39888b';
const taskId2 = '0a5317c4-bfbc-41e1-a7fa-17c43c61bd36';

function website({
  id = websiteId,
  appId = applicationId,
  unixUser = 'yunapp-0123456789ab',
  runtimeType = 'node',
} = {}) {
  return {
    id,
    serverId,
    name: 'Example',
    applicationId: appId,
    runtimeType,
    documentRoot: `/var/lib/yunpanel/apps/${appId}/current`,
    unixUser,
    revision: 1,
  };
}

function clock(start = Date.parse('2026-09-19T12:00:00.000Z')) {
  let value = start;
  return {
    now: () => value,
    advance: (milliseconds = 1000) => { value += milliseconds; },
  };
}

test('Website cron registry creates canonical Website-scoped tasks and lists by owner', async () => {
  const c = clock();
  const websites = new Map([
    [websiteId, website()],
    [otherWebsiteId, website({
      id: otherWebsiteId,
      appId: otherApplicationId,
      unixUser: 'yunapp-fedcba987654',
      runtimeType: 'php',
    })],
  ]);
  const ids = [taskId, taskId2];
  const registry = createWebsiteCronRegistry({
    now: c.now,
    randomId: () => ids.shift(),
    getWebsite: async (id) => websites.get(id) ?? null,
  });

  const first = await registry.createTask({
    websiteId,
    name: ' Queue worker ',
    schedule: '*/5   * * * *',
    command: 'php artisan schedule:run',
  });
  c.advance();
  const second = await registry.createTask({
    websiteId: otherWebsiteId,
    name: 'Report',
    schedule: '15 2 * * 1-5',
    command: 'node scripts/report.js',
    enabled: false,
  });

  assert.deepEqual(first, {
    id: taskId,
    websiteId,
    serverId,
    applicationId,
    unixUser: 'yunapp-0123456789ab',
    name: 'Queue worker',
    schedule: '*/5 * * * *',
    command: 'php artisan schedule:run',
    enabled: true,
    revision: 1,
    createdAt: '2026-09-19T12:00:00.000Z',
    updatedAt: '2026-09-19T12:00:00.000Z',
  });
  assert.equal(second.enabled, false);
  assert.deepEqual(await registry.listTasks({ websiteId }), [first]);
  assert.deepEqual(await registry.listTasks({ serverId }), [first, second]);
  assert.deepEqual(await registry.getTask(taskId), first);
});

test('Website cron registry validates numeric five-field cron syntax and hosted Website identity', async () => {
  const registry = createWebsiteCronRegistry({
    randomId: () => taskId,
    getWebsite: async (id) => id === websiteId ? website() : null,
  });

  for (const schedule of [
    '* * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 8',
    '*/0 * * * *',
    '5-2 * * * *',
    'JAN * * * *',
  ]) {
    await assert.rejects(
      registry.createTask({
        websiteId,
        name: 'Bad schedule',
        schedule,
        command: 'echo ok',
      }),
      (error) => error instanceof WebsiteCronRegistryError
        && error.code === 'cron_schedule_invalid',
    );
  }

  const unsupported = createWebsiteCronRegistry({
    randomId: () => taskId,
    getWebsite: async () => website({ runtimeType: 'proxy', appId: null, unixUser: null }),
  });
  await assert.rejects(
    unsupported.createTask({
      websiteId,
      name: 'Unsupported',
      schedule: '* * * * *',
      command: 'echo ok',
    }),
    (error) => error instanceof WebsiteCronRegistryError
      && error.code === 'cron_website_unsupported',
  );
});

test('Website cron registry updates with optimistic revision and fails closed on Website binding drift', async () => {
  const c = clock();
  let currentWebsite = website();
  const registry = createWebsiteCronRegistry({
    now: c.now,
    randomId: () => taskId,
    getWebsite: async () => currentWebsite,
  });
  const created = await registry.createTask({
    websiteId,
    name: 'Worker',
    schedule: '0 * * * *',
    command: 'node worker.js',
  });

  c.advance();
  const updated = await registry.updateTask(taskId, {
    expectedRevision: created.revision,
    schedule: '0 */2 * * *',
    enabled: false,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.schedule, '0 */2 * * *');
  assert.equal(updated.enabled, false);
  assert.equal(updated.updatedAt, '2026-09-19T12:00:01.000Z');

  await assert.rejects(
    registry.updateTask(taskId, {
      expectedRevision: 1,
      name: 'Stale',
    }),
    (error) => error instanceof WebsiteCronRegistryError
      && error.code === 'cron_revision_conflict',
  );

  currentWebsite = website({
    appId: otherApplicationId,
    unixUser: 'yunapp-fedcba987654',
  });
  await assert.rejects(
    registry.updateTask(taskId, {
      expectedRevision: 2,
      enabled: true,
    }),
    (error) => error instanceof WebsiteCronRegistryError
      && error.code === 'cron_website_binding_drift',
  );
});

test('Website cron registry persists canonical state and deletes only the expected revision', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-cron-'));
  const filePath = path.join(directory, 'cron.json');
  const c = clock();
  const getWebsite = async () => website();
  const registry = createWebsiteCronRegistry({
    filePath,
    now: c.now,
    randomId: () => taskId,
    getWebsite,
  });
  await registry.init();
  const created = await registry.createTask({
    websiteId,
    name: 'Cleanup',
    schedule: '30 3 * * 0',
    command: 'node cleanup.js',
  });

  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(stored.version, websiteCronRegistryInternals.storeVersion);
  assert.equal(stored.tasks.length, 1);
  assert.equal(stored.tasks[0].command, 'node cleanup.js');

  const reloaded = createWebsiteCronRegistry({ filePath, now: c.now, getWebsite });
  await reloaded.init();
  assert.deepEqual(await reloaded.getTask(taskId), created);

  await assert.rejects(
    reloaded.deleteTask(taskId, { expectedRevision: 2 }),
    (error) => error instanceof WebsiteCronRegistryError
      && error.code === 'cron_revision_conflict',
  );
  assert.deepEqual(
    await reloaded.deleteTask(taskId, { expectedRevision: 1 }),
    { deleted: true, taskId },
  );
  assert.equal(await reloaded.getTask(taskId), null);
});
