import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebsitePhpToolsService,
  WebsitePhpToolsServiceError,
} from '../src/website-php-tools-service.js';

const WEBSITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APP_ID = '11111111-1111-4111-8111-111111111111';
const UNIX_USER = 'yunapp-0123456789ab';

function createMockRegistries({
  website = {
    id: WEBSITE_ID,
    applicationId: APP_ID,
    unixUser: UNIX_USER,
    runtimeType: 'php',
  },
  application = {
    id: APP_ID,
    type: 'php',
  },
} = {}) {
  return {
    websiteRegistry: {
      getWebsite: async (id) => (id === WEBSITE_ID ? website : null),
    },
    applicationRegistry: {
      getApplication: async (id) => (id === APP_ID ? application : null),
    },
  };
}

test('resolveWebsitePhpContext rejects non-PHP website', async () => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries({
    website: {
      id: WEBSITE_ID,
      applicationId: APP_ID,
      unixUser: UNIX_USER,
      runtimeType: 'static',
    },
    application: {
      id: APP_ID,
      type: 'static',
    },
  });

  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: {},
    lstatFn: async () => ({ isDirectory: () => false }),
  });

  await assert.rejects(
    async () => service.getWpCliStatus(WEBSITE_ID),
    (err) => err instanceof WebsitePhpToolsServiceError && err.code === 'website_runtime_not_php' && err.status === 409,
  );
});

test('getWpCliStatus returns full status when WP is installed', async () => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries();
  const mockPhpCliToolManager = {
    inspectWpCli: async () => ({
      available: true,
      path: '/usr/local/bin/wp',
      version: '2.8.1',
    }),
    runWpCli: async ({ command, args }) => {
      if (command === 'core' && args[0] === 'is-installed') {
        return { success: true, exitCode: 0, stdout: '', stderr: '' };
      }
      if (command === 'core' && args[0] === 'version') {
        return { success: true, exitCode: 0, stdout: '6.4.2\n', stderr: '' };
      }
      if (command === 'plugin' && args[0] === 'list') {
        return { success: true, exitCode: 0, stdout: JSON.stringify([{ name: 'akismet', status: 'active' }]), stderr: '' };
      }
      if (command === 'theme' && args[0] === 'list') {
        return { success: true, exitCode: 0, stdout: JSON.stringify([{ name: 'twentytwentyfour', status: 'active' }]), stderr: '' };
      }
      return { success: false, exitCode: 1, stdout: '', stderr: 'unknown' };
    },
  };

  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: mockPhpCliToolManager,
    lstatFn: async () => ({ isDirectory: () => true }),
  });

  const status = await service.getWpCliStatus(WEBSITE_ID);
  assert.equal(status.available, true);
  assert.equal(status.version, '2.8.1');
  assert.equal(status.installed, true);
  assert.equal(status.coreVersion, '6.4.2');
  assert.deepEqual(status.plugins, [{ name: 'akismet', status: 'active' }]);
  assert.deepEqual(status.themes, [{ name: 'twentytwentyfour', status: 'active' }]);
});

test('runWpCli executes command via phpCliToolManager', async () => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries();
  let passedContext = null;

  const mockPhpCliToolManager = {
    runWpCli: async (ctx) => {
      passedContext = ctx;
      return { success: true, exitCode: 0, stdout: 'Success: Cache flushed.\n', stderr: '' };
    },
  };

  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: mockPhpCliToolManager,
    lstatFn: async () => ({ isDirectory: () => true }),
  });

  const result = await service.runWpCli(WEBSITE_ID, {
    command: 'cache',
    args: ['flush'],
  });

  assert.equal(result.success, true);
  assert.equal(result.stdout, 'Success: Cache flushed.\n');
  assert.equal(passedContext.unixUser, UNIX_USER);
  assert.equal(passedContext.command, 'cache');
  assert.deepEqual(passedContext.args, ['flush']);
});

test('getComposerStatus detects composer.json and runs validate', async () => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries();
  const mockPhpCliToolManager = {
    inspectComposer: async () => ({
      available: true,
      path: '/usr/bin/composer',
      version: '2.7.2',
    }),
    runComposer: async ({ command, args }) => {
      if (command === 'validate') {
        return { success: true, exitCode: 0, stdout: './composer.json is valid\n', stderr: '' };
      }
      return { success: false, exitCode: 1, stdout: '', stderr: '' };
    },
  };

  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: mockPhpCliToolManager,
    lstatFn: async (p) => {
      if (p.endsWith('composer.json') || p.endsWith('composer.lock')) {
        return { isFile: () => true, isDirectory: () => false };
      }
      return { isFile: () => false, isDirectory: () => true };
    },
  });

  const status = await service.getComposerStatus(WEBSITE_ID);
  assert.equal(status.available, true);
  assert.equal(status.version, '2.7.2');
  assert.equal(status.hasComposerJson, true);
  assert.equal(status.hasComposerLock, true);
  assert.equal(status.valid, true);
});

test('runComposer executes command via phpCliToolManager', async () => {
  const { websiteRegistry, applicationRegistry } = createMockRegistries();
  let passedContext = null;

  const mockPhpCliToolManager = {
    runComposer: async (ctx) => {
      passedContext = ctx;
      return { success: true, exitCode: 0, stdout: 'Generating optimized autoload files\n', stderr: '' };
    },
  };

  const service = createWebsitePhpToolsService({
    websiteRegistry,
    applicationRegistry,
    phpCliToolManager: mockPhpCliToolManager,
    lstatFn: async () => ({ isFile: () => false, isDirectory: () => true }),
  });

  const result = await service.runComposer(WEBSITE_ID, {
    command: 'dump-autoload',
    args: ['-o'],
  });

  assert.equal(result.success, true);
  assert.equal(result.stdout, 'Generating optimized autoload files\n');
  assert.equal(passedContext.unixUser, UNIX_USER);
  assert.equal(passedContext.command, 'dump-autoload');
  assert.deepEqual(passedContext.args, ['-o']);
});
