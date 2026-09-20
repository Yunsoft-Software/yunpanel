import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailAntivirusHealthInspector,
  MailAntivirusHealthError,
} from '../src/index.js';

function createMockInspector({
  dpkgStatus = 'install ok installed',
  serviceActive = true,
  existingPaths = ['/run/clamav/clamd.ctl'],
  totalMem = 2 * 1024 * 1024 * 1024, // 2 GiB
} = {}) {
  return createMailAntivirusHealthInspector({
    run: async (file, args) => {
      if (file === '/usr/bin/dpkg-query') {
        return { stdout: dpkgStatus };
      }
      if (file === '/usr/bin/systemctl' && args[0] === 'is-active') {
        if (!serviceActive) throw new Error('inactive');
        return { stdout: 'active\n' };
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
    },
    statFn: async (filePath) => {
      if (existingPaths.includes(filePath)) {
        return { isFile: () => true, isSocket: () => true };
      }
      const error = new Error(`ENOENT: ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    },
    totalMemFn: () => totalMem,
  });
}

test('mail antivirus health inspector returns disabled when profile is disabled', async () => {
  const inspector = createMockInspector();
  const result = await inspector.inspect({ profile: 'disabled' });
  assert.equal(result.profile, 'disabled');
  assert.equal(result.enabled, false);
  assert.equal(result.active, false);
  assert.equal(result.healthy, false);
  assert.equal(result.status, 'disabled');
  assert.deepEqual(result.blockers, []);
});

test('mail antivirus health inspector returns ready and active when clamav profile is fully healthy', async () => {
  const inspector = createMockInspector();
  const result = await inspector.inspect({ profile: 'clamav' });
  assert.equal(result.profile, 'clamav');
  assert.equal(result.enabled, true);
  assert.equal(result.active, true);
  assert.equal(result.healthy, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.blockers, []);
});

test('mail antivirus health inspector returns active=false when clamav service is inactive', async () => {
  const inspector = createMockInspector({ serviceActive: false });
  const result = await inspector.inspect({ profile: 'clamav' });
  assert.equal(result.profile, 'clamav');
  assert.equal(result.enabled, true);
  assert.equal(result.active, false); // health yoksa aktif gösterme!
  assert.equal(result.healthy, false);
  assert.equal(result.status, 'unhealthy');
  assert.ok(result.blockers.includes('clamav_service_inactive'));
});

test('mail antivirus health inspector returns active=false when socket is missing', async () => {
  const inspector = createMockInspector({ existingPaths: [] });
  const result = await inspector.inspect({ profile: 'clamav' });
  assert.equal(result.profile, 'clamav');
  assert.equal(result.enabled, true);
  assert.equal(result.active, false);
  assert.equal(result.healthy, false);
  assert.equal(result.status, 'unhealthy');
  assert.ok(result.blockers.includes('clamav_socket_missing'));
});

test('mail antivirus health inspector returns active=false when memory is insufficient (< 1GB)', async () => {
  const inspector = createMockInspector({ totalMem: 512 * 1024 * 1024 }); // 512 MB
  const result = await inspector.inspect({ profile: 'clamav' });
  assert.equal(result.profile, 'clamav');
  assert.equal(result.enabled, true);
  assert.equal(result.active, false);
  assert.equal(result.healthy, false);
  assert.equal(result.status, 'unhealthy');
  assert.ok(result.blockers.includes('clamav_insufficient_memory'));
});

test('mail antivirus health inspector returns active=false when package is missing', async () => {
  const inspector = createMockInspector({ dpkgStatus: 'deinstall ok config-files' });
  const result = await inspector.inspect({ profile: 'clamav' });
  assert.equal(result.profile, 'clamav');
  assert.equal(result.enabled, true);
  assert.equal(result.active, false);
  assert.equal(result.healthy, false);
  assert.equal(result.status, 'unhealthy');
  assert.ok(result.blockers.includes('clamav_package_missing'));
});

test('mail antivirus health inspector throws on invalid profile', async () => {
  const inspector = createMockInspector();
  await assert.rejects(
    async () => inspector.inspect({ profile: 'invalid' }),
    (error) => error instanceof MailAntivirusHealthError && error.code === 'invalid_antivirus_profile',
  );
});
