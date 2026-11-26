import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createDockerComposeObserver } from '@yunpanel/host-runtime';
import {
  createDockerComposeProjectRegistry,
  DockerComposeProjectRegistryError,
} from '../src/docker/docker-compose-project-registry.js';
import { createDockerComposeEnvironmentRegistry } from '../src/docker/docker-compose-environment-registry.js';
import { createDockerRegistryCredentialRegistry } from '../src/docker/docker-registry-credential-registry.js';
import { createDockerComposeOperationsService } from '../src/docker/docker-compose-operations.js';
import { createJobRegistry } from '../src/jobs/job-registry.js';
import { mountDockerComposeRoutes } from '../src/docker/docker-compose-http.js';
import {
  DockerPleskCatalogError,
  generateComposeFromCatalogInput,
  inferDockerHubPortPreset,
  PLESK_DOCKER_CATALOG,
  resolveDockerProxyRule,
  searchDockerCatalog,
  searchDockerCatalogLive,
} from '../src/docker/docker-plesk-catalog.js';

const SERVER_ID = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const PROJECT_ID = '0bb78242-03a6-429f-9d17-7725c521437c';

function computeValidationSummary(projectName, document, {
  serviceName = 'n8n',
  targetPort = 5678,
  publishedPort = 15678,
  hostIp = '127.0.0.1',
  volumeName = 'n8n_data',
  volumeTarget = '/home/node/.n8n',
} = {}) {
  return {
    version: 1,
    projectName,
    composeSha256: createHash('sha256').update(document).digest('hex'),
    composeBytes: Buffer.byteLength(document),
    serviceCount: 1,
    services: [
      {
        name: serviceName,
        imageConfigured: true,
        buildConfigured: false,
        publishedPorts: [
          {
            hostIp,
            publishedPort,
            targetPort,
            protocol: 'tcp',
          },
        ],
        storageMounts: volumeName
          ? [
            {
              kind: 'named_volume',
              source: volumeName,
              sourceScope: 'project',
              target: volumeTarget,
              readOnly: false,
            },
          ]
          : [],
      },
    ],
    networks: ['default'],
    volumes: volumeName ? [volumeName] : [],
    secretCount: 0,
    configCount: 0,
    validated: true,
    sideEffects: false,
  };
}

async function createRealDockerApiServer(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-plesk-docker-real-'));
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
    baseUrl,
  };
}

test('real DockerComposeProjectRegistry decrypts YAML via getProjectDocument and GET /api/docker/compose/projects/:id/document', async (t) => {
  const { rootDir, projectRegistry, baseUrl } = await createRealDockerApiServer(t);

  const generated = generateComposeFromCatalogInput({
    projectName: 'n8n_stack',
    image: 'n8n',
    tag: 'latest',
    innerPort: 5678,
    outerPort: 15678,
    bindHost: '127.0.0.1',
  });

  const created = await projectRegistry.createProject({
    projectId: PROJECT_ID,
    serverId: SERVER_ID,
    projectName: 'n8n_stack',
    document: generated.document,
    validation: computeValidationSummary('n8n_stack', generated.document),
  });

  // Verify getProject preserves exact public shape without leaking raw document
  const publicRecord = await projectRegistry.getProject(PROJECT_ID);
  assert.equal(Object.hasOwn(publicRecord, 'document'), false);
  assert.equal(publicRecord.id, created.id);

  // Verify file on disk is encrypted at rest
  const rawDiskContent = await readFile(path.join(rootDir, 'docker-projects.json'), 'utf8');
  assert.equal(rawDiskContent.includes('n8nio/n8n'), false);

  // Verify getProjectDocument decrypts and returns exact Compose YAML
  const docRecord = await projectRegistry.getProjectDocument(PROJECT_ID);
  assert.deepEqual(docRecord, {
    projectId: PROJECT_ID,
    projectName: 'n8n_stack',
    revision: 1,
    composeSha256: createHash('sha256').update(generated.document).digest('hex'),
    document: generated.document,
  });

  await assert.rejects(
    projectRegistry.getProjectDocument('99999999-9999-4999-8999-999999999999'),
    (error) => error instanceof DockerComposeProjectRegistryError && error.code === 'docker_compose_project_not_found',
  );

  // Verify real HTTP endpoint GET /api/docker/compose/projects/:dockerProjectId/document
  const response = await fetch(`${baseUrl}/api/docker/compose/projects/${PROJECT_ID}/document`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data, {
    projectId: PROJECT_ID,
    projectName: 'n8n_stack',
    revision: 1,
    composeSha256: createHash('sha256').update(generated.document).digest('hex'),
    document: generated.document,
  });
});

test('Plesk Docker catalog search, 1-click Compose YAML generation, and Inner<->Outer Port Proxy rule resolution over HTTP', async (t) => {
  const { projectRegistry, baseUrl } = await createRealDockerApiServer(t);

  // 1. Catalog completeness & search filter
  const allItems = searchDockerCatalog();
  assert.equal(allItems.length, 10);
  const expectedIds = [
    'redis', 'postgres', 'mariadb', 'nginx', 'n8n',
    'ghost', 'uptime-kuma', 'minio', 'wordpress-stack', 'node-app',
  ];
  assert.deepEqual(allItems.map((item) => item.id), expectedIds);

  const catalogRes = await fetch(`${baseUrl}/api/docker/catalog?q=postgres`);
  assert.equal(catalogRes.status, 200);
  const catalogJson = await catalogRes.json();
  assert.equal(catalogJson.data.length, 1);
  assert.equal(catalogJson.data[0].id, 'postgres');
  assert.equal(catalogJson.data[0].innerPort, 5432);
  assert.equal(catalogJson.data[0].outerPort, 15432);

  // 1b. Live Docker Hub Registry search via /api/docker/catalog?q=grafana&live=1 and /api/docker/hub/search
  const grafanaPreset = inferDockerHubPortPreset('grafana/grafana');
  assert.equal(grafanaPreset.targetPort, 3000);
  assert.equal(grafanaPreset.publishedPort, 13000);
  assert.equal(grafanaPreset.category, 'monitoring');

  const liveHubResults = await searchDockerCatalogLive({ q: 'grafana', pageSize: 10 });
  assert.ok(liveHubResults.length >= 1, 'Live Docker Hub search for grafana must return results');
  const grafanaItem = liveHubResults.find((item) => item.image.includes('grafana'));
  assert.ok(grafanaItem, 'grafana image must be present in live Docker Hub search results');
  assert.equal(grafanaItem.innerPort, 3000);
  assert.equal(grafanaItem.outerPort, 13000);

  const hubHttpRes = await fetch(`${baseUrl}/api/docker/catalog?q=grafana&live=1`);
  assert.equal(hubHttpRes.status, 200);
  const hubHttpJson = await hubHttpRes.json();
  assert.equal(hubHttpJson.source, 'docker_hub_live');
  assert.ok(Array.isArray(hubHttpJson.data) && hubHttpJson.data.length >= 1);

  // 2. Generate Compose YAML via POST /api/docker/catalog/generate-compose
  const genRes = await fetch(`${baseUrl}/api/docker/catalog/generate-compose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectName: 'ghost_blog',
      image: 'ghost',
      tag: '5-alpine',
      innerPort: 2368,
      outerPort: 12368,
      bindHost: '127.0.0.1',
      restartPolicy: 'unless-stopped',
      volumes: [{ source: 'ghost_content', target: '/var/lib/ghost/content', kind: 'named_volume' }],
      environment: { NODE_ENV: 'production', url: 'https://blog.webrich.news' },
    }),
  });
  assert.equal(genRes.status, 200);
  const genJson = await genRes.json();
  assert.equal(genJson.sideEffects, false);
  assert.equal(genJson.data.projectName, 'ghost_blog');
  assert.equal(genJson.data.image, 'ghost:5-alpine');
  assert.deepEqual(genJson.data.portMapping, {
    innerPort: 2368,
    outerPort: 12368,
    targetPort: 2368,
    publishedPort: 12368,
    bindHost: '127.0.0.1',
    protocol: 'tcp',
  });
  assert.match(genJson.data.document, /"127\.0\.0\.1:12368:2368\/tcp"/);
  assert.match(genJson.data.document, /ghost_content: \{\}/);

  // Persist generated project into real registry so we can resolve proxy rules against it
  const ghostProject = await projectRegistry.createProject({
    serverId: SERVER_ID,
    projectName: 'ghost_blog',
    document: genJson.data.document,
    validation: computeValidationSummary('ghost_blog', genJson.data.document, {
      serviceName: 'ghost',
      targetPort: 2368,
      publishedPort: 12368,
      volumeName: 'ghost_content',
      volumeTarget: '/var/lib/ghost/content',
    }),
  });

  // 3. Resolve Domain/Subdomain Docker Proxy rule (Inner Port 2368 -> Outer Loopback Port 12368)
  const proxyRes = await fetch(`${baseUrl}/api/docker/proxy-rules/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hostname: 'blog.webrich.news',
      projectId: ghostProject.id,
      serviceName: 'ghost',
      innerPort: 2368,
      urlPath: '/',
    }),
  });
  assert.equal(proxyRes.status, 200);
  const proxyJson = await proxyRes.json();
  assert.equal(proxyJson.data.hostname, 'blog.webrich.news');
  assert.equal(proxyJson.data.urlPath, '/');
  assert.equal(proxyJson.data.serviceName, 'ghost');
  assert.equal(proxyJson.data.innerPort, 2368);
  assert.equal(proxyJson.data.outerPort, 12368);
  assert.equal(proxyJson.data.upstreamHost, '127.0.0.1');
  assert.equal(proxyJson.data.upstreamPort, 12368);
  assert.equal(proxyJson.data.websocket, true);

  // Sub-path proxy rule resolution (/api)
  const apiProxy = await resolveDockerProxyRule(
    {
      hostname: 'api.webrich.news',
      projectId: ghostProject.id,
      serviceName: 'ghost',
      innerPort: 2368,
      urlPath: '/api',
    },
    { dockerComposeProjectRegistry: projectRegistry, localServerId: SERVER_ID },
  );
  assert.equal(apiProxy.hostname, 'api.webrich.news');
  assert.equal(apiProxy.urlPath, '/api');
  assert.equal(apiProxy.innerPort, 2368);
  assert.equal(apiProxy.outerPort, 12368);
  assert.equal(apiProxy.upstreamHost, '127.0.0.1');
  assert.equal(apiProxy.upstreamPort, 12368);

  await assert.rejects(
    resolveDockerProxyRule(
      {
        hostname: 'api.webrich.news',
        projectId: ghostProject.id,
        serviceName: 'ghost',
        innerPort: 9999,
        urlPath: '/api',
      },
      { dockerComposeProjectRegistry: projectRegistry, localServerId: SERVER_ID },
    ),
    (error) => error instanceof DockerPleskCatalogError && error.code === 'docker_proxy_port_not_published',
  );
});
