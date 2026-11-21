import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCustomerQuotaSnapshot,
  buildCustomerSiteQuotaBreakdown,
  buildResellerAccountQuotaMetrics,
  describeQuotaMetric,
  formatQuotaMeasurementTime,
} from '../src/workspace/quota-model.js';
import {
  buildCustomerNextActions,
  buildOwnerNextActions,
  buildResellerNextActions,
} from '../src/workspace/next-actions-model.js';

test('describeQuotaMetric clearly separates unmeasured, pending, unlimited, ok, near_limit and full metrics without broken symbols', () => {
  const unmeasuredUnlimited = describeQuotaMetric({
    key: 'diskMb',
    label: 'Disk Alanı',
    usage: null,
    limit: null,
    unit: 'mb',
    enforced: false,
  });
  assert.equal(unmeasuredUnlimited.status, 'unmeasured');
  assert.equal(unmeasuredUnlimited.enforced, false);
  assert.equal(unmeasuredUnlimited.usageText, 'Ölçülmüyor');
  assert.equal(unmeasuredUnlimited.limitText, 'Sınırsız');
  assert.equal(unmeasuredUnlimited.summaryText, 'Ölçülmüyor · Sınır: Sınırsız');
  assert.equal(unmeasuredUnlimited.summaryText.includes('— /'), false);
  assert.doesNotMatch(unmeasuredUnlimited.detailText, /Aktif sınır|uygulanır/);
  assert.match(unmeasuredUnlimited.detailText, /otomatik ölçülmüyor ve uygulanmıyor/);

  const unmeasuredLimited = describeQuotaMetric({
    key: 'databases',
    label: 'Veritabanları',
    usage: undefined,
    limit: 3,
    unit: 'count',
    enforced: false,
  });
  assert.equal(unmeasuredLimited.status, 'unmeasured');
  assert.equal(unmeasuredLimited.enforced, false);
  assert.equal(unmeasuredLimited.usageText, 'Ölçülmüyor');
  assert.equal(unmeasuredLimited.limitText, '3');
  assert.match(unmeasuredLimited.detailText, /Tanımlı sınır: 3/);
  assert.match(unmeasuredLimited.detailText, /Yalnız kayıtlı sınır \(henüz otomatik ölçülmüyor ve uygulanmıyor\)/);
  assert.doesNotMatch(unmeasuredLimited.detailText, /Aktif sınır|uygulanır/);
  assert.equal(unmeasuredLimited.isFull, false);

  const pendingEnforced = describeQuotaMetric({
    key: 'websites',
    label: 'Web Siteleri',
    usage: null,
    limit: 2,
    unit: 'count',
    enforced: true,
    enforcementNote: 'Yeni site tahsisinde uygulanır',
  });
  assert.equal(pendingEnforced.status, 'pending');
  assert.equal(pendingEnforced.measured, false);
  assert.equal(pendingEnforced.remaining, null);
  assert.equal(pendingEnforced.isFull, false);
  assert.equal(pendingEnforced.usageText, 'Ölçüm bekleniyor');

  const unlimitedEnforced = describeQuotaMetric({
    key: 'websites',
    label: 'Web Siteleri',
    usage: 2,
    limit: null,
    unit: 'count',
    enforced: true,
    enforcementNote: 'Yeni site tahsisinde uygulanır',
  });
  assert.equal(unlimitedEnforced.status, 'unlimited');
  assert.equal(unlimitedEnforced.badgeLabel, 'Sınırsız');
  assert.equal(unlimitedEnforced.summaryText, '2 / Sınırsız');
  assert.equal(unlimitedEnforced.remaining, null);

  const okEnforced = describeQuotaMetric({
    key: 'websites',
    label: 'Web Siteleri',
    usage: 1,
    limit: 5,
    enforced: true,
    enforcementNote: 'Yeni site tahsisinde uygulanır',
  });
  assert.equal(okEnforced.status, 'ok');
  assert.equal(okEnforced.badgeLabel, 'Uygun');
  assert.equal(okEnforced.remaining, 4);
  assert.match(okEnforced.detailText, /4 boş · Yeni site tahsisinde uygulanır/);
  assert.equal(okEnforced.isFull, false);

  const nearLimit = describeQuotaMetric({ key: 'websites', label: 'Web Siteleri', usage: 4, limit: 5, enforced: true });
  assert.equal(nearLimit.status, 'near_limit');
  assert.equal(nearLimit.badgeLabel, 'Sınıra yakın');
  assert.equal(nearLimit.remaining, 1);
  assert.equal(nearLimit.isNear, true);
  assert.equal(nearLimit.isFull, false);

  const fullLimit = describeQuotaMetric({ key: 'websites', label: 'Web Siteleri', usage: 5, limit: 5, enforced: true });
  assert.equal(fullLimit.status, 'full');
  assert.equal(fullLimit.badgeLabel, 'Kota doldu');
  assert.equal(fullLimit.remaining, 0);
  assert.equal(fullLimit.isFull, true);

  const zeroLimit = describeQuotaMetric({ key: 'websites', label: 'Web Siteleri', usage: 0, limit: 0, enforced: true });
  assert.equal(zeroLimit.status, 'full');
  assert.equal(zeroLimit.isFull, true);
});

test('formatQuotaMeasurementTime ONLY uses dedicated usage.measuredAt and NEVER falls back to account updatedAt', () => {
  assert.equal(formatQuotaMeasurementTime(null), 'Henüz ölçülmedi');
  assert.equal(formatQuotaMeasurementTime({ measuredAt: '' }), 'Henüz ölçülmedi');
  assert.equal(formatQuotaMeasurementTime({ updatedAt: '2026-11-21T10:30:00.000Z' }), 'Henüz ölçülmedi');
  const fromMeasuredAt = formatQuotaMeasurementTime({ measuredAt: '2026-11-21T10:30:00.000Z' });
  assert.match(fromMeasuredAt, /^Son ölçüm: /);
});

test('buildCustomerQuotaSnapshot uses ONLY authoritative backend usage (including reservations), never updatedAt or visible list fallback, and never labels unproven limits as enforced', () => {
  // Without authoritative backend usage, never fabricate remaining or full status even if updatedAt is present
  const pendingSnapshot = buildCustomerQuotaSnapshot({
    hostingProfile: {
      kind: 'customer',
      resellerId: 'reseller-1',
      updatedAt: '2026-11-21T12:00:00.000Z',
      quotas: { maxWebsites: 2, maxDiskMb: 500, maxTrafficMb: null, maxDatabases: 3 },
    },
    account: null,
  });
  assert.equal(pendingSnapshot.usageAuthoritative, false);
  assert.equal(pendingSnapshot.websites.measured, false);
  assert.equal(pendingSnapshot.websites.remaining, null);
  assert.equal(pendingSnapshot.websites.isFull, false);
  assert.equal(pendingSnapshot.measurementLabel, 'Henüz ölçülmedi');

  // With authoritative backend account where 1 site is attached + 1 site is reserved -> usage.websites = 2 / 2
  const reservedFull = buildCustomerQuotaSnapshot({
    hostingProfile: {
      kind: 'customer',
      resellerId: 'reseller-1',
      quotas: { maxWebsites: 2, maxDiskMb: 500, maxTrafficMb: null, maxDatabases: null },
    },
    account: {
      id: 'cust-1',
      kind: 'customer',
      resellerId: 'reseller-1',
      updatedAt: '2026-11-21T12:00:00.000Z',
      quotas: { maxWebsites: 2, maxDiskMb: 500, maxTrafficMb: null, maxDatabases: null },
      usage: { websites: 2, diskMb: null, trafficMb: null, databases: null },
      websiteIds: ['site-1'],
    },
  });
  assert.equal(reservedFull.usageAuthoritative, true);
  assert.equal(reservedFull.websites.summaryText, '2 / 2');
  assert.equal(reservedFull.websites.enforced, true);
  assert.equal(reservedFull.websites.isFull, true);
  assert.equal(reservedFull.websites.remaining, 0);
  assert.equal(reservedFull.websites.reservedCount, 1);
  assert.match(reservedFull.websites.detailText, /1 bekleyen tahsis dahil/);
  assert.equal(reservedFull.measurementLabel, 'Henüz ölçülmedi');
  assert.equal(reservedFull.disk.enforced, false);
  assert.equal(reservedFull.disk.usageText, 'Ölçülmüyor');
  assert.match(reservedFull.disk.detailText, /Tanımlı sınır: 500 MB/);
  assert.match(reservedFull.disk.detailText, /henüz otomatik ölçülmüyor ve uygulanmıyor/);
  assert.doesNotMatch(reservedFull.disk.detailText, /Aktif sınır|uygulanır/);
  assert.equal(reservedFull.traffic.enforced, false);
  assert.equal(reservedFull.traffic.usageText, 'Ölçülmüyor');
  assert.doesNotMatch(reservedFull.traffic.detailText, /Aktif sınır|uygulanır/);
  assert.equal(reservedFull.databases.enforced, false);
  assert.equal(reservedFull.databases.usageText, 'Ölçülmüyor');
  assert.equal(reservedFull.databases.limitText, 'Sınırsız');
  assert.equal(reservedFull.databases.summaryText, 'Ölçülmüyor · Sınır: Sınırsız');
  assert.doesNotMatch(reservedFull.databases.detailText, /Aktif sınır|uygulanır/);
  assert.equal(reservedFull.managementContext.kind, 'reseller_managed');
  assert.equal(reservedFull.managementContext.label, 'Bayi yönetimli müşteri');

  const directManaged = buildCustomerQuotaSnapshot({
    hostingProfile: {
      kind: 'customer',
      resellerId: null,
      quotas: { maxWebsites: null, maxDiskMb: null, maxTrafficMb: null, maxDatabases: 4 },
    },
    account: {
      id: 'cust-2',
      kind: 'customer',
      resellerId: null,
      quotas: { maxWebsites: null, maxDiskMb: null, maxTrafficMb: null, maxDatabases: 4 },
      usage: { websites: 0, diskMb: null, trafficMb: null, databases: null },
      websiteIds: [],
    },
  });
  assert.equal(directManaged.managementContext.kind, 'direct_managed');
  assert.equal(directManaged.managementContext.label, 'Doğrudan yönetilen müşteri');
  assert.equal(directManaged.databases.limitText, '4');
  assert.equal(directManaged.databases.enforced, false);
});

test('buildResellerAccountQuotaMetrics and buildCustomerSiteQuotaBreakdown format reseller/customer records cleanly', () => {
  const resellerMetrics = buildResellerAccountQuotaMetrics({
    kind: 'reseller',
    updatedAt: '2026-11-21T12:00:00.000Z',
    usageScope: 'registered_and_reserved_ownership',
    limits: { maxCustomers: 10, maxWebsites: 25 },
    usage: { customers: 10, websites: 12 },
  });
  assert.equal(resellerMetrics.customers.summaryText, '10 / 10');
  assert.equal(resellerMetrics.customers.isFull, true);
  assert.equal(resellerMetrics.customers.enforced, true);
  assert.equal(resellerMetrics.websites.summaryText, '12 / 25');
  assert.equal(resellerMetrics.websites.isFull, false);
  assert.equal(resellerMetrics.websites.includesReservations, true);
  assert.match(resellerMetrics.websites.detailText, /Bekleyen site tahsisleri dahil/);
  assert.equal(resellerMetrics.measurementLabel, 'Henüz ölçülmedi');

  const breakdown = buildCustomerSiteQuotaBreakdown(
    [{ id: 'w1', name: 'Shop', runtimeType: 'php', state: 'draft' }],
    [{ id: 'd1', websiteId: 'w1', primaryDomain: 'shop.example.test', state: 'draft', targetType: 'proxy' }],
  );
  assert.equal(breakdown.length, 1);
  assert.equal(breakdown[0].name, 'shop.example.test');
  assert.equal(breakdown[0].runtimeLabel, 'PHP');
  assert.equal(breakdown[0].statusLabel, 'Taslak');
  assert.equal(breakdown[0].href, '/websites/d1/overview');
});

test('next-actions-model produces concrete role-specific actions for Owner, Reseller and Customer using real domain.state', () => {
  const owner = buildOwnerNextActions({
    domains: {
      status: 'ready',
      items: [{ id: 'd1', primaryDomain: 'site.example.test', state: 'draft', httpsMode: 'off' }],
    },
    websites: { status: 'ready', items: [{ id: 'w1' }] },
    certificates: { status: 'ready', items: [] },
    servers: {
      status: 'ready',
      items: [{ id: 's1', connectivity: 'connected', inventory: { filesystem: { usedBytes: 91, totalBytes: 100 } } }],
    },
    jobs: { status: 'ready', items: [{ id: 'j1', status: 'failed' }] },
  });
  assert.equal(owner.allClear, false);
  assert.ok(owner.items.some((i) => i.id === 'owner-disk-pressure' && i.to === '/servers'));
  assert.ok(owner.items.some((i) => i.id === 'owner-failed-jobs' && i.to === '/jobs?status=failed'));
  assert.ok(owner.items.some((i) => i.id === 'owner-draft-sites' && i.to === '/websites/d1/overview'));
  assert.ok(owner.items.some((i) => i.id === 'owner-ssl-dns' && i.to === '/websites/d1/dns'));
  assert.ok(owner.quickEntries.some((e) => e.to === '/dashboard'));
  assert.ok(owner.quickEntries.some((e) => e.to === '/firewall'));

  const resellerZero = buildResellerNextActions({
    reseller: { usage: { customers: 0, websites: 0 } },
    customers: [],
  });
  assert.equal(resellerZero.items[0].id, 'reseller-add-first-customer');

  const resellerNeedsFirstSite = buildResellerNextActions({
    reseller: { usage: { customers: 1, websites: 0 } },
    customers: [{ id: 'c1', username: 'cust1', active: true, usage: { websites: 0 }, quotas: { maxWebsites: 2 } }],
  });
  assert.equal(resellerNeedsFirstSite.items[0].id, 'reseller-allocate-first-site');
  assert.equal(resellerNeedsFirstSite.items[0].targetAccountId, 'c1');

  const customerPending = buildCustomerNextActions({
    domains: [{ id: 'd1', primaryDomain: 'my.example.test', state: 'draft', httpsMode: 'off' }],
    certificates: { status: 'ready', items: [] },
  });
  assert.equal(customerPending.allClear, false);
  assert.ok(customerPending.items.some((i) => i.to === '/websites/d1/overview'));
  assert.ok(customerPending.items.some((i) => i.to === '/websites/d1/ssl'));
  assert.ok(customerPending.items.some((i) => i.to === '/websites/d1/dns'));
  assert.ok(customerPending.quickLinks.some((q) => q.to === '/websites/d1/mail'));
  assert.ok(customerPending.quickLinks.some((q) => q.to === '/websites/d1/backup'));

  const customerReady = buildCustomerNextActions({
    domains: [{ id: 'd2', primaryDomain: 'live.example.test', state: 'active', httpsMode: 'managed', certificateId: 'cert-1' }],
    certificates: {
      status: 'ready',
      items: [{ id: 'cert-1', state: 'active', staging: false, validTo: new Date(Date.now() + 60 * 86400000).toISOString() }],
    },
  });
  assert.equal(customerReady.allClear, true);
  assert.equal(customerReady.summaryText, 'Siteleriniz yayında');
});
