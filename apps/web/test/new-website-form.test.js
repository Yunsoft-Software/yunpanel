import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableExistingApplications,
  availableSharedWebsites,
  existingApplicationType,
  sharedDomainCreateInput,
  sharedWebsiteConfirmation,
  siteCreateInputFromForm,
} from '../src/workspace/new-website-form.js';

const operationId = '531071bb-d40d-4444-94ba-c9545144febc';
const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const parentDomainId = '3854e385-adfc-42bd-bccf-f655f24cd68f';

function form(overrides = {}) {
  return {
    sourceMode: 'new_node',
    repositoryUrl: 'https://github.com/example/blog',
    branch: 'main',
    entryFile: 'server.js',
    healthPath: '/health',
    outputDir: 'dist',
    targetValue: '',
    wwwMode: 'alias',
    httpsMode: 'managed',
    ...overrides,
  };
}

test('independent subdomain input creates a new Application source under the explicit parent', () => {
  const input = siteCreateInputFromForm({
    form: form({ sourceMode: 'new_static' }),
    operationId,
    serverId,
    domain: { primaryDomain: 'blog.example.test', parentDomainId },
  });

  assert.equal(input.parentDomainId, parentDomainId);
  assert.equal(input.wwwMode, 'none');
  assert.deepEqual(input.source, {
    kind: 'new_static',
    repositoryUrl: 'https://github.com/example/blog',
    branch: 'main',
    retention: 5,
    build: {
      mode: 'npm', installMode: 'ci', buildScript: 'build', outputDir: 'dist', healthFile: 'index.html',
    },
  });
  assert.deepEqual(input.database, { mode: 'none' });
  assert.deepEqual(input.mail, { mode: 'none' });
});

test('new Node and PHP modes use dedicated site-create Application contracts', () => {
  const node = siteCreateInputFromForm({
    form: form(), operationId, serverId, domain: { primaryDomain: 'example.test', parentDomainId: null },
  });
  assert.equal(node.source.kind, 'new_node');
  assert.equal(node.source.runtime.nodeMajor, 24);
  assert.equal(node.source.runtime.entryFile, 'server.js');
  assert.equal(Object.hasOwn(node.source.runtime, 'port'), false);
  assert.deepEqual(node.database, { mode: 'none' });
  assert.deepEqual(node.mail, { mode: 'local' });


  const php = siteCreateInputFromForm({
    form: form({ sourceMode: 'new_php', wwwMode: 'none' }),
    operationId,
    serverId,
    domain: { primaryDomain: 'php.example.test', parentDomainId: null },
  });
  assert.deepEqual(php.source, { kind: 'new_php' });
});

test('managed Website can request an initial scoped database without choosing names or secrets', () => {
  const input = siteCreateInputFromForm({
    form: form({ initialDatabase: true }),
    operationId,
    serverId,
    domain: { primaryDomain: 'database.example.test', parentDomainId: null },
  });
  assert.deepEqual(input.database, { mode: 'create' });
  assert.equal(Object.hasOwn(input.database, 'name'), false);
  assert.equal(Object.hasOwn(input.database, 'password'), false);

  assert.throws(
    () => siteCreateInputFromForm({
      form: form({ sourceMode: 'external_proxy', targetValue: '4301', initialDatabase: true }),
      operationId,
      serverId,
      domain: { primaryDomain: 'proxy.example.test', parentDomainId: null },
    }),
    /yalnız yönetilen Application Website/,
  );
});

test('stale independent-www state never reaches the site-create API', () => {
  assert.throws(
    () => siteCreateInputFromForm({
      form: form({ wwwMode: 'independent' }),
      operationId,
      serverId,
      domain: { primaryDomain: 'example.test', parentDomainId: null },
    }),
    /ayrı bir Website/,
  );
});

test('existing Application choices exclude bound and cross-server resources', () => {
  const applications = [
    { id: 'node-free', serverId, type: 'node' },
    { id: 'node-bound', serverId, type: 'node' },
    { id: 'static-free', serverId, type: 'static' },
    { id: 'remote-node', serverId: 'remote', type: 'node' },
  ];
  const websites = [{ id: 'website', applicationId: 'node-bound' }];
  assert.equal(existingApplicationType('existing_node'), 'node');
  assert.deepEqual(
    availableExistingApplications({ applications, websites, serverId, sourceMode: 'existing_node' }).map((item) => item.id),
    ['node-free'],
  );
  assert.deepEqual(
    availableExistingApplications({ applications, websites, serverId, sourceMode: 'existing_static' }).map((item) => item.id),
    ['static-free'],
  );
});

test('existing Application input requires the selected source type', () => {
  assert.throws(
    () => siteCreateInputFromForm({
      form: form({ sourceMode: 'existing_node' }), operationId, serverId,
      domain: { primaryDomain: 'app.example.test', parentDomainId: null },
      selectedApplication: { id: 'static-app', type: 'static' },
    }),
    /kullanılmamış uygun uygulamayı/,
  );
});

test('shared-site creates only a Domain binding with the selected Website canonical target', () => {
  const applicationId = '5a5ea77f-2d7d-43f7-a455-1ed9e5cb41be';
  const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
  const applications = [{
    id: applicationId, serverId, type: 'node', runtimeAdapter: 'passenger', name: 'API',
  }];
  const website = {
    id: websiteId, serverId, name: 'API Website', applicationId, runtimeType: 'node',
    documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`, unixUser: 'yunapp-123456789abc',
  };
  assert.deepEqual(availableSharedWebsites({ websites: [website], applications, serverId }), [website]);

  const input = sharedDomainCreateInput({
    domain: { serverId, primaryDomain: 'example.test', parentDomainId: null, httpsMode: 'managed' },
    website,
    applications,
    wwwMode: 'alias',
  });
  assert.deepEqual(input, {
    serverId,
    websiteId,
    primaryDomain: 'example.test',
    parentDomainId: null,
    aliases: ['www.example.test'],
    targetType: 'passenger',
    target: { applicationId },
    httpsMode: 'managed',
  });
  assert.equal(Object.hasOwn(input, 'application'), false);
  assert.equal(Object.hasOwn(input, 'unixUser'), false);
  assert.equal(sharedWebsiteConfirmation(input.primaryDomain, input.websiteId), `share-site:example.test:${websiteId}`);
});

test('shared-site excludes ambiguous legacy and unmanaged Website routing', () => {
  const applicationId = '5a5ea77f-2d7d-43f7-a455-1ed9e5cb41be';
  const applications = [{ id: applicationId, serverId, type: 'node', runtimeAdapter: 'direct-systemd' }];
  const legacy = { id: 'legacy', serverId, applicationId, runtimeType: 'node' };
  const managedCompose = { id: 'compose', serverId, applicationId: null, runtimeType: 'docker', proxyTarget: null };
  const remote = { id: 'remote', serverId: 'remote', applicationId, runtimeType: 'node' };
  assert.deepEqual(availableSharedWebsites({ websites: [legacy, managedCompose, remote], applications, serverId }), []);
  assert.throws(
    () => sharedDomainCreateInput({
      domain: { serverId, primaryDomain: 'api.example.test', parentDomainId, httpsMode: 'off' },
      website: legacy,
      applications,
    }),
    /uygun değil/,
  );
});
