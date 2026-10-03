import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import {
  initializeCustomerQuotaSchema,
  validateCustomerQuotas,
  assertCustomerQuotaCapacity,
  assertCustomerQuotaWithinResellerCapacity,
  RESOURCE_METRICS,
  evaluateResourceMetric,
  buildSiteConsumptionReport,
  assertSiteResourceLimit,
  assertSiteIsolation,
  createSiteConsumptionInspector,
} from '../src/customer-quotas.js';
import { mountWebsiteRoutes } from '../src/website-http.js';

test('Customer Quota: validateCustomerQuotas strictly verifies fields and bounds', () => {
  const valid = validateCustomerQuotas({
    maxWebsites: 5,
    maxDiskMb: 10240,
    maxTrafficMb: 51200,
    maxDatabases: 10,
  });
  assert.deepEqual(valid, {
    maxWebsites: 5,
    maxDiskMb: 10240,
    maxTrafficMb: 51200,
    maxDatabases: 10,
  });

  // Allows null for unlimited
  const unlimited = validateCustomerQuotas({
    maxWebsites: null,
    maxDiskMb: null,
    maxTrafficMb: null,
    maxDatabases: null,
  });
  assert.deepEqual(unlimited, {
    maxWebsites: null,
    maxDiskMb: null,
    maxTrafficMb: null,
    maxDatabases: null,
  });

  // Rejects invalid types or missing fields
  assert.throws(() => validateCustomerQuotas(null), (err) => err.code === 'invalid_customer_quotas' && err.status === 400);
  assert.throws(() => validateCustomerQuotas({}), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas({ maxWebsites: -1 }), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas({ maxWebsites: 5, maxDiskMb: 'invalid', maxTrafficMb: null, maxDatabases: null }), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas({ maxWebsites: 5, maxDiskMb: 100, maxTrafficMb: 100, maxDatabases: 1, extraField: true }), (err) => err.code === 'invalid_customer_quotas');
});

test('Customer Quota: assertCustomerQuotaCapacity verifies capacity and throws 409 on breach', () => {
  const quotas = { maxWebsites: 3, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 };

  // Under limit: ok
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { websites: 2 }, resource: 'websites', amount: 1 }));
  // Exactly at limit: ok
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { websites: 0 }, resource: 'websites', amount: 3 }));
  // Exceeded: throws 409 customer_quota_exceeded
  assert.throws(
    () => assertCustomerQuotaCapacity({ quotas, usage: { websites: 3 }, resource: 'websites', amount: 1 }),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );

  // Disk capacity check
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { diskMb: 1024 }, resource: 'diskMb', amount: 1024 }));
  assert.throws(
    () => assertCustomerQuotaCapacity({ quotas, usage: { diskMb: 2000 }, resource: 'diskMb', amount: 100 }),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );

  // Unlimited quota allows addition
  const unlimitedQuotas = { maxWebsites: null, maxDiskMb: null, maxTrafficMb: null, maxDatabases: null };
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas: unlimitedQuotas, usage: { websites: 999 }, resource: 'websites', amount: 50 }));
});

test('Customer Quota: assertCustomerQuotaWithinResellerCapacity enforces RS-01-03 count limits only', () => {
  // Reseller has maxWebsites: 10
  const resellerLimits = { maxCustomers: 5, maxWebsites: 10 };

  // Customer within reseller limit
  assert.doesNotThrow(() => assertCustomerQuotaWithinResellerCapacity({
    customerQuotas: { maxWebsites: 5 },
    resellerLimits,
  }));

  // Customer exact reseller limit
  assert.doesNotThrow(() => assertCustomerQuotaWithinResellerCapacity({
    customerQuotas: { maxWebsites: 10 },
    resellerLimits,
  }));

  // Customer exceeds reseller limit
  assert.throws(
    () => assertCustomerQuotaWithinResellerCapacity({
      customerQuotas: { maxWebsites: 11 },
      resellerLimits,
    }),
    (err) => err.code === 'reseller_limit_reached' && err.status === 409,
  );

  // Customer cannot have unlimited websites if reseller has finite limit
  assert.throws(
    () => assertCustomerQuotaWithinResellerCapacity({
      customerQuotas: { maxWebsites: null },
      resellerLimits,
    }),
    (err) => err.code === 'reseller_limit_reached' && err.status === 409,
  );

  // Unlimited reseller allows any customer website quota
  assert.doesNotThrow(() => assertCustomerQuotaWithinResellerCapacity({
    customerQuotas: { maxWebsites: null },
    resellerLimits: { maxCustomers: null, maxWebsites: null },
  }));
  assert.doesNotThrow(() => assertCustomerQuotaWithinResellerCapacity({
    customerQuotas: { maxWebsites: 1000 },
    resellerLimits: { maxCustomers: null, maxWebsites: null },
  }));

  // RS-01-03: No separate package, subscription, or overselling engine is required or enforced
  assert.doesNotThrow(() => assertCustomerQuotaWithinResellerCapacity({
    customerQuotas: { maxWebsites: 4, customPackage: undefined, subscriptionPlan: undefined },
    resellerLimits: { maxCustomers: 10, maxWebsites: 10 },
  }));
});

test('PROD-15 Site Consumption: RESOURCE_METRICS defines disk, inode, mail, db, cpu, memory, process', () => {
  const keys = Object.keys(RESOURCE_METRICS);
  assert.ok(keys.includes('diskSpaceMb'), 'diskSpaceMb metric must be defined');
  assert.ok(keys.includes('diskInodes'), 'diskInodes metric must be defined');
  assert.ok(keys.includes('mailStorageMb'), 'mailStorageMb metric must be defined');
  assert.ok(keys.includes('mailboxes'), 'mailboxes metric must be defined');
  assert.ok(keys.includes('databaseStorageMb'), 'databaseStorageMb metric must be defined');
  assert.ok(keys.includes('databases'), 'databases metric must be defined');
  assert.ok(keys.includes('cpuPercent'), 'cpuPercent metric must be defined');
  assert.ok(keys.includes('memoryMb'), 'memoryMb metric must be defined');
  assert.ok(keys.includes('processCount'), 'processCount metric must be defined');

  // Verify categories
  assert.equal(RESOURCE_METRICS.diskSpaceMb.category, 'disk');
  assert.equal(RESOURCE_METRICS.diskInodes.category, 'disk');
  assert.equal(RESOURCE_METRICS.mailStorageMb.category, 'mail');
  assert.equal(RESOURCE_METRICS.mailboxes.category, 'mail');
  assert.equal(RESOURCE_METRICS.databaseStorageMb.category, 'database');
  assert.equal(RESOURCE_METRICS.databases.category, 'database');
  assert.equal(RESOURCE_METRICS.cpuPercent.category, 'cpu');
  assert.equal(RESOURCE_METRICS.memoryMb.category, 'memory');
  assert.equal(RESOURCE_METRICS.processCount.category, 'process');
});

test('PROD-15 Three-Way Distinction: separates measured usage, defined limit, and enforced limit', () => {
  const metric = evaluateResourceMetric({
    metric: 'diskSpaceMb',
    measured: 350,
    definedLimit: 1000,
    enforcedLimit: 800,
  });

  // Verify three distinct fields
  assert.equal(metric.measured, 350, 'measured usage must be 350');
  assert.equal(metric.definedLimit, 1000, 'defined limit must be 1000');
  assert.equal(metric.enforcedLimit, 800, 'enforced limit must be 800');
  assert.equal(metric.effectiveLimit, 800, 'enforced limit takes precedence as effective limit');
  assert.equal(metric.unknown, false);
  assert.equal(metric.status, 'ok');
  assert.equal(metric.exceeded, false);
  assert.equal(metric.warning, false);
});

test('PROD-15 Unknown Values: unknown or unmeasurable values must NEVER be converted to zero', () => {
  // When measurement is unknown / null / undefined / unmeasurable
  const unknownMetric = evaluateResourceMetric({
    metric: 'diskSpaceMb',
    measured: null,
    definedLimit: 1000,
    enforcedLimit: 800,
  });

  assert.equal(unknownMetric.measured, null, 'unknown measured usage must be null');
  assert.notEqual(unknownMetric.measured, 0, 'unknown measured usage must NOT be 0');
  assert.equal(unknownMetric.unknown, true, 'unknown must be true');
  assert.equal(unknownMetric.status, 'unknown', 'status must be unknown');

  // Undefined measured
  const undefinedMetric = evaluateResourceMetric({
    metric: 'cpuPercent',
    measured: undefined,
    definedLimit: 100,
  });
  assert.equal(undefinedMetric.measured, null, 'undefined measured must be null');
  assert.notEqual(undefinedMetric.measured, 0, 'undefined measured must NOT be 0');
  assert.equal(undefinedMetric.unknown, true);
  assert.equal(undefinedMetric.status, 'unknown');

  // Genuine zero measurement MUST be preserved as 0 and NOT considered unknown
  const zeroMetric = evaluateResourceMetric({
    metric: 'mailStorageMb',
    measured: 0,
    definedLimit: 500,
    enforcedLimit: 500,
  });
  assert.equal(zeroMetric.measured, 0, 'genuine zero measurement must be 0');
  assert.equal(zeroMetric.unknown, false, 'genuine zero is known (unknown = false)');
  assert.equal(zeroMetric.status, 'ok');
});

test('PROD-15 Limit Breach & Warning: distinguishes ok, warning (85%), and exceeded', () => {
  // OK: 400 / 1000 = 40%
  const okMetric = evaluateResourceMetric({
    metric: 'memoryMb',
    measured: 400,
    definedLimit: 1000,
  });
  assert.equal(okMetric.status, 'ok');
  assert.equal(okMetric.warning, false);
  assert.equal(okMetric.exceeded, false);

  // Warning: 860 / 1000 = 86% >= 85%
  const warningMetric = evaluateResourceMetric({
    metric: 'memoryMb',
    measured: 860,
    definedLimit: 1000,
  });
  assert.equal(warningMetric.status, 'warning');
  assert.equal(warningMetric.warning, true);
  assert.equal(warningMetric.exceeded, false);

  // Exceeded: 1050 / 1000 = 105%
  const exceededMetric = evaluateResourceMetric({
    metric: 'memoryMb',
    measured: 1050,
    definedLimit: 1000,
  });
  assert.equal(exceededMetric.status, 'exceeded');
  assert.equal(exceededMetric.warning, false);
  assert.equal(exceededMetric.exceeded, true);

  // Enforced limit takes precedence over defined limit
  const enforcedExceeded = evaluateResourceMetric({
    metric: 'processCount',
    measured: 60,
    definedLimit: 100, // defined allows 100
    enforcedLimit: 50,  // but systemd TasksMax enforces 50
  });
  assert.equal(enforcedExceeded.status, 'exceeded');
  assert.equal(enforcedExceeded.exceeded, true);
});

test('PROD-15 buildSiteConsumptionReport: builds complete 6-category report', () => {
  const report = buildSiteConsumptionReport({
    websiteId: 'site-alpha',
    customerId: 'cust-1',
    measurements: {
      diskSpaceMb: 450,
      diskInodes: 12000,
      mailStorageMb: 120,
      mailboxes: 3,
      databaseStorageMb: 80,
      databases: 1,
      cpuPercent: 12.5,
      memoryMb: 256,
      processCount: 8,
    },
    definedLimits: {
      diskSpaceMb: 1024,
      diskInodes: 50000,
      mailStorageMb: 500,
      mailboxes: 5,
      databaseStorageMb: 250,
      databases: 2,
      cpuPercent: 100,
      memoryMb: 512,
      processCount: 30,
    },
    enforcedLimits: {
      diskSpaceMb: 1024,
      diskInodes: 50000,
      memoryMb: 512,
      processCount: 30,
    },
  });

  assert.equal(report.websiteId, 'site-alpha');
  assert.equal(report.customerId, 'cust-1');
  assert.equal(report.exceeded, false);
  assert.equal(report.exceededMetrics.length, 0);

  // Check categories structure
  assert.ok(report.categories.disk.spaceMb);
  assert.ok(report.categories.disk.inodes);
  assert.ok(report.categories.mail.storageMb);
  assert.ok(report.categories.mail.mailboxes);
  assert.ok(report.categories.database.storageMb);
  assert.ok(report.categories.database.databases);
  assert.ok(report.categories.cpu.usage);
  assert.ok(report.categories.memory.usage);
  assert.ok(report.categories.process.count);

  // Check metrics values
  assert.equal(report.categories.disk.spaceMb.measured, 450);
  assert.equal(report.categories.disk.spaceMb.definedLimit, 1024);
  assert.equal(report.categories.disk.spaceMb.enforcedLimit, 1024);

  assert.equal(report.categories.cpu.usage.measured, 12.5);
  assert.equal(report.categories.memory.usage.measured, 256);
  assert.equal(report.categories.process.count.measured, 8);
});

test('PROD-15 Limit Breach Behavior & assertSiteResourceLimit throws 409', () => {
  const breachedReport = buildSiteConsumptionReport({
    websiteId: 'site-breached',
    customerId: 'cust-1',
    measurements: {
      diskSpaceMb: 1200, // Exceeds limit
      memoryMb: 600,     // Exceeds limit
    },
    definedLimits: {
      diskSpaceMb: 1000,
      memoryMb: 512,
    },
  });

  assert.equal(breachedReport.exceeded, true);
  assert.ok(breachedReport.exceededMetrics.includes('diskSpaceMb'));
  assert.ok(breachedReport.exceededMetrics.includes('memoryMb'));

  // assertSiteResourceLimit on breached report throws 409 site_quota_exceeded
  assert.throws(
    () => assertSiteResourceLimit({ report: breachedReport }),
    (err) => err.code === 'site_quota_exceeded' && err.status === 409,
  );

  // assertSiteResourceLimit on specific exceeded metric throws
  assert.throws(
    () => assertSiteResourceLimit({ report: breachedReport, metric: 'diskSpaceMb' }),
    (err) => err.code === 'site_quota_exceeded' && err.status === 409,
  );

  // assertSiteResourceLimit on compliant metric does NOT throw
  assert.doesNotThrow(() => assertSiteResourceLimit({ report: breachedReport, metric: 'mailStorageMb' }));
});

test('PROD-15 Cross-Site Isolation: Breach on Site A does NOT affect Site B', () => {
  // Site A: Breached disk and CPU limits
  const siteAReport = buildSiteConsumptionReport({
    websiteId: 'site-a-breached',
    customerId: 'cust-a',
    measurements: {
      diskSpaceMb: 5500,
      cpuPercent: 95,
      memoryMb: 1024,
    },
    definedLimits: {
      diskSpaceMb: 5000,
      cpuPercent: 50,
      memoryMb: 512,
    },
  });

  // Site B: Completely isolated, healthy usage
  const siteBReport = buildSiteConsumptionReport({
    websiteId: 'site-b-isolated',
    customerId: 'cust-b',
    measurements: {
      diskSpaceMb: 250,
      cpuPercent: 5,
      memoryMb: 128,
    },
    definedLimits: {
      diskSpaceMb: 2000,
      cpuPercent: 50,
      memoryMb: 512,
    },
  });

  // Site A is breached
  assert.equal(siteAReport.exceeded, true);
  assert.throws(
    () => assertSiteResourceLimit({ report: siteAReport }),
    (err) => err.code === 'site_quota_exceeded' && err.status === 409,
  );

  // Site B remains unaffected and completely compliant
  assert.equal(siteBReport.exceeded, false);
  assert.equal(siteBReport.exceededMetrics.length, 0);
  assert.doesNotThrow(() => assertSiteResourceLimit({ report: siteBReport }));

  // Cross-site isolation assertion passes
  assert.equal(assertSiteIsolation({ breachedSiteReport: siteAReport, isolatedSiteReport: siteBReport }), true);

  // Verification that isolation assertion fails if Site B is claimed to be impacted
  const falseIsolatedReport = buildSiteConsumptionReport({
    websiteId: 'site-b-leaked',
    customerId: 'cust-b',
    measurements: { diskSpaceMb: 3000 },
    definedLimits: { diskSpaceMb: 2000 },
  });
  assert.throws(
    () => assertSiteIsolation({ breachedSiteReport: siteAReport, isolatedSiteReport: falseIsolatedReport }),
    (err) => err.code === 'site_isolation_violation' && err.status === 409,
  );
});

test('PROD-15 createSiteConsumptionInspector: queries system inspector and preserves null for unknown', async () => {
  const mockSystemInspector = {
    async getDiskUsage(id) {
      return { spaceMb: 320, inodes: 4500 };
    },
    async getMailUsage(id) {
      return { storageMb: 45, mailboxes: 2 };
    },
    async getDatabaseUsage(id) {
      return { storageMb: 60, databases: 1 };
    },
    async getCpuUsage(id) {
      return { percent: 8.2 };
    },
    async getMemoryUsage(id) {
      return { usageMb: 180 };
    },
    async getProcessUsage(id) {
      // Process usage fails / cannot be inspected on this platform
      throw new Error('Process inspection not supported on host');
    },
  };

  const inspector = createSiteConsumptionInspector({
    systemInspector: mockSystemInspector,
  });

  const report = await inspector.inspectWebsite('site-123', {
    definedLimits: {
      diskSpaceMb: 1000,
      memoryMb: 512,
    },
  });

  assert.equal(report.websiteId, 'site-123');
  // Measured values are populated
  assert.equal(report.categories.disk.spaceMb.measured, 320);
  assert.equal(report.categories.disk.inodes.measured, 4500);
  assert.equal(report.categories.mail.storageMb.measured, 45);
  assert.equal(report.categories.mail.mailboxes.measured, 2);
  assert.equal(report.categories.database.storageMb.measured, 60);
  assert.equal(report.categories.database.databases.measured, 1);
  assert.equal(report.categories.cpu.usage.measured, 8.2);
  assert.equal(report.categories.memory.usage.measured, 180);

  // Process measurement failed in inspector: MUST BE NULL, NOT 0!
  assert.equal(report.categories.process.count.measured, null, 'failed process measurement must be null');
  assert.notEqual(report.categories.process.count.measured, 0, 'failed process measurement must NOT be 0');
  assert.equal(report.categories.process.count.unknown, true);
  assert.equal(report.categories.process.count.status, 'unknown');
});

test('PROD-15 HTTP API: GET /api/websites/:websiteId/consumption returns 3-way consumption with tenant isolation', async () => {
  const app = express();
  app.use(express.json());

  // Mock website registry
  const websites = [
    {
      id: 'site-owner',
      name: 'Owner Site',
      customerId: 'cust-owner',
      quotas: { diskSpaceMb: 1000, memoryMb: 512 },
      enforcedLimits: { diskSpaceMb: 1000, memoryMb: 512 },
    },
    {
      id: 'site-foreign',
      name: 'Foreign Site',
      customerId: 'cust-foreign',
      quotas: { diskSpaceMb: 2000 },
      enforcedLimits: { diskSpaceMb: 2000 },
    },
  ];

  const websiteRegistry = {
    async listWebsites() { return websites; },
    async getWebsite(id) { return websites.find((w) => w.id === id) ?? null; },
    async createWebsite() {},
    async previewWebsiteUpdate() {},
    async updateWebsite() {},
  };

  const domainRegistry = {
    async listDomains() { return []; },
  };

  // Auth middleware simulator
  let currentAuth = null;
  app.use((req, res, next) => {
    req.auth = currentAuth;
    next();
  });

  const mockSystemInspector = {
    async getDiskUsage(id) {
      if (id === 'site-owner') return { spaceMb: 250, inodes: 1200 };
      return null;
    },
    async getMailUsage() { return null; },
    async getDatabaseUsage() { return null; },
    async getCpuUsage() { return { percent: 15.0 }; },
    async getMemoryUsage() { return { usageMb: 200 }; },
    async getProcessUsage() { return null; },
  };

  const siteConsumptionInspector = createSiteConsumptionInspector({
    websiteRegistry,
    systemInspector: mockSystemInspector,
  });

  mountWebsiteRoutes(app, {
    websiteRegistry,
    domainRegistry,
    siteConsumptionInspector,
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Owner can access site consumption
    currentAuth = {
      user: { id: 'owner-1', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    const ownerRes = await fetch(`${baseUrl}/api/websites/site-owner/consumption`);
    assert.equal(ownerRes.status, 200);
    const ownerData = await ownerRes.json();
    assert.equal(ownerData.data.websiteId, 'site-owner');
    assert.equal(ownerData.data.categories.disk.spaceMb.measured, 250);
    assert.equal(ownerData.data.categories.disk.spaceMb.definedLimit, 1000);
    assert.equal(ownerData.data.categories.disk.spaceMb.enforcedLimit, 1000);
    assert.equal(ownerData.data.categories.disk.spaceMb.status, 'ok');

    // Unmeasured metric in HTTP response is null, NOT zero!
    assert.equal(ownerData.data.categories.mail.storageMb.measured, null);
    assert.notEqual(ownerData.data.categories.mail.storageMb.measured, 0);
    assert.equal(ownerData.data.categories.mail.storageMb.unknown, true);

    // 2. Customer assigned to site can access their own site consumption
    currentAuth = {
      user: {
        id: 'cust-owner',
        role: 'customer',
        websiteIds: ['site-owner'],
        hosting: { kind: 'customer' },
      },
      access: { mode: 'site_management', permissions: ['sites:read'] },
      security: { managementAllowed: true },
    };
    const custRes = await fetch(`${baseUrl}/api/websites/site-owner/consumption`);
    assert.equal(custRes.status, 200);

    // 3. Foreign customer CANNOT access site-owner (Tenant boundary: 403 Forbidden)
    currentAuth = {
      user: {
        id: 'cust-foreign',
        role: 'customer',
        websiteIds: ['site-foreign'],
        hosting: { kind: 'customer' },
      },
      access: { mode: 'site_management', permissions: ['sites:read'] },
      security: { managementAllowed: true },
    };
    const foreignRes = await fetch(`${baseUrl}/api/websites/site-owner/consumption`);
    assert.equal(foreignRes.status, 403);

    // 4. GET /api/websites/:websiteId/quotas endpoint also works
    currentAuth = {
      user: { id: 'owner-1', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    };
    const quotasRes = await fetch(`${baseUrl}/api/websites/site-owner/quotas`);
    assert.equal(quotasRes.status, 200);
    const quotasData = await quotasRes.json();
    assert.equal(quotasData.data.websiteId, 'site-owner');
  } finally {
    server.close();
  }
});
