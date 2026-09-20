import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPhpCliToolManager,
  PhpCliToolError,
  phpCliToolInternals,
} from '../src/php-cli-tool-manager.js';

const VALID_APP_ID = '11111111-1111-4111-8111-111111111111';
const VALID_RELEASE_ID = '22222222-2222-4222-8222-222222222222';
const VALID_USER = 'yunapp-0123456789ab';
const VALID_CWD = `/var/lib/yunpanel/apps/${VALID_APP_ID}/current`;
const VALID_REAL_CWD = `/var/lib/yunpanel/apps/${VALID_APP_ID}/releases/${VALID_RELEASE_ID}`;

const MOCK_PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin',
  `${VALID_USER}:x:1001:1001:YunPanel App User:/var/lib/yunpanel/data/${VALID_APP_ID}:/usr/sbin/nologin`,
].join('\n');

test('inspectWpCli detects binary and parses version', async () => {
  const manager = createPhpCliToolManager({
    wpCliPaths: ['/usr/local/bin/wp'],
    lstatFn: async (p) => {
      if (p === '/usr/local/bin/wp') return { isFile: () => true, isSymbolicLink: () => false };
      throw new Error('ENOENT');
    },
    run: async (file, args) => {
      assert.equal(file, '/usr/local/bin/wp');
      assert.deepEqual(args, ['--version', '--allow-root']);
      return { stdout: 'WP-CLI 2.8.1\n', stderr: '' };
    },
  });

  const info = await manager.inspectWpCli();
  assert.equal(info.available, true);
  assert.equal(info.path, '/usr/local/bin/wp');
  assert.equal(info.version, '2.8.1');
});

test('inspectWpCli returns available: false when binary is missing', async () => {
  const manager = createPhpCliToolManager({
    wpCliPaths: ['/usr/local/bin/wp'],
    lstatFn: async () => {
      throw new Error('ENOENT');
    },
  });

  const info = await manager.inspectWpCli();
  assert.equal(info.available, false);
  assert.equal(info.path, null);
  assert.equal(info.version, null);
});

test('inspectComposer detects binary and parses version', async () => {
  const manager = createPhpCliToolManager({
    composerPaths: ['/usr/bin/composer'],
    lstatFn: async (p) => {
      if (p === '/usr/bin/composer') return { isFile: () => true, isSymbolicLink: () => false };
      throw new Error('ENOENT');
    },
    run: async (file, args) => {
      assert.equal(file, '/usr/bin/composer');
      assert.deepEqual(args, ['--version']);
      return { stdout: 'Composer version 2.7.2 2024-03-11 17:12:18\n', stderr: '' };
    },
  });

  const info = await manager.inspectComposer();
  assert.equal(info.available, true);
  assert.equal(info.path, '/usr/bin/composer');
  assert.equal(info.version, '2.7.2');
});

test('resolveTargetContext validates user and cwd and prevents root execution', async () => {
  const manager = createPhpCliToolManager({
    lstatFn: async () => ({ isDirectory: () => true }),
    realpathFn: async () => VALID_REAL_CWD,
    readFileFn: async () => MOCK_PASSWD,
  });

  const context = await manager.resolveTargetContext({
    unixUser: VALID_USER,
    cwd: VALID_CWD,
  });

  assert.equal(context.account.user, VALID_USER);
  assert.equal(context.account.uid, 1001);
  assert.equal(context.account.gid, 1001);
  assert.equal(context.cwd, VALID_REAL_CWD);
  assert.equal(context.env.USER, VALID_USER);
  assert.equal(context.env.HOME, `/var/lib/yunpanel/data/${VALID_APP_ID}`);
});

test('resolveTargetContext rejects invalid cwd escape', async () => {
  const manager = createPhpCliToolManager({
    lstatFn: async () => ({ isDirectory: () => true }),
    realpathFn: async () => '/etc/shadow',
    readFileFn: async () => MOCK_PASSWD,
  });

  await assert.rejects(
    async () => manager.resolveTargetContext({
      unixUser: VALID_USER,
      cwd: VALID_CWD,
    }),
    (err) => err instanceof PhpCliToolError && err.code === 'php_cli_cwd_escape',
  );
});

test('validateCommandArgs strictly forbids --allow-root and unsupported commands', () => {
  // Unsupported command
  assert.throws(
    () => phpCliToolInternals.validateCommandArgs('eval-file', ['bad.php'], phpCliToolInternals.WP_CLI_ALLOWED_COMMANDS, 'wp_cli'),
    (err) => err instanceof PhpCliToolError && err.code === 'wp_cli_command_unsupported',
  );

  // --allow-root forbidden
  assert.throws(
    () => phpCliToolInternals.validateCommandArgs('plugin', ['list', '--allow-root'], phpCliToolInternals.WP_CLI_ALLOWED_COMMANDS, 'wp_cli'),
    (err) => err instanceof PhpCliToolError && err.code === 'wp_cli_root_forbidden',
  );

  // Control characters forbidden
  assert.throws(
    () => phpCliToolInternals.validateCommandArgs('plugin', ['list\x00'], phpCliToolInternals.WP_CLI_ALLOWED_COMMANDS, 'wp_cli'),
    (err) => err instanceof PhpCliToolError && err.code === 'wp_cli_argument_invalid',
  );

  // Valid commands
  const valid = phpCliToolInternals.validateCommandArgs('plugin', ['list', '--format=json'], phpCliToolInternals.WP_CLI_ALLOWED_COMMANDS, 'wp_cli');
  assert.deepEqual(valid, ['plugin', 'list', '--format=json']);
});

test('runWpCli executes command via runuser as site user', async () => {
  let executedFile = null;
  let executedArgs = null;
  let executedOptions = null;

  const manager = createPhpCliToolManager({
    wpCliPaths: ['/usr/local/bin/wp'],
    lstatFn: async () => ({ isFile: () => true, isSymbolicLink: () => false, isDirectory: () => true }),
    realpathFn: async () => VALID_REAL_CWD,
    readFileFn: async () => MOCK_PASSWD,
    run: async (file, args, options) => {
      if (args[0] === '--version') {
        return { stdout: 'WP-CLI 2.8.1\n', stderr: '' };
      }
      executedFile = file;
      executedArgs = args;
      executedOptions = options;
      return { stdout: JSON.stringify([{ name: 'akismet', status: 'active' }]), stderr: '' };
    },
  });

  const result = await manager.runWpCli({
    unixUser: VALID_USER,
    cwd: VALID_CWD,
    command: 'plugin',
    args: ['list', '--format=json'],
  });

  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(executedFile, '/usr/sbin/runuser');
  assert.deepEqual(executedArgs, [
    '-u', VALID_USER,
    '--', '/usr/local/bin/wp',
    'plugin', 'list', '--format=json',
  ]);
  assert.equal(executedOptions.cwd, VALID_REAL_CWD);
  assert.equal(executedOptions.env.USER, VALID_USER);
});

test('runComposer executes command via runuser as site user', async () => {
  let executedFile = null;
  let executedArgs = null;

  const manager = createPhpCliToolManager({
    composerPaths: ['/usr/bin/composer'],
    lstatFn: async () => ({ isFile: () => true, isSymbolicLink: () => false, isDirectory: () => true }),
    realpathFn: async () => VALID_REAL_CWD,
    readFileFn: async () => MOCK_PASSWD,
    run: async (file, args) => {
      if (args[0] === '--version') {
        return { stdout: 'Composer 2.7.2\n', stderr: '' };
      }
      executedFile = file;
      executedArgs = args;
      return { stdout: '{"valid": true}', stderr: '' };
    },
  });

  const result = await manager.runComposer({
    unixUser: VALID_USER,
    cwd: VALID_CWD,
    command: 'validate',
    args: ['--strict'],
  });

  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(executedFile, '/usr/sbin/runuser');
  assert.deepEqual(executedArgs, [
    '-u', VALID_USER,
    '--', '/usr/bin/composer',
    'validate', '--strict',
  ]);
});

test('resolveTargetContext correctly handles symlink cwd resolving to release dir', async () => {
  const manager = createPhpCliToolManager({
    statFn: async (p) => {
      assert.equal(p, VALID_REAL_CWD);
      return { isDirectory: () => true };
    },
    realpathFn: async (p) => {
      assert.equal(p, VALID_CWD);
      return VALID_REAL_CWD;
    },
    readFileFn: async () => MOCK_PASSWD,
  });

  const context = await manager.resolveTargetContext({
    unixUser: VALID_USER,
    cwd: VALID_CWD,
  });

  assert.equal(context.cwd, VALID_REAL_CWD);
  assert.equal(context.account.user, VALID_USER);
});
