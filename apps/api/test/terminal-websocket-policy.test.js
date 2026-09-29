import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalWebSocketInternals } from '../src/terminal-websocket.js';

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WEBSITE_ID = '22222222-2222-4222-8222-222222222222';

function owner() {
  return {
    user: { id: 'owner', role: 'owner' },
    access: { mode: 'management', permissions: ['*'] },
    security: { managementAllowed: true },
  };
}

function siteActor(role = 'site_manager', websiteIds = [WEBSITE_ID], active = true) {
  return {
    user: { id: `${role}-user`, role, websiteIds, active },
    access: { mode: 'site_management', permissions: ['sites.manage'] },
    security: { managementAllowed: true },
  };
}

test('terminal WebSocket target policy keeps root Owner-only and site access bound to current grants', () => {
  const { requireTerminalTargetAccess } = terminalWebSocketInternals;
  assert.equal(
    requireTerminalTargetAccess(owner(), { scope: 'server', serverId: 'local-server' }).user.role,
    'owner',
  );
  assert.equal(
    requireTerminalTargetAccess(owner(), { scope: 'site', websiteId: WEBSITE_ID }).user.role,
    'owner',
  );
  assert.equal(
    requireTerminalTargetAccess(siteActor(), { scope: 'site', websiteId: WEBSITE_ID }).user.role,
    'site_manager',
  );
  for (const role of ['reseller', 'customer']) {
    assert.equal(
      requireTerminalTargetAccess(siteActor(role), { scope: 'site', websiteId: WEBSITE_ID }).user.role,
      role,
    );
    assert.throws(
      () => requireTerminalTargetAccess(siteActor(role), { scope: 'site', websiteId: OTHER_WEBSITE_ID }),
      { code: 'terminal_site_forbidden', status: 403 },
    );
  }

  assert.throws(
    () => requireTerminalTargetAccess(siteActor(), { scope: 'server', serverId: 'local-server' }),
    { code: 'terminal_server_forbidden', status: 403 },
  );
  assert.throws(
    () => requireTerminalTargetAccess(siteActor(), { scope: 'site', websiteId: OTHER_WEBSITE_ID }),
    { code: 'terminal_site_forbidden', status: 403 },
  );
  assert.throws(
    () => requireTerminalTargetAccess(siteActor('site_manager', []), { scope: 'site', websiteId: WEBSITE_ID }),
    { code: 'terminal_site_forbidden', status: 403 },
  );
  for (const role of ['site_manager', 'reseller', 'customer']) {
    assert.throws(
      () => requireTerminalTargetAccess(siteActor(role, [WEBSITE_ID], false), { scope: 'site', websiteId: WEBSITE_ID }),
      { code: 'terminal_site_forbidden', status: 403 },
    );
  }
});
