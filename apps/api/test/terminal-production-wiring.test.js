import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);

test('production binds ttyd terminal gateway to auth, live-session and capability boundary', async () => {
  const source = await readFile(indexUrl, 'utf8');
  for (const expected of [
    'const liveSessions = createLiveSessionRegistry();',
    'const authStore = createAuthStore({ filePath: authStorePath, liveSessions });',
    'const terminalCapabilityRegistry = createTerminalCapabilityRegistry({ liveSessions });',
    'const ttydSessionManager = createTtydSessionManager({ liveSessions });',
    'ttydSessionManager,',
    "gateway.id !== 'ttyd'",
    "request.headers['x-yunpanel-tool-session']",
    'ttydSessionManager.authorize(toolSessionId, {',
  ]) assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(source, /createTerminalProcessManager/);
  assert.match(source, /createTerminalWebSocketServer/);
});

test('production shutdown revokes sockets and closes ttyd sessions before closing auth storage', async () => {
  const source = await readFile(indexUrl, 'utf8');
  const revokeIndex = source.indexOf("liveSessions.closeAll('server_shutdown');");
  const ttydIndex = source.indexOf("ttydSessionManager.closeAll('server_shutdown');");
  const authCloseIndex = source.indexOf('authStore.close();');
  assert.ok(revokeIndex >= 0);
  assert.ok(ttydIndex > revokeIndex);
  assert.ok(authCloseIndex > ttydIndex);
});


test('production createApp mounts the authenticated ttyd session bridge', async () => {
  const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(source, /mountTtydSessionRoutes/);
  assert.match(source, /ttydSessionManager = null/);
  assert.match(source, /if \(ttydSessionManager\) \{[\s\S]*mountTtydSessionRoutes\(app, \{[\s\S]*terminalCapabilityRegistry,[\s\S]*ttydSessionManager/);
  assert.match(source, /error instanceof TtydSessionError/);
});
