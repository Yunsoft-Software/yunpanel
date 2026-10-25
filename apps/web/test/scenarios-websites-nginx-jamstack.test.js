import { register } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

register('./jsx-loader.js', import.meta.url);

import { domainCreatePayload } from '../src/domain-form.js';
import {
  JAMSTACK_FRAMEWORK_PRESETS,
  applyFrameworkPresetToForm,
  availableExistingApplications,
  availableSharedWebsites,
  existingApplicationType,
  resolveSubdomainSharedFileRoot,
  sharedDomainCreateInput,
  sharedWebsiteConfirmation,
  sharedWebsiteTarget,
  siteCreateInputFromForm,
} from '../src/workspace/new-website-form.js';
import {
  DomainAliasError,
  aliasErrorMessage,
} from '../src/workspace/domain-alias-model.js';
import {
  HOSTING_SETTING_FIELDS,
  hostingDraftValues,
  hostingExpectedDomain,
  hostingSettingsChanges,
  hostingSettingsDiff,
  hostingSettingsFromDomain,
  hostingSettingsWarnings,
  hostingValuesEqual,
  validateHostingSettingsPreview,
} from '../src/workspace/domain-hosting-model.js';
import {
  createHostingForm,
  editHostingForm,
  hostingFormDirty,
  hostingFormStale,
  hostingReviewMatches,
  hostingWriteBlock,
   refreshHostingForm,
  reloadHostingForm,
} from '../src/workspace/domain-hosting-form.js';
import { createDomainHostingClient } from '../src/workspace/domain-hosting-client.js';
import {
  EMPTY_SITE_SUBMISSION,
  createSiteSubmission,
  siteSubmissionBusy,
} from '../src/workspace/site-create-submission.js';
import {
  normalizeNginxSettings,
  NginxSettingsValidationError,
} from '@yunpanel/shared/nginx-settings';

const {
  default: NginxSettingsFields,
  NGINX_HEADER_PRESETS,
  STATIC_CACHE_PRESETS,
  applyNginxHeaderPreset,
} = await import('../src/workspace/NginxSettingsFields.jsx');

const {
  JAMSTACK_FRAMEWORK_PRESETS: SUBPATH_FRAMEWORK_PRESETS,
  buildNginxSubPathLocationBlock,
  NginxSubPathProxyBuilder,
} = await import('../src/workspace/DomainHostingPanel.jsx');

const { buildGitWebhookCiCdSummary } = await import('../src/workspace/SiteOperations.jsx');

const OPERATION_ID = '531071bb-d40d-4444-94ba-c9545144febc';
const PROVISIONING_ID = '7a91f0c4-1122-4888-9abc-def012345678';
const SERVER_ID = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const PARENT_DOMAIN_ID = '3854e385-adfc-42bd-bccf-f655f24cd68f';
const WEBSITE_ID = 'c0ffee11-2233-4455-8666-778899aabbcc';
const DOMAIN_ID = 'd00d1122-3344-4556-8778-8899aabbccdd';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function makeWizardForm(overrides = {}) {
  return {
    mode: 'domain',
    ownerMode: 'owner',
    sourceMode: 'new_node',
    primaryDomain: 'webrich.news',
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

function makeDomainRecord(overrides = {}) {
  const targetType = overrides.targetType ?? 'static';
  const defaultTarget =
    targetType === 'static'
      ? { root: '/var/www/vhosts/webrich.news/httpdocs', spaFallback: true }
      : targetType === 'proxy' || targetType === 'python'
        ? { upstreamHost: '127.0.0.1', upstreamPort: 3000, websocket: true }
        : { applicationId: 'app-1' };
  const baseNginx = normalizeNginxSettings(targetType, overrides.nginxSettings ?? {});
  return {
    id: DOMAIN_ID,
    serverId: SERVER_ID,
    websiteId: WEBSITE_ID,
    parentDomainId: null,
    primaryDomain: 'webrich.news',
    aliases: ['www.webrich.news'],
    desiredRevision: 1,
    stagedRevision: 1,
    appliedRevision: 1,
    stagedChecksum: DIGEST_A,
    state: 'active',
    targetType,
    target: defaultTarget,
    httpsMode: 'managed',
    httpsRedirect: false,
    canonicalRedirect: false,
    nginxSettings: baseNginx,
    certificateId: 'cert-1',
    ...overrides,
  };
}

// ============================================================================
// SCN-WEB-01: Domain -> Subdomain Shared File Root & Domain Creation Payloads
// ============================================================================

test('SCN-WEB-01a: resolveSubdomainSharedFileRoot resolves single-level and multi-level subdomain prefixes inside parent vhost directory', () => {
  assert.equal(
    resolveSubdomainSharedFileRoot('webrich.news', 'api'),
    '/var/www/vhosts/webrich.news/subdomains/api',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('webrich.news', 'blog'),
    '/var/www/vhosts/webrich.news/subdomains/blog',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('webrich.news', 'staging.api'),
    '/var/www/vhosts/webrich.news/subdomains/staging.api',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('example.co.uk', 'eu.v2.cdn-1'),
    '/var/www/vhosts/example.co.uk/subdomains/eu.v2.cdn-1',
  );
});

test('SCN-WEB-01b: resolveSubdomainSharedFileRoot strips redundant parent domain suffix when user types full FQDN in prefix', () => {
  assert.equal(
    resolveSubdomainSharedFileRoot('webrich.news', 'api.webrich.news'),
    '/var/www/vhosts/webrich.news/subdomains/api',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('webrich.news', 'staging.api.webrich.news'),
    '/var/www/vhosts/webrich.news/subdomains/staging.api',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('webrich.news', '.webrich.news'),
    '/var/www/vhosts/webrich.news/subdomains/sub',
  );
});

test('SCN-WEB-01c: resolveSubdomainSharedFileRoot normalizes uppercase, whitespace, and leading/trailing dots', () => {
  assert.equal(
    resolveSubdomainSharedFileRoot('  WebRich.NEWS  ', '  API.Staging  '),
    '/var/www/vhosts/webrich.news/subdomains/api.staging',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('Example.COM', '...blog..dev...'),
    '/var/www/vhosts/example.com/subdomains/blog.dev',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('Example.COM', '  API.Example.COM  '),
    '/var/www/vhosts/example.com/subdomains/api',
  );
});

test('SCN-WEB-01d: resolveSubdomainSharedFileRoot neutralizes adversarial path traversal, slashes, null bytes, and empty/null inputs', () => {
  const adversarialPrefixes = [
    '../../etc/passwd',
    '../root',
    'sub/../../etc',
    '///',
    '\\..\\..\\windows\\system32',
    '\0../../var/log',
    'api; rm -rf /',
    '$(whoami)',
    '`id`',
    '...',
    '',
    '    ',
    null,
    undefined,
  ];

  for (const badPrefix of adversarialPrefixes) {
    const resolved = resolveSubdomainSharedFileRoot('webrich.news', badPrefix);
    assert.ok(
      resolved.startsWith('/var/www/vhosts/webrich.news/subdomains/'),
      `Expected safe vhost root for prefix ${JSON.stringify(badPrefix)}, got ${resolved}`,
    );
    assert.equal(resolved.includes('..'), false, `Traversal sequence leaked for ${JSON.stringify(badPrefix)}: ${resolved}`);
    assert.match(resolved, /^\/var\/www\/vhosts\/webrich\.news\/subdomains\/[a-z0-9.-]+$/);
  }

  // Adversarial parent domain inputs must also stay strictly confined
  for (const badParent of ['../../etc/shadow', '///', '', '   ', null, undefined]) {
    const resolved = resolveSubdomainSharedFileRoot(badParent, 'api');
    assert.equal(resolved.includes('..'), false);
    assert.match(resolved, /^\/var\/www\/vhosts\/[a-z0-9.-]+\/subdomains\/api$/);
  }

  // Verify exact sanitized outputs for common traversal strings
  assert.equal(
    resolveSubdomainSharedFileRoot('webrich.news', '../../etc/passwd'),
    '/var/www/vhosts/webrich.news/subdomains/etcpasswd',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('webrich.news', '../root'),
    '/var/www/vhosts/webrich.news/subdomains/root',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('webrich.news', '///'),
    '/var/www/vhosts/webrich.news/subdomains/sub',
  );
  assert.equal(
    resolveSubdomainSharedFileRoot('webrich.news', null),
    '/var/www/vhosts/webrich.news/subdomains/sub',
  );
});

test('SCN-WEB-01e: domainCreatePayload builds valid root domain and subdomain payloads with shared file root and proxy targets', () => {
  const servers = [{ id: SERVER_ID }];
  const parentDomains = [
    {
      id: PARENT_DOMAIN_ID,
      serverId: SERVER_ID,
      websiteId: WEBSITE_ID,
      primaryDomain: 'webrich.news',
    },
  ];

  const rootPayload = domainCreatePayload(
    {
      mode: 'domain',
      primaryDomain: '  WebRich.News. ',
      aliases: ' www.webrich.news , cdn.webrich.news , ',
      targetType: 'static',
      targetValue: ' /var/www/vhosts/webrich.news/httpdocs ',
      httpsMode: 'managed',
    },
    parentDomains,
    servers,
  );
  assert.deepEqual(rootPayload, {
    serverId: SERVER_ID,
    websiteId: null,
    primaryDomain: 'webrich.news',
    parentDomainId: null,
    aliases: ['www.webrich.news', 'cdn.webrich.news'],
    targetType: 'static',
    target: { root: '/var/www/vhosts/webrich.news/httpdocs', spaFallback: true },
    httpsMode: 'managed',
  });

  const subSharedRoot = resolveSubdomainSharedFileRoot('webrich.news', 'v2.api');
  const subPayload = domainCreatePayload(
    {
      mode: 'subdomain',
      parentDomainId: PARENT_DOMAIN_ID,
      prefix: ' V2.API ',
      primaryDomain: '',
      aliases: '',
      targetType: 'proxy',
      targetValue: '4000',
      httpsMode: 'managed',
    },
    parentDomains,
    servers,
  );
  assert.deepEqual(subPayload, {
    serverId: SERVER_ID,
    websiteId: WEBSITE_ID,
    primaryDomain: 'v2.api.webrich.news',
    parentDomainId: PARENT_DOMAIN_ID,
    aliases: [],
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 4000, websocket: true },
    httpsMode: 'managed',
  });
  assert.equal(subSharedRoot, '/var/www/vhosts/webrich.news/subdomains/v2.api');
});

test('SCN-WEB-01f: domainCreatePayload rejects invalid subdomain prefixes, missing parent domain, cross-server mismatches, >253 char domains, and invalid proxy ports', () => {
  const servers = [{ id: SERVER_ID }];
  const parentDomains = [
    {
      id: PARENT_DOMAIN_ID,
      serverId: SERVER_ID,
      websiteId: WEBSITE_ID,
      primaryDomain: 'webrich.news',
    },
  ];

  assert.throws(
    () => domainCreatePayload({ mode: 'domain', primaryDomain: 'a.com', aliases: '', targetType: 'static', targetValue: '/srv' }, [], []),
    /Yerel sunucu kullanılamıyor/,
  );

  assert.throws(
    () => domainCreatePayload({ mode: 'subdomain', parentDomainId: 'missing-id', prefix: 'api', primaryDomain: '', aliases: '', targetType: 'static', targetValue: '/srv' }, parentDomains, servers),
    /Select an existing parent domain/,
  );

  assert.throws(
    () => domainCreatePayload(
      { mode: 'subdomain', parentDomainId: PARENT_DOMAIN_ID, prefix: 'api', primaryDomain: '', aliases: '', targetType: 'static', targetValue: '/srv' },
      [{ ...parentDomains[0], serverId: 'other-server' }],
      servers,
    ),
    /Üst alan adı bu panel sunucusuna ait değil/,
  );

  assert.throws(
    () => domainCreatePayload(
      { mode: 'domain', serverId: 'other-server', primaryDomain: 'webrich.news', aliases: '', targetType: 'static', targetValue: '/srv' },
      parentDomains,
      servers,
    ),
    /Yalnızca bu panel sunucusu yönetilebilir/,
  );

  for (const invalidPrefix of ['', '   ', '-api', 'api-', 'a..b', 'bad_underscore', '../etc', 'a'.repeat(64)]) {
    assert.throws(
      () => domainCreatePayload(
        {
          mode: 'subdomain',
          parentDomainId: PARENT_DOMAIN_ID,
          prefix: invalidPrefix,
          primaryDomain: '',
          aliases: '',
          targetType: 'static',
          targetValue: '/srv',
          httpsMode: 'managed',
        },
        parentDomains,
        servers,
      ),
      /Enter a valid subdomain prefix/,
      `Expected invalid prefix ${JSON.stringify(invalidPrefix)} to throw`,
    );
  }

  assert.throws(
    () => domainCreatePayload(
      {
        mode: 'domain',
        primaryDomain: `${'a'.repeat(250)}.com`,
        aliases: '',
        targetType: 'static',
        targetValue: '/srv',
        httpsMode: 'managed',
      },
      parentDomains,
      servers,
    ),
    /at most 253 characters/,
  );

  for (const badPort of ['0', '1023', '65536', '70000', 'abc', '']) {
    assert.throws(
      () => domainCreatePayload(
        {
          mode: 'domain',
          primaryDomain: 'webrich.news',
          aliases: '',
          targetType: 'proxy',
          targetValue: badPort,
          httpsMode: 'managed',
        },
        parentDomains,
        servers,
      ),
      /Upstream port must be between 1024 and 65535/,
    );
  }
});

// ============================================================================
// SCN-WEB-02 & SCN-WEB-03: 9 JAMstack Presets, Wizard Validation & Shared Sites
// ============================================================================

test('SCN-WEB-02a: applyFrameworkPresetToForm and siteCreateInputFromForm produce valid payloads for all 9 JAMstack presets on root domains', () => {
  assert.equal(JAMSTACK_FRAMEWORK_PRESETS.length, 9);

  const expectedByPreset = {
    nextjs: { kind: 'new_node', entryFile: 'server.js', healthPath: '/api/health', port: 3000 },
    astro: { kind: 'new_static', outputDir: 'dist', port: 4321 },
    vite_spa: { kind: 'new_static', outputDir: 'dist', port: 5173 },
    nuxt: { kind: 'new_node', entryFile: '.output/server/index.mjs', healthPath: '/', port: 3000 },
    remix: { kind: 'new_node', entryFile: 'build/server/index.js', healthPath: '/', port: 3000 },
    node_api: { kind: 'new_node', entryFile: 'server.js', healthPath: '/health', port: 4000 },
    python_api: { kind: 'new_python', entryFile: 'app.py', healthPath: '/health', port: 8000 },
    docker_stack: { kind: 'existing_managed_compose', targetPort: 8080, port: 8080 },
    php_wordpress: { kind: 'new_php', port: 9000 },
  };

  for (const preset of JAMSTACK_FRAMEWORK_PRESETS) {
    const form = applyFrameworkPresetToForm(
      makeWizardForm({ applicationId: 'old-app', websiteId: 'old-site' }),
      preset.id,
    );
    assert.equal(form.frameworkPreset, preset.id);
    assert.equal(form.sourceMode, preset.sourceMode);
    assert.equal(form.defaultPort, expectedByPreset[preset.id].port);
    assert.equal(form.applicationId, '');
    assert.equal(form.websiteId, '');

    const input = siteCreateInputFromForm({
      form,
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain: { primaryDomain: `${preset.id.replace('_', '-')}.webrich.news`, parentDomainId: null },
    });

    const exp = expectedByPreset[preset.id];
    assert.equal(input.source.kind, exp.kind);
    assert.equal(input.wwwMode, 'alias');
    assert.equal(input.mail.mode, 'local');
    assert.equal(input.dns.mode, 'local');

    if (exp.kind === 'new_node') {
      assert.equal(input.source.runtime.nodeMajor, 24);
      assert.equal(input.source.runtime.entryFile, exp.entryFile);
      assert.equal(input.source.runtime.healthPath, exp.healthPath);
    } else if (exp.kind === 'new_static') {
      assert.equal(input.source.build.outputDir, exp.outputDir);
      assert.equal(input.source.build.healthFile, 'index.html');
    } else if (exp.kind === 'new_python') {
      assert.equal(input.source.runtime.pythonVersion, '3.12');
      assert.equal(input.source.runtime.entryFile, exp.entryFile);
      assert.equal(input.source.runtime.healthPath, exp.healthPath);
    } else if (exp.kind === 'existing_managed_compose') {
      assert.equal(input.source.targetPort, exp.targetPort);
      assert.equal(input.source.protocol, 'tcp');
    }
  }

  assert.throws(
    () => applyFrameworkPresetToForm(makeWizardForm(), 'non_existent_preset'),
    /Geçersiz framework şablonu: non_existent_preset/,
  );
});

test('SCN-WEB-02b: applyFrameworkPresetToForm and siteCreateInputFromForm produce valid subdomain payloads across all 9 presets with shared root', () => {
  const servers = [{ id: SERVER_ID }];
  const parentDomains = [
    { id: PARENT_DOMAIN_ID, serverId: SERVER_ID, websiteId: WEBSITE_ID, primaryDomain: 'webrich.news' },
  ];

  for (const preset of JAMSTACK_FRAMEWORK_PRESETS) {
    const cleanPrefix = preset.id.replace(/_/g, '-');
    const sharedRoot = resolveSubdomainSharedFileRoot('webrich.news', cleanPrefix);
    assert.equal(sharedRoot, `/var/www/vhosts/webrich.news/subdomains/${cleanPrefix}`);

    const domainPayload = domainCreatePayload(
      {
        mode: 'subdomain',
        parentDomainId: PARENT_DOMAIN_ID,
        prefix: cleanPrefix,
        primaryDomain: '',
        aliases: '',
        targetType: preset.sourceMode === 'new_static' ? 'static' : 'proxy',
        targetValue: preset.sourceMode === 'new_static' ? sharedRoot : String(preset.defaultPort),
        httpsMode: 'managed',
      },
      parentDomains,
      servers,
    );

    const form = applyFrameworkPresetToForm(
      makeWizardForm({
        mode: 'subdomain',
        parentDomainId: PARENT_DOMAIN_ID,
        prefix: cleanPrefix,
        dnsMode: undefined,
      }),
      preset.id,
    );

    const siteInput = siteCreateInputFromForm({
      form,
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain: domainPayload,
    });

    assert.equal(siteInput.primaryDomain, `${cleanPrefix}.webrich.news`);
    assert.equal(siteInput.parentDomainId, PARENT_DOMAIN_ID);
    assert.equal(siteInput.wwwMode, 'none');
    assert.equal(siteInput.mail.mode, 'none');
    assert.equal(siteInput.dns.mode, 'external');
    assert.equal(Object.hasOwn(siteInput, 'siteAdmin'), false);
  }
});

test('SCN-WEB-02c: siteCreateInputFromForm allows initialDatabase on managed apps and rejects it on docker_compose, existing_managed_compose, existing_docker, and external_proxy', () => {
  const domain = { primaryDomain: 'dbtest.webrich.news', parentDomainId: null };

  for (const presetId of ['nextjs', 'astro', 'vite_spa', 'nuxt', 'remix', 'node_api', 'python_api', 'php_wordpress']) {
    const form = applyFrameworkPresetToForm(makeWizardForm({ initialDatabase: true }), presetId);
    const input = siteCreateInputFromForm({ form, operationId: OPERATION_ID, serverId: SERVER_ID, domain });
    assert.deepEqual(input.database, { mode: 'create' }, `Preset ${presetId} must allow initialDatabase`);
  }

  // Static upload and existing_application also allow initialDatabase
  const uploadInput = siteCreateInputFromForm({
    form: makeWizardForm({ sourceMode: 'new_static_upload', initialDatabase: true }),
    operationId: OPERATION_ID,
    serverId: SERVER_ID,
    domain,
  });
  assert.deepEqual(uploadInput.database, { mode: 'create' });

  const existingAppInput = siteCreateInputFromForm({
    form: makeWizardForm({ sourceMode: 'existing_node', initialDatabase: true }),
    operationId: OPERATION_ID,
    serverId: SERVER_ID,
    domain,
    selectedApplication: { id: 'app-node-1', type: 'node', serverId: SERVER_ID },
  });
  assert.deepEqual(existingAppInput.database, { mode: 'create' });

  // Non-managed runtime sources must reject initialDatabase: true
  const disallowedForms = [
    applyFrameworkPresetToForm(makeWizardForm({ initialDatabase: true }), 'docker_stack'),
    makeWizardForm({
      sourceMode: 'existing_managed_compose',
      dockerProjectId: 'proj-1',
      dockerServiceName: 'api',
      dockerTargetPort: '8080',
      initialDatabase: true,
    }),
    makeWizardForm({
      sourceMode: 'existing_docker',
      dockerWorkloadId: 'workload-1',
      initialDatabase: true,
    }),
    makeWizardForm({
      sourceMode: 'external_proxy',
      targetValue: '3000',
      initialDatabase: true,
    }),
  ];

  for (const form of disallowedForms) {
    assert.throws(
      () => siteCreateInputFromForm({ form, operationId: OPERATION_ID, serverId: SERVER_ID, domain }),
      /Başlangıç veritabanı yalnız yönetilen Application Website için oluşturulabilir/,
    );
  }
});

test('SCN-WEB-02d: siteCreateInputFromForm validates ownerMode (owner, customer, new_admin) and siteAdmin email/password rules', () => {
  const domain = { primaryDomain: 'owned.webrich.news', parentDomainId: null };

  // 1. Invalid ownerMode
  assert.throws(
    () => siteCreateInputFromForm({
      form: makeWizardForm({ ownerMode: 'reseller_invalid' }),
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Site sahibini seçin/,
  );

  // 2. Customer mode without customerId
  assert.throws(
    () => siteCreateInputFromForm({
      form: makeWizardForm({ ownerMode: 'customer', customerId: '' }),
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Sitenin bağlı olacağı müşteriyi seçin/,
  );

  // 3. Customer mode with valid customerId
  const customerSite = siteCreateInputFromForm({
    form: makeWizardForm({ ownerMode: 'customer', customerId: 'cust-42' }),
    operationId: OPERATION_ID,
    serverId: SERVER_ID,
    domain,
  });
  assert.equal(Object.hasOwn(customerSite, 'siteAdmin'), false);

  // 4. new_admin mode with invalid email
  for (const badEmail of ['', '   ', 'not-an-email', 'admin@', '@webrich.news']) {
    assert.throws(
      () => siteCreateInputFromForm({
        form: makeWizardForm({
          ownerMode: 'new_admin',
          adminEmail: badEmail,
          adminPassword: 'StrongPassword123!',
        }),
        operationId: OPERATION_ID,
        serverId: SERVER_ID,
        domain,
      }),
      /Site yöneticisi için geçerli bir e-posta adresi girin/,
    );
  }

  // 5. new_admin mode with <12 char password
  for (const shortPass of ['', '12345678901', 'short']) {
    assert.throws(
      () => siteCreateInputFromForm({
        form: makeWizardForm({
          ownerMode: 'new_admin',
          adminEmail: 'Admin@WebRich.News',
          adminPassword: shortPass,
        }),
        operationId: OPERATION_ID,
        serverId: SERVER_ID,
        domain,
      }),
      /Site yöneticisi parolası en az 12 karakter olmalıdır/,
    );
  }

  // 6. new_admin mode with valid email and >=12 char password
  const adminSite = siteCreateInputFromForm({
    form: makeWizardForm({
      ownerMode: 'new_admin',
      adminEmail: '  Admin.User@WebRich.News ',
      adminPassword: '12CharSecret',
    }),
    operationId: OPERATION_ID,
    serverId: SERVER_ID,
    domain,
  });
  assert.deepEqual(adminSite.siteAdmin, {
    email: 'admin.user@webrich.news',
    password: '12CharSecret',
  });

  // 7. wwwMode === 'independent' on root domain is rejected
  assert.throws(
    () => siteCreateInputFromForm({
      form: makeWizardForm({ wwwMode: 'independent' }),
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Bağımsız www, üst alan adı seçilmiş ayrı bir Website olarak oluşturulmalıdır/,
  );
});

test('SCN-WEB-03a: siteCreateInputFromForm rejects missing repositoryUrl, branch, entryFile, outputDir, and healthPath across Git-based JAMstack presets', () => {
  const domain = { primaryDomain: 'git.webrich.news', parentDomainId: null };

  for (const presetId of ['nextjs', 'astro', 'python_api']) {
    assert.throws(
      () => siteCreateInputFromForm({
        form: { ...applyFrameworkPresetToForm(makeWizardForm(), presetId), repositoryUrl: '   ' },
        operationId: OPERATION_ID,
        serverId: SERVER_ID,
        domain,
      }),
      /GitHub repository adresini girin/,
    );

    assert.throws(
      () => siteCreateInputFromForm({
        form: { ...applyFrameworkPresetToForm(makeWizardForm(), presetId), branch: '' },
        operationId: OPERATION_ID,
        serverId: SERVER_ID,
        domain,
      }),
      /Git branch bilgisini girin/,
    );
  }

  assert.throws(
    () => siteCreateInputFromForm({
      form: { ...applyFrameworkPresetToForm(makeWizardForm(), 'nextjs'), entryFile: '  ' },
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Node\.js başlangıç dosyasını girin/,
  );

  assert.throws(
    () => siteCreateInputFromForm({
      form: { ...applyFrameworkPresetToForm(makeWizardForm(), 'nextjs'), healthPath: '' },
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Sağlık kontrolü yolunu girin/,
  );

  assert.throws(
    () => siteCreateInputFromForm({
      form: { ...applyFrameworkPresetToForm(makeWizardForm(), 'astro'), outputDir: ' ' },
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Statik build çıktı klasörünü girin/,
  );

  assert.throws(
    () => siteCreateInputFromForm({
      form: { ...applyFrameworkPresetToForm(makeWizardForm(), 'python_api'), entryFile: '' },
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Python başlangıç dosyasını girin/,
  );

  assert.throws(
    () => siteCreateInputFromForm({
      form: { ...applyFrameworkPresetToForm(makeWizardForm(), 'python_api'), healthPath: '   ' },
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Sağlık kontrolü yolunu girin/,
  );
});

test('SCN-WEB-03b: siteCreateInputFromForm validates port boundaries and required identifiers for external_proxy, docker_compose, existing_managed_compose, and existing_docker', () => {
  const domain = { primaryDomain: 'proxy.webrich.news', parentDomainId: null };

  // external_proxy valid boundaries (1024..65535)
  for (const validPort of ['1024', '3000', '65535']) {
    const res = siteCreateInputFromForm({
      form: makeWizardForm({ sourceMode: 'external_proxy', targetValue: validPort }),
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    });
    assert.deepEqual(res.source, {
      kind: 'external_proxy',
      target: { host: '127.0.0.1', port: Number(validPort), websocket: true },
    });
  }

  // external_proxy invalid ports
  for (const invalidPort of ['0', '80', '1023', '65536', '70000', 'NaN', '']) {
    assert.throws(
      () => siteCreateInputFromForm({
        form: makeWizardForm({ sourceMode: 'external_proxy', targetValue: invalidPort }),
        operationId: OPERATION_ID,
        serverId: SERVER_ID,
        domain,
      }),
      /Yerel proxy portu 1024–65535 aralığında olmalıdır/,
    );
  }

  // docker_compose invalid targetPort (1..65535)
  for (const invalidTargetPort of ['0', '-5', '65536', '70000', 'abc']) {
    assert.throws(
      () => siteCreateInputFromForm({
        form: makeWizardForm({
          sourceMode: 'docker_compose',
          dockerTargetPort: invalidTargetPort,
        }),
        operationId: OPERATION_ID,
        serverId: SERVER_ID,
        domain,
      }),
      /Docker container iç portu \(targetPort\) 1–65535 aralığında olmalıdır/,
    );
  }

  // existing_managed_compose missing projectId / serviceName / invalid port
  assert.throws(
    () => siteCreateInputFromForm({
      form: makeWizardForm({
        sourceMode: 'existing_managed_compose',
        dockerProjectId: '  ',
        dockerServiceName: 'web',
        dockerTargetPort: '8080',
      }),
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Docker Compose projesini seçin/,
  );

  assert.throws(
    () => siteCreateInputFromForm({
      form: makeWizardForm({
        sourceMode: 'existing_managed_compose',
        dockerProjectId: 'proj-1',
        dockerServiceName: '',
        dockerTargetPort: '8080',
      }),
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Docker Compose servisini girin/,
  );

  // existing_docker missing workloadId
  assert.throws(
    () => siteCreateInputFromForm({
      form: makeWizardForm({
        sourceMode: 'existing_docker',
        dockerWorkloadId: '   ',
      }),
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Docker iş yükü kimliğini girin/,
  );

  // Unknown sourceMode
  assert.throws(
    () => siteCreateInputFromForm({
      form: makeWizardForm({ sourceMode: 'unknown_runtime_mode' }),
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain,
    }),
    /Website yayın kaynağı geçersiz/,
  );
});

test('SCN-WEB-03c: availableExistingApplications filters unbound applications by serverId and sourceMode', () => {
  assert.equal(existingApplicationType('existing_node'), 'node');
  assert.equal(existingApplicationType('existing_static'), 'static');
  assert.equal(existingApplicationType('new_node'), null);

  const applications = [
    { id: 'app-node-free', serverId: SERVER_ID, type: 'node' },
    { id: 'app-node-bound', serverId: SERVER_ID, type: 'node' },
    { id: 'app-node-other-srv', serverId: 'other-server', type: 'node' },
    { id: 'app-static-free', serverId: SERVER_ID, type: 'static' },
  ];
  const websites = [{ id: 'site-1', serverId: SERVER_ID, applicationId: 'app-node-bound' }];

  const freeNodeApps = availableExistingApplications({
    applications,
    websites,
    serverId: SERVER_ID,
    sourceMode: 'existing_node',
  });
  assert.deepEqual(freeNodeApps.map((a) => a.id), ['app-node-free']);

  const freeStaticApps = availableExistingApplications({
    applications,
    websites,
    serverId: SERVER_ID,
    sourceMode: 'existing_static',
  });
  assert.deepEqual(freeStaticApps.map((a) => a.id), ['app-static-free']);

  assert.deepEqual(
    availableExistingApplications({ applications, websites, serverId: '', sourceMode: 'existing_node' }),
    [],
  );

  // Passing wrong application type to siteCreateInputFromForm must throw
  assert.throws(
    () => siteCreateInputFromForm({
      form: makeWizardForm({ sourceMode: 'existing_node' }),
      operationId: OPERATION_ID,
      serverId: SERVER_ID,
      domain: { primaryDomain: 'webrich.news', parentDomainId: null },
      selectedApplication: { id: 'app-static-free', serverId: SERVER_ID, type: 'static' },
    }),
    /Bu Website için kullanılmamış uygun uygulamayı seçin/,
  );
});

test('SCN-WEB-03d: sharedWebsiteTarget, availableSharedWebsites, sharedWebsiteConfirmation, and sharedDomainCreateInput across static, php, node (Passenger), and docker/proxy websites', () => {
  const applications = [
    { id: 'app-static', serverId: SERVER_ID, type: 'static', webRoot: '/var/www/static-site' },
    { id: 'app-php', serverId: SERVER_ID, type: 'php' },
    { id: 'app-node-passenger', serverId: SERVER_ID, type: 'node', runtimeAdapter: 'passenger' },
    { id: 'app-node-systemd', serverId: SERVER_ID, type: 'node', runtimeAdapter: 'systemd' },
  ];

  const staticSite = {
    id: 'site-static',
    serverId: SERVER_ID,
    runtimeType: 'static',
    applicationId: 'app-static',
    documentRoot: '/var/www/static-site',
  };
  const phpSite = {
    id: 'site-php',
    serverId: SERVER_ID,
    runtimeType: 'php',
    applicationId: 'app-php',
  };
  const passengerSite = {
    id: 'site-passenger',
    serverId: SERVER_ID,
    runtimeType: 'node',
    applicationId: 'app-node-passenger',
  };
  const systemdNodeSite = {
    id: 'site-systemd',
    serverId: SERVER_ID,
    runtimeType: 'node',
    applicationId: 'app-node-systemd',
  };
  const dockerSite = {
    id: 'site-docker',
    serverId: SERVER_ID,
    runtimeType: 'docker',
    proxyTarget: { host: '127.0.0.1', port: 18080, websocket: true },
  };

  assert.deepEqual(sharedWebsiteTarget(staticSite, applications), {
    targetType: 'static',
    target: { root: '/var/www/static-site', spaFallback: true },
  });
  assert.deepEqual(sharedWebsiteTarget(phpSite, applications), {
    targetType: 'php',
    target: { applicationId: 'app-php' },
  });
  assert.deepEqual(sharedWebsiteTarget(passengerSite, applications), {
    targetType: 'passenger',
    target: { applicationId: 'app-node-passenger' },
  });
  assert.equal(sharedWebsiteTarget(systemdNodeSite, applications), null);
  assert.deepEqual(sharedWebsiteTarget(dockerSite, applications), {
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 18080, websocket: true },
  });

  const shareable = availableSharedWebsites({
    websites: [staticSite, phpSite, passengerSite, systemdNodeSite, dockerSite],
    applications,
    serverId: SERVER_ID,
  });
  assert.deepEqual(
    shareable.map((w) => w.id),
    ['site-static', 'site-php', 'site-passenger', 'site-docker'],
  );

  assert.equal(
    sharedWebsiteConfirmation('alias.webrich.news', 'site-docker'),
    'share-site:alias.webrich.news:site-docker',
  );

  // Root domain sharedDomainCreateInput with wwwMode='alias'
  const sharedRoot = sharedDomainCreateInput({
    domain: {
      serverId: SERVER_ID,
      primaryDomain: 'brand.webrich.news',
      parentDomainId: null,
      httpsMode: 'managed',
    },
    website: dockerSite,
    applications,
    wwwMode: 'alias',
  });
  assert.deepEqual(sharedRoot, {
    serverId: SERVER_ID,
    websiteId: 'site-docker',
    primaryDomain: 'brand.webrich.news',
    parentDomainId: null,
    aliases: ['www.brand.webrich.news'],
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 18080, websocket: true },
    httpsMode: 'managed',
  });

  // Reject www. primaryDomain when wwwMode='alias'
  assert.throws(
    () => sharedDomainCreateInput({
      domain: {
        serverId: SERVER_ID,
        primaryDomain: 'www.webrich.news',
        parentDomainId: null,
        httpsMode: 'managed',
      },
      website: dockerSite,
      applications,
      wwwMode: 'alias',
    }),
    /www ile başlayan alan adı için ayrıca www alias oluşturulamaz/,
  );

  // Reject cross-server sharing
  assert.throws(
    () => sharedDomainCreateInput({
      domain: {
        serverId: 'different-server',
        primaryDomain: 'brand.webrich.news',
        parentDomainId: null,
        httpsMode: 'managed',
      },
      website: dockerSite,
      applications,
    }),
    /aynı yerel sunucuda olmalıdır/,
  );
});

test('SCN-WEB-03e: createSiteSubmission orchestrates preview -> create -> provisioning progression and handles customerId and provisioning errors', async () => {
  const states = [];
  const nextjsForm = applyFrameworkPresetToForm(makeWizardForm({ ownerMode: 'customer', customerId: 'cust_1' }), 'nextjs');
  const siteInput = siteCreateInputFromForm({
    form: nextjsForm,
    operationId: OPERATION_ID,
    serverId: SERVER_ID,
    domain: { primaryDomain: 'jamstack.webrich.news', parentDomainId: null },
  });

  const submission = createSiteSubmission({
    onState: (s) => states.push(s),
    request: async (path, options) => {
      if (path === '/sites/hosted/create-preview') {
        assert.equal(options.body.customerId, 'cust_1');
        return {
          operationId: OPERATION_ID,
          customerId: 'cust_1',
          ids: { websiteId: WEBSITE_ID, primaryDomainId: DOMAIN_ID },
          hostname: { primaryDomain: 'jamstack.webrich.news' },
          previewDigest: DIGEST_A,
          confirmation: `create-hosted-site:${OPERATION_ID}:${DIGEST_A}`,
          provisioning: {
            operationId: PROVISIONING_ID,
            websiteId: WEBSITE_ID,
            ready: false,
            steps: [
              { id: 'unix_user', state: 'pending', required: true },
              { id: 'nginx_vhost', state: 'pending', required: true },
            ],
          },
        };
      }
      if (path === '/sites/hosted') {
        return {
          operationId: OPERATION_ID,
          website: { id: WEBSITE_ID, serverId: SERVER_ID },
          primaryDomain: {
            id: DOMAIN_ID,
            websiteId: WEBSITE_ID,
            serverId: SERVER_ID,
            primaryDomain: 'jamstack.webrich.news',
            parentDomainId: null,
          },
          ownership: {
            customerId: 'cust_1',
            websiteId: WEBSITE_ID,
            state: 'attached',
          },
          accessGranted: true,
          provisioning: {
            operationId: PROVISIONING_ID,
            websiteId: WEBSITE_ID,
            ready: false,
            steps: [
              { id: 'unix_user', state: 'succeeded', required: true },
              { id: 'nginx_vhost', state: 'applying', required: true },
            ],
          },
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
    advance: async (provId, { onStep }) => {
      assert.equal(provId, PROVISIONING_ID);
      onStep({
        operationId: PROVISIONING_ID,
        operation: {
          operationId: PROVISIONING_ID,
          websiteId: WEBSITE_ID,
          ready: true,
          steps: [
            { id: 'unix_user', state: 'succeeded', required: true },
            { id: 'nginx_vhost', state: 'succeeded', required: true },
          ],
        },
      });
      return {
        operationId: PROVISIONING_ID,
        websiteId: WEBSITE_ID,
        ready: true,
        steps: [
          { id: 'unix_user', state: 'succeeded', required: true },
          { id: 'nginx_vhost', state: 'succeeded', required: true },
        ],
      };
    },
  });

  assert.equal(submission.getState(), EMPTY_SITE_SUBMISSION);
  const finalState = await submission.submit(siteInput, { customerId: 'cust_1' });
  assert.equal(finalState.phase, 'ready');
  assert.equal(finalState.error, null);
  assert.deepEqual(finalState.created, {
    id: DOMAIN_ID,
    websiteId: WEBSITE_ID,
    primaryDomain: 'jamstack.webrich.news',
  });
  assert.equal(siteSubmissionBusy({ phase: 'previewing' }), true);
  assert.equal(siteSubmissionBusy(finalState), false);
  assert.deepEqual(
    states.map((s) => s.phase),
    ['previewing', 'creating', 'recorded', 'provisioning', 'provisioning', 'ready'],
  );
});

// ============================================================================
// SCN-WEB-04: Git Push Webhook & CI/CD Summary Calculation
// ============================================================================

test('SCN-WEB-04a: buildGitWebhookCiCdSummary computes accurate webhook URL, branchRef, outputDir, startEntry, healthPath, and activeRelease across Node, Python, and Static Git apps', () => {
  // 1. Next.js / Node SSR app with entryFile
  const nextSummary = buildGitWebhookCiCdSummary(
    {
      type: 'node',
      branch: 'main',
      outputDir: '.next',
      currentReleaseId: 'rel-next-01',
      runtime: { startMode: 'node', entryFile: 'server.js', healthPath: '/api/health' },
    },
    { primaryDomain: 'next.webrich.news' },
  );
  assert.deepEqual(nextSummary, {
    webhookEndpoint: 'https://next.webrich.news/api/webhooks/github',
    branchRef: 'refs/heads/main',
    contentType: 'application/json',
    outputDir: '.next',
    startEntry: 'server.js',
    healthPath: '/api/health',
    activeRelease: 'rel-next-01',
  });

  // 2. Node app with startMode: 'npm'
  const npmNodeSummary = buildGitWebhookCiCdSummary(
    {
      type: 'node',
      branch: 'production',
      runtime: { startMode: 'npm', startScript: 'start:prod', healthPath: '/ready' },
      currentReleaseId: 'rel-npm-02',
    },
    { primaryDomain: 'api.webrich.news' },
  );
  assert.equal(npmNodeSummary.branchRef, 'refs/heads/production');
  assert.equal(npmNodeSummary.outputDir, '.next');
  assert.equal(npmNodeSummary.startEntry, 'npm run start:prod');
  assert.equal(npmNodeSummary.healthPath, '/ready');

  // 3. Python FastAPI app
  const pythonSummary = buildGitWebhookCiCdSummary(
    {
      type: 'python',
      branch: 'release/v2',
      outputDir: 'static',
      runtime: { entryFile: 'app.py', healthPath: '/health' },
      currentReleaseId: 'rel-py-03',
    },
    { primaryDomain: 'ai.webrich.news' },
  );
  assert.equal(pythonSummary.webhookEndpoint, 'https://ai.webrich.news/api/webhooks/github');
  assert.equal(pythonSummary.branchRef, 'refs/heads/release/v2');
  assert.equal(pythonSummary.outputDir, 'static');
  assert.equal(pythonSummary.startEntry, 'app.py');
  assert.equal(pythonSummary.healthPath, '/health');
  assert.equal(pythonSummary.activeRelease, 'rel-py-03');

  // 4. Astro / Vite Static Git app
  const staticSummary = buildGitWebhookCiCdSummary(
    {
      type: 'static',
      branch: 'main',
      build: { outputDir: 'dist', buildScript: 'build', healthFile: 'index.html' },
    },
    { primaryDomain: 'static.webrich.news' },
  );
  assert.equal(staticSummary.outputDir, 'dist');
  assert.equal(staticSummary.startEntry, 'npm run build');
  assert.equal(staticSummary.healthPath, 'index.html');
  assert.equal(staticSummary.activeRelease, 'Henüz yayınlanmadı');
});

test('SCN-WEB-04b: buildGitWebhookCiCdSummary handles empty/default application and domain fallbacks safely without throwing', () => {
  const fallbackSummary = buildGitWebhookCiCdSummary({}, {});
  assert.deepEqual(fallbackSummary, {
    webhookEndpoint: 'https://localhost/api/webhooks/github',
    branchRef: 'refs/heads/main',
    contentType: 'application/json',
    outputDir: 'dist',
    startEntry: 'index.html',
    healthPath: '/',
    activeRelease: 'Henüz yayınlanmadı',
  });
});

// ============================================================================
// SCN-WEB-05: Nginx Header Presets, Static Cache Presets & NginxSettingsFields
// ============================================================================

test('SCN-WEB-05a: applyNginxHeaderPreset cleans empty or whitespace-only draft rows before applying CORS, Security, Immutable Cache, and No-Cache presets', () => {
  const withEmptyDraftRows = [
    { name: '', value: '', always: true },
    { name: '   ', value: '   ', always: false },
    { name: 'X-App-Version', value: '2.5.0', always: true },
    { name: '', value: '' },
  ];

  const afterCors = applyNginxHeaderPreset(withEmptyDraftRows, 'cors');
  assert.equal(afterCors.length, 4);
  assert.deepEqual(
    afterCors.map((h) => h.name),
    [
      'X-App-Version',
      'Access-Control-Allow-Origin',
      'Access-Control-Allow-Methods',
      'Access-Control-Allow-Headers',
    ],
  );
  assert.equal(afterCors.some((h) => h.name.trim() === ''), false);
});

test('SCN-WEB-05b: applyNginxHeaderPreset updates existing headers in-place (case-insensitively) when switching between Immutable Cache and No-Cache or re-applying presets', () => {
  // Start with CORS + Immutable Cache
  let headers = applyNginxHeaderPreset([], 'cors');
  headers = applyNginxHeaderPreset(headers, 'immutable_cache');
  assert.equal(headers.length, 4);
  assert.equal(
    headers.find((h) => h.name === 'Cache-Control')?.value,
    'public, max-age=31536000, immutable',
  );

  // Switch to No-Cache: must overwrite Cache-Control in-place at index 3, not duplicate
  headers = applyNginxHeaderPreset(headers, 'no_cache');
  assert.equal(headers.length, 4);
  assert.equal(
    headers.filter((h) => h.name.toLowerCase() === 'cache-control').length,
    1,
  );
  assert.equal(
    headers.find((h) => h.name === 'Cache-Control')?.value,
    'no-store, no-cache, must-revalidate',
  );

  // Existing lowercase custom header is overwritten in-place by preset
  const customLower = [
    { name: 'access-control-allow-origin', value: 'https://webrich.news', always: false },
    { name: 'x-frame-options', value: 'DENY', always: false },
  ];
  const mergedCors = applyNginxHeaderPreset(customLower, 'cors');
  assert.equal(mergedCors.length, 4);
  assert.deepEqual(mergedCors[0], {
    name: 'Access-Control-Allow-Origin',
    value: '*',
    always: true,
  });

  const mergedSec = applyNginxHeaderPreset(mergedCors, 'security');
  assert.equal(mergedSec.length, 7);
  assert.deepEqual(mergedSec[1], {
    name: 'X-Frame-Options',
    value: 'SAMEORIGIN',
    always: true,
  });
});

test('SCN-WEB-05c: applyNginxHeaderPreset strictly enforces the 12-header maximum boundary across chained presets and oversized inputs', () => {
  const tenCustom = Array.from({ length: 10 }, (_, idx) => ({
    name: `X-Custom-${idx + 1}`,
    value: `v-${idx + 1}`,
    always: true,
  }));

  // Adding 4 security headers to 10 custom headers caps at 12
  const cappedAt12 = applyNginxHeaderPreset(tenCustom, 'security');
  assert.equal(cappedAt12.length, 12);
  assert.equal(cappedAt12[10].name, 'X-Frame-Options');
  assert.equal(cappedAt12[11].name, 'X-Content-Type-Options');

  // Re-applying security when already at 12 still updates existing X-Frame-Options in-place without exceeding 12
  cappedAt12[10].value = 'DENY';
  const updatedAt12 = applyNginxHeaderPreset(cappedAt12, 'security');
  assert.equal(updatedAt12.length, 12);
  assert.equal(updatedAt12[10].value, 'SAMEORIGIN');

  // Passing 15 headers into applyNginxHeaderPreset slices to 12
  const fifteenCustom = Array.from({ length: 15 }, (_, idx) => ({
    name: `X-Extra-${idx + 1}`,
    value: `val-${idx + 1}`,
    always: true,
  }));
  const sliced = applyNginxHeaderPreset(fifteenCustom, 'unknown_preset');
  assert.equal(sliced.length, 12);
});

test('SCN-WEB-05d: NginxSettingsFields renders target-specific controls for static, php, proxy, python, and passenger targets and executes onChange callbacks', () => {
  // 1. Static target
  const staticHtml = renderToStaticMarkup(
    createElement(NginxSettingsFields, {
      targetType: 'static',
      domainNames: ['webrich.news', 'www.webrich.news'],
      disabled: false,
      onChange() {},
      settings: normalizeNginxSettings('static', {
        documentRoot: 'dist',
        preferredDomain: 'webrich.news',
        clientMaxBodySizeMb: 64,
        staticAssetCacheSeconds: 86400,
        indexFiles: ['index.html'],
        spaFallback: true,
        errorPages: { 404: '/errors/404.html' },
        headers: [],
      }),
    }),
  );
  assert.ok(staticHtml.includes('Document root'));
  assert.ok(staticHtml.includes('Statik dosya önbelleği (saniye)'));
  assert.ok(staticHtml.includes('Bulunamayan sayfalarda index.html kullan'));
  assert.ok(staticHtml.includes('Özel hata sayfaları'));
  assert.equal(staticHtml.includes('Uygulama yanıt süresi (saniye)'), false);
  for (const [label] of STATIC_CACHE_PRESETS) {
    assert.ok(staticHtml.includes(label), `Missing static cache preset button: ${label}`);
  }

  // 2. PHP target
  const phpHtml = renderToStaticMarkup(
    createElement(NginxSettingsFields, {
      targetType: 'php',
      domainNames: ['wp.webrich.news'],
      disabled: false,
      onChange() {},
      settings: normalizeNginxSettings('php', {
        documentRoot: 'public',
        indexFiles: ['index.php', 'index.html'],
        errorPages: { 500: '/500.html' },
      }),
    }),
  );
  assert.ok(phpHtml.includes('Document root'));
  assert.ok(phpHtml.includes('Başlangıç dosyaları'));
  assert.ok(phpHtml.includes('Özel hata sayfaları'));
  assert.equal(phpHtml.includes('Statik dosya önbelleği (saniye)'), false);
  assert.equal(phpHtml.includes('WebSocket bağlantılarına izin ver'), false);

  // 3. Proxy & Python targets
  for (const targetType of ['proxy', 'python']) {
    const html = renderToStaticMarkup(
      createElement(NginxSettingsFields, {
        targetType,
        domainNames: ['api.webrich.news'],
        disabled: false,
        onChange() {},
        settings: normalizeNginxSettings(targetType, {
          clientMaxBodySizeMb: 128,
          proxyTimeoutSeconds: 180,
          websocket: true,
        }),
      }),
    );
    assert.ok(html.includes('Uygulama yanıt süresi (saniye)'));
    assert.ok(html.includes('WebSocket bağlantılarına izin ver'));
    assert.equal(html.includes('Document root'), false);
    assert.equal(html.includes('Statik dosya önbelleği (saniye)'), false);
  }

  // 4. Passenger target
  const passengerHtml = renderToStaticMarkup(
    createElement(NginxSettingsFields, {
      targetType: 'passenger',
      domainNames: ['node.webrich.news'],
      disabled: false,
      onChange() {},
      settings: normalizeNginxSettings('passenger', { clientMaxBodySizeMb: 32 }),
    }),
  );
  assert.ok(passengerHtml.includes('En büyük yükleme boyutu (MB)'));
  assert.equal(passengerHtml.includes('Document root'), false);
  assert.equal(passengerHtml.includes('Uygulama yanıt süresi (saniye)'), false);
});

test('SCN-WEB-05e: normalizeNginxSettings and hostingSettingsChanges validate custom response headers and reject blocked, duplicate, malformed, or >12 headers', () => {
  const domain = makeDomainRecord({ targetType: 'static' });

  // Valid CORS + Security headers (7 headers total) pass hostingSettingsChanges
  const validHeaders = applyNginxHeaderPreset(applyNginxHeaderPreset([], 'cors'), 'security');
  assert.equal(validHeaders.length, 7);
  const draft = {
    ...hostingDraftValues(domain),
    nginxSettings: {
      ...hostingDraftValues(domain).nginxSettings,
      headers: validHeaders,
    },
  };
  const changes = hostingSettingsChanges(domain, draft);
  assert.equal(changes.nginxSettings.headers.length, 7);

  // Blocked protocol/panel headers must be rejected by normalizeNginxSettings
  for (const blockedName of ['Cache-Control', 'Set-Cookie', 'Server', 'Content-Length', 'Connection', 'Upgrade', 'Location']) {
    assert.throws(
      () => normalizeNginxSettings('static', {
        headers: [{ name: blockedName, value: 'test', always: true }],
      }),
      (err) => err instanceof NginxSettingsValidationError && err.code === 'blocked_nginx_header',
    );
  }

  // Case-insensitive duplicate header names must be rejected
  assert.throws(
    () => normalizeNginxSettings('static', {
      headers: [
        { name: 'X-Custom-Token', value: 'one', always: true },
        { name: 'x-custom-token', value: 'two', always: false },
      ],
    }),
    (err) => err instanceof NginxSettingsValidationError && err.code === 'duplicate_nginx_header',
  );

  // Invalid header names or unsafe characters in value ($, ", \, newline) must be rejected
  for (const badHeader of [
    { name: '123-Invalid', value: 'ok', always: true },
    { name: 'Bad Space', value: 'ok', always: true },
    { name: '', value: 'ok', always: true },
    { name: 'X-Inject', value: 'val\nInjected: 1', always: true },
    { name: 'X-Inject', value: 'val$http_host', always: true },
    { name: 'X-Inject', value: 'val"quote', always: true },
    { name: 'X-Inject', value: 'val\\slash', always: true },
    { name: 'X-Empty-Val', value: '', always: true },
  ]) {
    assert.throws(
      () => normalizeNginxSettings('static', { headers: [badHeader] }),
      (err) => err instanceof NginxSettingsValidationError && err.code === 'invalid_nginx_header',
    );
  }

  // 13 headers must be rejected
  const thirteenHeaders = Array.from({ length: 13 }, (_, i) => ({
    name: `X-Header-${i + 1}`,
    value: '1',
    always: true,
  }));
  assert.throws(
    () => normalizeNginxSettings('static', { headers: thirteenHeaders }),
    (err) => err instanceof NginxSettingsValidationError && err.code === 'invalid_nginx_headers',
  );
});

// ============================================================================
// SCN-WEB-06: Nginx Reverse Proxy & Sub-Path Location Block Builder
// ============================================================================

test('SCN-WEB-06a: buildNginxSubPathLocationBlock generates valid Nginx location blocks for all 7 JAMstack framework presets', () => {
  assert.equal(SUBPATH_FRAMEWORK_PRESETS.length, 7);

  for (const preset of SUBPATH_FRAMEWORK_PRESETS) {
    const block = buildNginxSubPathLocationBlock({
      path: preset.path,
      innerPort: preset.innerPort,
      outerPort: preset.outerPort,
      websocket: preset.websocket,
    });

    assert.ok(
      block.includes(`# Alt yol yönlendirmesi: ${preset.path} -> Konteyner :${preset.innerPort} (Host ${preset.outerPort})`),
    );
    assert.ok(block.includes(`location ${preset.path} {`));
    assert.ok(block.includes(`    proxy_pass http://${preset.outerPort};`));
    assert.ok(block.includes('    proxy_http_version 1.1;'));
    assert.ok(block.includes('    proxy_set_header Host $host;'));
    assert.ok(block.includes('    proxy_set_header X-Real-IP $remote_addr;'));

    if (preset.websocket) {
      assert.ok(block.includes('    proxy_set_header Upgrade $http_upgrade;'));
      assert.ok(block.includes('    proxy_set_header Connection "upgrade";'));
    } else {
      assert.equal(block.includes('Upgrade $http_upgrade'), false);
    }
  }
});

test('SCN-WEB-06b: buildNginxSubPathLocationBlock normalizes relative paths and bare outerPort numbers and renders NginxSubPathProxyBuilder', () => {
  const block = buildNginxSubPathLocationBlock({
    path: 'v1/graphql',
    innerPort: '4000',
    outerPort: '14000',
    websocket: false,
  });
  assert.ok(block.includes('location /v1/graphql {'));
  assert.ok(block.includes('proxy_pass http://127.0.0.1:14000;'));

  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(NginxSubPathProxyBuilder, {
        domain: { id: DOMAIN_ID, primaryDomain: 'webrich.news', target: { upstreamPort: 13500 } },
      }),
    ),
  );
  assert.ok(html.includes('proxy_pass http://127.0.0.1:13500;'));
  assert.ok(html.includes('href="/docker"'));
});

test('SCN-WEB-06c: buildNginxSubPathLocationBlock blocks Nginx config injection characters, path traversal, and malformed paths', () => {
  const maliciousPaths = [
    '',
    '   ',
    '/api; rm -rf /',
    '/api { return 200; }',
    '/api } location /pwn {',
    '/api\n    proxy_pass http://evil.com;',
    '/api\r\nlocation /evil',
    '../secret',
    '/api/../etc/passwd',
    '/api$request_uri',
    '/api"quote',
    "/api'single",
    '/api\\backslash',
    '/api with space',
  ];

  for (const badPath of maliciousPaths) {
    assert.throws(
      () => buildNginxSubPathLocationBlock({
        path: badPath,
        innerPort: '3000',
        outerPort: '127.0.0.1:13000',
        websocket: true,
      }),
      /Geçersiz Nginx alt yol \(location\) ifadesi/,
      `Expected path ${JSON.stringify(badPath)} to be rejected`,
    );
  }
});

test('SCN-WEB-06d: buildNginxSubPathLocationBlock rejects out-of-range or malformed innerPort and outerPort values', () => {
  for (const badInner of ['0', '-1', '-5', '65536', '70000', '99999', 'abc', '', '3000.5']) {
    assert.throws(
      () => buildNginxSubPathLocationBlock({
        path: '/api',
        innerPort: badInner,
        outerPort: '127.0.0.1:13000',
        websocket: true,
      }),
      /Inner \(Konteyner\) portu 1–65535 aralığında olmalıdır/,
      `Expected innerPort ${JSON.stringify(badInner)} to be rejected`,
    );
  }

  for (const badOuter of [
    '0',
    '-80',
    '65536',
    '99999',
    'abc',
    '127.0.0.1:0',
    '127.0.0.1:70000',
    '127.0.0.1:99999',
    '127.0.0.1:abc',
    '127.0.0.1:13000:extra',
    ':13000',
    'bad host!:13000',
    'http://127.0.0.1:13000',
  ]) {
    assert.throws(
      () => buildNginxSubPathLocationBlock({
        path: '/api',
        innerPort: '3000',
        outerPort: badOuter,
        websocket: true,
      }),
      /Outer \(Yerel Host\) adresi geçerli bir host:port \(1–65535\) olmalıdır/,
      `Expected outerPort ${JSON.stringify(badOuter)} to be rejected`,
    );
  }
});

// ============================================================================
// SCN-WEB-07: Full Nginx & Hosting Settings Lifecycle, Stale Reload & Client
// ============================================================================

test('SCN-WEB-07a: Full Nginx settings validation across static, php, proxy, python, and passenger targets', () => {
  // 1. All 4 static cache presets (3600, 86400, 2592000, 31536000) + 0 + null
  for (const [, seconds] of STATIC_CACHE_PRESETS) {
    const normalized = normalizeNginxSettings('static', { staticAssetCacheSeconds: seconds });
    assert.equal(normalized.staticAssetCacheSeconds, seconds);
  }
  assert.equal(normalizeNginxSettings('static', { staticAssetCacheSeconds: 0 }).staticAssetCacheSeconds, 0);
  assert.equal(normalizeNginxSettings('static', { staticAssetCacheSeconds: null }).staticAssetCacheSeconds, null);
  assert.throws(() => normalizeNginxSettings('static', { staticAssetCacheSeconds: -1 }));
  assert.throws(() => normalizeNginxSettings('static', { staticAssetCacheSeconds: 31_536_001 }));

  // 2. documentRoot validation
  assert.equal(normalizeNginxSettings('static', { documentRoot: 'apps/web/dist' }).documentRoot, 'apps/web/dist');
  assert.equal(normalizeNginxSettings('php', { documentRoot: null }).documentRoot, null);
  for (const badRoot of ['/abs/path', '../escape', 'a/../b', 'a//b', 'bad space']) {
    assert.throws(
      () => normalizeNginxSettings('static', { documentRoot: badRoot }),
      (err) => err instanceof NginxSettingsValidationError && err.code === 'invalid_nginx_document_root',
    );
  }

  // 3. indexFiles validation (including string splitting via hostingSettingsChanges)
  const phpDomain = makeDomainRecord({ targetType: 'php' });
  const phpChanges = hostingSettingsChanges(phpDomain, {
    ...hostingDraftValues(phpDomain),
    nginxSettings: {
      ...hostingDraftValues(phpDomain).nginxSettings,
      indexFiles: 'index.php, home.html default.htm',
    },
  });
  assert.deepEqual(phpChanges.nginxSettings.indexFiles, ['index.php', 'home.html', 'default.htm']);

  // Static target rejects .php index files and duplicate index files
  assert.throws(
    () => normalizeNginxSettings('static', { indexFiles: ['index.php'] }),
    (err) => err instanceof NginxSettingsValidationError && err.code === 'invalid_nginx_index_files',
  );
  assert.throws(
    () => normalizeNginxSettings('static', { indexFiles: ['index.html', 'index.html'] }),
    (err) => err instanceof NginxSettingsValidationError && err.code === 'invalid_nginx_index_files',
  );

  // 4. errorPages validation for all 6 supported status codes (403, 404, 500, 502, 503, 504)
  const validErrorPages = {
    403: '/errors/403.html',
    404: '/errors/404.html',
    500: '/errors/500.html',
    502: '/errors/502.html',
    503: '/errors/503.html',
    504: '/errors/504.htm',
  };
  const withErrors = normalizeNginxSettings('static', { errorPages: validErrorPages });
  assert.deepEqual(withErrors.errorPages, validErrorPages);

  // Error page conflicting with index file (/index.html) must be rejected
  assert.throws(
    () => normalizeNginxSettings('static', {
      indexFiles: ['index.html'],
      errorPages: { 404: '/index.html' },
    }),
    (err) => err instanceof NginxSettingsValidationError && err.code === 'nginx_error_page_index_conflict',
  );

  // 5. clientMaxBodySizeMb (1..1024) and proxyTimeoutSeconds (1..600) bounds
  assert.equal(normalizeNginxSettings('proxy', { clientMaxBodySizeMb: 1, proxyTimeoutSeconds: 1 }).clientMaxBodySizeMb, 1);
  assert.equal(normalizeNginxSettings('proxy', { clientMaxBodySizeMb: 1024, proxyTimeoutSeconds: 600 }).proxyTimeoutSeconds, 600);
  assert.throws(() => normalizeNginxSettings('proxy', { clientMaxBodySizeMb: 0 }));
  assert.throws(() => normalizeNginxSettings('proxy', { clientMaxBodySizeMb: 1025 }));
  assert.throws(() => normalizeNginxSettings('proxy', { proxyTimeoutSeconds: 0 }));
  assert.throws(() => normalizeNginxSettings('proxy', { proxyTimeoutSeconds: 601 }));
});

test('SCN-WEB-07b: createHostingForm, editHostingForm, hostingFormDirty, hostingSettingsDiff, hostingSettingsWarnings, and redirect/preferredDomain rules', () => {
  const domain = makeDomainRecord({
    targetType: 'static',
    httpsMode: 'managed',
    certificateId: null,
    aliases: ['www.webrich.news'],
  });

  let form = createHostingForm(domain);
  assert.equal(hostingFormDirty(form), false);
  assert.deepEqual(hostingSettingsFromDomain(domain), form.values);

  // Editing httpsRedirect and nginxSettings marks form dirty
  form = editHostingForm(form, 'httpsRedirect', true);
  form = editHostingForm(form, 'nginxSettings', {
    ...form.values.nginxSettings,
    preferredDomain: 'www.webrich.news',
    staticAssetCacheSeconds: 3600,
  });
  assert.equal(hostingFormDirty(form), true);

  // Diff and warnings (certificateId is null while httpsRedirect is true)
  const diff = hostingSettingsDiff(domain, form.values);
  assert.deepEqual(diff.map((d) => d.key), ['httpsRedirect', 'nginxSettings']);
  const warnings = hostingSettingsWarnings(domain, form.values);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SSL sertifikası bağlı değil/);

  // Invalid editHostingForm calls throw hosting_draft_invalid
  assert.throws(
    () => editHostingForm(form, 'unknownField', true),
    (err) => err instanceof DomainAliasError && err.code === 'hosting_draft_invalid',
  );
  assert.throws(
    () => editHostingForm(form, 'httpsRedirect', 'yes'),
    (err) => err instanceof DomainAliasError && err.code === 'hosting_draft_invalid',
  );

  // httpsRedirect: true when httpsMode === 'off' throws invalid_redirect_policy
  const httpOnlyDomain = makeDomainRecord({ httpsMode: 'off', httpsRedirect: false });
  assert.throws(
    () => hostingSettingsChanges(httpOnlyDomain, {
      ...hostingDraftValues(httpOnlyDomain),
      httpsRedirect: true,
    }),
    (err) => err instanceof DomainAliasError && err.code === 'invalid_redirect_policy',
  );

  // preferredDomain not in [primaryDomain, ...aliases] throws hosting_draft_invalid
  assert.throws(
    () => hostingSettingsChanges(domain, {
      ...hostingDraftValues(domain),
      nginxSettings: {
        ...hostingDraftValues(domain).nginxSettings,
        preferredDomain: 'unattached.webrich.news',
      },
    }),
    (err) => err instanceof DomainAliasError && err.code === 'hosting_draft_invalid',
  );
});

test('SCN-WEB-07c: Concurrent operator edits — desiredRevision bump triggers hostingFormStale and reloadHostingForm preserves only dirty fields while adopting new base values', () => {
  const initialDomain = makeDomainRecord({
    targetType: 'static',
    desiredRevision: 1,
    canonicalRedirect: false,
    nginxSettings: {
      documentRoot: 'public',
      clientMaxBodySizeMb: 64,
      staticAssetCacheSeconds: 86400,
      spaFallback: true,
      headers: [],
    },
  });

  // Operator A opens the form and modifies ONLY staticAssetCacheSeconds and headers (CORS)
  let formA = createHostingForm(initialDomain);
  formA = editHostingForm(formA, 'nginxSettings', {
    ...formA.values.nginxSettings,
    staticAssetCacheSeconds: 31536000,
    headers: applyNginxHeaderPreset([], 'cors'),
  });
  assert.equal(hostingFormDirty(formA), true);
  assert.equal(hostingFormStale(formA, initialDomain), false);

  // Background publication status update with identical routing fingerprint is adopted by refreshHostingForm
  const refreshedForm = refreshHostingForm(formA, { ...initialDomain, appliedRevision: 1 });
  assert.equal(refreshedForm.base.desiredRevision, 1);

  // Operator B saves revision 2: changes canonicalRedirect -> true, documentRoot -> 'dist', clientMaxBodySizeMb -> 256
  const concurrentDomainRev2 = makeDomainRecord({
    targetType: 'static',
    desiredRevision: 2,
    canonicalRedirect: true,
    nginxSettings: {
      documentRoot: 'dist',
      clientMaxBodySizeMb: 256,
      staticAssetCacheSeconds: 86400,
      spaFallback: false,
      headers: [],
    },
  });

  // Form A immediately detects stale state
  assert.equal(hostingFormStale(formA, concurrentDomainRev2), true);

  // Reloading Form A preserves Operator A's dirty fields (staticAssetCacheSeconds, headers)
  // while adopting Operator B's changes (canonicalRedirect, documentRoot, clientMaxBodySizeMb, spaFallback)
  const reloaded = reloadHostingForm(formA, concurrentDomainRev2, concurrentDomainRev2);
  assert.equal(reloaded.base.desiredRevision, 2);
  assert.equal(reloaded.values.canonicalRedirect, true);
  assert.equal(reloaded.values.nginxSettings.documentRoot, 'dist');
  assert.equal(reloaded.values.nginxSettings.clientMaxBodySizeMb, 256);
  assert.equal(reloaded.values.nginxSettings.spaFallback, false);
  assert.equal(reloaded.values.nginxSettings.staticAssetCacheSeconds, 31536000);
  assert.equal(reloaded.values.nginxSettings.headers.length, 3);
  assert.equal(hostingFormStale(reloaded, concurrentDomainRev2), false);
  assert.equal(hostingFormDirty(reloaded), true);

  // Reloading with an older revision than expected or changed websiteId must throw
  assert.throws(
    () => reloadHostingForm(reloaded, initialDomain, concurrentDomainRev2),
    (err) => err instanceof DomainAliasError && err.code === 'hosting_reload_stale',
  );
  assert.throws(
    () => reloadHostingForm(reloaded, { ...concurrentDomainRev2, websiteId: 'other-website' }, concurrentDomainRev2),
    (err) => err instanceof DomainAliasError && err.code === 'hosting_target_changed',
  );
});

test('SCN-WEB-07d: hostingWriteBlock blocks saving under unauthorized role, suspended domain, busy resource, unready collections, or stale revision', () => {
  const domain = makeDomainRecord({ desiredRevision: 1 });
  const form = createHostingForm(domain);
  const readyCtx = {
    form,
    domain,
    canManage: true,
    domainsStatus: 'ready',
    jobsStatus: 'ready',
    resourceBusy: false,
    reloadRequired: false,
  };

  assert.equal(hostingWriteBlock(readyCtx), null);

  assert.equal(
    hostingWriteBlock({ ...readyCtx, canManage: false }),
    'Bu hesap barındırma ayarlarını değiştiremez.',
  );
  assert.equal(
    hostingWriteBlock({ ...readyCtx, form: null }),
    'Alan adı kaydı doğrulanamadı. Güncel kaydı yükleyin.',
  );
  assert.equal(
    hostingWriteBlock({ ...readyCtx, domainsStatus: 'loading' }),
    'Alan adı ve işlem bilgileri güncel olmadan kaydedilemez.',
  );
  assert.equal(
    hostingWriteBlock({ ...readyCtx, jobsStatus: 'error' }),
    'Alan adı ve işlem bilgileri güncel olmadan kaydedilemez.',
  );
  assert.equal(
    hostingWriteBlock({ ...readyCtx, domain: { ...domain, state: 'suspended' } }),
    'Askıdaki alan adının ayarları değiştirilemez.',
  );
  assert.equal(
    hostingWriteBlock({ ...readyCtx, reloadRequired: true }),
    'Güncel kaydı yükleyip değişiklikleri yeniden inceleyin. Taslağınız korunur.',
  );
  assert.equal(
    hostingWriteBlock({ ...readyCtx, domain: { ...domain, desiredRevision: 2, httpsRedirect: true } }),
    'Güncel kaydı yükleyip değişiklikleri yeniden inceleyin. Taslağınız korunur.',
  );
  assert.equal(
    hostingWriteBlock({ ...readyCtx, resourceBusy: true }),
    'Bu alan adı için çalışan işlem var. İşlem tamamlandıktan sonra yeniden inceleyin.',
  );
});

test('SCN-WEB-07e: createDomainHostingClient end-to-end async lifecycle — preview, hostingReviewMatches, save, and stage/activate job publication', async () => {
  let serverDomain = makeDomainRecord({
    targetType: 'proxy',
    desiredRevision: 1,
    stagedRevision: 1,
    appliedRevision: 1,
    httpsRedirect: false,
    nginxSettings: {
      clientMaxBodySizeMb: 32,
      proxyTimeoutSeconds: 60,
      websocket: false,
      headers: [],
    },
  });

  const progressEvents = [];
  const observedJobs = [];
  let savedCallbackDomain = null;

  const client = createDomainHostingClient({
    isCurrent: () => true,
    onProgress: (ev) => progressEvents.push(ev),
    observe: (job) => observedJobs.push(job),
    onSaved: (dom) => { savedCallbackDomain = dom; },
    waitForJob: async (jobId) => ({
      id: jobId,
      serverId: SERVER_ID,
      resourceType: 'domain',
      resourceId: DOMAIN_ID,
      status: 'succeeded',
    }),
    request: async (path, options = {}) => {
      if (path === `/domains/${DOMAIN_ID}` && !options.method) {
        return structuredClone(serverDomain);
      }
      if (path === `/domains/${DOMAIN_ID}/update-preview` && options.method === 'POST') {
        const { changes } = options.body;
        const next = hostingExpectedDomain(serverDomain, changes, serverDomain.desiredRevision + 1);
        return {
          version: 1,
          domainId: DOMAIN_ID,
          currentRevision: serverDomain.desiredRevision,
          nextRevision: serverDomain.desiredRevision + 1,
          previewDigest: DIGEST_B,
          confirmation: `update-domain:${DOMAIN_ID}:${DIGEST_B}`,
          next: {
            primaryDomain: next.primaryDomain,
            aliases: next.aliases,
            httpsMode: next.httpsMode,
            httpsRedirect: next.httpsRedirect,
            canonicalRedirect: next.canonicalRedirect,
            nginxSettings: next.nginxSettings,
          },
          impact: {
            hostnameChanged: false,
            policyChanged: Object.hasOwn(changes, 'httpsRedirect') || Object.hasOwn(changes, 'canonicalRedirect'),
            settingsChanged: Object.hasOwn(changes, 'nginxSettings'),
            requiresStageAndActivation: true,
            certificate: { id: serverDomain.certificateId, detached: false },
          },
        };
      }
      if (path === `/domains/${DOMAIN_ID}` && options.method === 'PATCH') {
        const { changes, previewDigest } = options.body;
        serverDomain = {
          ...hostingExpectedDomain(serverDomain, changes, serverDomain.desiredRevision + 1),
          state: 'staged',
        };
        return {
          previewDigest,
          domain: structuredClone(serverDomain),
          impact: { certificate: { id: serverDomain.certificateId, detached: false } },
        };
      }
      if (path === `/domains/${DOMAIN_ID}/stage` && options.method === 'POST') {
        serverDomain = {
          ...serverDomain,
          stagedRevision: serverDomain.desiredRevision,
          stagedChecksum: DIGEST_B,
        };
        return {
          id: 'job-stage-1',
          serverId: SERVER_ID,
          resourceType: 'domain',
          resourceId: DOMAIN_ID,
          status: 'running',
        };
      }
      if (path === `/domains/${DOMAIN_ID}/activate` && options.method === 'POST') {
        serverDomain = {
          ...serverDomain,
          appliedRevision: serverDomain.desiredRevision,
          state: 'active',
        };
        return {
          id: 'job-activate-1',
          serverId: SERVER_ID,
          resourceType: 'domain',
          resourceId: DOMAIN_ID,
          status: 'running',
        };
      }
      throw new Error(`Unhandled request: ${options.method ?? 'GET'} ${path}`);
    },
  });

  let form = createHostingForm(serverDomain);
  form = editHostingForm(form, 'httpsRedirect', true);
  form = editHostingForm(form, 'nginxSettings', {
    ...form.values.nginxSettings,
    clientMaxBodySizeMb: 256,
    proxyTimeoutSeconds: 180,
    websocket: true,
    headers: applyNginxHeaderPreset([], 'cors'),
  });

  const plan = await client.preview(form.base, form.values);
  assert.equal(hostingReviewMatches(form, plan), true);
  assert.equal(plan.nextRevision, 2);
  assert.equal(plan.rows.length, 2);

  // If user edits form after preview, hostingReviewMatches becomes false
  const modifiedAfterPreview = editHostingForm(form, 'canonicalRedirect', true);
  assert.equal(hostingReviewMatches(modifiedAfterPreview, plan), false);

  // Save and apply (stage + activate)
  const applied = await client.save(plan, { apply: true });
  assert.equal(applied.alreadyApplied, false);
  assert.equal(applied.domain.desiredRevision, 2);
  assert.equal(applied.domain.appliedRevision, 2);
  assert.equal(applied.domain.state, 'active');
  assert.equal(applied.domain.httpsRedirect, true);
  assert.equal(applied.domain.target.websocket, true);
  assert.equal(applied.domain.nginxSettings.clientMaxBodySizeMb, 256);
  assert.equal(applied.domain.nginxSettings.headers.length, 3);
  assert.ok(savedCallbackDomain);
  assert.deepEqual(
    progressEvents.map((p) => p.phase),
    ['stage', 'stage', 'activate', 'activate', 'applied'],
  );
  assert.equal(observedJobs.length, 4);
});

test('SCN-WEB-07f: createDomainHostingClient rejects reused plans, concurrent exclusive calls, context changes, and tampered preview responses', async () => {
  const domain = makeDomainRecord({ targetType: 'static' });
  let active = true;

  const client = createDomainHostingClient({
    isCurrent: () => active,
    request: async (path, options = {}) => {
      if (path === `/domains/${DOMAIN_ID}` && !options.method) return structuredClone(domain);
      if (path === `/domains/${DOMAIN_ID}/update-preview`) {
        const { changes } = options.body;
        const next = hostingExpectedDomain(domain, changes, domain.desiredRevision + 1);
        return {
          version: 1,
          domainId: DOMAIN_ID,
          currentRevision: domain.desiredRevision,
          nextRevision: domain.desiredRevision + 1,
          previewDigest: DIGEST_A,
          confirmation: `update-domain:${DOMAIN_ID}:${DIGEST_A}`,
          next: {
            primaryDomain: next.primaryDomain,
            aliases: next.aliases,
            httpsMode: next.httpsMode,
            httpsRedirect: next.httpsRedirect,
            canonicalRedirect: next.canonicalRedirect,
            nginxSettings: next.nginxSettings,
          },
          impact: {
            hostnameChanged: false,
            policyChanged: true,
            settingsChanged: false,
            requiresStageAndActivation: true,
            certificate: { id: domain.certificateId, detached: false },
          },
        };
      }
      if (path === `/domains/${DOMAIN_ID}` && options.method === 'PATCH') {
        throw new Error('simulated network drop');
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  });

  const form = editHostingForm(createHostingForm(domain), 'httpsRedirect', true);
  const plan = await client.preview(form.base, form.values);

  // First save fails during PATCH with hosting_save_unconfirmed
  await assert.rejects(
    () => client.save(plan),
    (err) => err instanceof DomainAliasError && err.code === 'hosting_save_unconfirmed' && err.needsReload === true,
  );

  // Re-using the same plan is rejected with hosting_preview_required
  await assert.rejects(
    () => client.save(plan),
    (err) => err instanceof DomainAliasError && err.code === 'hosting_preview_required',
  );

  // Tampered preview digest is rejected by validateHostingSettingsPreview
  assert.throws(
    () => validateHostingSettingsPreview(domain, form.values, {
      version: 1,
      domainId: DOMAIN_ID,
      currentRevision: 1,
      nextRevision: 2,
      previewDigest: 'not-a-sha256',
      confirmation: 'bad',
    }),
    (err) => err instanceof DomainAliasError && err.code === 'hosting_response_invalid',
  );

  // When isCurrent() becomes false, client throws hosting_context_changed
  active = false;
  await assert.rejects(
    () => client.preview(form.base, form.values),
    (err) => err instanceof DomainAliasError && err.code === 'hosting_context_changed',
  );
  assert.match(aliasErrorMessage({ code: 'domain_suspended_update_blocked' }), /Askıdaki alan adı/);
});

// ============================================================================
// SCN-V3-02: 1-Level Flattened Subdomain Hierarchy, FileRootBadge Removal &
//            Subdomain Table Card Rendering
// ============================================================================

const { domainTreeRows } = await import('../src/domain-tree.js');
const {
  isSystemMailServiceDomain,
  filterWebsiteListDomains,
  siteListPage,
} = await import('../src/workspace/site-list-model.js');
const { createWebsiteTaskResolver } = await import('../src/workspace/website-task-model.js');
const { default: WebsiteTaskCard } = await import('../src/workspace/WebsiteTaskCard.jsx');
const {
  resumeDomainOrWebsite,
  resumeWebsiteOrDomain,
} = await import('../src/workspace/website-suspension-client.js');
const {
  domainSuspensionAction,
  resolveWebsiteSuspensionAccess,
  websiteSuspensionErrorMessage,
} = await import('../src/workspace/website-suspension-model.js');

test('SCN-V3-02a: domainTreeRows with flattenSubdomains=true flattens multi-level subdomains to depth 1 under root domain with childCount=0 on all subdomains', () => {
  const hierarchy = [
    { id: 'd-root', primaryDomain: 'webrich.news', parentDomainId: null, websiteId: 'ws-root', state: 'active', targetType: 'static' },
    { id: 'd-yp-node', primaryDomain: 'yp-node.webrich.news', parentDomainId: 'd-root', websiteId: 'ws-yp', state: 'active', targetType: 'proxy' },
    { id: 'd-git-route', primaryDomain: 'git-route.yp-node.webrich.news', parentDomainId: 'd-yp-node', websiteId: 'ws-git', state: 'active', targetType: 'proxy' },
    { id: 'd-canary', primaryDomain: 'canary.git-route.yp-node.webrich.news', parentDomainId: 'd-git-route', websiteId: 'ws-canary', state: 'active', targetType: 'proxy' },
    { id: 'd-api', primaryDomain: 'api.webrich.news', parentDomainId: 'd-root', websiteId: 'ws-api', state: 'active', targetType: 'proxy' },
    { id: 'd-other', primaryDomain: 'other.org', parentDomainId: null, websiteId: 'ws-other', state: 'active', targetType: 'static' },
  ];

  // Default behavior (flattenSubdomains = false) preserves multi-level depths
  const unflattened = domainTreeRows(hierarchy);
  assert.deepEqual(
    unflattened.map((r) => [r.domain.id, r.depth, r.childCount]),
    [
      ['d-other', 0, 0],
      ['d-root', 0, 2],
      ['d-api', 1, 0],
      ['d-yp-node', 1, 1],
      ['d-git-route', 2, 1],
      ['d-canary', 3, 0],
    ],
  );

  // Flattened behavior (flattenSubdomains = true) places all descendants at depth 1 under root
  const flattened = domainTreeRows(hierarchy, { flattenSubdomains: true });
  assert.deepEqual(
    flattened.map((r) => [r.domain.id, r.depth, r.childCount]),
    [
      ['d-other', 0, 0],
      ['d-root', 0, 4],
      ['d-api', 1, 0],
      ['d-canary', 1, 0],
      ['d-git-route', 1, 0],
      ['d-yp-node', 1, 0],
    ],
  );

  // Collapsing root domain hides all flattened descendants when search is empty
  const collapsedRoot = domainTreeRows(hierarchy, {
    collapsed: new Set(['d-root']),
    flattenSubdomains: true,
  });
  assert.deepEqual(
    collapsedRoot.map((r) => [r.domain.id, r.depth, r.childCount, r.expanded]),
    [
      ['d-other', 0, 0, true],
      ['d-root', 0, 4, false],
    ],
  );

  // Searching a deep descendant expands root and includes matching descendants at depth 1
  const searched = domainTreeRows(hierarchy, {
    query: 'canary',
    collapsed: new Set(['d-root']),
    flattenSubdomains: true,
  });
  assert.deepEqual(
    searched.map((r) => [r.domain.id, r.depth, r.childCount]),
    [
      ['d-root', 0, 4],
      ['d-canary', 1, 0],
    ],
  );

  // Works seamlessly with siteListPage pagination and status/type filtering
  const paged = siteListPage(flattened, { perPage: 10, page: 1 });
  assert.equal(paged.totalGroups, 2);
  assert.equal(paged.rows.length, 6);
});

test('SCN-V3-02b: WebsiteTaskCard renders clean 1-level subdomain cards without FileRootBadge or ASCII tree connectors and exposes 1-click Yayını Etkinleştir link when suspended', () => {
  const domains = [
    { id: 'd-root', serverId: SERVER_ID, websiteId: 'ws-root', primaryDomain: 'webrich.news', parentDomainId: null, aliases: ['www.webrich.news'], state: 'active', targetType: 'static' },
    { id: 'd-sub', serverId: SERVER_ID, websiteId: 'ws-sub', primaryDomain: 'git-route.yp-node.webrich.news', parentDomainId: 'd-root', aliases: [], state: 'active', targetType: 'proxy' },
    { id: 'd-susp', serverId: SERVER_ID, websiteId: null, primaryDomain: 'paused.webrich.news', parentDomainId: 'd-root', aliases: [], state: 'suspended', targetType: 'static' },
  ];
  const websites = [
    { id: 'ws-root', serverId: SERVER_ID, runtimeType: 'static', applicationId: null },
    { id: 'ws-sub', serverId: SERVER_ID, runtimeType: 'node', applicationId: 'app-sub' },
  ];
  const resolveTasks = createWebsiteTaskResolver({
    domains: { status: 'ready', items: domains },
    websites: { status: 'ready', items: websites },
    applications: { status: 'ready', items: [{ id: 'app-sub', name: 'yp-node-app', type: 'node', serverId: SERVER_ID }] },
    canManage: true,
    isOwner: true,
  });

  const rows = domainTreeRows(domains, { flattenSubdomains: true });
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        'ul',
        null,
        rows.map((row) =>
          createElement(WebsiteTaskCard, {
            key: row.domain.id,
            row,
            tasks: resolveTasks(row.domain.id),
            certificates: { status: 'ready', items: [] },
            filtering: false,
            onToggle: () => {},
          }),
        ),
      ),
    ),
  );

  // No FileRootBadge or ASCII connectors
  assert.doesNotMatch(html, /Yayın klasörü:|Ortak Kök:|\/var\/www\/vhosts|├─|yp-tree-connector/);
  // Root domain has disclosure button for its 2 subdomains
  assert.match(html, /2 alt alan adı · Daralt/);
  // Subdomain card has yp-subdomain-task-card class
  assert.match(html, /yp-subdomain-task-card/);
  // Suspended domain card has prominent Yayını Etkinleştir link to quickResume=1
  assert.match(html, /href="\/websites\/d-susp\/settings\?quickResume=1"/);
  assert.match(html, /Yayını Etkinleştir/);
});

// ============================================================================
// SCN-V3-03: System Mail Service Domain Filtering (mail.*, webmail.*)
// ============================================================================

test('SCN-V3-03: isSystemMailServiceDomain and filterWebsiteListDomains exclude unbound mail.* and webmail.* service domains while preserving bound websites', () => {
  const unboundMail = { id: 'd-mail', primaryDomain: 'mail.webrich.news', websiteId: null, state: 'suspended' };
  const unboundWebmail = { id: 'd-webmail', primaryDomain: '  WEBMAIL.WebRich.News ', websiteId: undefined, state: 'active' };
  const boundMailWebsite = { id: 'd-bound-mail', primaryDomain: 'mail.customer-portal.com', websiteId: 'ws-mail-app', state: 'active' };
  const normalUnbound = { id: 'd-unbound-site', primaryDomain: 'standalone.webrich.news', websiteId: null, state: 'suspended' };
  const normalSubdomain = { id: 'd-api', primaryDomain: 'api.webrich.news', parentDomainId: 'd-root', websiteId: 'ws-api', state: 'active' };
  const mailerPrefixed = { id: 'd-mailer', primaryDomain: 'mailer.webrich.news', websiteId: null, state: 'active' };

  assert.equal(isSystemMailServiceDomain(unboundMail), true);
  assert.equal(isSystemMailServiceDomain(unboundWebmail), true);
  assert.equal(isSystemMailServiceDomain(boundMailWebsite), false);
  assert.equal(isSystemMailServiceDomain(normalUnbound), false);
  assert.equal(isSystemMailServiceDomain(normalSubdomain), false);
  assert.equal(isSystemMailServiceDomain(mailerPrefixed), false);
  assert.equal(isSystemMailServiceDomain(null), false);
  assert.equal(isSystemMailServiceDomain(undefined), false);
  assert.equal(isSystemMailServiceDomain('mail.webrich.news'), false);

  const filtered = filterWebsiteListDomains([
    unboundMail,
    unboundWebmail,
    boundMailWebsite,
    normalUnbound,
    normalSubdomain,
    mailerPrefixed,
  ]);
  assert.deepEqual(
    filtered.map((d) => d.id),
    ['d-bound-mail', 'd-unbound-site', 'd-api', 'd-mailer'],
  );
  assert.deepEqual(filterWebsiteListDomains(null), []);
});

// ============================================================================
// SCN-V3-04: 1-Click Unsuspend (resumeDomainOrWebsite) for Bound Websites and
//            Unbound Domains
// ============================================================================

test('SCN-V3-04a: resumeDomainOrWebsite resumes and retries resume for bound Websites via /websites/:id/suspension', async () => {
  assert.equal(resumeDomainOrWebsite, resumeWebsiteOrDomain);

  const calls = [];
  const websiteId = '11111111-2222-4333-8444-555555555555';
  const domain = { id: 'd-bound', primaryDomain: 'webrich.news', websiteId, state: 'suspended' };

  // 1. First-time resume when status === 'suspended'
  const resumeResult = await resumeDomainOrWebsite({
    domain,
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === `/websites/${websiteId}/suspension` && !options) {
        return {
          operations: [
            {
              id: 'op-web-1',
              status: 'suspended',
              updatedAt: '2026-10-25T00:00:00.000Z',
              actions: {
                resumeConfirmation: 'resume-website:token-1',
                resumeRetryConfirmation: null,
              },
            },
          ],
        };
      }
      if (path === `/websites/${websiteId}/suspension/resume` && options?.method === 'POST') {
        return { id: 'op-web-1', status: 'resumed' };
      }
      throw new Error(`Unexpected call: ${path}`);
    },
  });

  assert.equal(resumeResult.status, 'resumed');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    path: `/websites/${websiteId}/suspension/resume`,
    options: {
      method: 'POST',
      body: {
        operationId: 'op-web-1',
        expectedUpdatedAt: '2026-10-25T00:00:00.000Z',
        confirmation: 'resume-website:token-1',
      },
    },
  });

  // 2. Retry resume when status === 'resume_failed'
  const retryCalls = [];
  await resumeDomainOrWebsite({
    domain,
    request: async (path, options) => {
      retryCalls.push({ path, options });
      if (path === `/websites/${websiteId}/suspension`) {
        return {
          data: {
            operations: [
              {
                id: 'op-web-2',
                status: 'resume_failed',
                updatedAt: '2026-10-25T01:00:00.000Z',
                actions: {
                  resumeConfirmation: null,
                  resumeRetryConfirmation: 'retry-website-resume:token-2',
                },
              },
            ],
          },
        };
      }
      return { id: 'op-web-2', status: 'resumed' };
    },
  });
  assert.deepEqual(retryCalls[1], {
    path: `/websites/${websiteId}/suspension/resume-retry`,
    options: {
      method: 'POST',
      body: {
        operationId: 'op-web-2',
        expectedUpdatedAt: '2026-10-25T01:00:00.000Z',
        confirmation: 'retry-website-resume:token-2',
      },
    },
  });
});

test('SCN-V3-04b: resumeDomainOrWebsite resumes and retries resume for unbound Domains via /domains/:id/suspension-operations', async () => {
  const domain = { id: 'd-unbound-1', primaryDomain: 'standalone.webrich.news', websiteId: null, state: 'suspended' };
  const calls = [];

  // 1. First-time resume on unbound domain
  const res = await resumeDomainOrWebsite({
    domain,
    request: async (path, options) => {
      calls.push({ path, options });
      if (path === `/domains/${domain.id}/suspension-operations` && !options) {
        return {
          data: [
            {
              id: 'dom-op-1',
              domainId: domain.id,
              status: 'suspended',
              updatedAt: '2026-10-25T02:00:00.000Z',
              checksum: DIGEST_A,
              actions: {
                resumeConfirmation: 'resume-domain:dom-op-1',
                resumeRetryConfirmation: null,
              },
            },
          ],
        };
      }
      if (path === `/domains/${domain.id}/suspension-operations/dom-op-1/resume`) {
        return { data: { id: 'dom-op-1', status: 'resumed' } };
      }
      throw new Error(`Unexpected call: ${path}`);
    },
  });

  assert.equal(res.data.status, 'resumed');
  assert.deepEqual(calls[1], {
    path: `/domains/${domain.id}/suspension-operations/dom-op-1/resume`,
    options: {
      method: 'POST',
      body: {
        expectedUpdatedAt: '2026-10-25T02:00:00.000Z',
        checksum: DIGEST_A,
        confirmation: 'resume-domain:dom-op-1',
      },
    },
  });

  // 2. Retry resume on unbound domain when status === 'resume_failed'
  const retryCalls = [];
  await resumeDomainOrWebsite({
    domain,
    request: async (path, options) => {
      retryCalls.push({ path, options });
      if (path === `/domains/${domain.id}/suspension-operations`) {
        return [
          {
            id: 'dom-op-2',
            domainId: domain.id,
            status: 'resume_failed',
            updatedAt: '2026-10-25T02:30:00.000Z',
            checksum: DIGEST_B,
            actions: {
              resumeConfirmation: null,
              resumeRetryConfirmation: 'retry-domain-resume:dom-op-2',
            },
          },
        ];
      }
      return { id: 'dom-op-2', status: 'resumed' };
    },
  });
  assert.deepEqual(retryCalls[1], {
    path: `/domains/${domain.id}/suspension-operations/dom-op-2/resume-retry`,
    options: {
      method: 'POST',
      body: {
        expectedUpdatedAt: '2026-10-25T02:30:00.000Z',
        checksum: DIGEST_B,
        confirmation: 'retry-domain-resume:dom-op-2',
      },
    },
  });
});

test('SCN-V3-04c: resumeDomainOrWebsite, resolveWebsiteSuspensionAccess, and domainSuspensionAction handle unbound domains and invalid states safely', async () => {
  const unboundDomain = { id: 'd-unbound', serverId: SERVER_ID, websiteId: null, primaryDomain: 'unbound.webrich.news', state: 'suspended' };
  const access = resolveWebsiteSuspensionAccess({
    domainId: 'd-unbound',
    domains: { status: 'ready', items: [unboundDomain] },
    websites: { status: 'ready', items: [] },
    canManage: true,
  });
  assert.equal(access.state, 'unbound');
  assert.equal(access.domain.id, 'd-unbound');

  assert.equal(domainSuspensionAction([]), null);
  assert.equal(
    domainSuspensionAction([{ id: 'op-1', status: 'suspended', actions: { resumeConfirmation: 'tok-1' } }])?.kind,
    'resume',
  );
  assert.equal(
    domainSuspensionAction([{ id: 'op-2', status: 'resume_failed', actions: { resumeRetryConfirmation: 'tok-2' } }])?.kind,
    'retry-resume',
  );

  // Rejects missing request function
  await assert.rejects(
    () => resumeDomainOrWebsite({ domain: unboundDomain }),
    (err) => err.code === 'website_suspension_response_invalid',
  );

  // Rejects missing domain and websiteId
  await assert.rejects(
    () => resumeDomainOrWebsite({ domain: null, request: async () => ({}) }),
    (err) => err.code === 'website_suspension_response_invalid',
  );

  // Rejects when no resumable operation exists on website
  await assert.rejects(
    () => resumeDomainOrWebsite({
      domain: { id: 'd-1', websiteId: 'ws-1' },
      request: async () => ({ operations: [] }),
    }),
    (err) => err.code === 'website_resume_invalid' && websiteSuspensionErrorMessage(err).includes('Site askıda değil'),
  );

  // Rejects when no resumable operation exists on unbound domain
  await assert.rejects(
    () => resumeDomainOrWebsite({
      domain: unboundDomain,
      request: async () => ({ data: [] }),
    }),
    (err) => err.code === 'domain_resume_invalid' && websiteSuspensionErrorMessage(err).includes('Alan adı askıda değil'),
  );
});

