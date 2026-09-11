import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Debian package installs the Ubuntu Cloudflare Certbot plugin', async () => {
  const control = await readFile(new URL('../../../packaging/debian/control', import.meta.url), 'utf8');
  assert.match(control, /^Depends:.*\bcertbot\b.*\bpython3-certbot-dns-cloudflare\b/m);
});
