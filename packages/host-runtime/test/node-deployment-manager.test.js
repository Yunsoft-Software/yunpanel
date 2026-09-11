import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeDeploymentManager, NodeDeploymentError, nodeDeploymentInternals } from '../src/node-deployment-manager.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const DEPLOYMENT_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';
const PREVIOUS_RELEASE = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

function deploymentSpec() {
  return {
    applicationId: APPLICATION_ID,
    deploymentId: DEPLOYMENT_ID,
    repositoryUrl: 'https://github.com/example/node-app',
    branch: 'main',
    runtime: {
      nodeMajor: 24,
      installMode: 'ci',
      buildScript: 'build',
      startMode: 'node',
      entryFile: 'dist/server.js',
      port: 3100,
      healthPath: '/health',
      healthTimeoutSeconds: 10,
      restartPolicy: 'on-failure',
    },
    retention: 5,
  };
}

function createHarness({ healthResults = [true], failFirstRestart = false, lstatFn = null, realpathFn = null } = {}) {
  const commands = [];
  const links = [];
  const removals = [];
  const writes = [];
  let restartCalls = 0;
  let healthIndex = 0;

  const run = async (file, args, options = {}) => {
    commands.push({ file, args, options });
    if (file === '/usr/bin/node' && args[0] === '--version') return { stdout: 'v24.8.0\n' };
    if (file === '/usr/bin/npm' && args[0] === '--version') return { stdout: '11.6.0\n' };
    if (file === '/usr/bin/systemctl' && args[0] === '--version') return { stdout: 'systemd 255\n' };
    if (file === '/usr/bin/systemctl' && args[0] === 'restart') {
      restartCalls += 1;
      if (failFirstRestart && restartCalls === 1) {
        const error = new Error('restart failed');
        error.code = 1;
        throw error;
      }
      return { stdout: '' };
    }
    if (file === '/usr/sbin/runuser' && args.includes('rev-parse')) return { stdout: 'a'.repeat(40) + '\n' };
    return { stdout: '' };
  };

  const manager = createNodeDeploymentManager({
    appRoot: '/apps',
    dataRoot: '/data',
    envRoot: '/env',
    systemdRoot: '/systemd',
    run,
    nodePaths: ['/usr/bin/node'],
    npmPaths: ['/usr/bin/npm'],
    systemctlPaths: ['/usr/bin/systemctl'],
    mkdirFn: async () => {},
    lstatFn: lstatFn ?? (async () => ({
      isFile: () => true,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mtimeMs: Date.now(),
    })),
    realpathFn: realpathFn ?? (async (value) => value),
    readlinkFn: async () => `releases/${PREVIOUS_RELEASE}`,
    readdirFn: async () => [],
    renameFn: async () => {},
    rmFn: async (value, options) => removals.push({ value, options }),
    symlinkFn: async (target, linkPath) => links.push({ target, linkPath }),
    writeFileFn: async (target, content, options) => writes.push({ target, content, options }),
    waitForHealth: async () => healthResults[Math.min(healthIndex++, healthResults.length - 1)],
  });

  return { manager, commands, links, removals, writes };
}

test('healthy Node deployment creates hardened service state and materializes custom environment', async () => {
  const harness = createHarness({ healthResults: [true] });
  const result = await harness.manager.deployNode({
    ...deploymentSpec(),
    environment: { API_TOKEN: 'secret-value', PUBLIC_URL: 'https://example.test' },
  });

  assert.equal(result.releaseId, DEPLOYMENT_ID);
  assert.equal(result.previousReleaseId, PREVIOUS_RELEASE);
  assert.equal(result.commitSha, 'a'.repeat(40));
  assert.equal(result.port, 3100);
  assert.equal(result.healthy, true);
  assert.ok(result.serviceName.startsWith('yunpanel-node-'));

  const currentSwitch = harness.links.find((entry) => entry.target === `releases/${DEPLOYMENT_ID}`);
  assert.ok(currentSwitch);
  const environmentWrite = harness.writes.find((entry) => entry.target.startsWith('/env/'));
  assert.match(environmentWrite.content, /HOST="127\.0\.0\.1"/);
  assert.match(environmentWrite.content, /PORT="3100"/);
  assert.match(environmentWrite.content, /API_TOKEN="secret-value"/);
  assert.match(environmentWrite.content, /PUBLIC_URL="https:\/\/example\.test"/);
  assert.equal(environmentWrite.options.mode, 0o600);

  const unitWrite = harness.writes.find((entry) => entry.target.startsWith('/systemd/'));
  assert.match(unitWrite.content, /ProtectSystem=strict/);
  assert.match(unitWrite.content, /NoNewPrivileges=true/);
  assert.equal(unitWrite.options.mode, 0o644);
});

test('failed health check restores the previous release before reporting failure', async () => {
  const harness = createHarness({ healthResults: [false, true] });

  await assert.rejects(
    harness.manager.deployNode(deploymentSpec()),
    (error) => error instanceof NodeDeploymentError && error.code === 'node_health_failed',
  );

  assert.ok(harness.links.some((entry) => entry.target === `releases/${DEPLOYMENT_ID}`));
  assert.ok(harness.links.some((entry) => entry.target === `releases/${PREVIOUS_RELEASE}`));
  assert.ok(harness.removals.some((entry) => entry.value === `/apps/${APPLICATION_ID}/releases/${DEPLOYMENT_ID}`));
});

test('systemd restart failure also restores the previous release', async () => {
  const harness = createHarness({ healthResults: [true], failFirstRestart: true });

  await assert.rejects(
    harness.manager.deployNode(deploymentSpec()),
    (error) => error instanceof NodeDeploymentError && error.code === 'node_deployment_command_failed',
  );

  assert.ok(harness.links.some((entry) => entry.target === `releases/${PREVIOUS_RELEASE}`));
  const restarts = harness.commands.filter((entry) => entry.file === '/usr/bin/systemctl' && entry.args[0] === 'restart');
  assert.equal(restarts.length, 2);
});

test('pnpm monorepo deployment runs install and build inside the verified document root', async () => {
  const harness = createHarness({ healthResults: [true] });
  const pnpmManager = createNodeDeploymentManager({
    appRoot: '/apps',
    dataRoot: '/data',
    envRoot: '/env',
    systemdRoot: '/systemd',
    run: async (file, args, options = {}) => {
      harness.commands.push({ file, args, options });
      if (file === '/usr/bin/node' && args[0] === '--version') return { stdout: 'v24.8.0\n' };
      if (file === '/usr/bin/pnpm' && args[0] === '--version') return { stdout: '10.0.0\n' };
      if (file === '/usr/bin/systemctl' && args[0] === '--version') return { stdout: 'systemd 255\n' };
      if (file === '/usr/sbin/runuser' && args.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n` };
      return { stdout: '' };
    },
    nodePaths: ['/usr/bin/node'],
    packageManagerPaths: { pnpm: ['/usr/bin/pnpm'] },
    systemctlPaths: ['/usr/bin/systemctl'],
    mkdirFn: async () => {},
    lstatFn: async () => ({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, mtimeMs: Date.now() }),
    realpathFn: async (value) => value,
    readlinkFn: async () => `releases/${PREVIOUS_RELEASE}`,
    readdirFn: async () => [],
    renameFn: async () => {},
    rmFn: async () => {},
    symlinkFn: async () => {},
    writeFileFn: async () => {},
    waitForHealth: async () => true,
  });

  await pnpmManager.deployNode({
    ...deploymentSpec(),
    runtime: {
      ...deploymentSpec().runtime,
      packageManager: 'pnpm',
      documentRoot: 'services/api',
    },
  });

  const commands = harness.commands.filter((entry) => entry.file === '/usr/sbin/runuser');
  assert.ok(commands.some((entry) => entry.args.includes('/usr/bin/pnpm')
    && entry.args.includes('--frozen-lockfile')
    && entry.options.cwd === `/apps/${APPLICATION_ID}/releases/${DEPLOYMENT_ID}/services/api`));
  assert.ok(commands.some((entry) => entry.args.includes('build')
    && entry.options.cwd === `/apps/${APPLICATION_ID}/releases/${DEPLOYMENT_ID}/services/api`));
});

test('document root symlinks and release escapes fail before package installation', async () => {
  for (const options of [
    {
      lstatFn: async () => ({ isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }),
      expectedCode: 'node_document_root_invalid',
    },
    {
      realpathFn: async (value) => value.endsWith('/services/api') ? '/outside/api' : value,
      expectedCode: 'node_document_root_escape',
    },
  ]) {
    const harness = createHarness(options);
    await assert.rejects(
      harness.manager.deployNode({
        ...deploymentSpec(),
        runtime: { ...deploymentSpec().runtime, documentRoot: 'services/api' },
      }),
      (error) => error instanceof NodeDeploymentError && error.code === options.expectedCode,
    );
    assert.equal(harness.commands.some((entry) => entry.file === '/usr/sbin/runuser' && entry.args.includes('/usr/bin/npm')), false);
  }
});

test('Node executable selection matches the requested site major without selecting panel Node', async () => {
  const calls = [];
  const selected = await nodeDeploymentInternals.findNodeExecutable([
    '/opt/yunpanel/node-runtimes/v24/bin/node',
    '/usr/bin/node',
  ], 24, async (file) => {
    calls.push(file);
    return { stdout: file.startsWith('/opt/') ? 'v24.21.0\n' : 'v22.23.2\n' };
  });
  assert.equal(selected, '/opt/yunpanel/node-runtimes/v24/bin/node');
  assert.deepEqual(calls, ['/opt/yunpanel/node-runtimes/v24/bin/node']);
  assert.equal(nodeDeploymentInternals.safeBuildEnvironment('/data/app', '/opt/yunpanel/node-runtimes/v24/bin').PATH,
    '/opt/yunpanel/node-runtimes/v24/bin:/usr/bin:/bin');
});
