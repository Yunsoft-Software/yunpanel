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

function siteManager(websiteIds = [WEBSITE_ID]) {
  return {
    user: { id: 'manager', role: 'site_manager', websiteIds },
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
    requireTerminalTargetAccess(siteManager(), { scope: 'site', websiteId: WEBSITE_ID }).user.role,
    'site_manager',
  );

  assert.throws(
    () => requireTerminalTargetAccess(siteManager(), { scope: 'server', serverId: 'local-server' }),
    { code: 'terminal_server_forbidden', status: 403 },
  );
  assert.throws(
    () => requireTerminalTargetAccess(siteManager(), { scope: 'site', websiteId: OTHER_WEBSITE_ID }),
    { code: 'terminal_site_forbidden', status: 403 },
  );
  assert.throws(
    () => requireTerminalTargetAccess(siteManager([]), { scope: 'site', websiteId: WEBSITE_ID }),
    { code: 'terminal_site_forbidden', status: 403 },
  );
});
