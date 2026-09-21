import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('site and server terminal surfaces use native sandboxed WebSocket terminal', async () => {
  const [site, operations, terminal] = await Promise.all([
    readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/OperationsPages.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/TerminalPanel.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(site, /scope: 'site', websiteId: domain\.websiteId/);
  assert.match(operations, /scope: 'server', serverId: server\.id/);
  assert.match(terminal, /createTerminalWebSocket/);
  assert.match(terminal, /\/terminal\/capabilities/);
  assert.match(terminal, /new Terminal\(/);
  assert.match(terminal, /type: 'resize'/);
  assert.match(terminal, /terminal\.current\?\.write\(message\.data\)/);
  assert.doesNotMatch(terminal, /localStorage|sessionStorage|window\.prompt|window\.alert|window\.confirm|innerHTML/);
  assert.doesNotMatch(terminal, /[?&](?:capability|token)=/);
});
