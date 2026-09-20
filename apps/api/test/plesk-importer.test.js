import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPleskImporter,
  PleskImporterError,
} from '../src/plesk-importer.js';

const localServerId = '99bc760a-d508-4ae6-92be-efdedee9658d';

test('createPleskImporter requires valid localServerId', () => {
  assert.throws(
    () => createPleskImporter({ localServerId: 'invalid' }),
    /localServerId must be a UUID/,
  );
  assert.throws(
    () => createPleskImporter({}),
    /localServerId must be a UUID/,
  );
});

test('importFromOfflineExport rejects forbidden .44 server references', () => {
  const importer = createPleskImporter({ localServerId });

  assert.throws(
    () => importer.importFromOfflineExport({
      websites: [{ name: 'test.com', target: '157.180.11.44' }],
    }),
    (err) => err instanceof PleskImporterError && err.code === 'plesk_forbidden_target_server',
  );

  assert.throws(
    () => importer.importFromOfflineExport(JSON.stringify({
      websites: [{ name: 'test.com', dns: { records: [{ type: 'A', value: '157.180.11.44' }] } }],
    })),
    (err) => err instanceof PleskImporterError && err.code === 'plesk_forbidden_target_server',
  );
});

test('importFromOfflineExport processes Node, PHP, Python and Static websites', () => {
  const importer = createPleskImporter({ localServerId });

  const exportData = {
    websites: [
      {
        name: 'node-app.example.com',
        aliases: ['www.node-app.example.com'],
        runtime: {
          runtimeType: 'node',
          nodeVersion: '24.2.0',
          entryFile: 'server.js',
          documentRoot: 'dist/public',
        },
        databases: [
          { name: 'nodedb', user: 'nodeuser' },
        ],
        mail: {
          mailboxes: [
            { name: 'admin', email: 'admin@node-app.example.com', quotaMb: 500 },
          ],
          aliases: [
            { source: 'support@node-app.example.com', destination: 'admin@node-app.example.com' },
          ],
          forwardings: [
            { source: 'info@node-app.example.com', destination: 'external@gmail.com' },
          ],
        },
        dns: {
          records: [
            { name: 'node-app.example.com', type: 'A', value: '157.180.11.28', ttl: 3600 },
            { name: 'mail.node-app.example.com', type: 'A', value: '157.180.11.28', ttl: 3600 },
            { name: 'node-app.example.com', type: 'MX', value: '10 mail.node-app.example.com', ttl: 3600 },
          ],
        },
        crons: [
          { name: 'Queue Worker', schedule: '*/5 * * * *', command: 'node worker.js', enabled: true },
          { name: 'Invalid Cron', schedule: 'invalid * *', command: 'echo bad' },
        ],
        certificates: [
          {
            name: 'node-cert',
            cert: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----',
            privkey: '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----',
            domains: ['node-app.example.com', 'www.node-app.example.com'],
          },
        ],
        backups: [
          { name: 'backup_2026_09_20.tar', path: '/var/lib/plesk/backups/backup.tar', sizeBytes: 10485760 },
        ],
      },
      {
        name: 'php-app.example.com',
        runtimeType: 'php',
        phpVersion: '8.3.6',
        documentRoot: 'httpdocs',
        databases: [
          { name: 'wordpress_db', user: 'wp_user' },
        ],
      },
      {
        name: 'python-app.example.com',
        runtime: {
          runtimeType: 'python',
          pythonVersion: '3.12',
          entryFile: 'main.py',
        },
      },
      {
        name: 'static-site.example.com',
        runtime: {
          runtimeType: 'static',
          documentRoot: 'public',
        },
      },
    ],
  };

  const preview = importer.importFromOfflineExport(exportData);

  assert.equal(preview.readOnly, true);
  assert.equal(preview.serverId, localServerId);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);

  assert.equal(preview.summary.websitesCount, 4);
  assert.equal(preview.summary.domainsCount, 5); // 4 primary + 1 alias
  assert.equal(preview.summary.databasesCount, 2);
  assert.equal(preview.summary.mailboxesCount, 1);
  assert.equal(preview.summary.dnsZonesCount, 1);
  assert.equal(preview.summary.cronsCount, 1); // 1 valid, 1 warned
  assert.equal(preview.summary.certificatesCount, 1);

  // 1. Node website checks
  const nodeSite = preview.websites.find((w) => w.primaryDomain === 'node-app.example.com');
  assert.ok(nodeSite);
  assert.deepEqual(nodeSite.aliases, ['www.node-app.example.com']);
  assert.equal(nodeSite.runtime.type, 'node');
  assert.equal(nodeSite.runtime.runtimeAdapter, 'passenger');
  assert.equal(nodeSite.runtime.nodeMajor, '24');
  assert.equal(nodeSite.runtime.entryFile, 'server.js');
  assert.equal(nodeSite.runtime.documentRoot, 'dist/public');
  assert.equal(nodeSite.databases.length, 1);
  assert.equal(nodeSite.databases[0].name, 'nodedb');
  assert.equal(nodeSite.databases[0].type, 'mariadb');
  assert.equal(nodeSite.mailDomain.mailboxes.length, 1);
  assert.equal(nodeSite.mailDomain.mailboxes[0].quotaBytes, 500 * 1024 * 1024);
  assert.equal(nodeSite.dnsZone.records.length, 3);
  assert.equal(nodeSite.crons.length, 1);
  assert.equal(nodeSite.crons[0].name, 'Queue Worker');
  assert.equal(nodeSite.certificates.length, 1);
  assert.equal(nodeSite.backups.length, 1);

  // 2. PHP website checks
  const phpSite = preview.websites.find((w) => w.primaryDomain === 'php-app.example.com');
  assert.ok(phpSite);
  assert.equal(phpSite.runtime.type, 'php');
  assert.equal(phpSite.runtime.phpVersion, '8.3');
  assert.equal(phpSite.runtime.handler, 'fpm');

  // 3. Python website checks
  const pySite = preview.websites.find((w) => w.primaryDomain === 'python-app.example.com');
  assert.ok(pySite);
  assert.equal(pySite.runtime.type, 'python');
  assert.equal(pySite.runtime.pythonVersion, '3.12');
  assert.equal(pySite.runtime.entryFile, 'main.py');

  // 4. Static website checks
  const staticSite = preview.websites.find((w) => w.primaryDomain === 'static-site.example.com');
  assert.ok(staticSite);
  assert.equal(staticSite.runtime.type, 'static');

  // Warnings check
  assert.equal(preview.warnings.length, 1);
  assert.equal(preview.warnings[0].code, 'cron_expression_invalid');
});

test('importFromOfflineExport rejects invalid JSON string or empty payload', () => {
  const importer = createPleskImporter({ localServerId });

  assert.throws(
    () => importer.importFromOfflineExport('not valid json {['),
    (err) => err instanceof PleskImporterError && err.code === 'plesk_export_invalid_json',
  );

  assert.throws(
    () => importer.importFromOfflineExport({ websites: [] }),
    (err) => err instanceof PleskImporterError && err.code === 'plesk_export_no_websites',
  );

  assert.throws(
    () => importer.importFromOfflineExport(null),
    (err) => err instanceof PleskImporterError && err.code === 'plesk_export_empty',
  );
});
