import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createPassengerSiteManager,
  createWebsitePassengerEnvironmentManager,
  PassengerSiteManagerError,
  validatePassengerSetup,
  WebsitePassengerEnvironmentError,
} from '@yunpanel/host-runtime';
import { renderPassengerSiteConfig } from '@yunpanel/config-templates';

test('Passenger Runtime Validation Slice - Env, Log, Startup, Config Validation & Rollback', async (t) => {
  const applicationId = 'c1000000-0000-4000-8000-000000000001';
  const operationId = 'c1000000-0000-4000-8000-000000000002';
  const unixUser = 'yunapp-0123456789ab';
  const appRoot = `/var/lib/yunpanel/apps/${applicationId}/current`;
  const logFile = `/var/lib/yunpanel/data/${applicationId}/logs/passenger.log`;

  await t.test('1. Setup Input Validation', () => {
    // Valid setup
    assert.equal(
      validatePassengerSetup({
        nodeMajor: 24,
        startupFile: 'server.js',
        appRoot,
        unixUser,
      }),
      true,
    );

    // Invalid Node major
    assert.throws(
      () => validatePassengerSetup({
        nodeMajor: 16,
        startupFile: 'server.js',
        appRoot,
        unixUser,
      }),
      (err) => err instanceof PassengerSiteManagerError && err.code === 'passenger_site_node_major_invalid',
    );

    // Invalid startup file extension (e.g. non-node script)
    assert.throws(
      () => validatePassengerSetup({
        nodeMajor: 24,
        startupFile: 'app.py',
        appRoot,
        unixUser,
      }),
      (err) => err instanceof PassengerSiteManagerError && err.code === 'passenger_site_startup_extension_invalid',
    );

    // Invalid unix user
    assert.throws(
      () => validatePassengerSetup({
        nodeMajor: 24,
        startupFile: 'server.js',
        appRoot,
        unixUser: 'root',
      }),
      (err) => err instanceof PassengerSiteManagerError && err.code === 'passenger_site_identity_mismatch',
    );
  });

  await t.test('2. Environment Validation and Rollback', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'yunpanel-passenger-env-test-'));
    const includeRoot = path.join(tempDir, 'include');
    const receiptRoot = path.join(tempDir, 'receipt');

    try {
      const envManager = createWebsitePassengerEnvironmentManager({
        includeRoot,
        receiptRoot,
        // The packaged API runs as root. Preserve real filesystem behavior while
        // modeling the ownership that the production manager requires.
        lstatFn: async (target) => {
          const stat = await lstat(target);
          return {
            uid: 0,
            gid: 0,
            mode: stat.mode,
            isFile: () => stat.isFile(),
            isSymbolicLink: () => stat.isSymbolicLink(),
          };
        },
      });

      // Reserved key rejection
      await assert.rejects(
        () => envManager.apply({
          applicationId,
          environmentRevision: 1,
          values: { NODE_ENV: 'development' },
        }, { operationId }),
        (err) => err instanceof WebsitePassengerEnvironmentError && err.code === 'website_passenger_environment_reserved_key',
      );

      // Valid env apply
      const applied = await envManager.apply({
        applicationId,
        environmentRevision: 1,
        values: { APP_PORT: '3000', APP_SECRET: 'secret123' },
      }, { operationId });

      assert.equal(applied.satisfied, true);
      assert.equal(applied.variableCount, 2);

      // Verify receipt persisted
      const opState = await envManager.operation(applicationId, operationId);
      assert.equal(opState.state, 'active');

      // Rollback (compensate)
      const compensated = await envManager.compensate({
        applicationId,
        environmentRevision: 1,
        values: { APP_PORT: '3000', APP_SECRET: 'secret123' },
      }, { operationId, ownedByOperation: true });

      assert.equal(compensated.satisfied, true);
      assert.equal(compensated.restored, true);

      // Verify the rollback-specific inspector after compensation.
      const afterComp = await envManager.inspectCompensation({
        applicationId,
        environmentRevision: 1,
        values: { APP_PORT: '3000', APP_SECRET: 'secret123' },
      }, { operationId, ownedByOperation: true });
      assert.equal(afterComp.satisfied, true);
      assert.equal(afterComp.restored, true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('3. Log Path and Nginx Config Directives', () => {
    const config = renderPassengerSiteConfig({
      primaryDomain: 'test-app.com',
      aliases: ['www.test-app.com'],
      target: {
        appRoot,
        documentRoot: `${appRoot}/public`,
        startupFile: 'index.js',
        nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
        user: unixUser,
        group: unixUser,
        appLogFile: logFile,
      },
      nginxSettings: { headers: [] },
    });

    assert.match(config, /passenger_enabled on;/);
    assert.match(config, /passenger_app_type node;/);
    assert.match(config, /passenger_startup_file index\.js;/);
    assert.match(config, /passenger_nodejs \/opt\/yunpanel\/node-runtimes\/v24\/bin\/node;/);
    assert.match(config, new RegExp(`passenger_user ${unixUser};`));
    assert.match(config, new RegExp(`passenger_group ${unixUser};`));
    assert.match(config, new RegExp(`passenger_app_log_file ${logFile.replaceAll('/', '\\/')};`));
  });

  await t.test('4. Startup File Validation', () => {
    // Valid node extensions
    for (const file of ['server.js', 'main.mjs', 'index.cjs', 'src/server.js']) {
      assert.equal(
        validatePassengerSetup({
          nodeMajor: 24,
          startupFile: file,
          appRoot,
          unixUser,
        }),
        true,
      );
    }

    // Invalid extension
    for (const invalid of ['server.ts', 'main.php', 'index.html', 'startup']) {
      assert.throws(
        () => validatePassengerSetup({
          nodeMajor: 24,
          startupFile: invalid,
          appRoot,
          unixUser,
        }),
        /startup file must have a \.js/,
      );
    }
  });
});
