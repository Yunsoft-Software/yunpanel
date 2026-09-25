import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mountWebsiteCronRoutes, WebsiteCronHttpError } from '../src/website-cron-http.js';

const websiteId = '12345678-1234-4234-8234-123456789012';
const taskId = '22345678-1234-4234-8234-123456789012';

function createApp({ serviceOverrides = {}, authOverride = null } = {}) {
  const app = express();
  app.use(express.json());

  // Simulate authentication
  app.use((req, res, next) => {
    req.auth = authOverride ?? {
      id: '32345678-1234-4234-8234-123456789012',
      user: { id: '42345678-1234-4234-8234-123456789012', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });

  const defaultService = {
    listCrons: async (id) => ({
      websiteId: id,
      reconciled: true,
      tasks: [{ id: taskId, websiteId: id, name: 'Backup' }],
    }),
    getCron: async (id) => ({
      id,
      websiteId,
      name: 'Backup',
      revision: 1,
    }),
    createCron: async (input, actor) => ({
      actor,
      task: { id: taskId, ...input, revision: 1 },
      job: { id: 'job-1', operation: 'cron.apply' },
    }),
    updateCron: async (id, input, actor) => ({
      actor,
      task: { id, websiteId, ...input, revision: 2 },
      job: { id: 'job-2', operation: 'cron.apply' },
    }),
    deleteCron: async (id, _input, actor) => ({
      actor,
      taskId: id,
      deleted: true,
      job: { id: 'job-3', operation: 'cron.remove' },
    }),
    ...serviceOverrides,
  };

  mountWebsiteCronRoutes(app, { websiteCronApplyService: defaultService });

  app.use((err, req, res, _next) => {
    if (err instanceof WebsiteCronHttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    return res.status(500).json({ error: { code: 'internal_error', message: err.message } });
  });

  return app;
}

async function request(app, method, path, body = undefined) {
  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}${path}`;
      try {
        const response = await fetch(url, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        const json = await response.json();
        server.close(() => resolve({ status: response.status, body: json }));
      } catch (err) {
        server.close(() => resolve({ status: 500, error: err }));
      }
    });
  });
}

test('GET /api/websites/:websiteId/crons returns cron list', async () => {
  const app = createApp();
  const res = await request(app, 'GET', `/api/websites/${websiteId}/crons`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.reconciled, true);
  assert.equal(res.body.data.tasks.length, 1);
});

test('POST /api/websites/:websiteId/crons creates a cron task', async () => {
  const app = createApp();
  const res = await request(app, 'POST', `/api/websites/${websiteId}/crons`, {
    name: 'Backup',
    schedule: '0 3 * * *',
    command: '/usr/bin/backup.sh',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.task.name, 'Backup');
  assert.equal(res.body.data.job.operation, 'cron.apply');
  assert.equal(res.body.data.actor.userId, '42345678-1234-4234-8234-123456789012');
});

test('POST /api/websites/:websiteId/crons rejects missing required fields', async () => {
  const app = createApp();
  const res = await request(app, 'POST', `/api/websites/${websiteId}/crons`, {
    name: 'Backup',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'cron_create_input_invalid');
});

test('GET /api/websites/:websiteId/crons/:cronId returns task detail', async () => {
  const app = createApp();
  const res = await request(app, 'GET', `/api/websites/${websiteId}/crons/${taskId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.id, taskId);
});

test('PATCH /api/websites/:websiteId/crons/:cronId updates task', async () => {
  const app = createApp();
  const res = await request(app, 'PATCH', `/api/websites/${websiteId}/crons/${taskId}`, {
    expectedRevision: 1,
    schedule: '0 5 * * *',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.task.revision, 2);
});

test('PATCH /api/websites/:websiteId/crons/:cronId rejects without expectedRevision', async () => {
  const app = createApp();
  const res = await request(app, 'PATCH', `/api/websites/${websiteId}/crons/${taskId}`, {
    schedule: '0 5 * * *',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'cron_update_input_invalid');
});

test('DELETE /api/websites/:websiteId/crons/:cronId deletes task', async () => {
  const app = createApp();
  const res = await request(app, 'DELETE', `/api/websites/${websiteId}/crons/${taskId}`, {
    expectedRevision: 1,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.deleted, true);
  assert.equal(res.body.data.job.operation, 'cron.remove');
});


test('cron mutation rejects an auth projection without live session/user identity', async () => {
  const app = createApp({
    authOverride: {
      user: { role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    },
  });
  const res = await request(app, 'POST', `/api/websites/${websiteId}/crons`, {
    name: 'Backup',
    schedule: '0 3 * * *',
    command: '/usr/bin/backup.sh',
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'cron_actor_invalid');
});
