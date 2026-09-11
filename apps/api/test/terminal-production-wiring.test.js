import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);

test('production binds terminal upgrade to the common auth, live-session, PTY and audit boundary', async () => {
  const source = await readFile(indexUrl, 'utf8');
  for (const expected of [
    'const liveSessions = createLiveSessionRegistry();',
    'const authStore = createAuthStore({ filePath: authStorePath, liveSessions });',
    'const terminalCapabilityRegistry = createTerminalCapabilityRegistry({ liveSessions });',
    'const terminalProcessManager = createTerminalProcessManager();',
    'const terminalAuthenticator = createLiveConnectionAuthenticator({',
    'const terminalWebSocket = createTerminalWebSocketServer({',
    'terminalCapabilityRegistry,',
    'terminalProcessManager,',
    'liveSessions,',
    'audit: authStore.audit,',
    "server.on('upgrade', terminalWebSocket.handleUpgrade);",
  ]) assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(source, /server\.on\('upgrade',[^\n]+404 Not Found/);
});

test('production shutdown revokes sockets and unused capabilities before closing auth storage', async () => {
  const source = await readFile(indexUrl, 'utf8');
  const revokeIndex = source.indexOf("liveSessions.closeAll('server_shutdown');");
  const transportIndex = source.indexOf("terminalWebSocket.closeAll('server_shutdown');");
  const authCloseIndex = source.indexOf('authStore.close();');
  assert.ok(revokeIndex >= 0);
  assert.ok(transportIndex > revokeIndex);
  assert.ok(authCloseIndex > transportIndex);
});
