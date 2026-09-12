import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => new URL(`../src/${name}`, import.meta.url);

async function text(name) {
  return readFile(source(name), 'utf8');
}

test('production API constructs and shares quota and forwarding managed mail state', async () => {
  const [indexSource, appSource] = await Promise.all([
    text('index.js'),
    text('app.js'),
  ]);

  assert.match(indexSource, /createMailboxQuotaRegistry\(\{/);
  assert.match(indexSource, /createMailboxForwardingRegistry\(\{/);
  assert.match(indexSource, /YUNPANEL_MAILBOX_FORWARDING_STORE/);
  assert.match(indexSource, /createMailConfigurationService\(\{[\s\S]*?mailDomainRegistry,[\s\S]*?mailboxRegistry,[\s\S]*?mailAliasRegistry,[\s\S]*?mailboxQuotaRegistry,[\s\S]*?mailboxForwardingRegistry,[\s\S]*?\}\)/);
  assert.match(indexSource, /createApp\(\{[\s\S]*?mailboxQuotaRegistry,[\s\S]*?mailboxForwardingRegistry,[\s\S]*?mailConfigurationService,[\s\S]*?\}\)/);
  assert.match(indexSource, /startConfiguredLocalRuntime\(\{[\s\S]*?mailDomainRegistry,[\s\S]*?mailConfigurationService,[\s\S]*?\}\)/);

  assert.match(appSource, /createMailboxForwardingRegistry\(\{/);
  assert.match(appSource, /createMailConfigurationService\(\{[\s\S]*?mailboxQuotaRegistry,[\s\S]*?mailboxForwardingRegistry,[\s\S]*?\}\)/);
  assert.match(appSource, /mountMailboxRoutes\(app,\s*\{[\s\S]*?mailboxQuotaRegistry,[\s\S]*?mailboxForwardingRegistry,[\s\S]*?\}\)/);
  assert.match(appSource, /mountMailboxQuotaRoutes\(app,\s*\{[\s\S]*?mailboxQuotaRegistry,[\s\S]*?mailboxQuotaInspector,[\s\S]*?mailboxRegistry,[\s\S]*?\}\)/);
  assert.match(appSource, /mountMailboxForwardingRoutes\(app,\s*\{[\s\S]*?mailboxForwardingRegistry,[\s\S]*?mailboxRegistry,[\s\S]*?\}\)/);
  assert.match(appSource, /mountMailConfigurationRoutes\(app,\s*\{[\s\S]*?mailConfigurationService,[\s\S]*?mailDomainRegistry,[\s\S]*?domainRegistry,[\s\S]*?jobRegistry,[\s\S]*?localServerId,[\s\S]*?\}\)/);
  assert.match(appSource, /error instanceof MailboxForwardingRegistryError/);
  assert.match(appSource, /error instanceof MailboxQuotaRegistryError/);
  assert.match(appSource, /error instanceof MailboxQuotaHttpError/);
  assert.match(appSource, /error instanceof MailConfigurationError/);
  assert.match(appSource, /error instanceof MailConfigurationHttpError/);
});

test('configured local runtime keeps protected material private and persists mail crash evidence', async () => {
  const [configuredSource, hostSource] = await Promise.all([
    text('configured-local-runtime.js'),
    text('local-host-operations.js'),
  ]);

  assert.match(configuredSource, /loadManagedMailConfiguration/);
  assert.match(configuredSource, /mailConfigurationService\.materializeTransition/);
  assert.match(configuredSource, /operation === OPERATIONS\.MAIL_CONFIG_APPLY/);
  assert.match(configuredSource, /mailConfigOperationReceipts\.write/);
  assert.match(configuredSource, /mailDomainRegistry,/);

  assert.match(hostSource, /OPERATIONS\.MAIL_CONFIG_APPLY/);
  assert.match(hostSource, /stageConfiguration\(bundle\.preview/);
  assert.match(hostSource, /backupConfiguration\(bundle\.preview/);
  assert.match(hostSource, /activateConfiguration\(bundle\.preview/);
  assert.doesNotMatch(configuredSource, /sensitiveArtifacts\s*:/);
});
