import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);
const gatewayUrl = new URL('../../web/server.js', import.meta.url);

test('production webhook and panel deploy share the audited durable application queue', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /const applicationDeployQueue = createApplicationDeployQueue\(\{[\s\S]*applicationRegistry,[\s\S]*applicationEnvironmentRegistry,[\s\S]*jobRegistry,/);
  assert.match(source, /publicWebhookHandler: createGithubWebhookHandler\(\{[\s\S]*queueApplicationDeploy: applicationDeployQueue,/);
  assert.match(source, /createHandler: \(\) => createApp\(\{[\s\S]*applicationDeployQueue,/);
  assert.doesNotMatch(source, /queueApplicationDeploy: durableJobRegistry/);
});

test('restricted web gateway exposes only the exact public GitHub webhook route', async () => {
  const source = await readFile(gatewayUrl, 'utf8');
  assert.match(source, /function isGithubWebhookPath\(pathname\)/);
  assert.match(source, /if \(!clientIp \|\| \(!signedWebhook && !allowedClients\.has\(clientIp\)\)\)/);
  assert.doesNotMatch(source, /pathname\.startsWith\('\/api\/webhooks\/'\)/);
});
