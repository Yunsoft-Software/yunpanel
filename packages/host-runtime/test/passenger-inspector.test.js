import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPassengerInspector,
  PassengerInspectorError,
  passengerInspectorInternals,
} from '../src/passenger-inspector.js';

const root = '/usr/lib/ruby/vendor_ruby/phusion_passenger/locations.ini';

function healthyRun(file, args) {
  if (file === '/usr/bin/dpkg-query') return Promise.resolve({ stdout: 'install ok installed\t6.0.27-1~noble1\n' });
  if (file === '/usr/bin/passenger-config' && args[0] === '--root') return Promise.resolve({ stdout: `${root}\n` });
  if (file === '/usr/bin/passenger-config' && args[0] === 'validate-install') return Promise.resolve({ stdout: 'all checks passed\n' });
  if (file === '/usr/sbin/nginx' && args[0] === '-T') {
    return Promise.resolve({
      stdout: `load_module modules/ngx_http_passenger_module.so;\nhttp {\n  passenger_root ${root};\n}\n`,
      stderr: 'nginx: configuration file /etc/nginx/nginx.conf test is successful\n',
    });
  }
  if (file === '/usr/bin/node') return Promise.resolve({ stdout: 'v24.7.0\n' });
  throw new Error(`unexpected command ${file} ${args.join(' ')}`);
}

test('Passenger inspector reports healthy only for matching loaded Nginx configuration', async () => {
  const inspector = createPassengerInspector({ run: healthyRun });
  const result = await inspector.inspect();

  assert.equal(result.installed, true);
  assert.equal(result.installedVersion, '6.0.27-1~noble1');
  assert.equal(result.passengerRoot, root);
  assert.deepEqual(result.nginxPassengerRoots, [root]);
  assert.equal(result.moduleLoaded, true);
  assert.equal(result.installValid, true);
  assert.equal(result.nodeVersion, 'v24.7.0');
  assert.equal(result.healthy, true);
});

test('missing Passenger package returns a non-healthy capability without running Passenger commands', async () => {
  const calls = [];
  const inspector = createPassengerInspector({
    run: async (file, args) => {
      calls.push([file, args]);
      const error = new Error('package is not installed');
      error.code = 1;
      throw error;
    },
  });

  const result = await inspector.inspect();
  assert.equal(result.installed, false);
  assert.equal(result.healthy, false);
  assert.equal(result.passengerRoot, null);
  assert.deepEqual(calls, [['/usr/bin/dpkg-query', ['-W', '-f=${Status}\t${Version}', 'libnginx-mod-http-passenger']]]);
});

test('Passenger root drift keeps capability unhealthy instead of accepting ambiguous config', async () => {
  const inspector = createPassengerInspector({
    run: async (file, args) => {
      const result = await healthyRun(file, args);
      if (file === '/usr/sbin/nginx') {
        return {
          ...result,
          stdout: 'load_module modules/ngx_http_passenger_module.so;\npassenger_root /wrong/root;\n',
        };
      }
      return result;
    },
  });

  const result = await inspector.inspect();
  assert.equal(result.moduleLoaded, true);
  assert.deepEqual(result.nginxPassengerRoots, ['/wrong/root']);
  assert.equal(result.healthy, false);
});

test('Passenger inspector surfaces failed validate-install as a bounded error', async () => {
  const inspector = createPassengerInspector({
    run: async (file, args) => {
      if (file === '/usr/bin/passenger-config' && args[0] === 'validate-install') {
        const error = new Error('private validation output');
        error.code = 2;
        throw error;
      }
      return healthyRun(file, args);
    },
  });

  await assert.rejects(
    inspector.inspect(),
    (error) => error instanceof PassengerInspectorError && error.code === 'passenger_install_invalid',
  );
});

test('Nginx config parser requires the Passenger dynamic module and exact roots', () => {
  const parsed = passengerInspectorInternals.parseNginxConfig(`
    load_module modules/ngx_http_passenger_module.so;
    passenger_root ${root};
    passenger_root ${root};
  `);
  assert.equal(parsed.moduleLoaded, true);
  assert.deepEqual(parsed.roots, [root]);
});
