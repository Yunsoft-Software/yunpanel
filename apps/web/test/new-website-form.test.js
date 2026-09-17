import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableExistingApplications,
  existingApplicationType,
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
});

test('new Node and PHP modes use dedicated site-create Application contracts', () => {
  const node = siteCreateInputFromForm({
    form: form(), operationId, serverId, domain: { primaryDomain: 'example.test', parentDomainId: null },
  });
  assert.equal(node.source.kind, 'new_node');
  assert.equal(node.source.runtime.nodeMajor, 24);
  assert.equal(node.source.runtime.entryFile, 'server.js');
  assert.equal(Object.hasOwn(node.source.runtime, 'port'), false);

  const php = siteCreateInputFromForm({
    form: form({ sourceMode: 'new_php', wwwMode: 'none' }),
    operationId,
    serverId,
    domain: { primaryDomain: 'php.example.test', parentDomainId: null },
  });
  assert.deepEqual(php.source, { kind: 'new_php' });
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
