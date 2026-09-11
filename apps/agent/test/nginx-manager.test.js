import assert from 'node:assert/strict';
import test from 'node:test';
import { createNginxManager, NginxManagerError } from '../src/nginx-manager.js';

function createMemoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));

  return {
    files,
    mkdirFn: async () => {},
    readFileFn: async (filePath) => {
      if (!files.has(filePath)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    },
    writeFileFn: async (filePath, content) => { files.set(filePath, content); },
    renameFn: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    rmFn: async (filePath) => { files.delete(filePath); },
  };
}

test('stages, validates and atomically activates a generated domain config', async () => {
  const memory = createMemoryFs();
  const commands = [];
  const manager = createNginxManager({
    ...memory,
    execFn: async (file, args) => { commands.push({ file, args }); return ''; },
  });

  const staged = await manager.stageDomain({
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    targetType: 'static',
    target: { root: '/var/lib/yunpanel/apps/example/current', spaFallback: true },
  });

  assert.match(staged.checksum, /^[a-f0-9]{64}$/);
  assert.equal(staged.configName, 'yunpanel-example.com.conf');

  const activated = await manager.activateDomain({
    primaryDomain: 'example.com',
    checksum: staged.checksum,
  });

  assert.equal(activated.active, true);
  assert.match(memory.files.get('/etc/nginx/sites-enabled/yunpanel-example.com.conf'), /server_name example\.com www\.example\.com;/);
  assert.deepEqual(commands.map((command) => command.args), [
    ['-t'],
    ['reload', 'nginx'],
  ]);
});

test('invalid candidate restores the previous active configuration', async () => {
  const activePath = '/etc/nginx/sites-enabled/yunpanel-example.com.conf';
  const memory = createMemoryFs({ [activePath]: 'server { # previous working config\n}\n' });
  const manager = createNginxManager({
    ...memory,
    execFn: async (file, args) => {
      if (args[0] === '-t') throw new Error('invalid config');
      return '';
    },
  });

  const staged = await manager.stageDomain({
    primaryDomain: 'example.com',
    targetType: 'proxy',
    target: { upstreamPort: 3008 },
  });

  await assert.rejects(
    manager.activateDomain({ primaryDomain: 'example.com', checksum: staged.checksum }),
    (error) => error instanceof NginxManagerError && error.code === 'nginx_config_invalid',
  );

  assert.equal(memory.files.get(activePath), 'server { # previous working config\n}\n');
});

test('activation refuses a candidate whose checksum changed after staging', async () => {
  const memory = createMemoryFs();
  const manager = createNginxManager({ ...memory, execFn: async () => '' });
  const staged = await manager.stageDomain({
    primaryDomain: 'api.example.com',
    targetType: 'proxy',
    target: { upstreamPort: 3000 },
  });

  memory.files.set('/var/lib/yunpanel/staging/nginx/yunpanel-api.example.com.conf', 'tampered');

  await assert.rejects(
    manager.activateDomain({ primaryDomain: 'api.example.com', checksum: staged.checksum }),
    (error) => error instanceof NginxManagerError && error.code === 'staged_config_changed',
  );
});

test('canonical hostname activation removes the previous config and restores it on failure', async () => {
  const previousPath = '/etc/nginx/sites-enabled/yunpanel-old.example.com.conf';
  const nextPath = '/etc/nginx/sites-enabled/yunpanel-new.example.com.conf';
  const previous = 'server { # old active config\n}\n';
  const memory = createMemoryFs({ [previousPath]: previous });
  const manager = createNginxManager({ ...memory, execFn: async () => '' });
  const staged = await manager.stageDomain({
    primaryDomain: 'new.example.com', targetType: 'proxy', target: { upstreamPort: 3008 },
  });
  await manager.activateDomain({
    primaryDomain: 'new.example.com', previousPrimaryDomain: 'old.example.com', checksum: staged.checksum,
  });
  assert.equal(memory.files.has(previousPath), false);
  assert.equal(memory.files.has(nextPath), true);

  const rollbackMemory = createMemoryFs({ [previousPath]: previous });
  const failing = createNginxManager({
    ...rollbackMemory,
    execFn: async (_file, args) => { if (args[0] === '-t') throw new Error('invalid'); },
  });
  const candidate = await failing.stageDomain({
    primaryDomain: 'new.example.com', targetType: 'proxy', target: { upstreamPort: 3008 },
  });
  await assert.rejects(
    failing.activateDomain({ primaryDomain: 'new.example.com', previousPrimaryDomain: 'old.example.com', checksum: candidate.checksum }),
    (error) => error instanceof NginxManagerError && error.code === 'nginx_config_invalid',
  );
  assert.equal(rollbackMemory.files.get(previousPath), previous);
  assert.equal(rollbackMemory.files.has(nextPath), false);
});

test('canonical hostname activation restores both paths when replacement preparation fails', async () => {
  const previousPath = '/etc/nginx/sites-enabled/yunpanel-old.example.com.conf';
  const nextPath = '/etc/nginx/sites-enabled/yunpanel-new.example.com.conf';
  const previous = 'server { # old active config\n}\n';
  const memory = createMemoryFs({ [previousPath]: previous });
  let failedOnce = false;
  const commands = [];
  const manager = createNginxManager({
    ...memory,
    rmFn: async (filePath) => {
      if (filePath === previousPath && !failedOnce) {
        failedOnce = true;
        throw new Error('permission denied');
      }
      memory.files.delete(filePath);
    },
    execFn: async (file, args) => { commands.push({ file, args }); },
  });
  const staged = await manager.stageDomain({
    primaryDomain: 'new.example.com', targetType: 'proxy', target: { upstreamPort: 3008 },
  });

  await assert.rejects(
    manager.activateDomain({
      primaryDomain: 'new.example.com', previousPrimaryDomain: 'old.example.com', checksum: staged.checksum,
    }),
    (error) => error instanceof NginxManagerError && error.code === 'nginx_activation_prepare_failed',
  );
  assert.equal(memory.files.get(previousPath), previous);
  assert.equal(memory.files.has(nextPath), false);
  assert.deepEqual(commands, []);
});
