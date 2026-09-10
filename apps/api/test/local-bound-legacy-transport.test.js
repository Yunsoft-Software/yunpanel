import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createServerRegistry } from '../src/server-registry.js';

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function requestJson(url, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test('local ownership rejects every retained legacy agent transport before state mutation', async () => {
  const registry = createServerRegistry();
  const enrollmentToken = await registry.issueEnrollmentToken({ label: 'local-transport-guard' });
  const enrollment = await registry.enrollServer({ token: enrollmentToken.token, hostname: 'local-guard-host' });
  const serverId = enrollment.server.id;
  const agentToken = enrollment.agentToken;
  const jobRegistry = createJobRegistry();
  await registry.bindLocalServer({ serverId, hostname: 'local-guard-host' });

  const app = createApp({ environment: 'production', registry, jobRegistry });
  await withServer(app, async (baseUrl) => {
    const requests = [
      requestJson(`${baseUrl}/api/servers/${serverId}/heartbeat`, {
        method: 'POST',
        token: agentToken,
        body: { agentVersion: 'legacy-agent-should-not-run' },
      }),
      requestJson(`${baseUrl}/api/servers/${serverId}/commands/next`, { token: agentToken }),
      requestJson(`${baseUrl}/api/servers/${serverId}/applications/fake-application/environment`, { token: agentToken }),
      requestJson(`${baseUrl}/api/servers/${serverId}/commands/fake-job/result`, {
        method: 'POST',
        token: agentToken,
        body: { status: 'failed', error: { code: 'must-not-write', message: 'must-not-write' } },
      }),
    ];

    const results = await Promise.all(requests);
    for (const result of results) {
      assert.equal(result.response.status, 409);
      assert.equal(result.payload.error.code, 'server_managed_locally');
    }
  });

  const server = await registry.getServer(serverId);
  assert.equal(server.executionMode, 'local');
  assert.equal(server.lastSeenAt, null);
  assert.equal(server.agentVersion, null);
  assert.deepEqual(await jobRegistry.listJobs(), []);
});
