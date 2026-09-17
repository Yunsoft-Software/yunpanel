import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Website database password rotation uses exact durable apply flow without exposing the secret', async () => {
  const panel = await readFile(new URL('../src/workspace/SiteResourcesPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /rotateDatabaseCredential/);
  assert.match(panel, /previewDatabaseCredentialApply/);
  assert.match(panel, /applyDatabaseCredential/);
  assert.match(panel, /observe\(queued\.job\)/);
  assert.match(panel, /waitForJob\(queued\.job\.id\)/);
  assert.match(panel, /credential: rotatedCredential, rotatedCredential/);
  assert.match(panel, /rotatedCredential: null/);
  assert.match(panel, /confirmation=\{rotateTarget\.credential\.username\}/);
  assert.match(panel, /resourceBusy\('database', binding\.databaseName\)/);
  assert.doesNotMatch(panel, /window\.(?:prompt|confirm|alert)|type="password"|setPassword/);
});
