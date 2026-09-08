import assert from 'node:assert/strict';
import test from 'node:test';
import { createNginxInspector, parseNginxConfigMetadata } from '../src/nginx-inspector.js';

test('parses operational Nginx metadata and removes proxy credentials', () => {
  const metadata = parseNginxConfigMetadata(`
    server {
      listen 443 ssl http2;
      server_name example.com www.example.com;
      root /var/www/example/current;
      location /api/ {
        proxy_pass http://user:secret@127.0.0.1:3000;
      }
    }
  `);

  assert.deepEqual(metadata.serverNames, ['example.com', 'www.example.com']);
  assert.deepEqual(metadata.listens, ['443 ssl http2']);
  assert.deepEqual(metadata.roots, ['/var/www/example/current']);
  assert.deepEqual(metadata.proxyTargets, ['http://127.0.0.1:3000']);
});

test('Nginx inspector refuses symlinks that escape /etc/nginx', async () => {
  const inspect = createNginxInspector({
    readdirFn: async (directory) => {
      if (directory === '/etc/nginx/sites-enabled') return ['safe.conf', 'escape.conf'];
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    lstatFn: async () => ({ isFile: () => false, isSymbolicLink: () => true }),
    realpathFn: async (sourcePath) => sourcePath.endsWith('safe.conf')
      ? '/etc/nginx/sites-available/safe.conf'
      : '/etc/shadow',
    statFn: async () => ({ isFile: () => true, size: 200 }),
    readFileFn: async () => 'server { listen 80; server_name safe.example.com; }',
  });

  const result = await inspect();
  assert.equal(result.installed, true);
  assert.equal(result.configs.length, 1);
  assert.equal(result.configs[0].name, 'safe.conf');
  assert.deepEqual(result.configs[0].serverNames, ['safe.example.com']);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].name, 'escape.conf');
  assert.equal(result.issues[0].code, 'symlink_outside_nginx_root');
});

test('missing Nginx config directories return an empty inventory', async () => {
  const inspect = createNginxInspector({
    readdirFn: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  });

  const result = await inspect();
  assert.equal(result.installed, false);
  assert.deepEqual(result.configs, []);
  assert.deepEqual(result.issues, []);
});
