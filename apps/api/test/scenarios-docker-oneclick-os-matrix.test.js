import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import {
  DockerComposeValidationError,
  OsPlatformError,
  createDockerComposeObserver,
  detectLinuxPlatform,
  dockerComposeValidatorInternals,
  isSupportedPassengerPlatform,
  isSupportedPhpRepositoryLine,
  normalizeLinuxPlatform,
  parseOsReleaseText,
  resolveDistroPackageName,
  resolveDistroUnitName,
  resolvePackageManagerCommands,
  resolvePhpFpmBinaryPath,
  resolvePhpFpmPackageName,
  resolvePhpFpmPoolDirectory,
  resolvePhpFpmServiceUnit,
  resolvePhpFpmSocketDirectory,
  summarizeDockerComposeConfig,
} from '@yunpanel/host-runtime';
import { createDockerComposeProjectRegistry } from '../src/docker-compose-project-registry.js';
import { createDockerComposeEnvironmentRegistry } from '../src/docker-compose-environment-registry.js';
import { createDockerRegistryCredentialRegistry } from '../src/docker-registry-credential-registry.js';
import { createDockerComposeOperationsService } from '../src/docker-compose-operations.js';
import { createJobRegistry } from '../src/job-registry.js';
import { mountDockerComposeRoutes } from '../src/docker-compose-http.js';
import {
   EASYPANEL_ONE_CLICK_APPS,
  PLESK_DOCKER_CATALOG,
  inferDockerHubPortPreset,
  provisionOneClickApp,
  searchDockerCatalogLive,
} from '../src/docker-plesk-catalog.js';

const LOCAL_SERVER_ID = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const FOREIGN_SERVER_ID = '11111111-2222-4333-8444-555555555555';

/**
 * Parses a Compose YAML document into the normalized config object expected by
 * the real `summarizeDockerComposeConfig` validator in `@yunpanel/host-runtime`.
 */
function parseComposeYamlToNormalizedConfig(projectName, document, environment = {}, projectDirectory = '/tmp') {
  const validatedName = dockerComposeValidatorInternals.projectName(projectName);
  const validatedDoc = dockerComposeValidatorInternals.composeDocument(document);
  dockerComposeValidatorInternals.normalizeEnvironment(environment);

  const lines = validatedDoc.document.split(/\r?\n/);
  if (lines[0]?.trim() !== 'services:') {
    throw new DockerComposeValidationError(
      'docker_compose_validation_failed',
      'Docker Compose document must start with services:',
    );
  }

  const services = {};
  const topLevelVolumes = {};
  let section = 'services';
  let currentService = null;
  let currentSubSection = null;

  for (let i = 1; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (!rawLine || !rawLine.trim()) continue;

    if (rawLine === 'volumes:') {
      section = 'volumes';
      currentService = null;
      currentSubSection = null;
      continue;
    }

    if (section === 'volumes') {
      const volDefMatch = /^ {2}([a-zA-Z0-9][a-zA-Z0-9_.-]*):\s*\{\}\s*$/.exec(rawLine);
      if (!volDefMatch) {
        throw new DockerComposeValidationError(
          'docker_compose_validation_failed',
          `Invalid top-level volume declaration: ${rawLine}`,
        );
      }
      topLevelVolumes[volDefMatch[1]] = {};
      continue;
    }

    const serviceHeaderMatch = /^ {2}([a-z0-9][a-z0-9_.-]*):\s*$/.exec(rawLine);
    if (serviceHeaderMatch) {
      currentService = serviceHeaderMatch[1];
      services[currentService] = {
        image: '',
        ports: [],
        volumes: [],
        environment: {},
      };
      currentSubSection = null;
      continue;
    }

    if (!currentService) {
      throw new DockerComposeValidationError(
        'docker_compose_validation_failed',
        `Unexpected line before service definition: ${rawLine}`,
      );
    }

    const imageMatch = /^ {4}image:\s*(.+)$/.exec(rawLine);
    if (imageMatch) {
      services[currentService].image = imageMatch[1].trim();
      currentSubSection = null;
      continue;
    }

    const restartMatch = /^ {4}restart:\s*(.+)$/.exec(rawLine);
    if (restartMatch) {
      services[currentService].restart = restartMatch[1].trim();
      currentSubSection = null;
      continue;
    }

    if (/^ {4}ports:\s*$/.test(rawLine)) {
      currentSubSection = 'ports';
      continue;
    }

    if (/^ {4}environment:\s*$/.test(rawLine)) {
      currentSubSection = 'environment';
      continue;
    }

    if (/^ {4}volumes:\s*$/.test(rawLine)) {
      currentSubSection = 'volumes';
      continue;
    }

    if (currentSubSection === 'ports') {
      const portMatch = /^ {6}-\s*"([0-9.]+):(\d+):(\d+)\/(tcp|udp)"\s*$/.exec(rawLine);
      if (!portMatch) {
        throw new DockerComposeValidationError(
          'docker_compose_validation_failed',
          `Invalid port mapping line: ${rawLine}`,
        );
      }
      services[currentService].ports.push({
        host_ip: portMatch[1],
        published: Number(portMatch[2]),
        target: Number(portMatch[3]),
        protocol: portMatch[4],
      });
      continue;
    }

    if (currentSubSection === 'environment') {
      const envMatch = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/.exec(rawLine);
      if (!envMatch) {
        throw new DockerComposeValidationError(
          'docker_compose_validation_failed',
          `Invalid environment line: ${rawLine}`,
        );
      }
      services[currentService].environment[envMatch[1]] = envMatch[2].trim();
      continue;
    }

    if (currentSubSection === 'volumes') {
      const mountMatch = /^ {6}-\s*"([^":]+):([^":]+)(?::(ro))?"\s*$/.exec(rawLine);
      if (!mountMatch) {
        throw new DockerComposeValidationError(
          'docker_compose_validation_failed',
          `Invalid volume mount line: ${rawLine}`,
        );
      }
      const rawSource = mountMatch[1];
      const target = mountMatch[2];
      const readOnly = mountMatch[3] === 'ro';
      const isBind = rawSource.startsWith('./') || rawSource.startsWith('/');
      const resolvedSource = isBind && rawSource.startsWith('./')
        ? path.resolve(projectDirectory, rawSource)
        : rawSource;

      services[currentService].volumes.push({
        type: isBind ? 'bind' : 'volume',
        source: resolvedSource,
        target,
        read_only: readOnly,
      });
    }
  }

  return summarizeDockerComposeConfig(
    {
      name: validatedName,
      services,
      networks: { default: {} },
      volumes: topLevelVolumes,
    },
    {
      expectedProjectName: validatedName,
      documentSha256: validatedDoc.sha256,
      documentBytes: validatedDoc.bytes,
      projectDirectory,
    },
  );
}

async function createRealScenarioDockerServer(t, { defaultAuth = null } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-scn-dck-matrix-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));

  const masterKey = randomBytes(32);
  const projectRegistry = createDockerComposeProjectRegistry({
    filePath: path.join(rootDir, 'docker-projects.json'),
    masterKey,
    serverExists: async (id) => id === LOCAL_SERVER_ID,
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

  const domainMap = new Map([
    ['dom-webrich-api', { id: 'dom-webrich-api', primaryDomain: 'api.webrich.news' }],
    ['dom-webrich-root', { id: 'dom-webrich-root', primaryDomain: 'webrich.news' }],
  ]);
  const domainRegistry = {
    getDomain: async (domainId) => domainMap.get(domainId) ?? null,
  };

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
  const validateDockerCompose = async ({ projectName, document, environment = {} }) => (
    parseComposeYamlToNormalizedConfig(projectName, document, environment, rootDir)
  );

  let activeAuth = defaultAuth !== null
    ? defaultAuth
    : {
        user: { id: 'owner-1', username: 'admin', role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: true },
      };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const roleHeader = req.headers['x-test-auth-mode'];
    if (roleHeader === 'unauthenticated') {
      req.auth = null;
    } else if (roleHeader === 'incomplete') {
      req.auth = { user: { id: 'u-incomplete', role: 'owner' } };
    } else if (roleHeader === 'customer_denied') {
      req.auth = {
        user: { id: 'cust-1', username: 'customer1', role: 'customer' },
        access: { mode: 'none', permissions: [] },
        security: { managementAllowed: false },
      };
    } else if (roleHeader === 'readonly_denied') {
      req.auth = {
        user: { id: 'ro-1', username: 'auditor', role: 'read_only' },
        access: { mode: 'read_only', permissions: ['servers:read'] },
        security: { managementAllowed: false },
      };
    } else if (roleHeader === 'owner_mfa_locked') {
      req.auth = {
        user: { id: 'owner-1', username: 'admin', role: 'owner' },
        access: { mode: 'management', permissions: ['*'] },
        security: { managementAllowed: false },
      };
    } else {
      req.auth = activeAuth;
    }
    next();
  });

  mountDockerComposeRoutes(app, {
    dockerComposeProjectRegistry: projectRegistry,
    dockerComposeEnvironmentRegistry: environmentRegistry,
    dockerRegistryCredentialRegistry: credentialRegistry,
    dockerComposeOperationsService: operationsService,
    dockerComposeObserver: observer,
    validateDockerCompose,
    domainRegistry,
    localServerId: LOCAL_SERVER_ID,
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
    domainRegistry,
    validateDockerCompose,
    baseUrl,
    setAuth: (nextAuth) => {
      activeAuth = nextAuth;
    },
  };
}

// ============================================================================
// SCN-DCK-01: All 14 Easypanel 1-Click Marketplace Templates Full Lifecycle
// ============================================================================

const EXPECTED_14_TEMPLATES = [
  { id: 'pocketbase', innerPort: 8090, outerPort: 18090, secrets: ['PB_ENCRYPTION_KEY'] },
  { id: 'n8n', innerPort: 5678, outerPort: 15678, secrets: ['N8N_ENCRYPTION_KEY'] },
  { id: 'directus', innerPort: 8055, outerPort: 18055, secrets: ['KEY', 'SECRET', 'ADMIN_PASSWORD'] },
  { id: 'strapi', innerPort: 1337, outerPort: 13370, secrets: ['APP_KEYS', 'API_TOKEN_SALT', 'ADMIN_JWT_SECRET', 'JWT_SECRET'] },
  { id: 'umami', innerPort: 3000, outerPort: 13005, secrets: ['APP_SECRET'] },
  { id: 'meilisearch', innerPort: 7700, outerPort: 17700, secrets: ['MEILI_MASTER_KEY'] },
  { id: 'ghost', innerPort: 2368, outerPort: 12368, secrets: [] },
  { id: 'wordpress-stack', innerPort: 80, outerPort: 18081, secrets: ['WORDPRESS_DB_PASSWORD'] },
  { id: 'uptime-kuma', innerPort: 3001, outerPort: 13001, secrets: [] },
  { id: 'minio', innerPort: 9000, outerPort: 19000, secrets: ['MINIO_ROOT_PASSWORD'] },
  { id: 'grafana', innerPort: 3000, outerPort: 13000, secrets: ['GF_SECURITY_ADMIN_PASSWORD'] },
  { id: 'redis', innerPort: 6379, outerPort: 16379, secrets: [] },
  { id: 'postgres', innerPort: 5432, outerPort: 15432, secrets: ['POSTGRES_PASSWORD'] },
  { id: 'ollama-webui', innerPort: 8080, outerPort: 18088, secrets: ['WEBUI_SECRET_KEY'] },
];

test('SCN-DCK-01.0: GET /api/docker/one-click-apps returns all 14 templates and supports category + keyword filtering', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  const response = await fetch(`${baseUrl}/api/docker/one-click-apps`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.total, 14);
  assert.deepEqual(
    payload.data.map((item) => item.id),
    EXPECTED_14_TEMPLATES.map((item) => item.id),
  );

  for (const spec of EXPECTED_14_TEMPLATES) {
    const item = payload.data.find((entry) => entry.id === spec.id);
    assert.ok(item, `Template ${spec.id} must be present`);
    assert.equal(item.innerPort, spec.innerPort);
    assert.equal(item.outerPort, spec.outerPort);
    assert.deepEqual(item.autoSecretKeys, spec.secrets);
    assert.equal(item.hasAutoSecrets, spec.secrets.length > 0);
  }

  const allCategoryRes = await fetch(`${baseUrl}/api/docker/one-click-apps?category=all`);
  assert.equal(allCategoryRes.status, 200);
  const allCategoryData = await allCategoryRes.json();
  assert.equal(allCategoryData.total, 14);

  const storageRes = await fetch(`${baseUrl}/api/docker/one-click-apps?category=storage&q=s3`);
  assert.equal(storageRes.status, 200);
  const storageData = await storageRes.json();
  assert.equal(storageData.total, 1);
  assert.equal(storageData.data[0].id, 'minio');
});

for (const spec of EXPECTED_14_TEMPLATES) {
  test(`SCN-DCK-01.${spec.id}: prepare 1-Click template "${spec.id}", verify secret entropy, create project via HTTP POST, and persist encrypted document`, async (t) => {
    const { baseUrl } = await createRealScenarioDockerServer(t);
    const projectName = `oneclick_${spec.id.replace(/[^a-z0-9]/g, '_')}`;
    const hostname = `${spec.id}.webrich.news`;

    // 1. Prepare first time
    const prepRes1 = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: spec.id,
        projectName,
        hostname,
        urlPath: '/',
      }),
    });
    assert.equal(prepRes1.status, 200);
    const prepBody1 = await prepRes1.json();
    assert.equal(prepBody1.sideEffects, false);
    const prep1 = prepBody1.data;

    // 2. Prepare second time to verify unique cryptographic secrets per call
    const prepRes2 = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: spec.id,
        projectName,
        hostname,
        urlPath: '/',
      }),
    });
    assert.equal(prepRes2.status, 200);
    const prep2 = (await prepRes2.json()).data;

    // 3. Verify YAML structure & port mapping
    assert.equal(prep1.templateId, spec.id);
    assert.equal(prep1.projectName, projectName);
    assert.equal(prep1.portMapping.innerPort, spec.innerPort);
    assert.equal(prep1.portMapping.outerPort, spec.outerPort);
    assert.equal(prep1.portMapping.bindHost, '127.0.0.1');
    assert.match(prep1.document, /^services:\n/);
    assert.match(prep1.document, /\n {4}image: /);
    assert.match(prep1.document, /\n {4}ports:\n/);
    assert.ok(
      prep1.document.includes(`"127.0.0.1:${spec.outerPort}:${spec.innerPort}/tcp"`),
      `Expected loopback port binding 127.0.0.1:${spec.outerPort}:${spec.innerPort}/tcp in ${spec.id} YAML`,
    );

    // 4. Verify secret generation & zero placeholder leakage
    assert.equal(prep1.generatedSecretsCount, spec.secrets.length);
    assert.deepEqual(prep1.generatedSecretKeys, spec.secrets);
    assert.ok(!prep1.document.includes('change_me'), `change_me must never appear in ${spec.id} document`);
    assert.ok(!prep1.document.includes('change_root_me'), `change_root_me must never appear in ${spec.id} document`);
    assert.ok(
      !JSON.stringify(prep1.environment).includes('change_me'),
      `change_me must never appear in ${spec.id} environment`,
    );
    assert.ok(
      !JSON.stringify(prep1.environment).includes('change_root_me'),
      `change_root_me must never appear in ${spec.id} environment`,
    );

    for (const secretKey of spec.secrets) {
      const secretVal1 = prep1.environment[secretKey];
      const secretVal2 = prep2.environment[secretKey];
      assert.match(
        secretVal1,
        /^[0-9a-f]{36}$/,
        `Expected 36-char hex secret for ${spec.id}.${secretKey}, got "${secretVal1}"`,
      );
      assert.match(
        secretVal2,
        /^[0-9a-f]{36}$/,
        `Expected 36-char hex secret on second call for ${spec.id}.${secretKey}`,
      );
      assert.notEqual(
        secretVal1,
        secretVal2,
        `Expected different random secrets across calls for ${spec.id}.${secretKey}`,
      );
      assert.ok(
        prep1.document.includes(`${secretKey}: ${secretVal1}`)
        || prep1.document.includes(`${secretKey}: "${secretVal1}"`),
        `Expected ${secretKey} secret value embedded in ${spec.id} YAML document`,
      );
    }

    if (spec.secrets.length > 0) {
      assert.notEqual(prep1.document, prep2.document);
    }

    // 5. Submit prepared project to POST /api/docker/projects
    const createRes = await fetch(`${baseUrl}/api/docker/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId: LOCAL_SERVER_ID,
        projectName: prep1.projectName,
        document: prep1.document,
      }),
    });
    assert.equal(createRes.status, 201);
    const createdBody = await createRes.json();
    const createdProject = createdBody.data.project;
    assert.ok(createdProject.id);
    assert.equal(createdProject.projectName, projectName);
    assert.equal(createdProject.serverId, LOCAL_SERVER_ID);
    assert.equal(createdProject.revision, 1);
    assert.equal(createdProject.services.length, 1);
    assert.equal(createdProject.services[0].publishedPorts[0].publishedPort, spec.outerPort);
    assert.equal(createdProject.services[0].publishedPorts[0].targetPort, spec.innerPort);

    // 6. Verify GET /api/docker/projects/:id and GET /api/docker/projects/:id/document persistence
    const getRes = await fetch(`${baseUrl}/api/docker/projects/${createdProject.id}`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.data.project.id, createdProject.id);
    assert.equal(getBody.data.project.composeSha256, createdProject.composeSha256);

    const docRes = await fetch(`${baseUrl}/api/docker/projects/${createdProject.id}/document`);
    assert.equal(docRes.status, 200);
    const docBody = await docRes.json();
    assert.equal(docBody.data.document, prep1.document);
  });
}

// ============================================================================
// SCN-DCK-02: Custom Overrides, Custom Ports, Domain/Subpath Proxy Resolution
// ============================================================================

test('SCN-DCK-02.1: custom environmentOverrides preserves non-placeholder values while auto-generating remaining secrets and replacing change_me/change_root_me', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  // Directus has 3 secrets: KEY, SECRET, ADMIN_PASSWORD, plus non-secret ADMIN_EMAIL.
  // Supply custom ADMIN_PASSWORD, custom ADMIN_EMAIL, pass 'change_me' for KEY (should still auto-generate),
  // and add extra custom variable PUBLIC_URL.
  const prepRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      templateId: 'directus',
      projectName: 'webrich_cms_v1',
      hostname: 'api.webrich.news',
      urlPath: '/v1',
      innerPort: 8055,
      outerPort: 28055,
      environmentOverrides: {
        KEY: 'change_me',
        ADMIN_EMAIL: 'ops@webrich.news',
        ADMIN_PASSWORD: 'MyCustomStrongPassword!2026',
        PUBLIC_URL: 'https://api.webrich.news/v1',
      },
    }),
  });
  assert.equal(prepRes.status, 200);
  const prepared = (await prepRes.json()).data;

  // KEY and SECRET should be auto-generated (2 secrets), while ADMIN_PASSWORD was overridden
  assert.equal(prepared.generatedSecretsCount, 2);
  assert.deepEqual(prepared.generatedSecretKeys, ['KEY', 'SECRET']);
  assert.match(prepared.environment.KEY, /^[0-9a-f]{36}$/);
  assert.match(prepared.environment.SECRET, /^[0-9a-f]{36}$/);
  assert.equal(prepared.environment.ADMIN_PASSWORD, 'MyCustomStrongPassword!2026');
  assert.equal(prepared.environment.ADMIN_EMAIL, 'ops@webrich.news');
  assert.equal(prepared.environment.PUBLIC_URL, 'https://api.webrich.news/v1');
  assert.ok(!prepared.document.includes('change_me'));

  // Verify normalized URL path (trailing slash stripped on '/v1/') and custom port mapping
  assert.equal(prepared.portMapping.innerPort, 8055);
  assert.equal(prepared.portMapping.outerPort, 28055);
  assert.equal(prepared.proxyPreview.hostname, 'api.webrich.news');
  assert.equal(prepared.proxyPreview.urlPath, '/v1');
  assert.equal(prepared.proxyPreview.upstreamHost, '127.0.0.1');
  assert.equal(prepared.proxyPreview.upstreamPort, 28055);
  assert.equal(prepared.proxyPreview.publicUrl, 'https://api.webrich.news/v1');

  // Also verify MariaDB catalog item with change_root_me via prepare endpoint
  const mariaPrepRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      templateId: 'mariadb',
      projectName: 'mariadb_custom',
      environmentOverrides: {
        MARIADB_ROOT_PASSWORD: 'change_root_me',
      },
    }),
  });
  assert.equal(mariaPrepRes.status, 200);
  const mariaPrepared = (await mariaPrepRes.json()).data;
  assert.equal(mariaPrepared.generatedSecretsCount, 2);
  assert.ok(!mariaPrepared.document.includes('change_root_me'));
  assert.ok(!mariaPrepared.document.includes('change_me'));
  assert.match(mariaPrepared.environment.MARIADB_PASSWORD, /^[0-9a-f]{36}$/);
  assert.match(mariaPrepared.environment.MARIADB_ROOT_PASSWORD, /^[0-9a-f]{36}$/);
});

test('SCN-DCK-02.2: end-to-end HTTP project creation, environment update, and POST /api/docker/proxy-rules/resolve for hostname + domainId', async (t) => {
  const { baseUrl, projectRegistry, validateDockerCompose, domainRegistry } = await createRealScenarioDockerServer(t);

  // 1. Prepare Strapi with custom ports and hostname: api.webrich.news, urlPath: /v1
  const prepRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      templateId: 'strapi',
      projectName: 'strapi_webrich_api',
      hostname: 'api.webrich.news',
      urlPath: '/v1',
      innerPort: 1337,
      outerPort: 21337,
    }),
  });
  assert.equal(prepRes.status, 200);
  const prepared = (await prepRes.json()).data;
  assert.equal(prepared.generatedSecretsCount, 4);

  // 2. Create project via HTTP POST /api/docker/projects
  const createRes = await fetch(`${baseUrl}/api/docker/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId: LOCAL_SERVER_ID,
      projectName: prepared.projectName,
      document: prepared.document,
    }),
  });
  assert.equal(createRes.status, 201);
  const createdProject = (await createRes.json()).data.project;

  // 3. Resolve Nginx proxy rule via POST /api/docker/proxy-rules/resolve using explicit hostname
  const resolveRes = await fetch(`${baseUrl}/api/docker/proxy-rules/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: createdProject.id,
      hostname: 'api.webrich.news',
      urlPath: '/v1',
      serviceName: 'strapi',
      innerPort: 1337,
    }),
  });
  assert.equal(resolveRes.status, 200);
  const resolved = (await resolveRes.json()).data;
  assert.equal(resolved.projectId, createdProject.id);
  assert.equal(resolved.projectName, 'strapi_webrich_api');
  assert.equal(resolved.hostname, 'api.webrich.news');
  assert.equal(resolved.urlPath, '/v1');
  assert.equal(resolved.serviceName, 'strapi');
  assert.equal(resolved.innerPort, 1337);
  assert.equal(resolved.outerPort, 21337);
  assert.equal(resolved.upstreamHost, '127.0.0.1');
  assert.equal(resolved.upstreamPort, 21337);
  assert.equal(resolved.websocket, true);
  assert.equal(resolved.protocol, 'tcp');

  // 4. Resolve Nginx proxy rule using domainId from domainRegistry and automatic single-service/port inference
  const resolveByDomainIdRes = await fetch(`${baseUrl}/api/docker/proxy-rules/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: createdProject.id,
      domainId: 'dom-webrich-api',
      urlPath: '/v1',
    }),
  });
  assert.equal(resolveByDomainIdRes.status, 200);
  const resolvedByDomain = (await resolveByDomainIdRes.json()).data;
  assert.equal(resolvedByDomain.domainId, 'dom-webrich-api');
  assert.equal(resolvedByDomain.hostname, 'api.webrich.news');
  assert.equal(resolvedByDomain.outerPort, 21337);

  // 5. Update project environment variables (initial revision is 0) and re-validate via HTTP
  const putEnvRes = await fetch(`${baseUrl}/api/docker/projects/${createdProject.id}/environment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedRevision: 0,
      variables: {
        NODE_ENV: 'production',
        STRAPI_TELEMETRY_DISABLED: 'true',
      },
    }),
  });
  assert.equal(putEnvRes.status, 200);
  const envPayload = (await putEnvRes.json()).data;
  assert.equal(envPayload.revision, 1);
  assert.equal(envPayload.variableCount, 2);
  assert.equal(envPayload.configured, true);
  assert.deepEqual(envPayload.keys, ['NODE_ENV', 'STRAPI_TELEMETRY_DISABLED']);

  // 6. Test provisionOneClickApp helper with real projectRegistry and domainRegistry
  const directProvision = await provisionOneClickApp(
    {
      templateId: 'n8n',
      projectName: 'n8n_webrich_flow',
      hostname: 'flow.webrich.news',
      urlPath: '/hooks',
      innerPort: 5678,
      outerPort: 25678,
    },
    {
      dockerComposeProjectRegistry: projectRegistry,
      validateDockerCompose,
      domainRegistry,
      localServerId: LOCAL_SERVER_ID,
    },
  );
  assert.ok(directProvision.project.id);
  assert.equal(directProvision.proxyRule.hostname, 'flow.webrich.news');
  assert.equal(directProvision.proxyRule.urlPath, '/hooks');
  assert.equal(directProvision.proxyRule.upstreamPort, 25678);
});

test('SCN-DCK-02.3: Docker Hub catalog search & compose generator HTTP routes work with real fetch and fallback', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  const catalogRes = await fetch(`${baseUrl}/api/docker/catalog?category=database`);
  assert.equal(catalogRes.status, 200);
  const catalogData = await catalogRes.json();
  assert.equal(catalogData.source, 'catalog');
  assert.deepEqual(catalogData.data.map((item) => item.id), ['postgres', 'mariadb']);

  const genRes = await fetch(`${baseUrl}/api/docker/catalog/generate-compose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectName: 'redis_cache_01',
      image: 'redis',
      tag: '7.4-alpine',
      innerPort: 6379,
      outerPort: 26379,
      bindHost: '127.0.0.1',
      restartPolicy: 'always',
      volumes: ['redis_cache_vol:/data'],
      environment: { REDIS_AOF: 'yes' },
    }),
  });
  assert.equal(genRes.status, 200);
  const genData = (await genRes.json()).data;
  assert.equal(genData.image, 'redis:7.4-alpine');
  assert.equal(genData.portMapping.outerPort, 26379);
  assert.ok(genData.document.includes('restart: always'));
  assert.ok(genData.document.includes('"127.0.0.1:26379:6379/tcp"'));

  // Test searchDockerCatalogLive with a deterministic custom fetchImpl returning real Docker Hub response shape
  const liveResults = await searchDockerCatalogLive({
    q: 'meilisearch',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            repo_name: 'getmeili/meilisearch',
            short_description: 'Lightning fast search engine',
            star_count: 450,
            pull_count: 1000000,
            is_official: false,
            is_automated: true,
          },
        ],
      }),
    }),
  });
  assert.ok(liveResults.length >= 1);
  assert.equal(liveResults[0].id, 'hub:getmeili/meilisearch');
  assert.equal(liveResults[0].innerPort, 7700);
  assert.equal(liveResults[0].outerPort, 17700);

  // Verify inferDockerHubPortPreset for known and unknown repositories
  assert.equal(inferDockerHubPortPreset('library/postgres').targetPort, 5432);
  assert.equal(inferDockerHubPortPreset('ollama/ollama').targetPort, 11434);
  const customPreset = inferDockerHubPortPreset('myorg/custom-microservice');
  assert.equal(customPreset.targetPort, 8080);
  assert.ok(customPreset.publishedPort >= 18100 && customPreset.publishedPort < 19000);
});

// ============================================================================
// SCN-DCK-03: Negative & Edge-Case HTTP Validation Scenarios
// ============================================================================

test('SCN-DCK-03.1: unknown or missing templateId on /api/docker/one-click-apps/prepare returns HTTP 404 / 400', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  const unknownRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ templateId: 'nonexistent-magic-template' }),
  });
  assert.equal(unknownRes.status, 404);
  const unknownErr = await unknownRes.json();
  assert.equal(unknownErr.error.code, 'one_click_template_not_found');

  for (const badTemplateId of ['', '   ', null, 12345]) {
    const emptyRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: badTemplateId }),
    });
    assert.equal(emptyRes.status, 400);
    const emptyErr = await emptyRes.json();
    assert.equal(emptyErr.error.code, 'invalid_template_id');
  }
});

test('SCN-DCK-03.2: invalid innerPort and outerPort values (0, -1, 65536, "abc") return HTTP 400', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  for (const badPort of [0, -1, -8080, 65536, 70000, 'abc', '8080;rm', 3.14, true]) {
    const innerRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'pocketbase',
        innerPort: badPort,
      }),
    });
    assert.equal(innerRes.status, 400, `Expected HTTP 400 for innerPort=${String(badPort)}`);
    const innerErr = await innerRes.json();
    assert.equal(innerErr.error.code, 'invalid_inner_port');

    const outerRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'pocketbase',
        outerPort: badPort,
      }),
    });
    assert.equal(outerRes.status, 400, `Expected HTTP 400 for outerPort=${String(badPort)}`);
    const outerErr = await outerRes.json();
    assert.equal(outerErr.error.code, 'invalid_outer_port');
  }
});

test('SCN-DCK-03.3: invalid projectName ("../evil", "UPPERCASE", "-bad") returns HTTP 400 across prepare, generate-compose, and create', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  for (const badProjectName of ['../evil', 'UPPERCASE', '-bad', '_underscore_start', 'bad space', 'a'.repeat(64)]) {
    const prepRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'redis',
        projectName: badProjectName,
      }),
    });
    assert.equal(prepRes.status, 400, `Expected 400 on prepare for projectName="${badProjectName}"`);
    assert.equal((await prepRes.json()).error.code, 'invalid_project_name');

    const genRes = await fetch(`${baseUrl}/api/docker/catalog/generate-compose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectName: badProjectName,
        image: 'redis:7-alpine',
        innerPort: 6379,
        outerPort: 16379,
      }),
    });
    assert.equal(genRes.status, 400, `Expected 400 on generate-compose for projectName="${badProjectName}"`);
    assert.equal((await genRes.json()).error.code, 'invalid_project_name');

    const createRes = await fetch(`${baseUrl}/api/docker/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId: LOCAL_SERVER_ID,
        projectName: badProjectName,
        document: 'services:\n  redis:\n    image: redis:7-alpine\n',
      }),
    });
    assert.equal(createRes.status, 400, `Expected 400 on create project for projectName="${badProjectName}"`);
    assert.equal((await createRes.json()).error.code, 'docker_compose_project_name_invalid');
  }
});

test('SCN-DCK-03.4: invalid hostname and urlPath values on prepare and proxy-rules/resolve return HTTP 400', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  for (const badHostname of ['bad host!', 'http://example.com', 'https://example.com/path', 'localhost', '-bad.example.com', 'bad..example.com']) {
    const prepRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'pocketbase',
        hostname: badHostname,
      }),
    });
    assert.equal(prepRes.status, 400, `Expected 400 for hostname="${badHostname}"`);
    assert.equal((await prepRes.json()).error.code, 'invalid_proxy_hostname');

    const resolveRes = await fetch(`${baseUrl}/api/docker/proxy-rules/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostname: badHostname,
        serviceName: 'pocketbase',
        innerPort: 8090,
        outerPort: 18090,
      }),
    });
    assert.equal(resolveRes.status, 400);
    assert.equal((await resolveRes.json()).error.code, 'invalid_proxy_hostname');
  }

  for (const badUrlPath of ['//double', '/api; rm -rf /', '/../secret', 'relative/path', '/api?query=1', '/api#frag']) {
    const prepRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'pocketbase',
        hostname: 'pb.example.com',
        urlPath: badUrlPath,
      }),
    });
    assert.equal(prepRes.status, 400, `Expected 400 for urlPath="${badUrlPath}"`);
    assert.equal((await prepRes.json()).error.code, 'invalid_proxy_url_path');
  }
});

test('SCN-DCK-03.5: invalid environmentOverrides, bindHost, restartPolicy, and volume traversal return HTTP 400', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  // Array instead of object for environmentOverrides
  const arrEnvRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      templateId: 'pocketbase',
      environmentOverrides: ['BAD_ARRAY'],
    }),
  });
  assert.equal(arrEnvRes.status, 400);
  assert.equal((await arrEnvRes.json()).error.code, 'invalid_environment');

  // Invalid environment key starting with digit or containing hyphen
  for (const badEnvKey of ['123_BAD', 'BAD-KEY', 'BAD KEY!']) {
    const badKeyRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: 'pocketbase',
        environmentOverrides: { [badEnvKey]: 'val' },
      }),
    });
    assert.equal(badKeyRes.status, 400, `Expected 400 for env key "${badEnvKey}"`);
    assert.equal((await badKeyRes.json()).error.code, 'invalid_environment_key');
  }

  // Invalid bindHost (non-loopback/wildcard LAN IP)
  const badBindRes = await fetch(`${baseUrl}/api/docker/catalog/generate-compose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectName: 'redis_bad_bind',
      image: 'redis',
      innerPort: 6379,
      outerPort: 16379,
      bindHost: '192.168.1.1',
    }),
  });
  assert.equal(badBindRes.status, 400);
  assert.equal((await badBindRes.json()).error.code, 'invalid_bind_host');

  // Invalid restartPolicy
  const badRestartRes = await fetch(`${baseUrl}/api/docker/catalog/generate-compose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectName: 'redis_bad_restart',
      image: 'redis',
      innerPort: 6379,
      outerPort: 16379,
      restartPolicy: 'never-ever',
    }),
  });
  assert.equal(badRestartRes.status, 400);
  assert.equal((await badRestartRes.json()).error.code, 'invalid_restart_policy');

  // Path traversal in volume source or relative volume target
  const badVolSourceRes = await fetch(`${baseUrl}/api/docker/catalog/generate-compose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectName: 'redis_bad_vol',
      image: 'redis',
      innerPort: 6379,
      outerPort: 16379,
      volumes: ['../../etc/passwd:/data'],
    }),
  });
  assert.equal(badVolSourceRes.status, 400);
  assert.equal((await badVolSourceRes.json()).error.code, 'invalid_volume_source');

  const badVolTargetRes = await fetch(`${baseUrl}/api/docker/catalog/generate-compose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectName: 'redis_bad_target',
      image: 'redis',
      innerPort: 6379,
      outerPort: 16379,
      volumes: ['redis_data:relative/target'],
    }),
  });
  assert.equal(badVolTargetRes.status, 400);
  assert.equal((await badVolTargetRes.json()).error.code, 'invalid_volume_target');
});

test('SCN-DCK-03.6: foreign serverId, exactBody violations, duplicate project names, and proxy port/service mismatches return 400/404/409', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  const prep = await (await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ templateId: 'pocketbase', projectName: 'pb_edge_test' }),
  })).json();

  // Foreign serverId -> HTTP 404 (local_server_required)
  for (const wrongServerId of ['srv_foreign', FOREIGN_SERVER_ID]) {
    const foreignRes = await fetch(`${baseUrl}/api/docker/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serverId: wrongServerId,
        projectName: prep.data.projectName,
        document: prep.data.document,
      }),
    });
    assert.equal(foreignRes.status, 404);
    assert.equal((await foreignRes.json()).error.code, 'local_server_required');
  }

  // Unexpected extra field on POST /api/docker/projects -> HTTP 400 (docker_compose_input_invalid)
  const extraFieldRes = await fetch(`${baseUrl}/api/docker/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId: LOCAL_SERVER_ID,
      projectName: prep.data.projectName,
      document: prep.data.document,
      unexpectedField: true,
    }),
  });
  assert.equal(extraFieldRes.status, 400);
  assert.equal((await extraFieldRes.json()).error.code, 'docker_compose_input_invalid');

  // Create project once (201), then attempt duplicate projectName (409)
  const firstCreateRes = await fetch(`${baseUrl}/api/docker/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId: LOCAL_SERVER_ID,
      projectName: prep.data.projectName,
      document: prep.data.document,
    }),
  });
  assert.equal(firstCreateRes.status, 201);
  const createdProject = (await firstCreateRes.json()).data.project;

  const duplicateCreateRes = await fetch(`${baseUrl}/api/docker/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serverId: LOCAL_SERVER_ID,
      projectName: prep.data.projectName,
      document: prep.data.document,
    }),
  });
  assert.equal(duplicateCreateRes.status, 409);
  assert.equal((await duplicateCreateRes.json()).error.code, 'docker_compose_project_name_conflict');

  // Resolve proxy rule with non-existent serviceName -> HTTP 404 (docker_proxy_service_not_found)
  const badSvcRes = await fetch(`${baseUrl}/api/docker/proxy-rules/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: createdProject.id,
      hostname: 'pb.webrich.news',
      serviceName: 'nonexistent_service',
      innerPort: 8090,
    }),
  });
  assert.equal(badSvcRes.status, 404);
  assert.equal((await badSvcRes.json()).error.code, 'docker_proxy_service_not_found');

  // Resolve proxy rule with unpublished innerPort -> HTTP 409 (docker_proxy_port_not_published)
  const badPortRes = await fetch(`${baseUrl}/api/docker/proxy-rules/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: createdProject.id,
      hostname: 'pb.webrich.news',
      serviceName: 'pocketbase',
      innerPort: 9999,
    }),
  });
  assert.equal(badPortRes.status, 409);
  assert.equal((await badPortRes.json()).error.code, 'docker_proxy_port_not_published');
});

// ============================================================================
// SCN-DCK-04: RBAC & Authentication Guard Enforcement on Docker Endpoints
// ============================================================================

test('SCN-DCK-04.1: unauthenticated requests (missing or incomplete session) to Docker endpoints are rejected with HTTP 401', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  const protectedEndpoints = [
    { method: 'GET', path: '/api/docker/one-click-apps' },
    { method: 'POST', path: '/api/docker/one-click-apps/prepare', body: { templateId: 'pocketbase' } },
    { method: 'GET', path: '/api/docker/projects' },
    { method: 'POST', path: '/api/docker/projects', body: { serverId: LOCAL_SERVER_ID, projectName: 'p1', document: 'services:\n' } },
    { method: 'POST', path: '/api/docker/catalog/generate-compose', body: { projectName: 'p1', image: 'redis' } },
    { method: 'POST', path: '/api/docker/proxy-rules/resolve', body: { hostname: 'a.com', serviceName: 's', innerPort: 80, outerPort: 18080 } },
  ];

  for (const mode of ['unauthenticated', 'incomplete']) {
    for (const ep of protectedEndpoints) {
      const response = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: {
          'content-type': 'application/json',
          'x-test-auth-mode': mode,
        },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      assert.equal(
        response.status,
        401,
        `Expected HTTP 401 for ${mode} on ${ep.method} ${ep.path}, got ${response.status}`,
      );
      const errBody = await response.json();
      assert.equal(errBody.error.code, 'unauthorized');
    }
  }
});

test('SCN-DCK-04.2: unauthorized roles (unprivileged customer, read_only on POST, MFA-locked owner) are rejected with HTTP 403', async (t) => {
  const { baseUrl } = await createRealScenarioDockerServer(t);

  for (const deniedMode of ['customer_denied', 'readonly_denied', 'owner_mfa_locked']) {
    const prepRes = await fetch(`${baseUrl}/api/docker/one-click-apps/prepare`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth-mode': deniedMode,
      },
      body: JSON.stringify({ templateId: 'pocketbase' }),
    });
    assert.equal(prepRes.status, 403, `Expected HTTP 403 for ${deniedMode} on prepare`);
    assert.equal((await prepRes.json()).error.code, 'forbidden');

    const createRes = await fetch(`${baseUrl}/api/docker/projects`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-auth-mode': deniedMode,
      },
      body: JSON.stringify({
        serverId: LOCAL_SERVER_ID,
        projectName: 'denied_proj',
        document: 'services:\n  redis:\n    image: redis:7-alpine\n',
      }),
    });
    assert.equal(createRes.status, 403, `Expected HTTP 403 for ${deniedMode} on POST /api/docker/projects`);
    assert.equal((await createRes.json()).error.code, 'forbidden');
  }
});

// ============================================================================
// SCN-DCK-05: Multi-Distro Linux OS Platform Adapter Matrix
// ============================================================================

const DISTRO_MATRIX = [
  {
    label: 'Ubuntu 20.04 LTS (Focal)',
    osRelease: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="20.04"\nVERSION_CODENAME=focal\n',
    expected: {
      id: 'ubuntu',
      versionId: '20.04',
      majorVersion: '20',
      codename: 'focal',
      family: 'debian',
      supported: true,
      passengerSupported: true,
      packageManager: 'apt',
      webUser: 'www-data',
      defaultPhpVersion: '7.4',
      nginxSitesAvailableDir: '/etc/nginx/sites-available',
      nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
    },
  },
  {
    label: 'Ubuntu 22.04 LTS (Jammy)',
    osRelease: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=jammy\n',
    expected: {
      id: 'ubuntu',
      versionId: '22.04',
      majorVersion: '22',
      codename: 'jammy',
      family: 'debian',
      supported: true,
      passengerSupported: true,
      packageManager: 'apt',
      webUser: 'www-data',
      defaultPhpVersion: '8.1',
      nginxSitesAvailableDir: '/etc/nginx/sites-available',
      nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
    },
  },
  {
    label: 'Ubuntu 24.04 LTS (Noble)',
    osRelease: 'NAME="Ubuntu"\nID="ubuntu"\nVERSION_ID="24.04"\nUBUNTU_CODENAME="noble"\n',
    expected: {
      id: 'ubuntu',
      versionId: '24.04',
      majorVersion: '24',
      codename: 'noble',
      family: 'debian',
      supported: true,
      passengerSupported: true,
      packageManager: 'apt',
      webUser: 'www-data',
      defaultPhpVersion: '8.3',
      nginxSitesAvailableDir: '/etc/nginx/sites-available',
      nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
    },
  },
  {
    label: 'Debian 11 (Bullseye)',
    osRelease: 'PRETTY_NAME="Debian GNU/Linux 11 (bullseye)"\nID=debian\nVERSION_ID="11"\nVERSION_CODENAME=bullseye\n',
    expected: {
      id: 'debian',
      versionId: '11',
      majorVersion: '11',
      codename: 'bullseye',
      family: 'debian',
      supported: true,
      passengerSupported: true,
      packageManager: 'apt',
      webUser: 'www-data',
      defaultPhpVersion: '7.4',
      nginxSitesAvailableDir: '/etc/nginx/sites-available',
      nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
    },
  },
  {
    label: 'Debian 12 (Bookworm)',
    osRelease: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12.7"\nVERSION_CODENAME=bookworm\n',
    expected: {
      id: 'debian',
      versionId: '12.7',
      majorVersion: '12',
      codename: 'bookworm',
      family: 'debian',
      supported: true,
      passengerSupported: true,
      packageManager: 'apt',
      webUser: 'www-data',
      defaultPhpVersion: '8.2',
      nginxSitesAvailableDir: '/etc/nginx/sites-available',
      nginxSitesEnabledDir: '/etc/nginx/sites-enabled',
    },
  },
  {
    label: 'AlmaLinux 8',
    osRelease: 'NAME="AlmaLinux"\nID="almalinux"\nVERSION_ID="8.10"\n',
    expected: {
      id: 'almalinux',
      versionId: '8.10',
      majorVersion: '8',
      codename: null,
      family: 'rhel',
      supported: true,
      passengerSupported: false,
      packageManager: 'dnf',
      webUser: 'nginx',
      defaultPhpVersion: '7.4',
      nginxSitesAvailableDir: '/etc/nginx/conf.d',
      nginxSitesEnabledDir: '/etc/nginx/conf.d',
    },
  },
  {
    label: 'AlmaLinux 9',
    osRelease: 'NAME="AlmaLinux"\nID="almalinux"\nVERSION_ID="9.4"\n',
    expected: {
      id: 'almalinux',
      versionId: '9.4',
      majorVersion: '9',
      codename: null,
      family: 'rhel',
      supported: true,
      passengerSupported: false,
      packageManager: 'dnf',
      webUser: 'nginx',
      defaultPhpVersion: '8.1',
      nginxSitesAvailableDir: '/etc/nginx/conf.d',
      nginxSitesEnabledDir: '/etc/nginx/conf.d',
    },
  },
  {
    label: 'Rocky Linux 8',
    osRelease: 'NAME="Rocky Linux"\nID="rocky"\nVERSION_ID="8.10"\n',
    expected: {
      id: 'rocky',
      versionId: '8.10',
      majorVersion: '8',
      codename: null,
      family: 'rhel',
      supported: true,
      passengerSupported: false,
      packageManager: 'dnf',
      webUser: 'nginx',
      defaultPhpVersion: '7.4',
      nginxSitesAvailableDir: '/etc/nginx/conf.d',
      nginxSitesEnabledDir: '/etc/nginx/conf.d',
    },
  },
  {
    label: 'Rocky Linux 9',
    osRelease: 'NAME="Rocky Linux"\nID="rocky"\nVERSION_ID="9.4"\n',
    expected: {
      id: 'rocky',
      versionId: '9.4',
      majorVersion: '9',
      codename: null,
      family: 'rhel',
      supported: true,
      passengerSupported: false,
      packageManager: 'dnf',
      webUser: 'nginx',
      defaultPhpVersion: '8.1',
      nginxSitesAvailableDir: '/etc/nginx/conf.d',
      nginxSitesEnabledDir: '/etc/nginx/conf.d',
    },
  },
  {
    label: 'RHEL 8',
    osRelease: 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nVERSION_ID="8.9"\n',
    expected: {
      id: 'rhel',
      versionId: '8.9',
      majorVersion: '8',
      codename: null,
      family: 'rhel',
      supported: true,
      passengerSupported: false,
      packageManager: 'dnf',
      webUser: 'nginx',
      defaultPhpVersion: '7.4',
      nginxSitesAvailableDir: '/etc/nginx/conf.d',
      nginxSitesEnabledDir: '/etc/nginx/conf.d',
    },
  },
  {
    label: 'RHEL 9',
    osRelease: 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nVERSION_ID="9.3"\n',
    expected: {
      id: 'rhel',
      versionId: '9.3',
      majorVersion: '9',
      codename: null,
      family: 'rhel',
      supported: true,
      passengerSupported: false,
      packageManager: 'dnf',
      webUser: 'nginx',
      defaultPhpVersion: '8.1',
      nginxSitesAvailableDir: '/etc/nginx/conf.d',
      nginxSitesEnabledDir: '/etc/nginx/conf.d',
    },
  },
];

for (const distro of DISTRO_MATRIX) {
  test(`SCN-DCK-05.${distro.expected.id}_${distro.expected.versionId}: detectLinuxPlatform & normalizeLinuxPlatform for ${distro.label}`, async (t) => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-os-release-'));
    t.after(() => rm(tmpDir, { recursive: true, force: true }));
    const releaseFile = path.join(tmpDir, 'os-release');
    await writeFile(releaseFile, distro.osRelease, 'utf8');

    const detected = await detectLinuxPlatform({ osReleasePath: releaseFile });
    assert.deepEqual(detected, distro.expected);
    assert.equal(isSupportedPassengerPlatform(distro.osRelease), distro.expected.passengerSupported);
  });
}

test('SCN-DCK-05.php_fpm_matrix: dynamic PHP-FPM service, pool, socket, binary, and package resolution for 8.1, 8.2, 8.3, 8.4 across Debian and RHEL', () => {
  for (const version of ['8.1', '8.2', '8.3', '8.4']) {
    const compact = version.replaceAll('.', '');

    // Debian / Ubuntu family
    assert.equal(resolvePhpFpmServiceUnit(version, { family: 'debian' }), `php${version}-fpm.service`);
    assert.equal(resolvePhpFpmPoolDirectory(version, { family: 'debian' }), `/etc/php/${version}/fpm/pool.d`);
    assert.equal(resolvePhpFpmSocketDirectory({ family: 'debian' }), '/run/php');
    assert.equal(resolvePhpFpmBinaryPath(version, { family: 'debian' }), `/usr/sbin/php-fpm${version}`);
    assert.equal(resolvePhpFpmPackageName(version, { family: 'debian' }), `php${version}-fpm`);

    // RHEL / AlmaLinux / Rocky default single-stream
    assert.equal(resolvePhpFpmServiceUnit(version, { family: 'rhel' }), 'php-fpm.service');
    assert.equal(resolvePhpFpmPoolDirectory(version, { family: 'rhel' }), '/etc/php-fpm.d');
    assert.equal(resolvePhpFpmSocketDirectory({ family: 'rhel' }), '/run/php-fpm');
    assert.equal(resolvePhpFpmBinaryPath(version, { family: 'rhel' }), '/usr/sbin/php-fpm');
    assert.equal(resolvePhpFpmPackageName(version, { family: 'rhel' }), 'php-fpm');

    // RHEL / AlmaLinux / Rocky with Remi multi-version stream
    assert.equal(resolvePhpFpmServiceUnit(version, { family: 'rhel', remi: true }), `php${compact}-php-fpm.service`);
    assert.equal(resolvePhpFpmPoolDirectory(version, { family: 'rhel', remi: true }), `/etc/opt/remi/php${compact}/php-fpm.d`);
    assert.equal(resolvePhpFpmBinaryPath(version, { family: 'rhel', remi: true }), `/opt/remi/php${compact}/root/usr/sbin/php-fpm`);
    assert.equal(resolvePhpFpmPackageName(version, { family: 'rhel', remi: true }), `php${compact}-php-fpm`);
  }
});

test('SCN-DCK-05.package_manager_and_overrides: apt-get vs dnf command builders, package overrides, unit overrides, and PHP repo validation', () => {
  const debianPkg = resolvePackageManagerCommands({ family: 'debian' });
  assert.equal(debianPkg.installBinary, '/usr/bin/apt-get');
  assert.equal(debianPkg.queryBinary, '/usr/bin/dpkg-query');
  assert.deepEqual(debianPkg.buildUpdateArgs(), ['update']);
  assert.deepEqual(
    debianPkg.buildInstallArgs(['nginx', 'redis-server']),
    ['install', '--yes', '--no-install-recommends', 'nginx', 'redis-server'],
  );
  assert.deepEqual(debianPkg.buildGroupAddArgs('site_u1', 'www-data'), ['site_u1', 'www-data']);

  const rhelPkg = resolvePackageManagerCommands({ family: 'rhel' });
  assert.equal(rhelPkg.installBinary, '/usr/bin/dnf');
  assert.equal(rhelPkg.queryBinary, '/usr/bin/rpm');
  assert.deepEqual(rhelPkg.buildUpdateArgs(), ['makecache', '--timer']);
  assert.deepEqual(
    rhelPkg.buildInstallArgs(['nginx', 'redis']),
    ['install', '-y', 'nginx', 'redis'],
  );
  assert.deepEqual(rhelPkg.buildGroupAddArgs('site_u1', 'nginx'), ['-aG', 'nginx', 'site_u1']);

  // Package & systemd unit overrides between Debian and RHEL
  assert.equal(resolveDistroPackageName('docker.io', { family: 'debian' }), 'docker.io');
  assert.equal(resolveDistroPackageName('docker.io', { family: 'rhel' }), 'docker-ce');
  assert.equal(resolveDistroPackageName('docker-compose-v2', { family: 'rhel' }), 'docker-compose-plugin');
  assert.equal(resolveDistroPackageName('redis-server', { family: 'rhel' }), 'redis');
  assert.equal(resolveDistroPackageName('apache2-utils', { family: 'rhel' }), 'httpd-tools');
  assert.equal(resolveDistroPackageName('cron', { family: 'rhel' }), 'cronie');
  assert.equal(resolveDistroUnitName('cron.service', { family: 'debian' }), 'cron.service');
  assert.equal(resolveDistroUnitName('cron.service', { family: 'rhel' }), 'crond.service');
  assert.equal(resolveDistroUnitName('redis-server.service', { family: 'rhel' }), 'redis.service');

  // PHP repository line allowlist
  assert.equal(isSupportedPhpRepositoryLine('deb https://ppa.launchpadcontent.net/ondrej/php/ubuntu noble main'), true);
  assert.equal(isSupportedPhpRepositoryLine('deb [signed-by=/usr/share/keyrings/sury.gpg] https://packages.sury.org/php/ bookworm main'), true);
  assert.equal(isSupportedPhpRepositoryLine('mirrorlist=http://rpms.remirepo.net/enterprise/9/remi/x86_64/mirror'), true);
  assert.equal(isSupportedPhpRepositoryLine('deb https://evil.example.com/php noble main'), false);
  assert.equal(isSupportedPhpRepositoryLine('deb https://packages.sury.org/php/\nmalicious'), false);
});

test('SCN-DCK-05.unknown_distro_and_errors: graceful fallback on unknown/non-LTS distros and error handling on unreadable os-release', async () => {
  const unknownArch = normalizeLinuxPlatform('ID=arch\nVERSION_ID="rolling"\n');
  assert.equal(unknownArch.id, 'arch');
  assert.equal(unknownArch.family, 'unknown');
  assert.equal(unknownArch.supported, false);
  assert.equal(unknownArch.passengerSupported, false);
  assert.equal(unknownArch.packageManager, null);
  assert.equal(unknownArch.defaultPhpVersion, '8.3');

  const nonLtsUbuntu = normalizeLinuxPlatform('ID=ubuntu\nVERSION_ID="23.10"\nVERSION_CODENAME=mantic\n');
  assert.equal(nonLtsUbuntu.id, 'ubuntu');
  assert.equal(nonLtsUbuntu.family, 'debian');
  assert.equal(nonLtsUbuntu.supported, false);
  assert.equal(nonLtsUbuntu.passengerSupported, false);

  const parsedWithComments = parseOsReleaseText('# comment\nID=\'debian\'\nVERSION_ID="12"\nVERSION_CODENAME="bookworm"\n');
  assert.deepEqual(parsedWithComments, { id: 'debian', versionId: '12', codename: 'bookworm' });

  await assert.rejects(
    () => detectLinuxPlatform({ readFileFn: null }),
    (error) => error instanceof OsPlatformError && error.code === 'os_platform_dependencies_invalid',
  );

  await assert.rejects(
    () => detectLinuxPlatform({ osReleasePath: '/nonexistent/os-release-missing-file' }),
    (error) => error instanceof OsPlatformError && error.code === 'os_platform_unavailable',
  );
});
