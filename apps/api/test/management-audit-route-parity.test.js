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
  assert.ok(routes.length >= 15, `expected current management mutation surface, found ${routes.length}`);
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

test('legacy agent transport and auth/user/audit handlers are intentionally outside management route discovery', () => {
  const routes = discoveredMutationRoutes();
  const names = routes.map((entry) => entry.route);
  assert.equal(names.some((route) => /heartbeat|commands/.test(route)), false);
  assert.equal(names.some((route) => route.startsWith('/api/auth/')), false);
  assert.equal(names.some((route) => route.startsWith('/api/users')), false);
  assert.equal(names.includes('/api/audit'), false);
});

export const managementAuditRouteParityInternals = Object.freeze({
  sourceFiles: Object.freeze([...SOURCE_FILES]),
  concretePath,
  discoveredMutationRoutes,
});
