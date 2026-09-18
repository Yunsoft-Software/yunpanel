import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const postinstUrl = new URL('../../../packaging/debian/postinst', import.meta.url);
const tmpfilesUrl = new URL('../../../packaging/tmpfiles/yunpanel.conf', import.meta.url);

test('Debian package prepares a dedicated elFinder broker identity without broad web-group membership', async () => {
  const [postinst, tmpfiles] = await Promise.all([
    readFile(postinstUrl, 'utf8'),
    readFile(tmpfilesUrl, 'utf8'),
  ]);

  assert.match(postinst, /addgroup --system yunpanel-elfinder/);
  assert.match(
    postinst,
    /adduser --system --ingroup yunpanel-elfinder --home \/var\/lib\/yunpanel\/elfinder --no-create-home --shell \/usr\/sbin\/nologin yunpanel-elfinder/,
  );
  assert.doesNotMatch(postinst, /adduser yunpanel-elfinder www-data/);
  assert.doesNotMatch(postinst, /adduser yunpanel-elfinder yunpanel/);

  assert.match(postinst, /install -d -o yunpanel-elfinder -g yunpanel-elfinder -m 0700 \/var\/lib\/yunpanel\/elfinder/);
  assert.match(postinst, /install -d -o root -g yunpanel-elfinder -m 0750 \/run\/yunpanel-elfinder/);
  assert.match(postinst, /install -d -o root -g yunpanel-elfinder -m 0750 \/usr\/lib\/yunpanel\/elfinder/);
  assert.match(tmpfiles, /^d \/run\/yunpanel-elfinder 0750 root yunpanel-elfinder - -$/m);
});
