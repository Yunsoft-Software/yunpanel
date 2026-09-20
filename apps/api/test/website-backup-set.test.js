import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WebsiteBackupSetError,
  createWebsiteBackupSetProvider,
  normalizeWebsiteBackupSet,
} from '../src/website-backup-set.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const otherServerId = 'd0bc7f95-bdbd-4375-904f-50c532fc3faa';
const websiteId = '2c387b02-8747-458a-b509-8f531d4d149e';
const staticWebsiteId = '3d498c03-9858-469b-8610-9f642e5e250f';
const composeWebsiteId = '4e509d14-a969-470c-8721-a0753f6f361a';
const dockerWebsiteId = '5f61ae25-ba7a-481d-8832-b1864a70472b';
const notFoundWebsiteId = '00000000-0000-4000-8000-000000000000';
const applicationId = '84e0ccf3-13b7-4abe-b8aa-68fc22d6f2c8';
const staticAppId = '95f1dd04-24c8-4bcf-89bb-79fd33e703d9';
const releaseId = '0bb78242-03a6-429f-9d17-7725c521437c';
const domainId = 'c2591ea3-e1c2-4c37-a194-cc5650acd9ef';
const aliasDomainId = 'd3602fb4-f2d3-4d48-b2a5-dd6761bde0fa';
const mailDomainId = 'f15f21e0-3ce8-47cf-93bf-d45c8c723246';
const databaseBindingId = 'd1432e13-edb5-49f5-8f9b-302c407c784b';
const projectId = '5bc2c0f4-948a-4f34-826c-5a9703f9cbf0';

function fixture() {
  const websites = new Map([
    [websiteId, {
      id: websiteId,
      serverId,
      name: 'NodeApp',
      primaryDomain: 'example.com',
      runtimeType: 'node',
      applicationId,
      unixUser: 'yunapp-84e0ccf313b7',
      documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
      revision: 4,
    }],
    [staticWebsiteId, {
      id: staticWebsiteId,
      serverId,
      name: 'StaticApp',
      primaryDomain: 'static.example.com',
      runtimeType: 'static',
      applicationId: staticAppId,
      unixUser: 'yunapp-95f1dd0424c8',
      documentRoot: `/var/www/yunpanel/apps/${staticAppId}/current`,
      revision: 2,
    }],
    [composeWebsiteId, {
      id: composeWebsiteId,
      serverId,
      name: 'ComposeApp',
      primaryDomain: 'compose.example.com',
      runtimeType: 'docker',
      applicationId: null,
      managedComposeBinding: {
        projectId,
        projectName: 'shop_stack',
        projectDirectory: `/var/lib/yunpanel/compose/${projectId}`,
      },
      documentRoot: null,
      revision: 3,
    }],
    [dockerWebsiteId, {
      id: dockerWebsiteId,
      serverId,
      name: 'DockerProxyApp',
      primaryDomain: 'docker.example.com',
      runtimeType: 'docker',
      applicationId: null,
      documentRoot: '/var/www/custom',
      revision: 1,
    }],
  ]);

  const domains = [
    {
      id: domainId,
      serverId,
      websiteId,
      primaryDomain: 'example.com',
      aliases: ['www.example.com'],
      dns: { mode: 'local', zoneName: 'example.com' },
      appliedRevision: 4,
    },
    {
      id: aliasDomainId,
      serverId,
      websiteId: staticWebsiteId,
      primaryDomain: 'static.example.com',
      aliases: [],
      dns: { mode: 'external', zoneName: 'static.example.com' },
      appliedRevision: 2,
    },
  ];

  const databaseBindings = [
    {
      id: databaseBindingId,
      serverId,
      websiteId,
      applicationId,
      databaseName: 'app_production',
      unixUser: 'yunapp-84e0ccf313b7',
      revision: 2,
    },
  ];

  const mailDomains = [
    {
      id: mailDomainId,
      webDomainId: domainId,
      domainName: 'example.com',
      managementMode: 'local',
      status: 'enabled',
      revision: 3,
    },
  ];

  const projects = new Map([
    [projectId, {
      id: projectId,
      serverId,
      projectName: 'shop_stack',
      projectDirectory: `/var/lib/yunpanel/compose/${projectId}`,
      services: [
        {
          name: 'web',
          storageMounts: [
            { kind: 'named_volume', source: 'uploads', sourceScope: 'project', target: '/app/uploads', readOnly: false },
            { kind: 'bind', source: './data', sourceScope: 'project', target: '/app/data', readOnly: false },
          ],
        },
      ],
    }],
  ]);

  const provider = createWebsiteBackupSetProvider({
    websiteRegistry: {
      async getWebsite(id) {
        return websites.get(id) ?? null;
      },
    },
    domainRegistry: {
      async listDomains() {
        return domains;
      },
    },
    databaseBindingRegistry: {
      async listBindings({ serverId: sId, websiteId: wId }) {
        assert.equal(sId, serverId);
        return databaseBindings.filter((b) => b.websiteId === wId);
      },
    },
    mailDomainRegistry: {
      async listMailDomains() {
        return mailDomains;
      },
    },
    applicationRegistry: {
      async getApplication(id) {
        return {
          id,
          serverId,
          currentReleaseId: releaseId,
        };
      },
    },
    applicationEnvironmentRegistry: {
      async environmentStatus(id) {
        return {
          applicationId: id,
          savedRevision: 5,
          appliedRevision: 4,
          appliedReleaseId: releaseId,
        };
      },
      async listVariables(id) {
        return [
          { applicationId: id, key: 'PORT', value: '3000', secret: false },
          { applicationId: id, key: 'API_SECRET', secret: true },
        ];
      },
    },
    dockerComposeProjectRegistry: {
      async getProject(id) {
        return projects.get(id) ?? null;
      },
    },
    localServerId: serverId,
  });

  return { provider, websites, domains, databaseBindings, mailDomains };
}

test('Website backup set generates complete set for Node.js website with database, mail, DNS, and Nginx', async () => {
  const { provider } = fixture();
  const backupSet = await provider.getWebsiteBackupSet({ websiteId });

  assert.equal(backupSet.version, 1);
  assert.equal(backupSet.website.id, websiteId);
  assert.equal(backupSet.website.runtimeType, 'node');
  assert.equal(backupSet.website.primaryDomain, 'example.com');

  // Files
  assert.equal(backupSet.files.currentRelease, `/var/lib/yunpanel/apps/${applicationId}/current`);
  assert.equal(backupSet.files.releasesDirectory, `/var/lib/yunpanel/apps/${applicationId}/releases`);
  assert.ok(backupSet.files.targetPaths.includes(`/var/lib/yunpanel/apps/${applicationId}/current`));
  assert.deepEqual(backupSet.files.exclusions, ['.git', 'node_modules/.cache', 'tmp']);

  // Data
  assert.equal(backupSet.data.persistentDataDirectory, `/var/lib/yunpanel/data/${applicationId}`);
  assert.equal(backupSet.data.logDirectory, `/var/lib/yunpanel/data/${applicationId}/logs`);
  assert.equal(backupSet.data.temporaryDirectory, `/var/lib/yunpanel/data/${applicationId}/tmp`);
  assert.ok(backupSet.data.targetPaths.includes(`/var/lib/yunpanel/data/${applicationId}`));
  assert.deepEqual(backupSet.data.exclusions, ['**/tmp/**', '**/*.sock', '**/*.pid']);

  // Env
  assert.equal(backupSet.env.savedRevision, 5);
  assert.equal(backupSet.env.appliedRevision, 4);
  assert.equal(backupSet.env.appliedReleaseId, releaseId);
  assert.equal(backupSet.env.variablesCount, 2);
  assert.deepEqual(backupSet.env.variableKeys, ['API_SECRET', 'PORT']);
  assert.equal(backupSet.env.stagedMetadataPath, `/var/lib/yunpanel/backups/resources/website/${websiteId}/env-metadata.json`);

  // DB dump
  assert.equal(backupSet.databases.length, 1);
  const db = backupSet.databases[0];
  assert.equal(db.databaseName, 'app_production');
  assert.equal(db.engine, 'mariadb');
  assert.equal(db.dumpHook.program, '/usr/bin/mariadb-dump');
  assert.ok(db.dumpHook.args.includes('app_production'));
  assert.equal(db.dumpHook.stagedDumpPath, `/var/lib/yunpanel/backups/resources/website/${websiteId}/databases/app_production.sql`);

  // Mail
  assert.equal(backupSet.mail.length, 1);
  const mail = backupSet.mail[0];
  assert.equal(mail.domainName, 'example.com');
  assert.equal(mail.managementMode, 'local');
  assert.equal(mail.storagePath, '/var/vmail/example.com');
  assert.equal(mail.virtualMailDbSnapshot, `/var/lib/yunpanel/backups/resources/website/${websiteId}/mail/example.com-virtual.sql`);

  // DNS
  assert.equal(backupSet.dns.length, 1);
  assert.equal(backupSet.dns[0].primaryDomain, 'example.com');
  assert.equal(backupSet.dns[0].mode, 'local');
  assert.equal(backupSet.dns[0].stagedZonePath, `/var/lib/yunpanel/backups/resources/website/${websiteId}/dns/example.com.zone.json`);

  // Nginx
  assert.equal(backupSet.nginx.length, 1);
  assert.equal(backupSet.nginx[0].configPath, `/etc/nginx/sites-available/yunpanel-${domainId}.conf`);
  assert.equal(backupSet.nginx[0].appliedRevision, 4);
  assert.equal(backupSet.nginx[0].stagedConfigPath, `/var/lib/yunpanel/backups/resources/website/${websiteId}/nginx/${domainId}.conf`);

  // Compose hooks
  assert.equal(backupSet.composeHooks.enabled, false);

  // Consolidated target paths
  assert.ok(backupSet.targetPaths.includes(`/var/lib/yunpanel/apps/${applicationId}/current`));
  assert.ok(backupSet.targetPaths.includes(`/var/lib/yunpanel/data/${applicationId}`));
  assert.ok(backupSet.targetPaths.includes(`/var/lib/yunpanel/backups/resources/website/${websiteId}`));
  assert.ok(backupSet.targetPaths.includes('/var/vmail/example.com'));

  // Tags & Digest
  assert.deepEqual(backupSet.tags, [
    `domain:example.com`,
    `runtime:node`,
    `server:${serverId}`,
    `website:${websiteId}`,
  ]);
  assert.equal(typeof backupSet.digest, 'string');
  assert.equal(backupSet.digest.length, 64);
});

test('Website backup set generates complete set for Static website', async () => {
  const { provider } = fixture();
  const backupSet = await provider.getWebsiteBackupSet({ websiteId: staticWebsiteId });

  assert.equal(backupSet.website.id, staticWebsiteId);
  assert.equal(backupSet.website.runtimeType, 'static');
  assert.equal(backupSet.files.publishRoot, `/var/www/yunpanel/apps/${staticAppId}`);
  assert.ok(backupSet.files.targetPaths.includes(`/var/www/yunpanel/apps/${staticAppId}`));
  assert.equal(backupSet.databases.length, 0);
  assert.equal(backupSet.mail.length, 0);
  assert.equal(backupSet.dns.length, 1);
  assert.equal(backupSet.dns[0].mode, 'external');
});

test('Website backup set generates complete set for Managed Compose website with hooks', async () => {
  const { provider } = fixture();
  const backupSet = await provider.getWebsiteBackupSet({ websiteId: composeWebsiteId });

  assert.equal(backupSet.website.id, composeWebsiteId);
  assert.equal(backupSet.composeHooks.enabled, true);
  assert.equal(backupSet.composeHooks.projectId, projectId);
  assert.equal(backupSet.composeHooks.projectName, 'shop_stack');
  assert.equal(backupSet.composeHooks.composeFile, `/var/lib/yunpanel/compose/${projectId}/docker-compose.yml`);

  // Pre and post hooks
  assert.deepEqual(backupSet.composeHooks.preHook, {
    command: 'docker',
    args: ['compose', '-p', 'shop_stack', '-f', `/var/lib/yunpanel/compose/${projectId}/docker-compose.yml`, 'pause'],
  });
  assert.deepEqual(backupSet.composeHooks.postHook, {
    command: 'docker',
    args: ['compose', '-p', 'shop_stack', '-f', `/var/lib/yunpanel/compose/${projectId}/docker-compose.yml`, 'unpause'],
  });

  // Storage
  assert.equal(backupSet.composeHooks.storage.length, 2);
  assert.ok(backupSet.targetPaths.includes(`/var/lib/yunpanel/compose/${projectId}`));
});

test('Website backup set handles Docker proxy website with documentRoot and no application', async () => {
  const { provider } = fixture();
  const backupSet = await provider.getWebsiteBackupSet({ websiteId: dockerWebsiteId });

  assert.equal(backupSet.website.id, dockerWebsiteId);
  assert.equal(backupSet.files.documentRoot, '/var/www/custom');
  assert.ok(backupSet.files.targetPaths.includes('/var/www/custom'));
  assert.equal(backupSet.env.variablesCount, 0);
  assert.equal(backupSet.env.stagedMetadataPath, null);
  assert.equal(backupSet.data.persistentDataDirectory, null);
});

test('Website backup set error cases: not found, server mismatch, invalid uuid, dependencies', async () => {
  const { provider } = fixture();

  await assert.rejects(
    () => provider.getWebsiteBackupSet({ websiteId: 'non-existent-uuid' }),
    (err) => err instanceof WebsiteBackupSetError && err.code === 'invalid_website_id',
  );

  await assert.rejects(
    () => provider.getWebsiteBackupSet({ websiteId: notFoundWebsiteId }),
    (err) => err instanceof WebsiteBackupSetError && err.code === 'website_not_found' && err.status === 404,
  );

  await assert.rejects(
    () => provider.getWebsiteBackupSet({ websiteId, serverId: otherServerId }),
    (err) => err instanceof WebsiteBackupSetError && err.code === 'website_server_mismatch' && err.status === 404,
  );

  assert.throws(
    () => createWebsiteBackupSetProvider({}),
    (err) => err instanceof WebsiteBackupSetError && err.code === 'website_backup_set_dependencies_invalid',
  );
});

test('normalizeWebsiteBackupSet validates backup set and detects digest tampering', async () => {
  const { provider } = fixture();
  const backupSet = await provider.getWebsiteBackupSet({ websiteId });

  const normalized = normalizeWebsiteBackupSet(backupSet);
  assert.equal(normalized.digest, backupSet.digest);

  // Tampered digest
  assert.throws(
    () => normalizeWebsiteBackupSet({ ...backupSet, digest: '0'.repeat(64) }),
    (err) => err instanceof WebsiteBackupSetError && err.code === 'website_backup_set_digest_mismatch' && err.status === 409,
  );

  // Invalid structure
  assert.throws(
    () => normalizeWebsiteBackupSet({ invalid: true }),
    (err) => err instanceof WebsiteBackupSetError && err.code === 'website_backup_set_invalid' && err.status === 409,
  );
});
