import { hostingAuthFixture } from './hosting-auth-fixture.js';
import { createHostingAccountStore } from '../src/hosting-account-store.js';
import { hostingWebsiteDigest } from '../src/hosting-site-allocation-store.js';

export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function website(n = 1, changes = {}) {
  return { id: uuid(n), serverId: uuid(100), name: 'Example', applicationId: null,
    dockerWorkloadId: null, managedComposeBinding: null, runtimeType: 'proxy',
    documentRoot: null, unixUser: null, proxyTarget: { host: '127.0.0.1', port: 8080, websocket: true }, revision: 1, ...changes };
}
export function allocation(n = 1, customerId = 'customer-a') {
  const site = website(n);
  return { operationId: uuid(1000 + n), websiteId: site.id, customerId, serverId: site.serverId,
    intentDigest: 'a'.repeat(64), websiteDigest: hostingWebsiteDigest(site) };
}
export function siteFixture(t, { filePath, maxWebsites = 1, maxCustomers = 5, audit, seed = true } = {}) {
  const f = hostingAuthFixture(filePath);
  t.after(() => f.db.close());
  if (seed) {
    f.addUser('owner', { role: 'owner' });
    for (const id of ['reseller-a', 'reseller-b', 'customer-a', 'customer-b', 'customer-c', 'direct']) f.addUser(id);
  }
  f.token = seed ? f.session('owner') : 'token-owner';
  f.store = createHostingAccountStore({ ...f, ...(audit ? { audit } : {}) });
  if (seed) {
    for (const id of ['reseller-a', 'reseller-b']) f.store.registerReseller(f.token, f.requireManagement, {
      userId: id, expectedUserRevision: 1, limits: { maxCustomers, maxWebsites },
    });
    for (const [userId, resellerId] of [['customer-a', 'reseller-a'], ['customer-b', 'reseller-a'], ['customer-c', 'reseller-b'], ['direct', null]]) {
      f.store.registerCustomer(f.token, f.requireManagement, { userId, resellerId, expectedUserRevision: 1 });
    }
  }
  f.preview = (p = allocation()) => f.store.siteAllocations.preview(f.token, f.requireManagement, p);
  f.reserve = (p = allocation()) => f.store.siteAllocations.reserve(f.token, f.requireManagement, p);
  f.complete = (p = allocation(), w = website()) => f.store.siteAllocations.complete(f.token, f.requireManagement, p, w);
  f.get = (id = 'reseller-a') => f.store.get(f.token, f.requireManagement, id);
  f.count = (table) => f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  return f;
}
