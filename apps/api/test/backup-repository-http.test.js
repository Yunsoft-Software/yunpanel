import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import {
  mountBackupRepositoryRoutes,
  isBackupRepositoryHttpError,
} from '../src/backup-repository-http.js';

const ownerAuth = Object.freeze({
  user: { id: 'owner-1', role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

const viewerAuth = Object.freeze({
  user: { id: 'viewer-1', role: 'viewer' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
});

async function fixture(t) {
  const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
  const repoId = '91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c';
  const remoteId = '3d4e5f6a-7b8c-4d0e-9f1a-2b3c4d5e6f7a';

  const mockRepo = {
    id: repoId,
    serverId,
    name: 'default_local',
    backend: 'local',
    target: '/var/lib/yunpanel/backups/restic/repos/default_local',
    status: 'ready',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };

  const mockRemote = {
    id: remoteId,
    serverId,
    name: 's3_backup',
    type: 's3',
    status: 'verified',
    parameters: { provider: 'AWS', region: 'eu-central-1' },
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };

  const repos = new Map([[repoId, mockRepo]]);
  const remotes = new Map([[remoteId, mockRemote]]);

  const resticRepositoryRegistry = {
    async listRepositories() {
      return Array.from(repos.values());
    },
    async createRepository(input) {
      const id = input.id ?? (input.name === 'new_repo' ? 'repo-new-id' : repoId);
      const created = { id, ...input, status: 'ready' };
      repos.set(id, created);
      return created;
    },
    async initResticRepository(id) {
      return { id, initialized: true };
    },
    async getRepository(id) {
      return repos.get(id) ?? null;
    },
    async deleteRepository(id) {
      repos.delete(id);
      return { id, deleted: true };
    },
    async listSnapshots(id) {
      return [{ id: 'snap-1', time: '2026-09-20T12:00:00Z', tags: ['website:test'] }];
    },
    async checkResticRepository(id) {
      return { id, status: 'ok', checkedAt: '2026-09-20T12:05:00Z' };
    },
    async unlockResticRepository(id) {
      return { id, unlocked: true };
    },
    async pruneResticRepository(id) {
      return { id, forgotten: 1, pruned: true };
    },
  };

  const rcloneRemoteRegistry = {
    async listRemotes() {
      return Array.from(remotes.values());
    },
    async createRemote(input) {
      const id = input.id ?? remoteId;
      const created = { id, ...input, status: 'untested' };
      remotes.set(id, created);
      return created;
    },
    async getRemote(id) {
      return remotes.get(id) ?? null;
    },
    async updateRemote(id, updates) {
      const existing = remotes.get(id) ?? mockRemote;
      const updated = { ...existing, ...updates };
      remotes.set(id, updated);
      return updated;
    },
    async deleteRemote(id) {
      remotes.delete(id);
      return { id, deleted: true };
    },
    async testRemote(id) {
      return { id, ok: true, message: 'Connection verified successfully' };
    },
  };

  let authContext = ownerAuth;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.auth = authContext;
    next();
  });

  mountBackupRepositoryRoutes(app, {
    resticRepositoryRegistry,
    rcloneRemoteRegistry,
    localServerId: serverId,
  });

  app.use((error, req, res, next) => {
    if (isBackupRepositoryHttpError(error)) {
      return res.status(error.status ?? 400).json({
        error: { code: error.code, message: error.message },
      });
    }
    return res.status(500).json({ error: { code: 'internal_error', message: error.message } });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    repoId,
    remoteId,
    setAuth: (a) => { authContext = a; },
  };
}

test('GET /api/backups/repositories returns list of repos', async (t) => {
  const { baseUrl, repoId } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/repositories`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, repoId);
});

test('POST /api/backups/repositories creates repo with owner auth', async (t) => {
  const { baseUrl } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'new_repo',
      backend: 'local',
      target: '/var/lib/yunpanel/backups/restic/repos/new_repo',
      password: 'strong_password',
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.data.name, 'new_repo');
});

test('POST /api/backups/repositories rejects non-owner with 403', async (t) => {
  const { baseUrl, setAuth } = await fixture(t);
  setAuth(viewerAuth);
  const res = await fetch(`${baseUrl}/api/backups/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'new_repo' }),
  });
  assert.equal(res.status, 403);
});

test('GET /api/backups/repositories/:repositoryId returns repo', async (t) => {
  const { baseUrl, repoId } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/repositories/${repoId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.id, repoId);
});

test('GET /api/backups/repositories/:repositoryId returns 404 for unknown repo', async (t) => {
  const { baseUrl } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/repositories/00000000-0000-0000-0000-000000000000`);
  assert.equal(res.status, 404);
});

test('GET /api/backups/repositories/:repositoryId/snapshots returns snapshots', async (t) => {
  const { baseUrl, repoId } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/repositories/${repoId}/snapshots`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, 'snap-1');
});

test('POST /api/backups/repositories/:repositoryId/check executes check', async (t) => {
  const { baseUrl, repoId } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/repositories/${repoId}/check`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.status, 'ok');
});

test('POST /api/backups/repositories/:repositoryId/unlock executes unlock', async (t) => {
  const { baseUrl, repoId } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/repositories/${repoId}/unlock`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.unlocked, true);
});

test('POST /api/backups/repositories/:repositoryId/prune executes prune', async (t) => {
  const { baseUrl, repoId } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/repositories/${repoId}/prune`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.pruned, true);
});

test('DELETE /api/backups/repositories/:repositoryId deletes repo', async (t) => {
  const { baseUrl, repoId } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/repositories/${repoId}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.deleted, true);
});

test('GET /api/backups/remotes returns list of remotes', async (t) => {
  const { baseUrl, remoteId } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/remotes`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, remoteId);
});

test('POST /api/backups/remotes creates remote', async (t) => {
  const { baseUrl } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/remotes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'b2_remote',
      type: 'b2',
      parameters: { account: 'test_acc', key: 'test_key' },
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.data.name, 'b2_remote');
});

test('POST /api/backups/remotes/:remoteId/test tests remote connectivity', async (t) => {
  const { baseUrl, remoteId } = await fixture(t);
  const res = await fetch(`${baseUrl}/api/backups/remotes/${remoteId}/test`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ok, true);
});
