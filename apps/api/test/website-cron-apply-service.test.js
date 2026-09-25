import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createWebsiteCronApplyService,
  WebsiteCronApplyServiceError,
} from '../src/website-cron-apply-service.js';

const websiteId = '12345678-1234-4234-8234-123456789012';
const taskId = '22345678-1234-4234-8234-123456789012';
const serverId = '32345678-1234-4234-8234-123456789012';
const applicationId = '42345678-1234-4234-8234-123456789012';
const unixUser = 'yunapp-0123456789ab';
const actor = Object.freeze({
  sessionId: '52345678-1234-4234-8234-123456789012',
  userId: '62345678-1234-4234-8234-123456789012',
  role: 'site_manager',
});

function createFixtures({ runtimeType = 'node' } = {}) {
  const websites = new Map([
    [websiteId, { id: websiteId, serverId, applicationId, unixUser, runtimeType }],
  ]);

  const tasks = new Map();

  const websiteRegistry = {
    getWebsite: async (id) => websites.get(id) ?? null,
  };

  const websiteCronRegistry = {
    createTask: async (input) => {
      const task = {
        id: taskId,
        websiteId: input.websiteId,
        serverId,
        applicationId,
        unixUser,
        name: input.name,
        schedule: input.schedule,
        command: input.command,
        enabled: input.enabled ?? true,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks.set(task.id, task);
      return task;
    },
    getTask: async (id) => tasks.get(id) ?? null,
    updateTask: async (id, input) => {
      const current = tasks.get(id);
      if (!current) throw new Error('not found');
      const updated = {
        ...current,
        name: input.name ?? current.name,
        schedule: input.schedule ?? current.schedule,
        command: input.command ?? current.command,
        enabled: input.enabled ?? current.enabled,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      tasks.set(id, updated);
      return updated;
    },
    deleteTask: async (id) => {
      tasks.delete(id);
      return { deleted: true, taskId: id };
    },
    listTasks: async ({ websiteId: filterWebsiteId }) => {
      return [...tasks.values()].filter((t) => t.websiteId === filterWebsiteId);
    },
  };

  const enqueuedJobs = [];
  const jobRegistry = {
    enqueue: async (jobInput) => {
      const job = { id: `job-${enqueuedJobs.length + 1}`, ...jobInput, status: 'queued' };
      enqueuedJobs.push(job);
      return job;
    },
  };

  return {
    websiteRegistry,
    websiteCronRegistry,
    jobRegistry,
    getEnqueuedJobs: () => enqueuedJobs,
  };
}

test('WebsiteCronApplyService creates a task and enqueues CRON_APPLY job', async () => {
  const f = createFixtures();
  const service = createWebsiteCronApplyService({
    websiteCronRegistry: f.websiteCronRegistry,
    jobRegistry: f.jobRegistry,
    websiteRegistry: f.websiteRegistry,
  });

  const result = await service.createCron({
    websiteId,
    name: 'Nightly Backup',
    schedule: '0 3 * * *',
    command: '/usr/local/bin/backup.sh',
    enabled: true,
  }, actor);

  assert.equal(result.task.id, taskId);
  assert.equal(result.task.name, 'Nightly Backup');
  assert.equal(result.job.operation, OPERATIONS.CRON_APPLY);
  assert.equal(result.job.resourceType, 'website_cron');
  assert.equal(result.job.resourceId, taskId);
  assert.equal(result.job.payload.expectedRevision, 1);
  assert.equal(result.job.payload.authorizationMode, 'user');
  assert.equal(result.job.payload.actorSessionId, actor.sessionId);
  assert.equal(typeof result.job.payload.desiredStateSha256, 'string');
});

test('WebsiteCronApplyService updates a task and enqueues CRON_APPLY job', async () => {
  const f = createFixtures();
  const service = createWebsiteCronApplyService({
    websiteCronRegistry: f.websiteCronRegistry,
    jobRegistry: f.jobRegistry,
    websiteRegistry: f.websiteRegistry,
  });

  await service.createCron({
    websiteId,
    name: 'Backup',
    schedule: '0 3 * * *',
    command: '/usr/local/bin/backup.sh',
  }, actor);

  const updated = await service.updateCron(taskId, {
    expectedRevision: 1,
    schedule: '0 4 * * *',
  }, actor);

  assert.equal(updated.task.revision, 2);
  assert.equal(updated.task.schedule, '0 4 * * *');
  assert.equal(updated.job.operation, OPERATIONS.CRON_APPLY);
  assert.equal(updated.job.payload.expectedRevision, 2);
});

test('WebsiteCronApplyService deletes a task and enqueues CRON_REMOVE job', async () => {
  const f = createFixtures();
  const service = createWebsiteCronApplyService({
    websiteCronRegistry: f.websiteCronRegistry,
    jobRegistry: f.jobRegistry,
    websiteRegistry: f.websiteRegistry,
  });

  await service.createCron({
    websiteId,
    name: 'Backup',
    schedule: '0 3 * * *',
    command: '/usr/local/bin/backup.sh',
  }, actor);

  const result = await service.deleteCron(taskId, { expectedRevision: 1 }, actor);
  assert.equal(result.deleted, false);
  assert.equal(result.job.operation, OPERATIONS.CRON_REMOVE);
  assert.equal(result.job.resourceType, 'website_cron');
  assert.equal(result.job.resourceId, taskId);
});

test('WebsiteCronApplyService rejects unhosted website runtimes', async () => {
  const f = createFixtures({ runtimeType: 'docker' });
  const service = createWebsiteCronApplyService({
    websiteCronRegistry: f.websiteCronRegistry,
    jobRegistry: f.jobRegistry,
    websiteRegistry: f.websiteRegistry,
  });

  await assert.rejects(
    () => service.createCron({
      websiteId,
      name: 'Backup',
      schedule: '0 3 * * *',
      command: '/usr/local/bin/backup.sh',
    }, actor),
    (err) => err instanceof WebsiteCronApplyServiceError && err.code === 'website_cron_unsupported_runtime',
  );
});
