import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createElFinderHandoffService,
  ElFinderHandoffError,
  elFinderHandoffInternals,
} from '../src/elfinder-handoff-service.js';
import { createLiveSessionRegistry } from '../src/live-session-registry.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const websiteId = '22345678-1234-4234-8234-123456789012';
const applicationId = '32345678-1234-4234-8234-123456789012';

function website(overrides = {}) {
  return {
    id: websiteId,
    serverId,
    applicationId,
    runtimeType: 'php',
    unixUser: elFinderHandoffInternals.applicationUser(applicationId),
    revision: 7,
    ...overrides,
  };
}

function fixture({
  initialWebsite = website(),
  now = 10_000,
  liveSessions = null,
  runtimeInspection = null,
} = {}) {
  let currentWebsite = initialWebsite;
  let clock = now;
  const service = createElFinderHandoffService({
    websiteRegistry: {
      async getWebsite(id) {
        return id === websiteId ? currentWebsite : null;
      },
    },
    localServerId: serverId,
    runtimeInspector: runtimeInspection ?? (async (intent) => ({
      satisfied: true,
      adapter: 'elfinder-fpm',
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
      unixUser: intent.unixUser,
      root: `/var/lib/yunpanel/data/${intent.applicationId}`,
      socketPath: `/run/php/yunpanel-elfinder-${intent.unixUser}.sock`,
      connectorPath: '/usr/share/yunpanel/elfinder/connector.php',
      runtimeUmask: '0027',
    })),
    liveSessions,
    now: () => clock,
  });
  return {
    service,
    setWebsite(value) { currentWebsite = value; },
    setNow(value) { clock = value; },
  };
}

test('elFinder handoff exposes only an audience-bound Website capability and keeps root private', async () => {
  const fx = fixture();
  const handoff = await fx.service.issue({
    sessionId: 'owner-session',
    userId: 'owner-user',
    serverId,
    websiteId,
  });

  assert.equal(handoff.protocol, 'yunpanel-elfinder-handoff-v1');
  assert.equal(handoff.audience, 'elfinder');
  assert.match(handoff.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(handoff.target, { serverId, websiteId });
  assert.equal(JSON.stringify(handoff).includes('/var/lib/yunpanel/data/'), false);
  assert.equal(JSON.stringify(handoff).includes('yunapp-'), false);
  assert.equal(JSON.stringify(handoff).includes(applicationId), false);

  const privateState = await fx.service.consume(handoff.capability);
  assert.equal(privateState.protocol, 'yunpanel-elfinder-handoff-v1');
  assert.equal(privateState.audience, 'elfinder');
  assert.equal(privateState.websiteRevision, 7);
  assert.equal(privateState.applicationId, applicationId);
  assert.equal(privateState.unixUser, elFinderHandoffInternals.applicationUser(applicationId));
  assert.equal(privateState.root, `/var/lib/yunpanel/data/${applicationId}`);
  assert.equal(fx.service.size(), 0);

  await assert.rejects(
    fx.service.consume(handoff.capability),
    (error) => error instanceof ElFinderHandoffError && error.code === 'elfinder_handoff_invalid',
  );
});

test('elFinder handoff becomes stale if Website revision or filesystem identity changes before consume', async () => {
  for (const changed of [
    website({ revision: 8 }),
    website({ unixUser: 'yunapp-000000000000' }),
    website({ applicationId: '42345678-1234-4234-8234-123456789012' }),
  ]) {
    const fx = fixture();
    const handoff = await fx.service.issue({
      sessionId: 'owner-session',
      userId: 'owner-user',
      serverId,
      websiteId,
    });
    fx.setWebsite(changed);
    await assert.rejects(
      fx.service.consume(handoff.capability),
      (error) => error instanceof ElFinderHandoffError
        && ['elfinder_handoff_stale', 'elfinder_handoff_site_user_drift'].includes(error.code),
    );
    assert.equal(fx.service.size(), 0);
  }
});

test('elFinder handoff rejects remote, unsupported and forged Website targets before minting capability', async () => {
  const remote = fixture();
  await assert.rejects(
    remote.service.issue({
      sessionId: 'owner-session',
      userId: 'owner-user',
      serverId: '52345678-1234-4234-8234-123456789012',
      websiteId,
    }),
    (error) => error instanceof ElFinderHandoffError && error.code === 'elfinder_handoff_server_not_local',
  );

  for (const invalid of [
    website({ runtimeType: 'proxy', applicationId: null, unixUser: null }),
    website({ runtimeType: 'docker', applicationId: null, unixUser: null }),
    website({ unixUser: 'yunapp-ffffffffffff' }),
  ]) {
    const fx = fixture({ initialWebsite: invalid });
    await assert.rejects(
      fx.service.issue({
        sessionId: 'owner-session',
        userId: 'owner-user',
        serverId,
        websiteId,
      }),
      (error) => error instanceof ElFinderHandoffError
        && ['elfinder_handoff_website_unsupported', 'elfinder_handoff_site_user_drift'].includes(error.code),
    );
    assert.equal(fx.service.size(), 0);
  }
});

test('elFinder handoff fails closed when the per-Website Files runtime is not proven healthy', async () => {
  for (const runtimeInspection of [
    async () => ({ satisfied: false, reason: 'elfinder_fpm_socket_missing' }),
    async (intent) => ({
      satisfied: true,
      adapter: 'elfinder-fpm',
      websiteId: intent.websiteId,
      applicationId: intent.applicationId,
      unixUser: intent.unixUser,
      root: `/var/lib/yunpanel/data/${intent.applicationId}`,
      socketPath: '/run/php/forged.sock',
      connectorPath: '/usr/share/yunpanel/elfinder/connector.php',
      runtimeUmask: '0027',
    }),
  ]) {
    const fx = fixture({ runtimeInspection });
    await assert.rejects(
      fx.service.issue({
        sessionId: 'owner-session',
        userId: 'owner-user',
        serverId,
        websiteId,
      }),
      (error) => error instanceof ElFinderHandoffError
        && error.code === 'elfinder_handoff_runtime_not_ready'
        && error.status === 409,
    );
    assert.equal(fx.service.size(), 0);
  }

  const unavailable = fixture({
    runtimeInspection: async () => { throw new Error('private host detail'); },
  });
  await assert.rejects(
    unavailable.service.issue({
      sessionId: 'owner-session',
      userId: 'owner-user',
      serverId,
      websiteId,
    }),
    (error) => error instanceof ElFinderHandoffError
      && error.code === 'elfinder_handoff_runtime_unavailable'
      && error.status === 503
      && !error.message.includes('private host detail'),
  );
});

test('elFinder handoff expires and is revoked with its Owner session', async () => {
  {
    const fx = fixture();
    const handoff = await fx.service.issue({
      sessionId: 'owner-session',
      userId: 'owner-user',
      serverId,
      websiteId,
    });
    fx.setNow(handoff.expiresAt);
    await assert.rejects(
      fx.service.consume(handoff.capability),
      (error) => error instanceof ElFinderHandoffError && error.code === 'elfinder_handoff_expired',
    );
  }

  {
    const liveSessions = createLiveSessionRegistry();
    const fx = fixture({ liveSessions });
    const handoff = await fx.service.issue({
      sessionId: 'owner-session',
      userId: 'owner-user',
      serverId,
      websiteId,
    });
    assert.equal(fx.service.size(), 1);
    assert.equal(liveSessions.revokeSession('owner-session'), 1);
    assert.equal(fx.service.size(), 0);
    await assert.rejects(
      fx.service.consume(handoff.capability),
      (error) => error instanceof ElFinderHandoffError && error.code === 'elfinder_handoff_invalid',
    );
  }
});
