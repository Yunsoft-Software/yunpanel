import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  applyFrameworkPresetToForm,
  JAMSTACK_FRAMEWORK_PRESETS,
  resolveSubdomainSharedFileRoot,
  siteCreateInputFromForm,
} from '../src/workspace/new-website-form.js';

const { buildGitWebhookCiCdSummary } = await import('../src/workspace/SiteOperations.jsx');

const operationId = '531071bb-d40d-4444-94ba-c9545144febc';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const parentDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';

function baseForm(overrides = {}) {
  return {
    mode: 'domain',
    ownerMode: 'owner',
    primaryDomain: 'example.com',
    parentDomainId: '',
    prefix: '',
    wwwMode: 'alias',
    httpsMode: 'managed',
    dnsMode: 'local',
    mailMode: 'local',
    repositoryUrl: 'https://github.com/yunpanel/jamstack-app',
    branch: 'main',
    entryFile: 'server.js',
    outputDir: 'dist',
    healthPath: '/health',
    dockerProjectId: 'compose-stack-1',
    dockerServiceName: 'web',
    dockerTargetPort: '8080',
    initialDatabase: false,
    ...overrides,
  };
}

test('JAMSTACK_FRAMEWORK_PRESETS exposes all 9 frozen presets with exact runtime and build metadata', () => {
  assert.equal(Object.isFrozen(JAMSTACK_FRAMEWORK_PRESETS), true);
  assert.equal(JAMSTACK_FRAMEWORK_PRESETS.length, 9);

  const expectedPresets = [
    {
      id: 'nextjs',
      label: 'Next.js (App Router / SSR)',
      category: 'JAMstack / SSR',
      sourceMode: 'new_node',
      entryFile: 'server.js',
      outputDir: '.next',
      healthPath: '/api/health',
      defaultPort: 3000,
      buildCommand: 'npm run build',
      startCommand: 'npm run start',
    },
    {
      id: 'astro',
      label: 'Astro (Static / Hybrid)',
      category: 'JAMstack / Static',
      sourceMode: 'new_static',
      entryFile: 'dist/server/entry.mjs',
      outputDir: 'dist',
      healthPath: '/',
      defaultPort: 4321,
      buildCommand: 'npm run build',
      startCommand: 'npm run preview',
    },
    {
      id: 'vite_spa',
      label: 'Vite / React / Vue SPA',
      category: 'JAMstack / Static',
      sourceMode: 'new_static',
      entryFile: 'index.html',
      outputDir: 'dist',
      healthPath: '/',
      defaultPort: 5173,
      buildCommand: 'npm run build',
      startCommand: '',
    },
    {
      id: 'nuxt',
      label: 'Nuxt 3 (SSR / Nitro)',
      category: 'JAMstack / SSR',
      sourceMode: 'new_node',
      entryFile: '.output/server/index.mjs',
      outputDir: '.output/public',
      healthPath: '/',
      defaultPort: 3000,
      buildCommand: 'npm run build',
      startCommand: 'node .output/server/index.mjs',
    },
    {
      id: 'remix',
      label: 'Remix / React Router v7',
      category: 'JAMstack / SSR',
      sourceMode: 'new_node',
      entryFile: 'build/server/index.js',
      outputDir: 'build/client',
      healthPath: '/',
      defaultPort: 3000,
      buildCommand: 'npm run build',
      startCommand: 'npm run start',
    },
    {
      id: 'node_api',
      label: 'Node.js API (Express / Fastify / Nest)',
      category: 'Backend API',
      sourceMode: 'new_node',
      entryFile: 'server.js',
      outputDir: 'dist',
      healthPath: '/health',
      defaultPort: 4000,
      buildCommand: 'npm run build',
      startCommand: 'node server.js',
    },
    {
      id: 'python_api',
      label: 'Python (FastAPI / Django / Flask)',
      category: 'Backend API',
      sourceMode: 'new_python',
      entryFile: 'app.py',
      outputDir: 'static',
      healthPath: '/health',
      defaultPort: 8000,
      buildCommand: 'pip install -r requirements.txt',
      startCommand: 'uvicorn app:app',
    },
    {
      id: 'docker_stack',
      label: 'Docker / Easypanel Stack Proxy',
      category: 'Container',
      sourceMode: 'docker_compose',
      entryFile: '',
      outputDir: '',
      healthPath: '/',
      defaultPort: 8080,
      buildCommand: 'docker compose up -d',
      startCommand: '',
    },
    {
      id: 'php_wordpress',
      label: 'PHP-FPM / WordPress / Laravel',
      category: 'PHP',
      sourceMode: 'new_php',
      entryFile: 'index.php',
      outputDir: 'public',
      healthPath: '/',
      defaultPort: 9000,
      buildCommand: 'composer install',
      startCommand: '',
    },
  ];

  for (const expected of expectedPresets) {
    const preset = JAMSTACK_FRAMEWORK_PRESETS.find((item) => item.id === expected.id);
    assert.ok(preset, `Preset ${expected.id} must exist`);
    assert.equal(Object.isFrozen(preset), true);
    assert.deepEqual(preset, expected);

    const updatedForm = applyFrameworkPresetToForm(baseForm({ applicationId: 'stale-app', websiteId: 'stale-site' }), expected.id);
    assert.equal(updatedForm.frameworkPreset, expected.id);
    assert.equal(updatedForm.sourceMode, expected.sourceMode);
    assert.equal(updatedForm.entryFile, expected.entryFile);
    assert.equal(updatedForm.outputDir, expected.outputDir);
    assert.equal(updatedForm.healthPath, expected.healthPath);
    assert.equal(updatedForm.defaultPort, expected.defaultPort);
    assert.equal(updatedForm.buildCommand, expected.buildCommand);
    assert.equal(updatedForm.startCommand, expected.startCommand);
    assert.equal(updatedForm.applicationId, '');
    assert.equal(updatedForm.websiteId, '');
  }

  assert.throws(
    () => applyFrameworkPresetToForm(baseForm(), 'unknown_framework'),
    /Geçersiz framework şablonu/,
  );
});

test('applyFrameworkPresetToForm integrates with siteCreateInputFromForm for both root domains and subdomains', () => {
  // 1. Root domain with Next.js preset
  const nextjsForm = applyFrameworkPresetToForm(baseForm({ initialDatabase: true }), 'nextjs');
  const nextjsInput = siteCreateInputFromForm({
    form: nextjsForm,
    operationId,
    serverId,
    domain: { primaryDomain: 'app.example.com', parentDomainId: null },
  });
  assert.equal(nextjsInput.primaryDomain, 'app.example.com');
  assert.equal(nextjsInput.parentDomainId, null);
  assert.equal(nextjsInput.wwwMode, 'alias');
  assert.equal(nextjsInput.source.kind, 'new_node');
  assert.equal(nextjsInput.source.runtime.entryFile, 'server.js');
  assert.equal(nextjsInput.source.runtime.healthPath, '/api/health');
  assert.deepEqual(nextjsInput.database, { mode: 'create' });

  // 2. Subdomain with Nuxt 3 preset + shared subdomain file root
  const nuxtSubdomainForm = applyFrameworkPresetToForm(
    baseForm({ mode: 'subdomain', prefix: 'portal', parentDomainId }),
    'nuxt',
  );
  const sharedRoot = resolveSubdomainSharedFileRoot('example.com', nuxtSubdomainForm.prefix);
  assert.equal(sharedRoot, '/var/www/vhosts/example.com/subdomains/portal');

  const nuxtSubdomainInput = siteCreateInputFromForm({
    form: nuxtSubdomainForm,
    operationId,
    serverId,
    domain: { primaryDomain: 'portal.example.com', parentDomainId },
  });
  assert.equal(nuxtSubdomainInput.parentDomainId, parentDomainId);
  assert.equal(nuxtSubdomainInput.wwwMode, 'none');
  assert.equal(nuxtSubdomainInput.mail.mode, 'none');
  assert.equal(nuxtSubdomainInput.source.kind, 'new_node');
  assert.equal(nuxtSubdomainInput.source.runtime.entryFile, '.output/server/index.mjs');
  assert.equal(nuxtSubdomainInput.source.runtime.healthPath, '/');

  // 3. Subdomain with Astro / Vite static presets
  for (const presetId of ['astro', 'vite_spa']) {
    const staticForm = applyFrameworkPresetToForm(
      baseForm({ mode: 'subdomain', prefix: presetId, parentDomainId }),
      presetId,
    );
    const staticInput = siteCreateInputFromForm({
      form: staticForm,
      operationId,
      serverId,
      domain: { primaryDomain: `${presetId}.example.com`, parentDomainId },
    });
    assert.equal(staticInput.source.kind, 'new_static');
    assert.equal(staticInput.source.build.outputDir, 'dist');
  }

  // 4. Root domain with Remix and Node.js API presets
  const remixInput = siteCreateInputFromForm({
    form: applyFrameworkPresetToForm(baseForm(), 'remix'),
    operationId,
    serverId,
    domain: { primaryDomain: 'remix.example.com', parentDomainId: null },
  });
  assert.equal(remixInput.source.kind, 'new_node');
  assert.equal(remixInput.source.runtime.entryFile, 'build/server/index.js');

  const nodeApiInput = siteCreateInputFromForm({
    form: applyFrameworkPresetToForm(baseForm(), 'node_api'),
    operationId,
    serverId,
    domain: { primaryDomain: 'api.example.com', parentDomainId: null },
  });
  assert.equal(nodeApiInput.source.kind, 'new_node');
  assert.equal(nodeApiInput.source.runtime.entryFile, 'server.js');
  assert.equal(nodeApiInput.source.runtime.healthPath, '/health');

  // 5. Subdomain with Python API preset + scoped database
  const pythonForm = applyFrameworkPresetToForm(
    baseForm({ mode: 'subdomain', prefix: 'ai', parentDomainId, initialDatabase: true }),
    'python_api',
  );
  const pythonInput = siteCreateInputFromForm({
    form: pythonForm,
    operationId,
    serverId,
    domain: { primaryDomain: 'ai.example.com', parentDomainId },
  });
  assert.equal(pythonInput.source.kind, 'new_python');
  assert.equal(pythonInput.source.runtime.entryFile, 'app.py');
  assert.equal(pythonInput.source.runtime.healthPath, '/health');
  assert.deepEqual(pythonInput.database, { mode: 'create' });

  // 6. Subdomain with Docker / Easypanel Stack Proxy preset
  const dockerForm = applyFrameworkPresetToForm(
    baseForm({ mode: 'subdomain', prefix: 'stack', parentDomainId, dockerProjectId: 'easypanel-app-1' }),
    'docker_stack',
  );
  const dockerInput = siteCreateInputFromForm({
    form: dockerForm,
    operationId,
    serverId,
    domain: { primaryDomain: 'stack.example.com', parentDomainId },
  });
  assert.deepEqual(dockerInput.source, {
    kind: 'existing_managed_compose',
    projectId: 'easypanel-app-1',
    serviceName: 'web',
    targetPort: 8080,
    protocol: 'tcp',
  });

  // 7. Root domain with PHP / WordPress preset
  const phpInput = siteCreateInputFromForm({
    form: applyFrameworkPresetToForm(baseForm({ initialDatabase: true }), 'php_wordpress'),
    operationId,
    serverId,
    domain: { primaryDomain: 'wp.example.com', parentDomainId: null },
  });
  assert.deepEqual(phpInput.source, { kind: 'new_php' });
  assert.deepEqual(phpInput.database, { mode: 'create' });
});

test('NewWebsitePage and SiteOperations wire JAMstack presets and Git Push Webhook CI/CD DX panel', async () => {
  const [newWebsiteSource, siteOpsSource] = await Promise.all([
    readFile(new URL('../src/workspace/NewWebsitePage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/SiteOperations.jsx', import.meta.url), 'utf8'),
  ]);

  // NewWebsitePage Step 2 preset selector bar wiring
  assert.match(newWebsiteSource, /JAMSTACK_FRAMEWORK_PRESETS/);
  assert.match(newWebsiteSource, /applyFrameworkPresetToForm/);
  assert.match(newWebsiteSource, /Hızlı Framework \/ JAMstack Şablonu Seçin/);
  for (const label of [
    'Next.js',
    'Astro',
    'Vite / React SPA',
    'Nuxt 3',
    'Remix',
    'Node.js API',
    'Python API',
    'Docker / Easypanel',
    'PHP / WordPress',
  ]) {
    assert.ok(newWebsiteSource.includes(label), `NewWebsitePage must mention ${label}`);
  }

  // SiteOperations Git Push Webhook & Otomatik Yayın (CI/CD) section wiring
  assert.match(siteOpsSource, /Git Push Webhook & Otomatik Yayın \(CI\/CD\)/);
  assert.match(siteOpsSource, /GitHub Webhook Endpoint/);
  assert.match(siteOpsSource, /\/api\/webhooks\/github/);
  assert.match(siteOpsSource, /Webhook URL Kopyala/);
  assert.match(siteOpsSource, /Tetiklenen Dal \(Branch\)/);
  assert.match(siteOpsSource, /refs\/heads\/\$\{application\.branch \|\| 'main'\}/);
  assert.match(siteOpsSource, /İçerik Türü \(Content-Type\)/);
  assert.match(siteOpsSource, /application\/json/);
  assert.match(siteOpsSource, /Build & Çalışma Özeti/);
  assert.match(siteOpsSource, /Çıktı Dizini \(outputDir\)/);
  assert.match(siteOpsSource, /Başlangıç \(entryFile \/ startScript\)/);
  assert.match(siteOpsSource, /Sağlık Kontrolü \(healthPath\)/);
  assert.match(siteOpsSource, /Aktif Sürüm \(Release\)/);

  // Verify buildGitWebhookCiCdSummary helper with real application objects
  const nodeSummary = buildGitWebhookCiCdSummary(
    {
      type: 'node',
      branch: 'production',
      outputDir: '.next',
      currentReleaseId: 'rel-20261025-01',
      runtime: { startMode: 'node', entryFile: 'server.js', healthPath: '/api/health' },
    },
    { primaryDomain: 'jamstack.example.com' },
  );
  assert.equal(nodeSummary.webhookEndpoint, 'https://jamstack.example.com/api/webhooks/github');
  assert.equal(nodeSummary.branchRef, 'refs/heads/production');
  assert.equal(nodeSummary.contentType, 'application/json');
  assert.equal(nodeSummary.outputDir, '.next');
  assert.equal(nodeSummary.startEntry, 'server.js');
  assert.equal(nodeSummary.healthPath, '/api/health');
  assert.equal(nodeSummary.activeRelease, 'rel-20261025-01');
});
