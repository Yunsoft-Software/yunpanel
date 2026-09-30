import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { navigationGroups, commandEntries } from '../src/workspace/ui/ux-model.js';
import { requireSession } from '../src/auth-protocol.js';
import {
  hostingCustomerQuotasInput,
  readHostingAccount,
  hostingAccountMessage,
} from '../src/workspace/hosting-account-client.js';

const source = (path) => readFile(new URL(`../src/workspace/${path}`, import.meta.url), 'utf8');

test('navigationGroups: Reseller sees Bayi Menüsü with Sitelerim, Müşterilerim and isolated site tools', () => {
  const groups = navigationGroups(true, false, true, false);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'Bayi Menüsü');
  assert.equal(groups[0].label, 'Bayi Menüsü');
  const paths = groups[0].items.map(([path]) => path);
  assert.deepEqual(paths, ['/customers', '/websites', '/mail', '/files', '/databases']);
  assert.equal(groups[0].items.find(([path]) => path === '/websites')[1], 'Sitelerim');
  assert.equal(groups[0].items.find(([path]) => path === '/customers')[1], 'Müşterilerim');

  // Forbidden items for Reseller
  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/docker'));
  assert.ok(!paths.includes('/dashboard'));
});

test('navigationGroups: Customer sees Müşteri Menüsü with Web Siteleri ve Alan Adları and self-service tools', () => {
  const groups = navigationGroups(true, false, false, true);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'Müşteri Menüsü');
  assert.equal(groups[0].label, 'Müşteri Menüsü');
  const paths = groups[0].items.map(([path]) => path);
  assert.deepEqual(paths, ['/websites', '/mail', '/files', '/databases']);
  assert.equal(groups[0].items.find(([path]) => path === '/websites')[1], 'Web Siteleri ve Alan Adları');

  // Forbidden items for Customer
  assert.ok(!paths.includes('/customers'));
  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/docker'));
  assert.ok(!paths.includes('/dashboard'));
});

test('navigationGroups: Owner sees standard Panel navigation including tools and settings', () => {
  const groups = navigationGroups(true, true, false, false);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'Panel');
  assert.equal(groups[0].label, 'Panel');
  const paths = groups[0].items.map(([path]) => path);
  assert.ok(paths.includes('/websites'));
  assert.ok(paths.includes('/tools-settings'));
  assert.ok(paths.includes('/settings/users'));
  assert.ok(paths.includes('/files'));
  assert.ok(paths.includes('/databases'));
  assert.ok(!paths.includes('/customers'));
});

test('navigationGroups: default backward compatibility for 2 arguments', () => {
  const ownerGroups = navigationGroups(true, true);
  assert.equal(ownerGroups[0].title, 'Panel');
  assert.equal(ownerGroups[0].label, 'Panel');
  assert.ok(ownerGroups[0].items.some(([path]) => path === '/tools-settings'));

  const nonOwnerGroups = navigationGroups(true, false);
  assert.equal(nonOwnerGroups[0].title, 'Panel');
  assert.equal(nonOwnerGroups[0].label, 'Panel');
  assert.ok(!nonOwnerGroups[0].items.some(([path]) => path === '/tools-settings'));
});

test('commandEntries: customer cannot search or access owner or reseller commands', () => {
  const customerEntries = commandEntries({ canManage: true, isCustomer: true });
  const customerPaths = customerEntries.map((c) => c.to);
  assert.ok(customerPaths.includes('/websites'));
  assert.ok(!customerPaths.includes('/customers'));
  assert.ok(!customerPaths.includes('/docker'));
  assert.ok(!customerPaths.includes('/tools-settings'));
  assert.ok(!customerPaths.includes('/settings/users'));
});

test('commandEntries: reseller can search /customers and sees Sitelerim detail', () => {
  const resellerEntries = commandEntries({ canManage: true, isReseller: true });
  const customerCmd = resellerEntries.find((c) => c.to === '/customers');
  assert.ok(customerCmd);
  assert.equal(customerCmd.title, 'Müşterilerim');
  assert.equal(customerCmd.label, 'Müşterilerim');

  const siteCmd = resellerEntries.find((c) => c.to === '/websites');
  assert.ok(siteCmd);
  assert.equal(siteCmd.title, 'Sitelerim');
  assert.equal(siteCmd.label, 'Sitelerim');
  assert.equal(siteCmd.detail, 'Sitelerim listesini aç');
});

test('auth-protocol: supports direct and site_manager hosting profile sessions for reseller and customer', () => {
  const baseSession = { id: 's1', csrfToken: 'csrf-1', expiresAt: 9999, idleExpiresAt: 9990 };
  const resellerSession = {
    ...baseSession,
    user: { id: 'r1', username: 'reseller1', role: 'reseller', hosting: { kind: 'reseller', resellerId: null } },
  };
  const customerSession = {
    ...baseSession,
    user: { id: 'c1', username: 'cust1', role: 'customer', hosting: { kind: 'customer', resellerId: 'r1' } },
  };
  assert.equal(requireSession(resellerSession), resellerSession);
  assert.equal(requireSession(customerSession), customerSession);
});

test('source: WorkspaceApp guards routes with role checks', async () => {
  const appSource = await source('WorkspaceApp.jsx');
  assert.match(appSource, /path: 'customers', element: reseller\(<ResellerCustomersPage \/>\)/);
  assert.match(appSource, /path: 'dashboard', element: owner\(scoped\(<DashboardPage \/>, <ReadOnlyDashboardPage \/>\)\)/);
  assert.match(appSource, /path: 'websites\/new', element: owner\(<NewWebsitePage \/>\)/);
  assert.match(appSource, /path: 'docker', element: owner\(<DockerProjectsPage \/>\)/);
  assert.match(appSource, /function CustomerRoute/);
});

test('source: WorkspaceLayout displays distinct branding for Reseller, Customer, and Owner', async () => {
  const layout = await source('WorkspaceLayout.jsx');
  assert.match(layout, /isReseller \? 'BAYİ PANELİ' : isCustomer \? 'MÜŞTERİ PANELİ'/);
  assert.match(layout, /isReseller \? 'Bayi yönetimi' : isCustomer \? 'Müşteri paneli'/);
  assert.match(layout, /SUNUCU YÖNETİMİ/);
  assert.match(layout, /Sunucu yönetimi/);
});

test('source: WebsitesPage preserves owner test invariants and adapts heading for reseller', async () => {
  const page = await source('WebsitesPage.jsx');
  assert.match(page, /isOwner && canManage && <LinkButton to="\/websites\/new"/);
  assert.match(page, /action=\{isOwner && canManage \? <LinkButton to="\/websites\/new"/);
  assert.match(page, /isReseller \? 'Sitelerim' : 'Web Siteleri ve Alan Adları'/);
  assert.doesNotMatch(page, /panelRequest|fetch\(|localStorage|sessionStorage/);
});

test('source: ResellerCustomersPage contains website quota and site allocation flow', async () => {
  const resellerPage = await source('ResellerCustomersPage.jsx');
  assert.match(resellerPage, /Web sitesi: ' \+ reseller\.usage\.websites/);
  assert.match(resellerPage, /Site tahsis et/);
  assert.match(resellerPage, /function AllocateSiteDialog/);
  assert.match(resellerPage, /\/api\/sites\/hosted\/create-preview/);
  assert.match(resellerPage, /\/api\/sites\/hosted/);
});

test('hostingCustomerQuotasInput: parses form inputs and handles nulls or invalid values', () => {
  const parsed = hostingCustomerQuotasInput({
    maxWebsites: '3',
    maxDiskMb: 1024,
    maxTrafficMb: '',
    maxDatabases: null,
  });
  assert.deepEqual(parsed, {
    maxWebsites: 3,
    maxDiskMb: 1024,
    maxTrafficMb: null,
    maxDatabases: null,
  });

  assert.throws(
    () => hostingCustomerQuotasInput({ maxWebsites: -1 }),
    (err) => err.code === 'invalid_customer_quotas'
  );
  assert.throws(
    () => hostingCustomerQuotasInput({ maxDiskMb: 'abc' }),
    (err) => err.code === 'invalid_customer_quotas'
  );
});

test('readHostingAccount: parses and validates customer quotas and usage', () => {
  const account = {
    id: 'c1',
    username: 'cust1',
    kind: 'customer',
    resellerId: 'r1',
    active: true,
    revision: 1,
    userRevision: 1,
    createdAt: 1000,
    updatedAt: 1000,
    stage: 'profile_only',
    quotas: {
      maxWebsites: 2,
      maxDiskMb: 1024,
      maxTrafficMb: null,
      maxDatabases: 1,
    },
    usage: {
      websites: 1,
      diskMb: 256,
      trafficMb: 100,
      databases: 1,
    },
  };
  const parsed = readHostingAccount(account);
  assert.deepEqual(parsed.quotas, account.quotas);
  assert.deepEqual(parsed.usage, account.usage);

  assert.throws(
    () => readHostingAccount({ ...account, quotas: { maxWebsites: 'invalid' } }),
    (err) => err.code === 'hosting_result_invalid'
  );
  assert.throws(
    () => readHostingAccount({ ...account, usage: { websites: -1 } }),
    (err) => err.code === 'hosting_result_invalid'
  );
});

test('hostingAccountMessage: translates customer quota and account lock error codes', () => {
  assert.equal(
    hostingAccountMessage({ code: 'customer_quota_exceeded' }),
    'Müşteri web sitesi kotası doldu. Yeni site tahsis edilemez.'
  );
  assert.equal(
    hostingAccountMessage({ code: 'hosting_account_inactive' }),
    'Hesap askıya alınmış veya kilitli durumda. Kaynak işlemleri yapılamaz.'
  );
  assert.equal(
    hostingAccountMessage({ code: 'invalid_customer_quotas' }),
    'Geçerli kota değerleri girin veya Sınırsız seçin. Değerler negatif olamaz.'
  );
});

test('source: ResellerCustomersPage contains customer quota management dialog, status badges and warnings', async () => {
  const resellerPage = await source('ResellerCustomersPage.jsx');
  assert.match(resellerPage, /CustomerQuotaDialog/);
  assert.match(resellerPage, /Kota tahsis et/);
  assert.match(resellerPage, /Etkin \(Kota Doldu\)/);
  assert.match(resellerPage, /Askıda \(Kilitli\)/);
  assert.match(resellerPage, /Bu müşterinin web sitesi kotası dolmuştur/);
  assert.match(resellerPage, /Askıya alınan müşterilere site tahsis edilemez/);
});

test('source: WebsitesPage contains customer quota section and resource locking warning', async () => {
  const page = await source('WebsitesPage.jsx');
  assert.match(page, /Barındırma Kaynakları ve Kotalar/);
  assert.match(page, /Kaynaklar Kilitli/);
  assert.match(page, /Kota Sınırı/);
  assert.match(page, /hostingProfile\?\.quotas/);
});
