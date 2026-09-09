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

test('admin can queue fixed-scope YunPanel package inspection and upgrade jobs', async () => {
  const registry = createServerRegistry();
  const token = await registry.issueEnrollmentToken();
  const enrollment = await registry.enrollServer({ token: token.token, hostname: 'package-test' });
  const jobRegistry = createJobRegistry();
  const adminToken = 'system-package-admin-token';
  const app = createApp({ registry, jobRegistry, environment: 'production', adminToken });

  await withServer(app, async (baseUrl) => {
    const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
    const inspectResponse = await fetch(`${baseUrl}/api/servers/${enrollment.server.id}/system/packages/inspect`, {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(inspectResponse.status, 202);
    const inspect = (await inspectResponse.json()).data;
    assert.equal(inspect.operation, 'system.packages.inspect');
    assert.equal(inspect.resourceType, 'system');

    const conflict = await fetch(`${baseUrl}/api/servers/${enrollment.server.id}/system/upgrade`, {
      method: 'POST', headers, body: JSON.stringify({ confirmation: 'upgrade-yunpanel' }),
    });
    assert.equal(conflict.status, 409);

    await jobRegistry.claimNext(enrollment.server.id);
    await jobRegistry.complete({
      serverId: enrollment.server.id,
      jobId: inspect.id,
      status: 'succeeded',
      result: {
        packageName: 'yunpanel', installed: false, installedVersion: null, candidateVersion: null, updateAvailable: false,
      },
    });

    const missingConfirmation = await fetch(`${baseUrl}/api/servers/${enrollment.server.id}/system/upgrade`, {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(missingConfirmation.status, 400);

    const upgradeResponse = await fetch(`${baseUrl}/api/servers/${enrollment.server.id}/system/upgrade`, {
      method: 'POST', headers, body: JSON.stringify({ confirmation: 'upgrade-yunpanel' }),
    });
    assert.equal(upgradeResponse.status, 202);
    const upgrade = (await upgradeResponse.json()).data;
    assert.equal(upgrade.operation, 'system.upgrade');
    assert.deepEqual(upgrade.result, null);
  });
});
