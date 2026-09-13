import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexUrl = new URL('../src/index.js', import.meta.url);
const appUrl = new URL('../src/app.js', import.meta.url);
const runtimeUrl = new URL('../src/job-running-database-credential-recovery-runtime.js', import.meta.url);
const cliUrl = new URL('../../../scripts/job-recovery.mjs', import.meta.url);
const envUrl = new URL('../../../.env.example', import.meta.url);
const postinstUrl = new URL('../../../packaging/debian/postinst', import.meta.url);

test('production boot initializes encrypted database credential state and local execution', async () => {
  const source = await readFile(indexUrl, 'utf8');
  assert.match(source, /createDatabaseCredentialRegistry/);
  assert.match(source, /YUNPANEL_DATABASE_CREDENTIAL_STORE/);
  assert.match(source, /masterKey: process\.env\.YUNPANEL_SECRET_MASTER_KEY/);
  assert.match(source, /getDatabaseBinding: async \(bindingId\) => databaseBindingRegistry\.getBinding\(bindingId\)/);
  assert.match(source, /createDatabaseCredentialMaterializer/);
  assert.match(source, /createLocalDatabaseCredentialOperation/);
  assert.match(source, /createDatabaseCredentialApplyService/);
  assert.match(source, /databaseCredentialRegistry,/);
  assert.match(source, /databaseCredentialApplyService,/);
  assert.match(source, /databaseCredentialOperation: localDatabaseCredentialOperation/);
});

test('production app mounts guarded database credential lifecycle only with complete dependencies', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /mountDatabaseCredentialRoutes/);
  assert.match(source, /databaseBindingRegistry && databaseCredentialRegistry && databaseCredentialApply/);
  assert.match(source, /databaseCredentialRegistry,/);
  assert.match(source, /databaseCredentialApplyService: databaseCredentialApply/);
  assert.match(source, /DatabaseCredentialApplyError/);
  assert.match(source, /DatabaseCredentialHttpError/);
  assert.match(source, /DatabaseCredentialRegistryError/);
});

test('packaged recovery reconstructs encrypted desired state without mutation replay', async () => {
  const [runtime, cli] = await Promise.all([readFile(runtimeUrl, 'utf8'), readFile(cliUrl, 'utf8')]);
  assert.match(runtime, /materializePublic/);
  assert.match(runtime, /createDatabaseCredentialEvidenceInspector/);
  assert.match(runtime, /createDatabaseCredentialOperationReceiptStore/);
  assert.match(runtime, /getDatabaseBinding: async \(id\) => databaseBindingRegistry\.getBinding\(id\)/);
  assert.doesNotMatch(runtime, /applyCredential\(|deleteCredential\(/);
  assert.match(cli, /recover-database-credential/);
});

test('source and Debian upgrade environments retain encrypted database credential store path', async () => {
  const [envSource, postinst] = await Promise.all([readFile(envUrl, 'utf8'), readFile(postinstUrl, 'utf8')]);
  assert.match(envSource, /^YUNPANEL_DATABASE_CREDENTIAL_STORE=\.data\/database-credential-registry\.json$/m);
  assert.match(postinst, /YUNPANEL_DATABASE_CREDENTIAL_STORE=\/var\/lib\/yunpanel\/control-plane\/database-credential-registry\.json/);
});
