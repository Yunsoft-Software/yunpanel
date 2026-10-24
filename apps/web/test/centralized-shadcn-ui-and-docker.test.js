import { register } from 'node:module';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

import {
  resolveSubdomainSharedFileRoot,
  siteCreateInputFromForm,
} from '../src/workspace/new-website-form.js';
import {
  generateDockerComposeFromImage,
  resolveDockerProxyRule,
} from '../src/workspace/docker-compose-client.js';

register('./jsx-loader.js', import.meta.url);

const {
  DesignSystemConfig,
  DEFAULT_DOCKER_STACK_TEMPLATES,
  ThemeRoot,
  HierarchyTree,
  PortMappingTable,
  DockerHubCatalogPicker,
} = await import('../src/workspace/PanelKit.jsx');
const { dockerProjectsPageInternals } = await import('../src/workspace/DockerProjectsPage.jsx');

const readSrc = (relPath) => readFile(new URL(`../src/${relPath}`, import.meta.url), 'utf8');

test('Centralized Shadcn Design System CSS defines Zinc/Slate surfaces, 1px borders, Indigo brand, Emerald status, and spotlight/tree rules', async () => {
  const [themeCss, emberCss] = await Promise.all([
    readSrc('workspace/design-system/theme.css'),
    readSrc('workspace/ui/ember-theme.css'),
  ]);

  assert.match(emberCss, /\.\.\/design-system\/theme\.css/, 'ember-theme.css must import centralized design-system/theme.css');

  // Dark and Light Shadcn Zinc/Slate tokens
  assert.match(themeCss, /--ws-canvas:\s*#09090b/);
  assert.match(themeCss, /--ws-surface:\s*#141418/);
  assert.match(themeCss, /--ws-border:\s*#27272a/);
  assert.match(themeCss, /--ws-canvas:\s*#fafafa/);
  assert.match(themeCss, /--ws-surface:\s*#ffffff/);
  assert.match(themeCss, /--ws-border:\s*#e4e4e7/);

  // Electric Indigo brand & Emerald active status
  assert.match(themeCss, /--ws-brand:\s*#6366f1/);
  assert.match(themeCss, /--ws-brand:\s*#4f46e5/);
  assert.match(themeCss, /--ws-success:\s*#10b981/);
  assert.match(themeCss, /--ws-success:\s*#059669/);

  // Modern 12px card and 8px control radii
  assert.match(themeCss, /--ws-radius:\s*12px/);
  assert.match(themeCss, /--ws-radius-control:\s*8px/);

  // Spotlight, specular hairline, and Domain -> Subdomain tree connectors
  assert.match(themeCss, /inset 0 1px 0 0 rgba\(255,\s*255,\s*255,\s*0\.08\)/);
  assert.match(themeCss, /\.yp-spotlight-card/);
  assert.match(themeCss, /\.yp-domain-tree-card/);
  assert.match(themeCss, /\.yp-subdomain-tree/);
  assert.match(themeCss, /\.yp-subdomain-branch/);
  assert.match(themeCss, /\.yp-file-root-pill/);
});

test('Centralized swappable primitives render through PanelKit adapter layer', () => {
  assert.equal(DesignSystemConfig.id, 'shadcn-zinc-indigo');
  assert.equal(DesignSystemConfig.swappable, true);
  assert.equal(DesignSystemConfig.tokens.dark.canvas, '#09090b');
  assert.equal(DesignSystemConfig.tokens.light.canvas, '#fafafa');
  assert.ok(DEFAULT_DOCKER_STACK_TEMPLATES.length >= 4);

  const treeMarkup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        ThemeRoot,
        { theme: 'dark', density: 'comfortable' },
        createElement(HierarchyTree, {
          parentDomain: 'example.com',
          items: [
            { id: 'sub-1', primaryDomain: 'api.example.com' },
            { id: 'sub-2', primaryDomain: 'app.example.com' },
          ],
          getItemHref: (item) => `/websites/${item.id}`,
        }),
      ),
    ),
  );

  assert.match(treeMarkup, /data-ws-design-system="shadcn-zinc-indigo"/);
  assert.match(treeMarkup, /class="yp-subdomain-tree"/);
  assert.match(treeMarkup, /├─/);
  assert.match(treeMarkup, /└─/);
  assert.match(treeMarkup, /\/var\/www\/vhosts\/example\.com\/subdomains\/api/);
  assert.match(treeMarkup, /\/var\/www\/vhosts\/example\.com\/subdomains\/app/);
  assert.doesNotMatch(treeMarkup, /ortak kök/);

  const portTableMarkup = renderToStaticMarkup(
    createElement(PortMappingTable, {
      services: [
        {
          name: 'api',
          imageConfigured: true,
          publishedPorts: [{ hostIp: '127.0.0.1', publishedPort: 18080, targetPort: 8080, protocol: 'tcp' }],
        },
      ],
      proxyTarget: 'https://api.example.com → 127.0.0.1:18080',
    }),
  );

  assert.match(portTableMarkup, /Inner: 8080\/tcp/);
  assert.match(portTableMarkup, /Outer: 127\.0\.0\.1:18080/);
  assert.match(portTableMarkup, /https:\/\/api\.example\.com → 127\.0\.0\.1:18080/);

  const pickerMarkup = renderToStaticMarkup(
    createElement(DockerHubCatalogPicker, {
      selectedImage: 'redis:7-alpine',
      targetPort: 6379,
      publishedPort: 16379,
    }),
  );
  assert.match(pickerMarkup, /Docker Hub \/ Hazır Stack Şablonundan Oluştur/);
  assert.match(pickerMarkup, /Inner Port \(Container targetPort\)/);
  assert.match(pickerMarkup, /Outer Port \(Host publishedPort\)/);
  assert.match(pickerMarkup, /Şablondan YAML Oluştur/);
});

test('Domain -> Subdomain shared file root and full application/DB/Docker capabilities in new-website-form', () => {
  assert.equal(
    resolveSubdomainSharedFileRoot('example.com', 'api'),
    '/var/www/vhosts/example.com/subdomains/api',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('example.com', 'blog.example.com'),
    '/var/www/vhosts/example.com/subdomains/blog',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('example.com', ''),
    '/var/www/vhosts/example.com/subdomains/sub',
  );

  const operationId = '531071bb-d40d-4444-94ba-c9545144febc';
  const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
  const parentDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';

  // Subdomain with Docker Compose service & Inner port binding
  const composeSubdomain = siteCreateInputFromForm({
    form: {
      mode: 'subdomain',
      sourceMode: 'existing_managed_compose',
      dockerProjectId: 'proj-compose-1',
      dockerServiceName: 'web',
      dockerTargetPort: '8080',
      wwwMode: 'none',
      httpsMode: 'managed',
    },
    operationId,
    serverId,
    domain: { primaryDomain: 'docker.example.com', parentDomainId },
  });

  assert.equal(composeSubdomain.parentDomainId, parentDomainId);
  assert.deepEqual(composeSubdomain.source, {
    kind: 'existing_managed_compose',
    projectId: 'proj-compose-1',
    serviceName: 'web',
    targetPort: 8080,
    protocol: 'tcp',
  });

  // Subdomain with PHP + initial scoped Database
  const phpDbSubdomain = siteCreateInputFromForm({
    form: {
      mode: 'subdomain',
      sourceMode: 'new_php',
      initialDatabase: true,
      wwwMode: 'none',
      httpsMode: 'managed',
    },
    operationId,
    serverId,
    domain: { primaryDomain: 'portal.example.com', parentDomainId },
  });
  assert.deepEqual(phpDbSubdomain.source, { kind: 'new_php' });
  assert.deepEqual(phpDbSubdomain.database, { mode: 'create' });
});

test('Docker Hub quick-generator and Inner <-> Outer Port proxy helpers produce valid Compose YAML and wiring', async () => {
  const generated = generateDockerComposeFromImage({
    image: 'redis:7-alpine',
    targetPort: 6379,
    publishedPort: 16379,
    environment: { REDIS_AOF: 'yes' },
  });

  assert.equal(generated.serviceName, 'redis');
  assert.equal(generated.targetPort, 6379);
  assert.equal(generated.publishedPort, 16379);
  assert.match(generated.document, /services:\n {2}redis:\n {4}image: redis:7-alpine/);
  assert.match(generated.document, /"127\.0\.0\.1:16379:6379\/tcp"/);
  assert.match(generated.document, /REDIS_AOF: "yes"/);

  const proxyRule = resolveDockerProxyRule({
    projectId: 'proj-1',
    serviceName: 'redis',
    targetPort: 6379,
    publishedPort: 16379,
    pathPrefix: '/api',
    domainName: 'api.example.com',
  });
  assert.equal(proxyRule.innerPort, 6379);
  assert.equal(proxyRule.outerPort, 16379);
  assert.equal(proxyRule.upstreamUrl, 'http://127.0.0.1:16379');
  assert.equal(proxyRule.pathPrefix, '/api');
  assert.equal(proxyRule.domainName, 'api.example.com');

  assert.equal(
    dockerProjectsPageInternals.innerOuterPortLabel({ hostIp: '127.0.0.1', publishedPort: 18080, targetPort: 80, protocol: 'tcp' }),
    'Inner: 80/tcp ↔ Outer: 127.0.0.1:18080',
  );

  // Verify UI wiring in DockerProjectCreateDialog, DockerConfigPanel, DockerProjectsPage, NewWebsitePage, SiteOperations
  const [createDialog, configPanel, projectsPage, newWebsitePage, siteOps] = await Promise.all([
    readSrc('workspace/DockerProjectCreateDialog.jsx'),
    readSrc('workspace/DockerConfigPanel.jsx'),
    readSrc('workspace/DockerProjectsPage.jsx'),
    readSrc('workspace/NewWebsitePage.jsx'),
    readSrc('workspace/SiteOperations.jsx'),
  ]);

  assert.match(createDialog, /\.yml Dosyası Seç \/ Yükle/);
  assert.match(createDialog, /accept="\.yml,\.yaml"/);
  assert.match(createDialog, /DockerHubCatalogPicker/);
  assert.match(configPanel, /Mevcut Compose YAML'ı Editöre Yükle/);
  assert.match(projectsPage, /Inner Port \(Container targetPort\)/);
  assert.match(projectsPage, /Outer Port \(Host publishedPort\)/);
  assert.match(newWebsitePage, /resolveSubdomainSharedFileRoot/);
  assert.match(siteOps, /yp-subdomain-tree/);
  assert.match(siteOps, /yp-subdomain-branch/);
});
