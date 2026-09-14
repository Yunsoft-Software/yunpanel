import assert from 'node:assert/strict';
import test from 'node:test';
import { createNginxManager } from '../src/nginx-manager.js';

const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const appRoot = `/var/lib/yunpanel/apps/${applicationId}/current`;
const user = 'yunapp-0123456789ab';

function passengerSpec() {
  return {
    primaryDomain: 'example.com',
    aliases: [],
    targetType: 'passenger',
    target: {
      appRoot,
      documentRoot: appRoot,
      startupFile: 'server.js',
      nodeBinary: '/usr/bin/node',
      user,
      group: user,
    },
  };
}

test('Nginx manager stages Passenger sites through the normal checksum contract', async () => {
  const files = new Map();
  const manager = createNginxManager({
    mkdirFn: async () => {},
    writeFileFn: async (file, content) => { files.set(file, content); },
    renameFn: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    readFileFn: async (file) => {
      if (!files.has(file)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    },
    rmFn: async (file) => { files.delete(file); },
    execFn: async () => '',
  });

  const staged = await manager.stageDomain(passengerSpec());
  assert.equal(staged.configName, 'yunpanel-example.com.conf');
  assert.match(staged.checksum, /^[a-f0-9]{64}$/);
  const content = files.get('/var/lib/yunpanel/staging/nginx/yunpanel-example.com.conf');
  assert.match(content, /passenger_enabled on;/);
  assert.match(content, new RegExp(`passenger_user ${user};`));

  const inspected = await manager.inspectStagedDomain(passengerSpec());
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.result.checksum, staged.checksum);
});
