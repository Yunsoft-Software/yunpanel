import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openWebsitePhpMyAdmin,
  phpMyAdminBrowserHandoffInternals,
  PhpMyAdminBrowserHandoffError,
} from '../src/workspace/phpmyadmin-client.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const credentialId = '32345678-1234-4234-8234-123456789012';
const capability = 'A'.repeat(43);

function handoff(overrides = {}) {
  return {
    capability,
    expiresAt: 50_000,
    protocol: 'yunpanel-phpmyadmin-signon-v1',
    target: {
      serverId,
      websiteId,
      databaseCredentialId: credentialId,
      databaseName: 'site_main',
    },
    ...overrides,
  };
}

function browserLocation() {
  return {
    origin: 'https://panel.example.test',
    assigned: [],
    assign(path) { this.assigned.push(path); },
  };
}

test('phpMyAdmin browser handoff posts the capability without putting it in the URL or browser storage', async () => {
  const issueCalls = [];
  const fetchCalls = [];
  const locationImpl = browserLocation();

  await openWebsitePhpMyAdmin({
    serverId,
    websiteId,
    credentialId,
    issueHandoff: async (...args) => {
      issueCalls.push(args);
      return handoff();
    },
    fetchImpl: async (url, options) => {
      fetchCalls.push({
        url,
        method: options.method,
        credentials: options.credentials,
        mode: options.mode,
        redirect: options.redirect,
        cache: options.cache,
        referrerPolicy: options.referrerPolicy,
        body: String(options.body),
      });
      return {
        ok: true,
        status: 200,
        url: 'https://panel.example.test/tools/phpmyadmin/',
      };
    },
    locationImpl,
    now: () => 10_000,
  });

  assert.deepEqual(issueCalls, [[serverId, websiteId, credentialId]]);
  assert.deepEqual(fetchCalls, [{
    url: '/tools/phpmyadmin/__yunpanel/signon',
    method: 'POST',
    credentials: 'same-origin',
    mode: 'same-origin',
    redirect: 'follow',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    body: `capability=${capability}`,
  }]);
  assert.equal(fetchCalls[0].url.includes(capability), false);
  assert.equal(fetchCalls[0].url.includes('?'), false);
  assert.deepEqual(locationImpl.assigned, ['/tools/phpmyadmin/']);
});

test('phpMyAdmin browser handoff rejects target drift before posting the capability', async () => {
  let signonCalls = 0;
  const locationImpl = browserLocation();

  await assert.rejects(
    openWebsitePhpMyAdmin({
      serverId,
      websiteId,
      credentialId,
      issueHandoff: async () => handoff({
        target: {
          serverId,
          websiteId: '42345678-1234-4234-8234-123456789012',
          databaseCredentialId: credentialId,
          databaseName: 'site_main',
        },
      }),
      fetchImpl: async () => {
        signonCalls += 1;
        return { ok: true, status: 200, url: 'https://panel.example.test/tools/phpmyadmin/' };
      },
      locationImpl,
      now: () => 10_000,
    }),
    (error) => error instanceof PhpMyAdminBrowserHandoffError
      && error.code === 'phpmyadmin_handoff_invalid'
      && !error.message.includes(capability),
  );

  assert.equal(signonCalls, 0);
  assert.deepEqual(locationImpl.assigned, []);
});


test('phpMyAdmin browser handoff rejects an already expired capability before signon', async () => {
  let signonCalls = 0;
  const locationImpl = browserLocation();

  await assert.rejects(
    openWebsitePhpMyAdmin({
      serverId,
      websiteId,
      credentialId,
      issueHandoff: async () => handoff({ expiresAt: 9_999 }),
      fetchImpl: async () => {
        signonCalls += 1;
        return { ok: true, status: 200, url: 'https://panel.example.test/tools/phpmyadmin/' };
      },
      locationImpl,
      now: () => 10_000,
    }),
    (error) => error instanceof PhpMyAdminBrowserHandoffError
      && error.code === 'phpmyadmin_handoff_expired'
      && !error.message.includes(capability),
  );

  assert.equal(signonCalls, 0);
  assert.deepEqual(locationImpl.assigned, []);
});

test('phpMyAdmin browser handoff reports consumed or expired capabilities without leaking them', async () => {
  const locationImpl = browserLocation();

  await assert.rejects(
    openWebsitePhpMyAdmin({
      serverId,
      websiteId,
      credentialId,
      issueHandoff: async () => handoff(),
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        url: 'https://panel.example.test/tools/phpmyadmin/__yunpanel/signon',
      }),
      locationImpl,
      now: () => 10_000,
    }),
    (error) => error instanceof PhpMyAdminBrowserHandoffError
      && error.code === 'phpmyadmin_handoff_expired'
      && !error.message.includes(capability),
  );

  assert.deepEqual(locationImpl.assigned, []);
});

test('phpMyAdmin browser handoff refuses a cross-origin redirect before navigation', async () => {
  const locationImpl = browserLocation();

  await assert.rejects(
    openWebsitePhpMyAdmin({
      serverId,
      websiteId,
      credentialId,
      issueHandoff: async () => handoff(),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://attacker.example/tools/phpmyadmin/',
      }),
      locationImpl,
      now: () => 10_000,
    }),
    (error) => error instanceof PhpMyAdminBrowserHandoffError
      && error.code === 'phpmyadmin_handoff_navigation_invalid',
  );

  assert.deepEqual(locationImpl.assigned, []);
});

test('phpMyAdmin browser handoff protocol constants stay pinned to the protected gateway routes', () => {
  assert.equal(phpMyAdminBrowserHandoffInternals.protocol, 'yunpanel-phpmyadmin-signon-v1');
  assert.equal(phpMyAdminBrowserHandoffInternals.signonPath, '/tools/phpmyadmin/__yunpanel/signon');
  assert.equal(phpMyAdminBrowserHandoffInternals.gatewayBase, '/tools/phpmyadmin/');
});
