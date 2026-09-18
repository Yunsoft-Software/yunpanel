import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ElFinderBrowserHandoffError,
  elFinderBrowserHandoffInternals,
  openWebsiteElFinder,
} from '../src/workspace/elfinder-client.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const capability = 'E'.repeat(43);

function handoff(overrides = {}) {
  return {
    capability,
    expiresAt: 50_000,
    protocol: 'yunpanel-elfinder-handoff-v1',
    audience: 'elfinder',
    target: { serverId, websiteId },
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

test('elFinder browser handoff keeps capability in URL fragment only', async () => {
  const issueCalls = [];
  const locationImpl = browserLocation();

  await openWebsiteElFinder({
    serverId,
    websiteId,
    issueHandoff: async (...args) => {
      issueCalls.push(args);
      return handoff();
    },
    locationImpl,
    now: () => 10_000,
  });

  assert.deepEqual(issueCalls, [[serverId, websiteId]]);
  assert.deepEqual(locationImpl.assigned, [
    `/tools/elfinder/#handoff=${capability}`,
  ]);
  assert.equal(locationImpl.assigned[0].includes('?'), false);
});

test('elFinder browser handoff rejects target drift and expiry before navigation', async () => {
  for (const value of [
    handoff({ target: { serverId, websiteId: '42345678-1234-4234-8234-123456789012' } }),
    handoff({ expiresAt: 9_999 }),
    handoff({ audience: 'phpmyadmin' }),
  ]) {
    const locationImpl = browserLocation();
    await assert.rejects(
      openWebsiteElFinder({
        serverId,
        websiteId,
        issueHandoff: async () => value,
        locationImpl,
        now: () => 10_000,
      }),
      (error) => error instanceof ElFinderBrowserHandoffError
        && !error.message.includes(capability),
    );
    assert.deepEqual(locationImpl.assigned, []);
  }
});

test('elFinder browser handoff rejects invalid browser context or client', async () => {
  await assert.rejects(
    openWebsiteElFinder({
      serverId,
      websiteId,
      issueHandoff: null,
      locationImpl: browserLocation(),
    }),
    (error) => error instanceof ElFinderBrowserHandoffError
      && error.code === 'elfinder_handoff_client_missing',
  );

  await assert.rejects(
    openWebsiteElFinder({
      serverId,
      websiteId,
      issueHandoff: async () => handoff(),
      locationImpl: { origin: 'https://panel.example.test' },
    }),
    (error) => error instanceof ElFinderBrowserHandoffError
      && error.code === 'elfinder_browser_unavailable',
  );
});

test('elFinder browser protocol constants stay pinned to protected gateway route', () => {
  assert.equal(elFinderBrowserHandoffInternals.protocol, 'yunpanel-elfinder-handoff-v1');
  assert.equal(elFinderBrowserHandoffInternals.audience, 'elfinder');
  assert.equal(elFinderBrowserHandoffInternals.gatewayBase, '/tools/elfinder/');
});
