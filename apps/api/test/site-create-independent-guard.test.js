import assert from 'node:assert/strict';
import test from 'node:test';
import { previewSiteCreate, SiteCreateError, siteCreateInternals } from '../src/site-create.js';

const input = Object.freeze({
  operationId: '1b3ec592-e2ee-4c29-8cc4-e97265c58d35',
  serverId: '28dc1532-a2cb-4f29-9e0d-05f793652fa3',
  name: 'Independent WWW Guard',
  primaryDomain: 'guard.example.test',
  parentDomainId: null,
  wwwMode: 'independent',
  httpsMode: 'off',
  source: Object.freeze({
    kind: 'new_static',
    repositoryUrl: 'https://github.com/example/guard',
    branch: 'main',
    build: Object.freeze({ mode: 'none', outputDir: '.' }),
    retention: 5,
  }),
});

function isIndependentGuard(error) {
  return error instanceof SiteCreateError
    && error.code === 'site_create_independent_www_requires_website'
    && error.status === 409;
}

test('public site-create core rejects independent www before dependency access', async () => {
  await assert.rejects(
    previewSiteCreate({ input }),
    isIndependentGuard,
  );
});

test('site-create normalizeInput cannot bypass the independent Website guard', () => {
  assert.throws(
    () => siteCreateInternals.normalizeInput(input),
    isIndependentGuard,
  );
});
