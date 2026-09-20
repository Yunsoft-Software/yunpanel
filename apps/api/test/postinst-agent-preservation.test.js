import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const postinstUrl = new URL('../../../packaging/debian/postinst', import.meta.url);

test('package installation and upgrades disable and retire the legacy agent', async () => {
  const script = await readFile(postinstUrl, 'utf8');
  assert.match(script, /systemctl enable yunpanel-api\.service yunpanel-web\.service/);
  assert.match(script, /systemctl disable --now yun-agent\.service/);
  assert.doesNotMatch(script, /systemctl enable yun-agent\.service/);
  assert.doesNotMatch(script, /systemctl start yun-agent\.service/);
  assert.doesNotMatch(script, /systemctl try-restart yun-agent\.service/);
});
