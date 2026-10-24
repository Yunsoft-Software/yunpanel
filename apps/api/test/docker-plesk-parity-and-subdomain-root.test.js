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
} from '../src/docker-compose-project-registry.js';
import { createDockerComposeEnvironmentRegistry } from '../src/docker-compose-environment-registry.js';
import { createDockerRegistryCredentialRegistry } from '../src/docker-registry-credential-registry.js';
import { createDockerComposeOperationsService } from '../src/docker-compose-operations.js';
import { createJobRegistry } from '../src/job-registry.js';
import { mountDockerComposeRoutes } from '../src/docker-compose-http.js';
import {
  DockerPleskCatalogError,
  generateComposeFromCatalogInput,
  PLESK_DOCKER_CATALOG,
  resolveDockerProxyRule,
  searchDockerCatalog,
} from '../src/docker-plesk-catalog.js';
import {
  buildDomainHierarchyTree,
  extractSubdomainPrefix,
  resolveParentWorkspaceRoot,
  resolveSubdomainFileRoot,
  SubdomainFileRootError,
} from '../src/subdomain-file-root.js';

const SERVER_ID = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const PROJECT_ID = '0bb78242-03a6-429f-9d17-7725c521437c';
const ROOT_WEBSITE_ID = '11111111-2222-4333-8444-555555555555';
const ROOT_DOMAIN_ID = '22222222-3333-4444-8555-666666666666';
const API_SUBDOMAIN_ID = '33333333-4444-4555-8666-777777777777';
const BLOG_SUBDOMAIN_ID = '44444444-5555-4666-8777-888888888888';
const STAGING_SUBDOMAIN_ID = '55555555-6666-4777-8888-999999999999';
const NODE_APP_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PHP_APP_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

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

test('subdomain hierarchical file root resolves inside parent domain workspace and rejects traversal', () => {
  assert.equal(extractSubdomainPrefix('api.webrich.news', 'webrich.news'), 'api');
  assert.equal(extractSubdomainPrefix('blog.webrich.news', 'webrich.news'), 'blog');
  assert.equal(extractSubdomainPrefix('staging.webrich.news', 'webrich.news'), 'staging');

  assert.throws(
    () => extractSubdomainPrefix('webrich.news', 'webrich.news'),
    (error) => error instanceof SubdomainFileRootError && error.code === 'subdomain_not_under_parent',
  );
  assert.throws(
    () => extractSubdomainPrefix('evil-webrich.news', 'webrich.news'),
    (error) => error instanceof SubdomainFileRootError && error.code === 'subdomain_not_under_parent',
  );
  assert.throws(
    () => extractSubdomainPrefix('../etc.webrich.news', 'webrich.news'),
    (error) => error instanceof SubdomainFileRootError,
  );
  assert.throws(
    () => extractSubdomainPrefix('a..b.webrich.news', 'webrich.news'),
    (error) => error instanceof SubdomainFileRootError,
  );

  const parentWebsite = {
    id: ROOT_WEBSITE_ID,
    name: 'Webrich Main',
    documentRoot: '/var/www/vhosts/webrich.news/httpdocs',
  };
  assert.equal(
    resolveParentWorkspaceRoot({ parentDomain: 'webrich.news', parentWebsite }),
    '/var/www/vhosts/webrich.news',
  );

  const apiRoot = resolveSubdomainFileRoot({
    parentDomain: 'webrich.news',
    parentWebsite,
    subdomainDomain: 'api.webrich.news',
  });
  assert.deepEqual(apiRoot, {
    parentDomain: 'webrich.news',
    subdomainDomain: 'api.webrich.news',
    subdomainPrefix: 'api',
    parentWorkspaceRoot: '/var/www/vhosts/webrich.news',
    subdomainRootPath: '/var/www/vhosts/webrich.news/subdomains/api',
    relativeFromParentRoot: 'subdomains/api',
    supportsIndependentRuntime: true,
    supportsDatabaseBinding: true,
    supportsDockerProxy: true,
  });

  const blogRoot = resolveSubdomainFileRoot({
    parentDomain: { id: ROOT_DOMAIN_ID, primaryDomain: 'webrich.news' },
    parentWebsite,
    subdomainDomain: { id: BLOG_SUBDOMAIN_ID, primaryDomain: 'blog.webrich.news' },
  });
  assert.equal(blogRoot.subdomainRootPath, '/var/www/vhosts/webrich.news/subdomains/blog');
  assert.equal(blogRoot.relativeFromParentRoot, 'subdomains/blog');

  const stagingRoot = resolveSubdomainFileRoot({
    parentDomain: 'webrich.news',
    parentWebsite,
    subdomainDomain: 'staging.webrich.news',
  });
  assert.equal(stagingRoot.subdomainRootPath, '/var/www/vhosts/webrich.news/subdomains/staging');
  assert.equal(stagingRoot.relativeFromParentRoot, 'subdomains/staging');
});

test('buildDomainHierarchyTree nests subdomains under parent domain with independent App, DB, and Docker Proxy capabilities', () => {
  const websites = [
    {
      id: ROOT_WEBSITE_ID,
      name: 'webrich.news',
      runtimeType: 'php',
      applicationId: PHP_APP_ID,
      documentRoot: '/var/www/vhosts/webrich.news/httpdocs',
      phpConfig: { phpVersion: '8.3' },
    },
  ];
  const applications = [
    { id: PHP_APP_ID, name: 'webrich-main-php', runtime: 'php', phpVersion: '8.3' },
    { id: NODE_APP_ID, name: 'webrich-blog-node', runtime: 'node', nodeVersion: '22' },
  ];
  const databases = [
    { id: 'db-main', name: 'webrich_wp', engine: 'mariadb', websiteId: ROOT_WEBSITE_ID },
    { id: 'db-api', name: 'webrich_api_pg', engine: 'postgresql', domainId: API_SUBDOMAIN_ID },
    { id: 'db-blog', name: 'webrich_blog_db', engine: 'mariadb', domainId: BLOG_SUBDOMAIN_ID, applicationId: NODE_APP_ID },
  ];
  const dockerProjects = [
    {
      id: PROJECT_ID,
      projectName: 'n8n_stack',
      services: [
        {
          name: 'n8n',
          publishedPorts: [
            { hostIp: '127.0.0.1', publishedPort: 15678, targetPort: 5678, protocol: 'tcp' },
          ],
        },
      ],
    },
  ];
  const domains = [
    {
      id: ROOT_DOMAIN_ID,
      websiteId: ROOT_WEBSITE_ID,
      primaryDomain: 'webrich.news',
      aliases: ['www.webrich.news'],
      parentDomainId: null,
      targetType: 'php',
      target: { applicationId: PHP_APP_ID },
    },
    {
      id: API_SUBDOMAIN_ID,
      websiteId: ROOT_WEBSITE_ID,
      primaryDomain: 'api.webrich.news',
      aliases: [],
      parentDomainId: ROOT_DOMAIN_ID,
      runtimeType: 'docker',
      targetType: 'proxy',
      managedComposeBinding: {
        projectId: PROJECT_ID,
        serviceName: 'n8n',
        targetPort: 5678,
        protocol: 'tcp',
      },
      target: {
        upstreamHost: '127.0.0.1',
        upstreamPort: 15678,
        websocket: true,
      },
    },
    {
      id: BLOG_SUBDOMAIN_ID,
      websiteId: ROOT_WEBSITE_ID,
      primaryDomain: 'blog.webrich.news',
      aliases: [],
      parentDomainId: ROOT_DOMAIN_ID,
      runtimeType: 'node',
      targetType: 'passenger',
      applicationId: NODE_APP_ID,
      target: { applicationId: NODE_APP_ID },
    },
    {
      id: STAGING_SUBDOMAIN_ID,
      websiteId: ROOT_WEBSITE_ID,
      primaryDomain: 'staging.webrich.news',
      aliases: [],
      parentDomainId: ROOT_DOMAIN_ID,
      runtimeType: 'static',
      targetType: 'static',
      target: { root: '/var/www/vhosts/webrich.news/subdomains/staging' },
    },
  ];

  const tree = buildDomainHierarchyTree({
    websites,
    domains,
    applications,
    databases,
    dockerProjects,
  });

  assert.equal(tree.length, 1);
  assert.equal(tree.totalRootDomains, 1);
  assert.equal(tree.totalSubdomains, 3);

  const rootNode = tree[0];
  assert.equal(rootNode.primaryDomain, 'webrich.news');
  assert.equal(rootNode.kind, 'domain');
  assert.equal(rootNode.workspaceRoot, '/var/www/vhosts/webrich.news');
  assert.equal(rootNode.fileRootPath, '/var/www/vhosts/webrich.news/httpdocs');
  assert.equal(rootNode.runtime.runtimeType, 'php');
  assert.equal(rootNode.databases.length, 1);
  assert.equal(rootNode.databases[0].name, 'webrich_wp');
  assert.equal(rootNode.subdomains.length, 3);

  const [apiNode, blogNode, stagingNode] = rootNode.subdomains;

  assert.equal(apiNode.primaryDomain, 'api.webrich.news');
  assert.equal(apiNode.kind, 'subdomain');
  assert.equal(apiNode.subdomainPrefix, 'api');
  assert.equal(apiNode.fileRootPath, '/var/www/vhosts/webrich.news/subdomains/api');
  assert.equal(apiNode.relativeFromParentRoot, 'subdomains/api');
  assert.equal(apiNode.supportsIndependentRuntime, true);
  assert.equal(apiNode.supportsDatabaseBinding, true);
  assert.equal(apiNode.supportsDockerProxy, true);
  assert.equal(apiNode.databases.length, 1);
  assert.equal(apiNode.databases[0].name, 'webrich_api_pg');
  assert.deepEqual(apiNode.dockerProxy, {
    mode: 'existing_managed_compose',
    projectId: PROJECT_ID,
    projectName: 'n8n_stack',
    serviceName: 'n8n',
    innerPort: 5678,
    outerPort: 15678,
    targetPort: 5678,
    publishedPort: 15678,
    upstreamHost: '127.0.0.1',
    upstreamPort: 15678,
    websocket: true,
  });

  assert.equal(blogNode.primaryDomain, 'blog.webrich.news');
  assert.equal(blogNode.fileRootPath, '/var/www/vhosts/webrich.news/subdomains/blog');
  assert.equal(blogNode.runtime.runtimeType, 'node');
  assert.equal(blogNode.runtime.applicationId, NODE_APP_ID);
  assert.equal(blogNode.databases.length, 1);
  assert.equal(blogNode.databases[0].name, 'webrich_blog_db');

  assert.equal(stagingNode.primaryDomain, 'staging.webrich.news');
  assert.equal(stagingNode.fileRootPath, '/var/www/vhosts/webrich.news/subdomains/staging');
  assert.equal(stagingNode.runtime.runtimeType, 'static');
});

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
