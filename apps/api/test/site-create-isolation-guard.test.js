import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SiteCreateError,
  siteCreateIsolationGuardInternals,
} from '../src/site-create-isolation-guard.js';

function input(wwwMode) {
  return {
    operationId: '47bc6cf1-75bc-4cba-a610-aa0cd0522c80',
    serverId: '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7',
    name: 'Example',
    primaryDomain: 'example.test',
    parentDomainId: null,
    wwwMode,
    httpsMode: 'off',
    source: { kind: 'new_php' },
  };
}

test('independent www mode is blocked until it creates a separate Website identity', () => {
  assert.throws(
    () => siteCreateIsolationGuardInternals.assertIndependentWebsiteIsolation(input('independent')),
    (error) => error instanceof SiteCreateError
      && error.code === 'site_create_independent_www_requires_website'
      && error.status === 409,
  );
});

test('www alias and no-www modes remain allowed', () => {
  assert.equal(siteCreateIsolationGuardInternals.assertIndependentWebsiteIsolation(input('alias')).wwwMode, 'alias');
  assert.equal(siteCreateIsolationGuardInternals.assertIndependentWebsiteIsolation(input('none')).wwwMode, 'none');
});
