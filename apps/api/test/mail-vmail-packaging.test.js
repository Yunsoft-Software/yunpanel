import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const postinstUrl = new URL('../../../packaging/debian/postinst', import.meta.url);

test('Debian package provisions a dedicated non-login vmail identity and canonical mail root', async () => {
  const postinst = await readFile(postinstUrl, 'utf8');

  assert.match(postinst, /addgroup --system vmail/);
  assert.match(
    postinst,
    /adduser --system --ingroup vmail --home \/var\/lib\/yunpanel\/mail --no-create-home --shell \/usr\/sbin\/nologin vmail/,
  );
  assert.match(
    postinst,
    /install -d -o vmail -g vmail -m 0750 \/var\/lib\/yunpanel\/mail/,
  );
  assert.doesNotMatch(postinst, /adduser vmail (?:yunpanel|www-data)/);
});
