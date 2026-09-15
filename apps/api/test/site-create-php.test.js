import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createSite, previewSiteCreate } from '../src/site-create.js';
import { createWebsiteRegistry, websiteRegistryInternals } from '../src/website-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';

function fixture() {
  const registry = {
    getServer: async (id) => id === serverId ? { id, executionMode: 'local' } : null,
  };
  const applicationRegistry = createApplicationRegistry({
    serverExists: async (id) => id === serverId,
  });
  const dockerWorkloadRegistry = {
    getWorkload: async () => null,
    listWorkloads: async () => [],
  };
  const websiteRegistry = createWebsiteRegistry({
    serverExists: async (id) => id === serverId,
    getApplication: async (id) => applicationRegistry.getApplication(id),
  });
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
    websiteBindingRequired: () => true,
  });
  return { registry, applicationRegistry, dockerWorkloadRegistry, websiteRegistry, domainRegistry };
}

function input() {
  return {
    operationId,
    serverId,
    name: 'PHP Website',
    primaryDomain: 'php.example.test',
    parentDomainId: null,
    wwwMode: 'alias',
    httpsMode: 'off',
    source: { kind: 'new_php' },
  };
}

test('new_php preview plans canonical isolated Application, Website and PHP Domain target', async () => {
  const dependencies = fixture();
  const preview = await previewSiteCreate({ input: input(), ...dependencies });

  assert.equal(preview.source.kind, 'new_php');
  assert.match(preview.ids.applicationId, /^[0-9a-f-]{36}$/);
  assert.equal(preview.plan.application.type, 'php');
  assert.equal(preview.plan.application.repositoryUrl, null);
  assert.equal(preview.plan.application.branch, null);
  assert.equal(preview.plan.application.retention, 2);
  assert.equal(preview.plan.application.webRoot, `/var/lib/yunpanel/apps/${preview.ids.applicationId}/current/public`);

  assert.equal(preview.plan.website.runtimeType, 'php');
  assert.equal(preview.plan.website.applicationId, preview.ids.applicationId);
  assert.equal(preview.plan.website.documentRoot, preview.plan.application.webRoot);
  assert.equal(preview.plan.website.unixUser, websiteRegistryInternals.appUnixUser(preview.ids.applicationId));

  assert.equal(preview.plan.primaryDomain.targetType, 'php');
  assert.deepEqual(preview.plan.primaryDomain.target, { applicationId: preview.ids.applicationId });
  assert.deepEqual(preview.plan.primaryDomain.aliases, ['www.php.example.test']);
  assert.equal(preview.complete, false);
});

test('new_php create persists PHP metadata idempotently without raw socket or document-root input', async () => {
  const dependencies = fixture();
  const firstPreview = await previewSiteCreate({ input: input(), ...dependencies });
  const created = await createSite({
    input: input(),
    previewDigest: firstPreview.previewDigest,
    confirmation: firstPreview.confirmation,
    ...dependencies,
  });

  assert.equal(created.application.type, 'php');
  assert.equal(created.application.id, firstPreview.ids.applicationId);
  assert.equal(created.website.runtimeType, 'php');
  assert.equal(created.website.documentRoot, `/var/lib/yunpanel/apps/${created.application.id}/current/public`);
  assert.equal(created.primaryDomain.targetType, 'php');
  assert.deepEqual(created.primaryDomain.target, { applicationId: created.application.id });
  assert.equal(Object.hasOwn(created.primaryDomain.target, 'socketPath'), false);
  assert.equal(Object.hasOwn(created.primaryDomain.target, 'root'), false);

  const resumedPreview = await previewSiteCreate({ input: input(), ...dependencies });
  assert.equal(resumedPreview.complete, true);
  assert.equal(resumedPreview.steps.applicationReady, true);
  assert.equal(resumedPreview.steps.websiteReady, true);
  assert.equal(resumedPreview.steps.primaryDomainReady, true);
});

test('new_php source rejects hidden repository, runtime or PHP-version fields', async () => {
  const dependencies = fixture();
  for (const source of [
    { kind: 'new_php', repositoryUrl: 'https://github.com/example/example' },
    { kind: 'new_php', phpVersion: '8.4' },
    { kind: 'new_php', runtime: {} },
  ]) {
    await assert.rejects(
      previewSiteCreate({ input: { ...input(), source }, ...dependencies }),
      (error) => error?.code === 'site_create_source_invalid',
    );
  }
});
