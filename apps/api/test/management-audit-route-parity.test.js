import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyManagementMutation } from '../src/management-audit.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiSource = path.resolve(testDirectory, '../src');
const SOURCE_FILES = [
  'app.js',
  'core-app.js',
  'site-create-http.js',
  'resource-impact-http.js',
  'external-lifecycle-http.js',
  'website-http.js',
  'website-migration-http.js',
  'managed-service-http.js',
  'database-http.js',
];
const ROUTE_PATTERN = /app\.(post|put|patch|delete)\(\s*'([^']+)'\s*,\s*requirePanelRouteAccess\b/g;

function concretePath(route) {
  return route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name) => {
    if (name === 'serviceId') return 'nginx';
    if (name === 'name') return 'example_db';
    if (name === 'key') return 'SAFE_KEY';
    return `${name}-1`;
  });
}

function discoveredMutationRoutes() {
  const routes = [];
  for (const file of SOURCE_FILES) {
    const source = readFileSync(path.join(apiSource, file), 'utf8');
    for (const match of source.matchAll(ROUTE_PATTERN)) {
      routes.push(Object.freeze({ file, method: match[1].toUpperCase(), route: match[2] }));
    }
  }
  const unique = new Map(routes.map((entry) => [`${entry.method} ${entry.route}`, entry]));
  return [...unique.values()].sort((left, right) => `${left.method} ${left.route}`.localeCompare(`${right.method} ${right.route}`));
}

test('every panel management mutation route has a common audit classification', () => {
  const routes = discoveredMutationRoutes();
  assert.ok(routes.length >= 20, `expected current management mutation surface, found ${routes.length}`);
  const missing = [];
  for (const route of routes) {
    const pathname = concretePath(route.route);
    const classification = classifyManagementMutation(route.method, pathname);
    if (!classification) {
      missing.push(`${route.file}: ${route.method} ${route.route}`);
      continue;
    }
    assert.equal(typeof classification.action, 'string');
    assert.equal(typeof classification.resourceType, 'string');
    assert.equal(typeof classification.resourceId, 'string');
    assert.ok(classification.resourceId.length > 0);
  }
  assert.deepEqual(missing, [], `management mutations missing audit classification:\n${missing.join('\n')}`);
});

test('Website creation and migration mutations are part of common management audit coverage', () => {
  const expected = new Map([
    ['/api/websites', { action: 'website.create', resourceType: 'website', resourceId: 'new' }],
    ['/api/websites/migration/create-website', { action: 'website.migration.create', resourceType: 'website_migration', resourceId: 'create' }],
    ['/api/websites/migration/bind', { action: 'website.migration.bind', resourceType: 'website_migration', resourceId: 'bind' }],
    ['/api/websites/migration/finalize', { action: 'website.migration.finalize', resourceType: 'website_migration', resourceId: 'policy' }],
    ['/api/websites/migration/rollback', { action: 'website.migration.rollback', resourceType: 'website_migration', resourceId: 'policy' }],
  ]);
  for (const [route, classification] of expected) {
    assert.deepEqual(classifyManagementMutation('POST', route), classification);
  }
  const routes = discoveredMutationRoutes();
  for (const route of expected.keys()) {
    const file = route === '/api/websites' ? 'website-http.js' : 'website-migration-http.js';
    assert.ok(routes.some((entry) => entry.file === file && entry.method === 'POST' && entry.route === route));
  }
  assert.deepEqual(classifyManagementMutation('POST', '/api/websites/website-1/update-preview'), {
    action: 'website.update.preview', resourceType: 'website', resourceId: 'website-1',
  });
  assert.deepEqual(classifyManagementMutation('PATCH', '/api/websites/website-1'), {
    action: 'website.update', resourceType: 'website', resourceId: 'website-1',
  });
});

test('site creation preview and apply have bounded common audit identities', () => {
  assert.deepEqual(classifyManagementMutation('POST', '/api/sites/create-preview'), {
    action: 'site.create.preview', resourceType: 'site', resourceId: 'new',
  });
  assert.deepEqual(classifyManagementMutation('POST', '/api/sites'), {
    action: 'site.create', resourceType: 'site', resourceId: 'new',
  });
});

test('Domain hierarchy preview and apply have bounded common audit identities', () => {
  assert.deepEqual(classifyManagementMutation('POST', '/api/domains/domain-1/reparent-preview'), {
    action: 'domain.reparent.preview', resourceType: 'domain', resourceId: 'domain-1',
  });
  assert.deepEqual(classifyManagementMutation('POST', '/api/domains/domain-1/reparent'), {
    action: 'domain.reparent', resourceType: 'domain', resourceId: 'domain-1',
  });
});

test('Website and Domain impact previews have resource-scoped audit identities', () => {
  assert.deepEqual(classifyManagementMutation('POST', '/api/websites/website-1/impact-preview'), {
    action: 'website.impact.preview', resourceType: 'website', resourceId: 'website-1',
  });
  assert.deepEqual(classifyManagementMutation('POST', '/api/domains/domain-1/impact-preview'), {
    action: 'domain.impact.preview', resourceType: 'domain', resourceId: 'domain-1',
  });
});

test('explicit external DNS and mail tracking have separate audit resources', () => {
  assert.deepEqual(classifyManagementMutation('POST', '/api/dns-zones'), {
    action: 'dns_zone.external.track', resourceType: 'dns_zone', resourceId: 'new',
  });
  assert.deepEqual(classifyManagementMutation('POST', '/api/mail-domains'), {
    action: 'mail_domain.external.track', resourceType: 'mail_domain', resourceId: 'new',
  });
});

test('legacy agent transport and auth/user/audit handlers are intentionally outside management route discovery', () => {
  const routes = discoveredMutationRoutes();
  const names = routes.map((entry) => entry.route);
  assert.equal(names.some((route) => /heartbeat|commands/.test(route)), false);
  assert.equal(names.some((route) => route.startsWith('/api/auth/')), false);
  assert.equal(names.some((route) => route.startsWith('/api/users')), false);
  assert.equal(names.includes('/api/audit'), false);
});

export const managementAuditRouteParityInternals = Object.freeze({
  sourceFiles: Object.freeze([...SOURCE_FILES]), concretePath, discoveredMutationRoutes,
});
