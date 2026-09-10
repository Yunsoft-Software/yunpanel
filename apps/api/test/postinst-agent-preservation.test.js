import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const postinstUrl = new URL('../../../packaging/debian/postinst', import.meta.url);

test('package upgrades do not re-enable the legacy agent after local migration', async () => {
  const script = await readFile(postinstUrl, 'utf8');
  assert.match(script, /systemctl enable yunpanel-api\.service yunpanel-web\.service/);
  assert.doesNotMatch(script, /systemctl enable yunpanel-api\.service yun-agent\.service yunpanel-web\.service/);
  const freshInstallBlock = script.match(/if \[ -z "\$\{2:-\}" \]; then([\s\S]+?)\n  fi/)?.[1] ?? '';
  assert.match(freshInstallBlock, /\[ -f \/etc\/yunpanel\/agent\/agent\.env \]/);
  assert.match(freshInstallBlock, /systemctl enable yun-agent\.service/);
  assert.equal((script.match(/systemctl enable yun-agent\.service/g) ?? []).length, 1);
});
