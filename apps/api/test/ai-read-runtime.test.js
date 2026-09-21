import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiToolRuntime } from '../src/ai-tool-runtime.js';

function fixture() {
  const server = { id: 'server-1', serverId: 'server-1' };
  const website = { id: 'website-1', serverId: 'server-1', applicationId: null, name: 'Site' };
  const domain = { id: 'domain-1', serverId: 'server-1', websiteId: 'website-1', primaryDomain: 'example.com' };
  const zone = { id: 'zone-1', webDomainId: 'domain-1', zoneName: 'example.com', status: 'ready' };
  const certificate = { id: 'cert-1', domainId: 'domain-1', state: 'active', validTo: '2026-12-01T00:00:00.000Z' };
  const mailDomain = { id: 'mail-1', webDomainId: 'domain-1', domainName: 'example.com', status: 'ready' };
  const binding = { id: 'db-1', serverId: 'server-1', websiteId: 'website-1', databaseName: 'app_db' };

  const registry = createAiToolRuntime({
    localServerId: server.id,
    serverRegistry: {
      async listServers() { return [server]; },
      async getServer(id) { return id === server.id ? server : null; },
    },
    websiteRegistry: {
      async listWebsites() { return [website]; },
      async getWebsite(id) { return id === website.id ? website : null; },
    },
    domainRegistry: {
      async listDomains() { return [domain]; },
      async getDomain(id) { return id === domain.id ? domain : null; },
    },
    applicationRegistry: { async getApplication() { return null; } },
    jobRegistry: { async getJob() { return null; }, async listJobs() { return []; } },
    dnsHostingRegistry: {
      async listZones() { return [zone]; },
      async getZone(id) { return id === zone.id ? zone : null; },
    },
    certificateRegistry: {
      async getForDomain(id) { return id === domain.id ? certificate : null; },
    },
    mailDomainRegistry: {
      async listMailDomains() { return [mailDomain]; },
      async getMailDomain(id) { return id === mailDomain.id ? mailDomain : null; },
    },
    databaseBindingRegistry: {
      async listBindings({ serverId, websiteId }) {
        return serverId === server.id && websiteId === website.id ? [binding] : [];
      },
      async getByDatabase({ serverId, databaseName }) {
        return serverId === server.id && databaseName === binding.databaseName ? binding : null;
      },
    },
  });
  return { registry };
}

test('AI read adapters expose DNS, certificate, mail and database control-plane views without secret material', async () => {
  const { registry } = fixture();
  for (const name of ['dns.inspect', 'certificate.inspect', 'mail.inspect', 'database.inspect']) {
    assert.equal(registry.get(name).available, true);
  }

  const dns = await registry.execute({ name: 'dns.inspect', input: { websiteId: 'website-1' } });
  assert.equal(dns.zones[0].zoneName, 'example.com');

  const cert = await registry.execute({ name: 'certificate.inspect', input: { domainId: 'domain-1' } });
  assert.equal(cert.certificate.id, 'cert-1');

  const mail = await registry.execute({ name: 'mail.inspect', input: { mailDomainId: 'mail-1' } });
  assert.equal(mail.mailDomain.domainName, 'example.com');

  const database = await registry.execute({ name: 'database.inspect', input: { websiteId: 'website-1' } });
  assert.equal(database.bindings[0].databaseName, 'app_db');

  const encoded = JSON.stringify({ dns, cert, mail, database });
  assert.equal(encoded.includes('password'), false);
  assert.equal(encoded.includes('privateKey'), false);
});

test('AI read adapters reject ambiguous scopes instead of listing unrelated resources', async () => {
  const { registry } = fixture();
  await assert.rejects(
    registry.execute({ name: 'dns.inspect', input: {} }),
    (error) => error.code === 'invalid_ai_dns_scope',
  );
  await assert.rejects(
    registry.execute({ name: 'certificate.inspect', input: { domainId: 'domain-1', websiteId: 'website-1' } }),
    (error) => error.code === 'invalid_ai_certificate_scope',
  );
  await assert.rejects(
    registry.execute({ name: 'database.inspect', input: {} }),
    (error) => error.code === 'invalid_ai_database_scope',
  );
});
