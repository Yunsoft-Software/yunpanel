import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => new URL(`../src/${name}`, import.meta.url);

async function text(name) {
  return readFile(source(name), 'utf8');
}

test('production bootstrap persists and shares one Roundcube Domain mapping registry', async () => {
  const [indexSource, appSource, postinstSource] = await Promise.all([
    text('index.js'),
    text('app.js'),
    readFile(new URL('../../../packaging/debian/postinst', import.meta.url), 'utf8'),
  ]);

  assert.match(indexSource, /YUNPANEL_ROUNDCUBE_DOMAIN_MAPPING_STORE/);
  assert.match(indexSource, /roundcube-domain-mapping-registry\.json/);
  assert.match(indexSource, /createRoundcubeDomainMappingRegistry\(\{[\s\S]*?getMailDomain:[\s\S]*?getDomain:[\s\S]*?getCertificate:[\s\S]*?inspectCertificate:[\s\S]*?\}\)/);
  assert.match(indexSource, /await roundcubeDomainMappingRegistry\.init\(\)/);
  assert.match(indexSource, /createRoundcubeConfigurationService\(\{[\s\S]*?roundcubeDomainMappingRegistry,[\s\S]*?certificateRegistry,[\s\S]*?certificateMaterialManager,[\s\S]*?\}\)/);
  assert.match(indexSource, /createRoundcubeDomainMappingService\(\{[\s\S]*?registry: roundcubeDomainMappingRegistry,[\s\S]*?roundcubeConfigurationService,[\s\S]*?jobRegistry,[\s\S]*?\}\)/);
  assert.match(indexSource, /createRoundcubeWebmailEndpointResolver\(\{[\s\S]*?roundcubeDomainMappingRegistry,[\s\S]*?roundcubeConfigurationService,[\s\S]*?jobRegistry,[\s\S]*?\}\)/);
  assert.match(indexSource, /createApp\(\{[\s\S]*?roundcubeWebmailEndpointResolver,[\s\S]*?roundcubeConfigurationService,[\s\S]*?roundcubeDomainMappingRegistry,[\s\S]*?roundcubeDomainMappingService,[\s\S]*?\}\)/);

  assert.match(appSource, /roundcubeDomainMappingRegistry = null/);
  assert.match(appSource, /roundcubeDomainMappingService = null/);
  assert.match(appSource, /roundcubeWebmailEndpointResolver = null/);
  assert.match(appSource, /mountRoundcubeDomainMappingRoutes\(app,\s*\{[\s\S]*?service: roundcubeDomainMappingService,[\s\S]*?\}\)/);
  assert.match(appSource, /webmailMappings:[\s\S]*?listActiveMappings[\s\S]*?listInFlight/);
  assert.match(postinstSource, /YUNPANEL_ROUNDCUBE_DOMAIN_MAPPING_STORE=\/var\/lib\/yunpanel\/control-plane\/roundcube-domain-mapping-registry\.json/);
});

test('PowerDNS mail desired state receives only live shared webmail readiness', async () => {
  const [appSource, powerDnsSource, mailIntentSource] = await Promise.all([
    text('app.js'),
    text('powerdns-http.js'),
    text('dns-zone-mail-intent.js'),
  ]);

  assert.match(appSource, /mountPowerDnsRoutes\(app,\s*\{[\s\S]*?roundcubeWebmailEndpointResolver,[\s\S]*?\}\)/);
  assert.match(powerDnsSource, /roundcubeWebmailEndpointResolver = null/);
  assert.match(powerDnsSource, /createDnsZoneMailIntentResolver\(\{[\s\S]*?roundcubeWebmailEndpointResolver,[\s\S]*?\}\)/);
  assert.match(mailIntentSource, /roundcubeWebmailEndpointResolver\.resolve\(\{ mailDomain, domain: scoped \}\)/);
  assert.match(mailIntentSource, /webmailEnabled: true,[\s\S]*?webmailReady: webmail\.intent !== null/);
  assert.match(mailIntentSource, /roundcubeWebmailMappingRevision/);
  assert.match(mailIntentSource, /roundcubeWebmailPreviewSha256/);
});

test('Domain removal uses the same mapping inventory and durable mapping lifecycle', async () => {
  const [indexSource, productionSource, runtimeSource, operationSource] = await Promise.all([
    text('index.js'),
    text('domain-removal-production-runtime.js'),
    text('domain-removal-runtime.js'),
    text('domain-removal-operation-registry.js'),
  ]);

  assert.match(indexSource, /createMailDomainRemovalProductionRuntime\(\{[\s\S]*?roundcubeDomainMappingRegistry,[\s\S]*?roundcubeDomainMappingService,[\s\S]*?\}\)/);
  assert.match(productionSource, /roundcubeDomainMappingRegistry\.listActiveMappings/);
  assert.match(productionSource, /roundcubeDomainMappingRegistry\.listInFlight/);
  assert.match(productionSource, /webmailMappings: webmailMappingImpactProvider/);
  assert.match(productionSource, /createDomainRemovalRuntime\(\{[\s\S]*?roundcubeDomainMappingRegistry,[\s\S]*?roundcubeDomainMappingService,[\s\S]*?\}\)/);
  assert.match(runtimeSource, /'webmail_mapping'/);
  assert.match(runtimeSource, /webmailRemovalOperationId/);
  assert.match(runtimeSource, /state === 'removed'/);
  assert.match(runtimeSource, /domain_removal_webmail_absence_unowned/);
  assert.match(operationSource, /add\('webmail_mapping', mapping\.id\)/);
  assert.match(operationSource, /certificate[\s\S]*?webmail_mapping[\s\S]*?mail_domain/);
});

test('Mail Domain configuration, impact and removal runtime wire shared Roundcube mapping registry', async () => {
  const [indexSource, appSource, mailRemovalSource] = await Promise.all([
    text('index.js'),
    text('app.js'),
    text('mail-domain-removal-production-runtime.js'),
  ]);

  assert.match(indexSource, /createMailConfigurationService\(\{[\s\S]*?roundcubeDomainMappingRegistry,[\s\S]*?\}\)/);
  assert.match(appSource, /createMailConfigurationService\(\{[\s\S]*?roundcubeDomainMappingRegistry[\s\S]*?\}\)/);
  assert.match(appSource, /createMailDeleteImpactService\(\{[\s\S]*?roundcubeDomainMappingRegistry[\s\S]*?\}\)/);
  assert.match(mailRemovalSource, /createMailDeleteImpactService\(\{[\s\S]*?roundcubeDomainMappingRegistry,[\s\S]*?\}\)/);
  assert.match(mailRemovalSource, /createMailDomainRemovalPlanService\(\{[\s\S]*?roundcubeDomainMappingRegistry,[\s\S]*?\}\)/);
});
