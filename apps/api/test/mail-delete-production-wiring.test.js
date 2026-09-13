import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appUrl = new URL('../src/app.js', import.meta.url);
const mailboxHttpUrl = new URL('../src/mailbox-http.js', import.meta.url);

test('production app wires fresh impact into mail data delete and guarded finalization', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /createMailDeleteFinalizeService/);
  assert.match(source, /mailDeleteImpactService: mailDeleteImpact/);
  assert.match(source, /mailDeleteFinalizeService: mailDeleteFinalize/);
  assert.match(source, /mountMailDomainDeleteRoute\(app, \{ mailDeleteFinalizeService: mailDeleteFinalize \}\)/);
  assert.match(source, /MailDeleteFinalizeError/);
});

test('local mailbox DELETE cannot mount without the guarded finalizer', async () => {
  const source = await readFile(mailboxHttpUrl, 'utf8');
  assert.match(source, /Local mailbox deletion requires the guarded mail data finalizer/);
  assert.match(source, /FINALIZE_DELETE_FIELDS/);
  assert.match(source, /deleteJobId/);
  assert.match(source, /finalizeMailbox/);
});
