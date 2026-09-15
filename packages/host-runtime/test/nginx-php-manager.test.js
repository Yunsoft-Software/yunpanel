import assert from 'node:assert/strict';
import test from 'node:test';
import { createNginxManager, NginxManagerError } from '../src/nginx-manager.js';

const root = '/var/lib/yunpanel/apps/6dcb8908-3f3e-43da-9452-15fd6b51ac76/current/public';
const socketPath = '/run/php/yunpanel-yunapp-0123456789ab.sock';

function phpSpec(overrides = {}) {
  return {
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    targetType: 'php',
    target: { root, socketPath },
    tls: null,
    canonicalRedirect: false,
    httpsRedirect: false,
    ...overrides,
  };
}

function memoryManager() {
  const files = new Map();
  const writes = [];
  const manager = createNginxManager({
    stagingDir: '/staging/nginx',
    sitesDir: '/etc/nginx/sites-enabled',
    mkdirFn: async () => {},
    writeFileFn: async (file, content, options = {}) => {
      files.set(file, String(content));
      writes.push({ file, content: String(content), mode: options.mode });
    },
    renameFn: async (source, target) => {
      if (!files.has(source)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      files.set(target, files.get(source));
      files.delete(source);
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
  return { manager, files, writes };
}

test('Nginx manager stages deterministic PHP config using the Website PHP-FPM socket', async () => {
  const host = memoryManager();
  const stage = await host.manager.stageDomain(phpSpec());

  assert.equal(stage.configName, 'yunpanel-example.com.conf');
  assert.match(stage.checksum, /^[a-f0-9]{64}$/);
  assert.ok(stage.bytes > 0);
  const config = host.files.get('/staging/nginx/yunpanel-example.com.conf');
  assert.match(config, new RegExp(`root ${root.replaceAll('.', '\\.')}\;`));
  assert.match(config, new RegExp(`fastcgi_pass unix:${socketPath.replaceAll('.', '\\.')}\;`));
  assert.doesNotMatch(config, /proxy_pass/);
  assert.doesNotMatch(config, /passenger_enabled/);
  assert.equal(host.writes.some((entry) => entry.file.includes('.tmp') && entry.mode === 0o640), true);

  const inspected = await host.manager.inspectStagedDomain(phpSpec());
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.result.checksum, stage.checksum);
});

test('Nginx manager rejects PHP target that does not use a managed Website socket', async () => {
  const host = memoryManager();
  await assert.rejects(
    host.manager.stageDomain(phpSpec({ target: { root, socketPath: '/run/php/php8.3-fpm.sock' } })),
    (error) => error?.code === 'invalid_php_socket',
  );
});

test('Nginx manager still fails closed on unknown target types', async () => {
  const host = memoryManager();
  await assert.rejects(
    host.manager.stageDomain(phpSpec({ targetType: 'cgi' })),
    (error) => error instanceof NginxManagerError && error.code === 'invalid_target_type',
  );
});
