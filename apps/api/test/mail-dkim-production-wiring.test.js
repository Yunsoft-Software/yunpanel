import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => new URL(`../src/${name}`, import.meta.url);
const text = (name) => readFile(source(name), 'utf8');

test('production API shares managed DKIM desired-state and DNS-retirement state with HTTP and local execution', async () => {
  const [indexSource, appSource, configuredSource] = await Promise.all([
    text('index.js'),
    text('app.js'),
    text('configured-local-runtime.js'),
  ]);

  assert.match(indexSource, /YUNPANEL_MAIL_DKIM_ROOT/);
  assert.match(indexSource, /YUNPANEL_MAIL_DKIM_RETIREMENT_STORE/);
  assert.match(indexSource, /createMailDkimRegistry\(\{[\s\S]*?keyRoot:\s*mailDkimRootPath,[\s\S]*?\}\)/);
  assert.match(indexSource, /createMailDkimRetirementRegistry\(\{[\s\S]*?filePath:\s*mailDkimRetirementStorePath,[\s\S]*?getDkimKey:[\s\S]*?mailDkimRegistry\.getKey/);
  assert.match(indexSource, /await mailDkimRetirementRegistry\.init\(\)/);
  assert.match(indexSource, /createMailDiagnosticsInspector\(\)/);
  assert.match(indexSource, /createMailDkimConfigurationService\(\{[\s\S]*?mailDomainRegistry,[\s\S]*?mailDkimRegistry,[\s\S]*?mailDiagnosticsInspector,[\s\S]*?\}\)/);
  assert.match(indexSource, /createApp\(\{[\s\S]*?mailDkimRegistry,[\s\S]*?mailDkimRetirementRegistry,[\s\S]*?mailDiagnosticsInspector,[\s\S]*?mailDkimConfigurationService,[\s\S]*?\}\)/);
  assert.match(indexSource, /startConfiguredLocalRuntime\(\{[\s\S]*?mailDomainRegistry,[\s\S]*?mailConfigurationService,[\s\S]*?mailDkimConfigurationService,[\s\S]*?\}\)/);

  assert.match(appSource, /createMailDkimRetirementRegistry\(\{[\s\S]*?getDkimKey:[\s\S]*?mailDkimRegistry\.getKey/);
  assert.match(appSource, /mailDkimConfigurationService\s*=\s*null/);
  assert.match(appSource, /mountMailDkimRoutes\(app,\s*\{[\s\S]*?mailDkimRegistry,[\s\S]*?mailDkimRetirementRegistry,[\s\S]*?mailDkimConfigurationService,[\s\S]*?jobRegistry:\s*mailDkimConfigurationService\s*\?\s*jobRegistry\s*:\s*null,[\s\S]*?\}\)/);
  assert.match(appSource, /error instanceof MailDkimRetirementRegistryError/);
  assert.match(configuredSource, /mailDkimConfigurationService\s*=\s*null/);
  assert.match(configuredSource, /mailDkimConfigurationService\.materializeApply/);
  assert.match(configuredSource, /loadManagedDkimConfiguration/);
  assert.match(configuredSource, /createMailDkimOperationReceiptStore/);
  assert.match(configuredSource, /operation === OPERATIONS\.MAIL_DKIM_APPLY/);
});

test('production package and lost-ack recovery use canonical DKIM private and retirement stores', async () => {
  const [envSource, postinst, runtimeSource] = await Promise.all([
    readFile(new URL('../../../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../../../packaging/debian/postinst', import.meta.url), 'utf8'),
    text('job-running-mail-dkim-recovery-runtime.js'),
  ]);
  assert.match(envSource, /^YUNPANEL_MAIL_DKIM_ROOT=.data\/mail-dkim$/m);
  assert.match(envSource, /^YUNPANEL_MAIL_DKIM_RETIREMENT_STORE=.data\/mail-dkim-retirement-registry\.json$/m);
  assert.match(postinst, /YUNPANEL_MAIL_DKIM_ROOT=\/var\/lib\/yunpanel\/control-plane\/mail-dkim/);
  assert.match(postinst, /YUNPANEL_MAIL_DKIM_RETIREMENT_STORE=\/var\/lib\/yunpanel\/control-plane\/mail-dkim-retirement-registry\.json/);
  assert.match(runtimeSource, /env\.YUNPANEL_MAIL_DKIM_ROOT/);
  assert.doesNotMatch(runtimeSource, /YUNPANEL_MAIL_DKIM_KEY_ROOT/);
});
