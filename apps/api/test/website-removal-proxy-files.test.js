import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createServerRegistry } from '../src/server-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createWebsiteRegistry } from '../src/website-registry.js';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';
import { createWebsiteRemovalCleanupAdapters } from '../src/website-removal-cleanup-adapters.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-proxy-removal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const servers = createServerRegistry({ filePath: path.join(directory, 'servers.json') });
  const server = await servers.createLocalServer({ hostname: 'proxy-removal-test' });
  const serverExists = async (id) => Boolean(await servers.getServer(id));
  const applications = createApplicationRegistry({ filePath: path.join(directory, 'applications.json'), serverExists });
  const workloads = createDockerWorkloadRegistry({ filePath: path.join(directory, 'workloads.json'), serverExists });
  const websitesPath = path.join(directory, 'websites.json');
  const websites = createWebsiteRegistry({ filePath: websitesPath, serverExists,
    getApplication: (id) => applications.getApplication(id), getDockerWorkload: (id) => workloads.getWorkload(id) });
  const provisioning = createWebsiteProvisioningRuntime({ filePath: path.join(directory, 'provisioning.json') });
  await Promise.all([applications.init(), workloads.init(), websites.init(), provisioning.init()]);
  const website = await websites.createWebsite({ serverId: server.id, name: 'External proxy',
    runtimeType: 'proxy', proxyTarget: { host: '127.0.0.1', port: 32050, websocket: true } });
  const adapters = createWebsiteRemovalCleanupAdapters({ websiteRegistry: websites,
    applicationRegistry: applications, websiteProvisioningRuntime: provisioning });
  return { website, websites, workloads, websitesPath, adapters };
}

test('the production adapter completes file cleanup for a persisted external proxy without an Application', async (t) => {
  const { website, websitesPath, adapters } = await fixture(t);
  const before = await readFile(websitesPath, 'utf8');
  const input = { websiteId: website.id, applicationId: null };
  assert.deepEqual(await adapters.inspectFileCleanup(input), { ready: true, ...input, targets: [] });
  const expected = { ...input, retainedBackups: ['backup-retained'], retainedLogScopes: [website.id],
    filesCleaned: true, cleanedFilesCount: 0 };
  const cleanup = { ...input, retainedBackups: ['backup-retained'], retainedLogScopes: [website.id] };
  assert.deepEqual(await adapters.fileCleanupHandler(cleanup), expected);
  assert.deepEqual(await adapters.fileCleanupHandler(cleanup), expected);
  assert.equal(await readFile(websitesPath, 'utf8'), before);
});

test('external proxy cleanup rejects missing Websites, mismatched Applications and invalid retained scopes', async (t) => {
  const { website, adapters } = await fixture(t);
  await assert.rejects(adapters.fileCleanupHandler({ websiteId: randomUUID(), applicationId: null }),
    { code: 'website_cleanup_identity_drift' });
  await assert.rejects(adapters.fileCleanupHandler({ websiteId: website.id, applicationId: randomUUID() }),
    { code: 'website_cleanup_identity_drift' });
  await assert.rejects(adapters.fileCleanupHandler({ websiteId: website.id, applicationId: null, retainedBackups: [null] }),
    { code: 'website_cleanup_retained_scope_invalid' });
});

test('an Application-free Website with a different runtime cannot use external proxy cleanup', async (t) => {
  const { website, websites, workloads, adapters } = await fixture(t);
  const workload = await workloads.createWorkload({ serverId: website.serverId, name: 'External Docker',
    managementMode: 'external', proxyTarget: { host: '127.0.0.1', port: 32051, websocket: true } });
  const docker = await websites.createWebsite({ serverId: website.serverId, name: 'Docker Website',
    runtimeType: 'docker', dockerWorkloadId: workload.id });
  await assert.rejects(adapters.fileCleanupHandler({ websiteId: docker.id, applicationId: null }),
    { code: 'website_cleanup_application_drift' });
});
