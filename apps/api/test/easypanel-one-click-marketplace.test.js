import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createDockerComposeObserver } from '@yunpanel/host-runtime';
import { createDockerComposeProjectRegistry } from '../src/docker-compose-project-registry.js';
import { createDockerComposeEnvironmentRegistry } from '../src/docker-compose-environment-registry.js';
import { createDockerRegistryCredentialRegistry } from '../src/docker-registry-credential-registry.js';
import { createDockerComposeOperationsService } from '../src/docker-compose-operations.js';
import { createJobRegistry } from '../src/job-registry.js';
import { mountDockerComposeRoutes } from '../src/docker-compose-http.js';
import {
  DockerPleskCatalogError,
  EASYPANEL_ONE_CLICK_APPS,
  PLESK_DOCKER_CATALOG,
  listEasypanelOneClickApps,
  prepareOneClickAppProvision,
  provisionOneClickApp,
  resolveDockerProxyRule,
} from '../src/docker-plesk-catalog.js';

const SERVER_ID = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

function computeValidationSummary(projectName, document, {
  serviceName = 'app',
  targetPort = 8080,
  publishedPort = 18080,
  hostIp = '127.0.0.1',
  volumeName = 'app_data',
  volumeTarget = '/data',
} = {}) {
  const serviceMatch = /^ {2}([a-z0-9][a-z0-9_.-]*):$/m.exec(document);
  const portMatch = /"([0-9.]+):(\d+):(\d+)\/(tcp|udp)"/.exec(document);
  const volumeMatch = /^ {6}- "([^":]+):([^":]+)(?::ro)?"/m.exec(document);

  const resolvedService = serviceMatch ? serviceMatch[1] : serviceName;
  const resolvedHostIp = portMatch ? portMatch[1] : hostIp;
  const resolvedPublishedPort = portMatch ? Number(portMatch[2]) : publishedPort;
  const resolvedTargetPort = portMatch ? Number(portMatch[3]) : targetPort;
  const resolvedVolumeName = volumeMatch ? volumeMatch[1] : volumeName;
  const resolvedVolumeTarget = volumeMatch ? volumeMatch[2] : volumeTarget;

  return {
    version: 1,
    projectName,
    composeSha256: createHash('sha256').update(document).digest('hex'),
    composeBytes: Buffer.byteLength(document),
    serviceCount: 1,
    services: [
      {
        name: resolvedService,
        imageConfigured: true,
        buildConfigured: false,
        publishedPorts: [
          {
            hostIp: resolvedHostIp,
            publishedPort: resolvedPublishedPort,
            targetPort: resolvedTargetPort,
            protocol: 'tcp',
          },
        ],
        storageMounts: resolvedVolumeName
          ? [
            {
              kind: 'named_volume',
              source: resolvedVolumeName,
              sourceScope: 'project',
              target: resolvedVolumeTarget,
              readOnly: false,
            },
          ]
          : [],
      },
    ],
    networks: ['default'],
    volumes: resolvedVolumeName ? [resolvedVolumeName] : [],
    secretCount: 0,
    configCount: 0,
    validated: true,
    sideEffects: false,
  };
}

async function createRealDockerApiServer(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-easypanel-one-click-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const masterKey = randomBytes(32);
  const projectRegistry = createDockerComposeProjectRegistry({
    filePath: path.join(rootDir, 'docker-projects.json'),
    masterKey,
    serverExists: async (id) => id === SERVER_ID,
  });
  await projectRegistry.init();

  const environmentRegistry = createDockerComposeEnvironmentRegistry({
    filePath: path.join(rootDir, 'docker-environments.json'),
    masterKey,
    projectExists: async (id) => Boolean(await projectRegistry.getProject(id)),
  });
  await environmentRegistry.init();

  const credentialRegistry = createDockerRegistryCredentialRegistry({
    filePath: path.join(rootDir, 'docker-credentials.json'),
    masterKey,
    projectExists: async (id) => Boolean(await projectRegistry.getProject(id)),
  });
  await credentialRegistry.init();

  const jobRegistry = createJobRegistry();
  const operationsService = createDockerComposeOperationsService({
    projectRegistry,
    environmentRegistry,
    credentialRegistry,
    jobRegistry,
    projectBackupLocked: async () => false,
    inspectRemoval: async () => ({
      removable: true,
      blockingWebsites: [],
      runtimeStatus: 'stopped',
    }),
  });

  const observer = createDockerComposeObserver();
  const validateDockerCompose = async ({ projectName, document }) => computeValidationSummary(projectName, document);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: 'owner-1', username: 'admin', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    next();
  });

  mountDockerComposeRoutes(app, {
    dockerComposeProjectRegistry: projectRegistry,
    dockerComposeEnvironmentRegistry: environmentRegistry,
    dockerRegistryCredentialRegistry: credentialRegistry,
    dockerComposeOperationsService: operationsService,
    dockerComposeObserver: observer,
    validateDockerCompose,
    localServerId: SERVER_ID,
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    rootDir,
    projectRegistry,
    environmentRegistry,
    credentialRegistry,
    validateDockerCompose,
    baseUrl,
  };
}

test('EASYPANEL_ONE_CLICK_APPS includes all 14 1-Click templates while keeping PLESK_DOCKER_CATALOG intact', () => {
  const expectedPleskIds = [
    'redis',
    'postgres',
    'mariadb',
    'nginx',
    'n8n',
    'ghost',
    'uptime-kuma',
    'minio',
    'wordpress-stack',
    'node-app',
  ];
  assert.deepEqual(PLESK_DOCKER_CATALOG.map((item) => item.id), expectedPleskIds);

  const expectedOneClickIds = [
    'pocketbase',
    'n8n',
    'directus',
    'strapi',
    'umami',
    'meilisearch',
    'ghost',
    'wordpress-stack',
    'uptime-kuma',
    'minio',
    'grafana',
    'redis',
    'postgres',
    'ollama-webui',
  ];
  assert.deepEqual(EASYPANEL_ONE_CLICK_APPS.map((item) => item.id), expectedOneClickIds);

  const jamstackApps = listEasypanelOneClickApps({ category: 'jamstack_baas' });
  assert.deepEqual(jamstackApps.map((item) => item.id), ['pocketbase', 'meilisearch']);

  const cmsApps = listEasypanelOneClickApps({ category: 'headless_cms' });
  assert.deepEqual(cmsApps.map((item) => item.id), ['directus', 'strapi', 'ghost', 'wordpress-stack']);

  const automationApps = listEasypanelOneClickApps({ category: 'automation_ai' });
  assert.deepEqual(automationApps.map((item) => item.id), ['n8n', 'ollama-webui']);

  const monitoringApps = listEasypanelOneClickApps({ category: 'analytics_monitoring' });
  assert.deepEqual(monitoringApps.map((item) => item.id), ['umami', 'uptime-kuma', 'grafana']);

  const dbApps = listEasypanelOneClickApps({ category: 'database_cache' });
  assert.deepEqual(dbApps.map((item) => item.id), ['redis', 'postgres']);

  const searchResult = listEasypanelOneClickApps({ q: 'umami', category: 'analytics_monitoring' });
  assert.equal(searchResult.length, 1);
  assert.equal(searchResult[0].id, 'umami');
});

test('prepareOneClickAppProvision auto-generates strong random secrets (never leaving change_me) and valid Compose YAML + proxy preview', () => {
  const templatesToVerify = [
    { id: 'pocketbase', expectedInner: 8090, expectedOuter: 18090, minSecrets: 1, hostname: 'pb.example.com' },
    { id: 'n8n', expectedInner: 5678, expectedOuter: 15678, minSecrets: 1, hostname: 'n8n.example.com' },
    { id: 'directus', expectedInner: 8055, expectedOuter: 18055, minSecrets: 3, hostname: 'cms.example.com' },
    { id: 'meilisearch', expectedInner: 7700, expectedOuter: 17700, minSecrets: 1, hostname: 'search.example.com' },
    { id: 'umami', expectedInner: 3000, expectedOuter: 13005, minSecrets: 1, hostname: 'stats.example.com' },
  ];

  for (const spec of templatesToVerify) {
    const first = prepareOneClickAppProvision({
      templateId: spec.id,
      projectName: `${spec.id}_prod`,
      hostname: spec.hostname,
      urlPath: '/',
    });
    const second = prepareOneClickAppProvision({
      templateId: spec.id,
      projectName: `${spec.id}_prod`,
      hostname: spec.hostname,
      urlPath: '/',
    });

    assert.equal(first.templateId, spec.id);
    assert.equal(first.projectName, `${spec.id}_prod`);
    assert.ok(first.generatedSecretsCount >= spec.minSecrets);
    assert.ok(!first.document.includes('change_me'), `Expected no change_me in ${spec.id} document`);
    assert.notEqual(first.document, second.document, `Expected unique random secrets per call for ${spec.id}`);
    assert.equal(first.portMapping.innerPort, spec.expectedInner);
    assert.equal(first.portMapping.outerPort, spec.expectedOuter);
    assert.equal(first.proxyPreview.hostname, spec.hostname);
    assert.equal(first.proxyPreview.urlPath, '/');
    assert.equal(first.proxyPreview.upstreamHost, '127.0.0.1');
    assert.equal(first.proxyPreview.upstreamPort, spec.expectedOuter);
    assert.equal(first.proxyPreview.innerPort, spec.expectedInner);
    assert.equal(first.proxyPreview.outerPort, spec.expectedOuter);
  }

  assert.throws(
    () => prepareOneClickAppProvision({ templateId: 'nonexistent-app' }),
    (error) => error instanceof DockerPleskCatalogError && error.code === 'one_click_template_not_found',
  );
});

test('HTTP endpoints GET /api/docker/one-click-apps and POST /api/docker/one-click-apps/prepare + real registry & proxy resolution', async (t) => {
  const { projectRegistry, validateDockerCompose, baseUrl } = await createRealDockerApiServer(t);

  const listResponse = await fetch(`${baseUrl}/api/docker/one-click-apps?category=jamstack_baas`);
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.equal(listPayload.total, 2);
  assert.deepEqual(listPayload.data.map((item) => item.id), ['pocketbase', 'meilisearch']);

  const prepareResponse = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      templateId: 'directus',
      projectName: 'directus_headless',
      hostname: 'directus.example.com',
      urlPath: '/cms',
    }),
  });
  assert.equal(prepareResponse.status, 200);
  const preparePayload = await prepareResponse.json();
  assert.equal(preparePayload.sideEffects, false);
  const prepared = preparePayload.data;
  assert.equal(prepared.templateId, 'directus');
  assert.equal(prepared.projectName, 'directus_headless');
  assert.equal(prepared.generatedSecretsCount, 3);
  assert.ok(!prepared.document.includes('change_me'));
  assert.equal(prepared.proxyPreview.hostname, 'directus.example.com');
  assert.equal(prepared.proxyPreview.urlPath, '/cms');
  assert.equal(prepared.proxyPreview.upstreamPort, 18055);

  const createResponse = await fetch(`${baseUrl}/api/docker/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId: SERVER_ID,
      projectName: prepared.projectName,
      document: prepared.document,
    }),
  });
  assert.equal(createResponse.status, 201);
  const createdPayload = await createResponse.json();
  const createdProject = createdPayload.data.project;
  assert.equal(createdProject.projectName, 'directus_headless');

  const proxyResponse = await fetch(`${baseUrl}/api/docker/proxy-rules/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: createdProject.id,
      hostname: 'directus.example.com',
      urlPath: '/cms',
      serviceName: 'directus',
      innerPort: 8055,
    }),
  });
  assert.equal(proxyResponse.status, 200);
  const proxyPayload = await proxyResponse.json();
  assert.equal(proxyPayload.data.hostname, 'directus.example.com');
  assert.equal(proxyPayload.data.urlPath, '/cms');
  assert.equal(proxyPayload.data.innerPort, 8055);
  assert.equal(proxyPayload.data.outerPort, 18055);
  assert.equal(proxyPayload.data.upstreamHost, '127.0.0.1');
  assert.equal(proxyPayload.data.upstreamPort, 18055);

  const provisioned = await provisionOneClickApp(
    {
      templateId: 'pocketbase',
      projectName: 'pb_realtime',
      hostname: 'api.example.com',
      urlPath: '/pb',
    },
    {
      dockerComposeProjectRegistry: projectRegistry,
      validateDockerCompose,
      localServerId: SERVER_ID,
    },
  );
  assert.ok(provisioned.project.id);
  assert.equal(provisioned.proxyRule.hostname, 'api.example.com');
  assert.equal(provisioned.proxyRule.urlPath, '/pb');
  assert.equal(provisioned.proxyRule.upstreamPort, 18090);

  const manualResolved = await resolveDockerProxyRule(
    {
      projectId: provisioned.project.id,
      hostname: 'api.example.com',
      urlPath: '/pb',
    },
    {
      dockerComposeProjectRegistry: projectRegistry,
      localServerId: SERVER_ID,
    },
  );
  assert.equal(manualResolved.outerPort, 18090);
});

test('Easypanel 1-Click Marketplace UI wiring in DockerProjectsPage, DockerProjectCreateDialog, and docker-compose-client', async () => {
  const [pageSource, dialogSource, clientSource] = await Promise.all([
    readFile(path.join(REPO_ROOT, 'apps/web/src/workspace/DockerProjectsPage.jsx'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'apps/web/src/workspace/DockerProjectCreateDialog.jsx'), 'utf8'),
    readFile(path.join(REPO_ROOT, 'apps/web/src/workspace/docker-compose-client.js'), 'utf8'),
  ]);

  assert.match(clientSource, /export async function listOneClickApps/);
  assert.match(clientSource, /export async function prepareOneClickApp/);
  assert.match(clientSource, /\/docker\/one-click-apps\/prepare/);

  assert.match(pageSource, /JAMstack & BaaS/);
  assert.match(pageSource, /Headless CMS/);
  assert.match(pageSource, /Otomasyon & AI/);
  assert.match(pageSource, /İzleme & Analitik/);
  assert.match(pageSource, /Veritabanı & Cache/);
  assert.match(pageSource, /Canlı Docker Hub Arama/);
  assert.match(pageSource, /Tek Tıkla Kur \(Easypanel\)/);
  assert.match(pageSource, /Otomatik Secret & Volume/);
  assert.match(pageSource, /Tek Tıkla Kur/);

  assert.match(dialogSource, /prepareOneClickApp/);
  assert.match(dialogSource, /Tek Tıkla Kur \(Easypanel\)/);
});
