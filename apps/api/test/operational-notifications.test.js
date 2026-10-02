import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import {
  createOperationalNotificationService,
  OperationalNotificationError,
  operationalNotificationInternals,
} from '../src/operational-notification-service.js';
import {
  mountOperationalNotificationRoutes,
  OperationalNotificationHttpError,
} from '../src/operational-notification-http.js';
import {
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_SEVERITY,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  DELIVERY_STATUS,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '../src/operational-notification-types.js';
import { maskSecrets, isSensitiveKey } from '../src/secret-masker.js';

// ============================================================================
// Test Doubles and Fixtures
// ============================================================================

function createMockAuthMailer({ fail = false, errorMessage = 'SMTP connection refused' } = {}) {
  const sentMails = [];
  let shouldFail = fail;
  let failMsg = errorMessage;

  return {
    sendMail: async (mail) => {
      if (shouldFail) {
        throw new Error(failMsg);
      }
      sentMails.push(mail);
      return {
        sent: true,
        messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      };
    },
    getSentMails: () => [...sentMails],
    clearSentMails: () => { sentMails.length = 0; },
    setFail: (value, msg = 'SMTP connection refused') => {
      shouldFail = value;
      failMsg = msg;
    },
  };
}

function createMockCertificateRegistry(initialCerts = []) {
  let certs = [...initialCerts];
  return {
    listCertificates: async () => [...certs],
    getCertificate: async (id) => certs.find((c) => c.id === id) || null,
    setCertificates: (newCerts) => { certs = newCerts; },
  };
}

function createMockWebsiteRegistry(initialSites = []) {
  let sites = [...initialSites];
  return {
    listWebsites: async () => [...sites],
    getWebsite: async (id) => sites.find((s) => s.id === id) || null,
    setWebsites: (newSites) => { sites = newSites; },
  };
}

function createMockHostingStore({ customers = [], resellers = [] } = {}) {
  return {
    getCustomer: async (id) => customers.find((c) => c.id === id) || null,
    getReseller: async (id) => resellers.find((r) => r.id === id) || null,
  };
}

function createTestExpressApp({
  notificationService,
  role = 'owner',
  userId = 'usr-owner',
  hosting = null,
} = {}) {
  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    if (role === 'unauthenticated') {
      return next();
    }

    req.auth = {
      user: {
        id: userId,
        username: userId,
        role,
        email: `${userId}@yunpanel.local`,
        hosting: hosting ? { kind: hosting.kind, id: hosting.id, websiteIds: hosting.websiteIds } : undefined,
      },
      access: {
        mode: role === 'owner' ? 'management' : 'site_management',
        permissions: role === 'owner' ? ['*'] : ['sites.manage'],
      },
      security: {
        managementAllowed: true,
      },
    };
    next();
  });

  mountOperationalNotificationRoutes(app, { notificationService });

  // Error middleware
  app.use((err, _req, res, _next) => {
    if (err instanceof OperationalNotificationError || err instanceof OperationalNotificationHttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    const status = err.status || 500;
    return res.status(status).json({ error: { code: err.code || 'internal_error', message: err.message } });
  });

  return app;
}

// ============================================================================
// 1. Secret Masking Tests
// ============================================================================

test('secret masking: recursively redacts passwords, tokens, private keys, and connection strings', () => {
  const rawString = 'Failed to connect: mysql://dbuser:SuperSecretPassword123!@127.0.0.1:3306/db with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz';
  const maskedString = maskSecrets(rawString);
  assert.ok(!maskedString.includes('SuperSecretPassword123!'));
  assert.ok(!maskedString.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz'));
  assert.ok(maskedString.includes('[REDACTED]'));

  const rawObject = {
    websiteId: 'site-1',
    password: 'ClearTextPassword99',
    apiToken: 'secret-token-xyz',
    nested: {
      clientSecret: 'shhh-secret',
      publicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC3 public',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
    },
  };

  const maskedObj = maskSecrets(rawObject);
  assert.equal(maskedObj.websiteId, 'site-1');
  assert.equal(maskedObj.password, '[REDACTED]');
  assert.equal(maskedObj.apiToken, '[REDACTED]');
  assert.equal(maskedObj.nested.clientSecret, '[REDACTED]');
  assert.equal(maskedObj.nested.privateKey, '[REDACTED]');
  assert.equal(maskedObj.nested.publicKey, 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC3 public');
});

test('secret masking: sensitive key detector flags security-critical property names', () => {
  assert.equal(isSensitiveKey('password'), true);
  assert.equal(isSensitiveKey('adminPassword'), true);
  assert.equal(isSensitiveKey('clientSecret'), true);
  assert.equal(isSensitiveKey('api_token'), true);
  assert.equal(isSensitiveKey('auth_key'), true);
  assert.equal(isSensitiveKey('privateKey'), true);
  assert.equal(isSensitiveKey('websiteId'), false);
  assert.equal(isSensitiveKey('domain'), false);
  assert.equal(isSensitiveKey('status'), false);
});

// ============================================================================
// 2. Acceptance Criterion 1 & 4: Autonomous SSL Certificate Expiration & Renewal
// ============================================================================

test('autonomous SSL check: detects expiring soon (<= 30 days) and issues warning alert', async () => {
  const baseTime = new Date('2026-10-01T00:00:00Z').getTime();
  const certRegistry = createMockCertificateRegistry([
    {
      id: 'cert-expiring-25d',
      certName: 'example.com',
      domains: ['example.com', 'www.example.com'],
      validTo: new Date(baseTime + 25 * 24 * 3600 * 1000).toISOString(), // 25 days remaining
      state: 'ready',
    },
  ]);
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({
    certificateRegistry: certRegistry,
    authMailer: mailer,
    now: () => baseTime,
  });

  const result = await service.checkCertificateExpirations({ now: baseTime });
  assert.equal(result.checked, 1);
  assert.equal(result.dispatched.length, 1);

  const event = result.dispatched[0];
  assert.equal(event.eventType, NOTIFICATION_EVENT_TYPES.SSL_CERTIFICATE_EXPIRING);
  assert.equal(event.severity, NOTIFICATION_SEVERITY.WARNING);
  assert.equal(event.category, NOTIFICATION_CATEGORIES.SSL);

  const sentMails = mailer.getSentMails();
  assert.equal(sentMails.length, 1);
  assert.ok(sentMails[0].subject.includes('25 gün kaldı'));
});

test('autonomous SSL check: detects critical expiration (<= 7 days) and issues critical alert', async () => {
  const baseTime = new Date('2026-10-01T00:00:00Z').getTime();
  const certRegistry = createMockCertificateRegistry([
    {
      id: 'cert-expiring-5d',
      certName: 'shop.example.com',
      domains: ['shop.example.com'],
      validTo: new Date(baseTime + 5 * 24 * 3600 * 1000).toISOString(), // 5 days remaining
      state: 'ready',
    },
  ]);
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({
    certificateRegistry: certRegistry,
    authMailer: mailer,
    now: () => baseTime,
  });

  const result = await service.checkCertificateExpirations({ now: baseTime });
  assert.equal(result.checked, 1);
  assert.equal(result.dispatched.length, 1);

  const event = result.dispatched[0];
  assert.equal(event.eventType, NOTIFICATION_EVENT_TYPES.SSL_CERTIFICATE_CRITICAL);
  assert.equal(event.severity, NOTIFICATION_SEVERITY.CRITICAL);
});

test('autonomous SSL check: detects expired certificate and issues critical alert', async () => {
  const baseTime = new Date('2026-10-01T00:00:00Z').getTime();
  const certRegistry = createMockCertificateRegistry([
    {
      id: 'cert-expired',
      certName: 'expired.example.com',
      domains: ['expired.example.com'],
      validTo: new Date(baseTime - 2 * 24 * 3600 * 1000).toISOString(), // expired 2 days ago
      state: 'ready',
    },
  ]);
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({
    certificateRegistry: certRegistry,
    authMailer: mailer,
    now: () => baseTime,
  });

  const result = await service.checkCertificateExpirations({ now: baseTime });
  assert.equal(result.checked, 1);
  assert.equal(result.dispatched.length, 1);

  const event = result.dispatched[0];
  assert.equal(event.eventType, NOTIFICATION_EVENT_TYPES.SSL_CERTIFICATE_EXPIRED);
  assert.equal(event.severity, NOTIFICATION_SEVERITY.CRITICAL);
});

test('autonomous SSL check: ignores certificates with plenty of validity remaining (> 30 days)', async () => {
  const baseTime = new Date('2026-10-01T00:00:00Z').getTime();
  const certRegistry = createMockCertificateRegistry([
    {
      id: 'cert-safe',
      certName: 'safe.example.com',
      domains: ['safe.example.com'],
      validTo: new Date(baseTime + 75 * 24 * 3600 * 1000).toISOString(), // 75 days remaining
      state: 'ready',
    },
  ]);
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({
    certificateRegistry: certRegistry,
    authMailer: mailer,
    now: () => baseTime,
  });

  const result = await service.checkCertificateExpirations({ now: baseTime });
  assert.equal(result.checked, 1);
  assert.equal(result.dispatched.length, 0);
  assert.equal(mailer.getSentMails().length, 0);
});

test('autonomous SSL check: detects certificate in error state or reload failure', async () => {
  const baseTime = new Date('2026-10-01T00:00:00Z').getTime();
  const certRegistry = createMockCertificateRegistry([
    {
      id: 'cert-failed',
      certName: 'fail.example.com',
      domains: ['fail.example.com'],
      state: 'error',
      lastError: 'ACME challenge failed for domain fail.example.com',
    },
  ]);
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({
    certificateRegistry: certRegistry,
    authMailer: mailer,
    now: () => baseTime,
  });

  const result = await service.checkCertificateExpirations({ now: baseTime });
  assert.equal(result.checked, 1);
  assert.equal(result.dispatched.length, 1);

  const event = result.dispatched[0];
  assert.equal(event.eventType, NOTIFICATION_EVENT_TYPES.SSL_RENEWAL_FAILED);
  assert.equal(event.severity, NOTIFICATION_SEVERITY.CRITICAL);
});

// ============================================================================
// 3. Acceptance Criterion 1: Backup and Restore Failure Notifications
// ============================================================================

test('backup failure notification: dispatches critical alert for backup operation failure', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({ authMailer: mailer });

  const result = await service.notifyBackupFailure({
    websiteId: 'site-alpha',
    repositoryId: 'repo-local-1',
    operationId: 'op-backup-101',
    operationType: 'backup',
    error: {
      code: 'restic_backup_failed',
      message: 'Failed to snapshot /var/www/site-alpha: disk I/O error',
    },
  });

  assert.equal(result.eventType, NOTIFICATION_EVENT_TYPES.BACKUP_FAILED);
  assert.equal(result.severity, NOTIFICATION_SEVERITY.CRITICAL);
  assert.equal(result.category, NOTIFICATION_CATEGORIES.BACKUP);

  const sentMails = mailer.getSentMails();
  assert.equal(sentMails.length, 1);
  assert.ok(sentMails[0].subject.includes('site-alpha'));
  assert.ok(sentMails[0].text.includes('disk I/O error'));
});

test('backup failure notification: dispatches critical alert for restore operation failure', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({ authMailer: mailer });

  const result = await service.notifyBackupFailure({
    websiteId: 'site-beta',
    repositoryId: 'repo-s3-remote',
    operationId: 'op-restore-202',
    operationType: 'restore',
    error: {
      code: 'restore_integrity_verification_failed',
      message: 'Restored files failed sha256 checksum check',
    },
  });

  assert.equal(result.eventType, NOTIFICATION_EVENT_TYPES.RESTORE_FAILED);
  assert.equal(result.severity, NOTIFICATION_SEVERITY.CRITICAL);

  const sentMails = mailer.getSentMails();
  assert.equal(sentMails.length, 1);
  assert.ok(sentMails[0].subject.includes('Geri yükleme'));
});

// ============================================================================
// 4. Acceptance Criterion 1: Critical Disk and Inode Threshold Alerts
// ============================================================================

test('disk threshold alerts: dispatches warning alert at >=85% and critical alert at >=95%', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({
    authMailer: mailer,
    diskWarningThresholdPercent: 85,
    diskCriticalThresholdPercent: 95,
  });

  // 1. Below warning threshold: no alerts
  const safeRun = await service.checkDiskAndInodeThresholds({
    disks: [{ mountPoint: '/', usedBytes: 80, totalBytes: 100, usedInodes: 10, totalInodes: 100 }],
  });
  assert.equal(safeRun.checked, 1);
  assert.equal(safeRun.dispatched.length, 0);

  // 2. Warning threshold (87%)
  const warnRun = await service.checkDiskAndInodeThresholds({
    disks: [{ mountPoint: '/', usedBytes: 87, totalBytes: 100, usedInodes: 10, totalInodes: 100 }],
  });
  assert.equal(warnRun.dispatched.length, 1);
  assert.equal(warnRun.dispatched[0].eventType, NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_WARNING);
  assert.equal(warnRun.dispatched[0].severity, NOTIFICATION_SEVERITY.WARNING);

  // Clear throttle to test critical on same mount
  service.clearThrottling();

  // 3. Critical threshold (96%)
  const critRun = await service.checkDiskAndInodeThresholds({
    disks: [{ mountPoint: '/', usedBytes: 96, totalBytes: 100, usedInodes: 10, totalInodes: 100 }],
  });
  assert.equal(critRun.dispatched.length, 1);
  assert.equal(critRun.dispatched[0].eventType, NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_CRITICAL);
  assert.equal(critRun.dispatched[0].severity, NOTIFICATION_SEVERITY.CRITICAL);
});

test('inode threshold alerts: dispatches warning alert at >=85% and critical alert at >=95%', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({
    authMailer: mailer,
    inodeWarningThresholdPercent: 85,
    inodeCriticalThresholdPercent: 95,
  });

  // 1. Warning Inode usage (88%)
  const warnRun = await service.checkDiskAndInodeThresholds({
    disks: [{ mountPoint: '/var', usedBytes: 20, totalBytes: 100, usedInodes: 88, totalInodes: 100 }],
  });
  assert.equal(warnRun.dispatched.length, 1);
  assert.equal(warnRun.dispatched[0].eventType, NOTIFICATION_EVENT_TYPES.INODE_THRESHOLD_WARNING);
  assert.equal(warnRun.dispatched[0].severity, NOTIFICATION_SEVERITY.WARNING);

  service.clearThrottling();

  // 2. Critical Inode usage (98%)
  const critRun = await service.checkDiskAndInodeThresholds({
    disks: [{ mountPoint: '/var', usedBytes: 20, totalBytes: 100, usedInodes: 98, totalInodes: 100 }],
  });
  assert.equal(critRun.dispatched.length, 1);
  assert.equal(critRun.dispatched[0].eventType, NOTIFICATION_EVENT_TYPES.INODE_THRESHOLD_CRITICAL);
  assert.equal(critRun.dispatched[0].severity, NOTIFICATION_SEVERITY.CRITICAL);
});

// ============================================================================
// 5. Acceptance Criterion 1: Service Outage Notifications
// ============================================================================

test('service outage notifications: dispatches alerts for service failures', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({ authMailer: mailer });

  const result = await service.notifyServiceOutage({
    serviceId: 'nginx',
    status: 'failed',
    critical: true,
    message: 'Nginx web server is inactive (failed)',
    error: { code: 'systemd_unit_failed', message: 'Main process exited with code 1' },
  });

  assert.equal(result.eventType, NOTIFICATION_EVENT_TYPES.SERVICE_OUTAGE);
  assert.equal(result.severity, NOTIFICATION_SEVERITY.CRITICAL);
  assert.equal(result.category, NOTIFICATION_CATEGORIES.SERVICE);

  const sentMails = mailer.getSentMails();
  assert.equal(sentMails.length, 1);
  assert.ok(sentMails[0].subject.includes('nginx'));
  assert.ok(sentMails[0].text.includes('systemd_unit_failed'));
});

// ============================================================================
// 6. Acceptance Criterion 2: Recipient and Site Authorization Boundaries
// ============================================================================

test('tenant boundary: system-level alerts dispatch only to owner, not to customer or reseller', async () => {
  const mailer = createMockAuthMailer();
  const websiteRegistry = createMockWebsiteRegistry([
    { id: 'site-customer-1', customerId: 'cust-1', resellerId: 'res-1' },
  ]);
  const hostingStore = createMockHostingStore({
    customers: [{ id: 'cust-1', email: 'cust1@example.com' }],
    resellers: [{ id: 'res-1', email: 'res1@example.com' }],
  });

  const service = createOperationalNotificationService({
    authMailer: mailer,
    websiteRegistry,
    hostingAccountStore: hostingStore,
    defaultOwnerEmail: 'owner@yunpanel.local',
  });

  // System-level event (no websiteId)
  const result = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_CRITICAL,
    severity: NOTIFICATION_SEVERITY.CRITICAL,
    title: 'Root filesystem 98% full',
    message: 'System disk full',
  });

  const deliveredRecipients = result.deliveries
    .filter((d) => d.status === DELIVERY_STATUS.DELIVERED)
    .map((d) => d.recipient.email);

  assert.ok(deliveredRecipients.includes('owner@yunpanel.local'));
  assert.ok(!deliveredRecipients.includes('cust1@example.com'), 'Customer must not receive global disk alerts');
  assert.ok(!deliveredRecipients.includes('res1@example.com'), 'Reseller must not receive global disk alerts');
});

test('tenant boundary: website-scoped alerts route to owner, customer, and reseller of that website', async () => {
  const mailer = createMockAuthMailer();
  const websiteRegistry = createMockWebsiteRegistry([
    { id: 'site-a', customerId: 'cust-a', resellerId: 'res-a' },
    { id: 'site-b', customerId: 'cust-b', resellerId: 'res-b' },
  ]);
  const hostingStore = createMockHostingStore({
    customers: [
      { id: 'cust-a', email: 'cust-a@client.com' },
      { id: 'cust-b', email: 'cust-b@other.com' },
    ],
    resellers: [
      { id: 'res-a', email: 'res-a@reseller.com' },
      { id: 'res-b', email: 'res-b@otherreseller.com' },
    ],
  });

  const service = createOperationalNotificationService({
    authMailer: mailer,
    websiteRegistry,
    hostingAccountStore: hostingStore,
    defaultOwnerEmail: 'owner@yunpanel.local',
  });

  // Website-scoped event for site-a
  const result = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.BACKUP_FAILED,
    severity: NOTIFICATION_SEVERITY.CRITICAL,
    title: 'Backup failed for site-a',
    message: 'Backup error on site-a',
    websiteId: 'site-a',
  });

  const recipientEmails = result.deliveries
    .filter((d) => d.status === DELIVERY_STATUS.DELIVERED)
    .map((d) => d.recipient.email);

  assert.ok(recipientEmails.includes('owner@yunpanel.local'));
  assert.ok(recipientEmails.includes('cust-a@client.com'));
  assert.ok(recipientEmails.includes('res-a@reseller.com'));
  assert.ok(!recipientEmails.includes('cust-b@other.com'), 'Customer B must not receive site-a alerts');
  assert.ok(!recipientEmails.includes('res-b@otherreseller.com'), 'Reseller B must not receive site-a alerts');
});

test('tenant boundary in delivery history: customer can only see own notifications; cannot see other tenants', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({
    authMailer: mailer,
    defaultOwnerEmail: 'owner@yunpanel.local',
  });

  // 1. Dispatch event for customer A
  await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.SSL_CERTIFICATE_EXPIRING,
    severity: NOTIFICATION_SEVERITY.WARNING,
    title: 'Cert expiring for site-a',
    message: 'Notice for customer A',
    websiteId: 'site-a',
    recipients: [
      { id: 'cust-a-user', role: 'customer', email: 'cust-a@example.com', websiteIds: ['site-a'] },
    ],
  });

  // 2. Dispatch event for customer B
  await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.SSL_CERTIFICATE_EXPIRING,
    severity: NOTIFICATION_SEVERITY.WARNING,
    title: 'Cert expiring for site-b',
    message: 'Notice for customer B',
    websiteId: 'site-b',
    recipients: [
      { id: 'cust-b-user', role: 'customer', email: 'cust-b@example.com', websiteIds: ['site-b'] },
    ],
  });

  // 3. Dispatch system-wide event
  await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_CRITICAL,
    severity: NOTIFICATION_SEVERITY.CRITICAL,
    title: 'Server disk critical',
    message: 'Disk 99% full',
    recipients: [
      { id: 'usr-owner', role: 'owner', email: 'owner@yunpanel.local', isGlobal: true },
    ],
  });

  // Owner sees all
  const ownerActor = { user: { id: 'usr-owner', role: 'owner' }, access: { mode: 'management' } };
  const ownerLogs = service.getDeliveryHistory({ actor: ownerActor });
  assert.ok(ownerLogs.length >= 3);

  // Customer A only sees site-a
  const customerAActor = {
    user: {
      id: 'cust-a-user',
      role: 'customer',
      hosting: { kind: 'customer', id: 'cust-a-user', websiteIds: ['site-a'] },
    },
    access: { mode: 'site_management' },
  };
  const customerALogs = service.getDeliveryHistory({ actor: customerAActor });
  assert.ok(customerALogs.length >= 1);
  for (const entry of customerALogs) {
    assert.equal(entry.details?.websiteId, 'site-a');
    assert.notEqual(entry.details?.websiteId, 'site-b');
  }

  // Customer B only sees site-b
  const customerBActor = {
    user: {
      id: 'cust-b-user',
      role: 'customer',
      hosting: { kind: 'customer', id: 'cust-b-user', websiteIds: ['site-b'] },
    },
    access: { mode: 'site_management' },
  };
  const customerBLogs = service.getDeliveryHistory({ actor: customerBActor });
  assert.ok(customerBLogs.length >= 1);
  for (const entry of customerBLogs) {
    assert.equal(entry.details?.websiteId, 'site-b');
    assert.notEqual(entry.details?.websiteId, 'site-a');
  }
});

// ============================================================================
// 7. Acceptance Criterion 2 & Secret Masking in Notifications
// ============================================================================

test('secret masking in dispatch: secrets in messages, details, and errors are sanitized before delivery', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({ authMailer: mailer });

  const result = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.SERVICE_OUTAGE,
    severity: NOTIFICATION_SEVERITY.CRITICAL,
    title: 'Service failure: DB connection token Bearer secret-auth-token-12345',
    message: 'Could not connect using password SecretPassword123! at mysql://app:DbPassword@127.0.0.1/db',
    details: {
      apiSecret: 'my-private-api-key',
      safeKey: 'safe-value',
      error: {
        code: 'auth_fail',
        message: 'Invalid key: Bearer secret-auth-token-12345',
      },
    },
  });

  const mail = mailer.getSentMails()[0];
  assert.ok(!mail.subject.includes('secret-auth-token-12345'));
  assert.ok(!mail.text.includes('SecretPassword123!'));
  assert.ok(!mail.text.includes('DbPassword'));
  assert.ok(!mail.text.includes('my-private-api-key'));
  assert.ok(mail.text.includes('[REDACTED]'));

  // Also check delivery history entries
  const history = service.getDeliveryHistory();
  const lastEntry = history[0];
  assert.equal(lastEntry.details?.safeKey, 'safe-value');
  assert.equal(lastEntry.details?.apiSecret, '[REDACTED]');
});

// ============================================================================
// 8. Acceptance Criterion 3: Alert Repeat Suppression (Throttling) and Escalation
// ============================================================================

test('throttling: suppresses repeated alerts within window, but allows escalation to critical', async () => {
  let currentTime = 1_700_000_000_000;
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({
    authMailer: mailer,
    now: () => currentTime,
    defaultThrottleWindowMs: 60 * 60 * 1000, // 60 minutes
  });

  // Alert 1: Warning alert for disk /
  const alert1 = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_WARNING,
    severity: NOTIFICATION_SEVERITY.WARNING,
    targetKey: 'disk:/',
    title: 'Disk 87% full',
    message: 'Disk space warning',
  });
  assert.equal(alert1.deliveries.some((d) => d.status === DELIVERY_STATUS.DELIVERED), true);
  assert.equal(mailer.getSentMails().length, 1);

  // Alert 2: Same warning alert 10 minutes later -> MUST BE SUPPRESSED
  currentTime += 10 * 60 * 1000;
  const alert2 = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_WARNING,
    severity: NOTIFICATION_SEVERITY.WARNING,
    targetKey: 'disk:/',
    title: 'Disk 88% full',
    message: 'Disk space warning',
  });
  assert.equal(alert2.deliveries.some((d) => d.status === DELIVERY_STATUS.SUPPRESSED), true);
  assert.equal(mailer.getSentMails().length, 1, 'Mailer must NOT have sent another email');

  // Alert 3: Escalation to CRITICAL 5 minutes later -> MUST BYPASS THROTTLING
  currentTime += 5 * 60 * 1000;
  const alert3 = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_CRITICAL,
    severity: NOTIFICATION_SEVERITY.CRITICAL,
    targetKey: 'disk:/',
    title: 'Disk 97% full',
    message: 'Disk space CRITICAL',
  });
  assert.equal(alert3.deliveries.some((d) => d.status === DELIVERY_STATUS.DELIVERED), true);
  assert.equal(mailer.getSentMails().length, 2, 'Mailer must deliver critical escalated alert');

  // Alert 4: After throttle window (70 minutes later), warning alert dispatches again
  currentTime += 70 * 60 * 1000;
  const alert4 = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_WARNING,
    severity: NOTIFICATION_SEVERITY.WARNING,
    targetKey: 'disk:/',
    title: 'Disk 89% full',
    message: 'Disk space warning',
  });
  assert.equal(alert4.deliveries.some((d) => d.status === DELIVERY_STATUS.DELIVERED), true);
  assert.equal(mailer.getSentMails().length, 3);
});

// ============================================================================
// 9. Acceptance Criterion 3: Severity Filtering & User Preferences
// ============================================================================

test('preferences & severity filtering: respects actor minSeverity and category toggles', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({ authMailer: mailer });

  const actorId = 'usr-admin';

  // Set minSeverity to critical for this actor
  service.updatePreferences(actorId, {
    minSeverity: NOTIFICATION_SEVERITY.CRITICAL,
  });

  // 1. Warning event should be filtered out for this actor
  const warnResult = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_WARNING,
    severity: NOTIFICATION_SEVERITY.WARNING,
    title: 'Disk warning',
    message: 'Low disk warning',
    recipients: [{ id: actorId, role: 'owner', email: 'admin@yunpanel.local' }],
  });
  assert.equal(warnResult.deliveries.some((d) => d.status === DELIVERY_STATUS.DELIVERED), false);
  assert.equal(mailer.getSentMails().length, 0);

  // 2. Critical event should be delivered
  const critResult = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.DISK_THRESHOLD_CRITICAL,
    severity: NOTIFICATION_SEVERITY.CRITICAL,
    title: 'Disk critical',
    message: 'Disk critical alert',
    recipients: [{ id: actorId, role: 'owner', email: 'admin@yunpanel.local' }],
  });
  assert.equal(critResult.deliveries.some((d) => d.status === DELIVERY_STATUS.DELIVERED), true);
  assert.equal(mailer.getSentMails().length, 1);

  // 3. Disable SSL category and dispatch SSL event
  service.updatePreferences(actorId, {
    minSeverity: NOTIFICATION_SEVERITY.INFO,
    categories: { ssl: false },
  });

  const sslResult = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.SSL_CERTIFICATE_CRITICAL,
    severity: NOTIFICATION_SEVERITY.CRITICAL,
    title: 'SSL critical',
    message: 'Cert expiring',
    recipients: [{ id: actorId, role: 'owner', email: 'admin@yunpanel.local' }],
  });
  assert.equal(sslResult.deliveries.some((d) => d.status === DELIVERY_STATUS.DELIVERED), false);
  assert.equal(mailer.getSentMails().length, 1, 'SSL alert skipped due to category disabled');
});

test('preferences & webhook delivery: dispatches HTTP POST when webhook channel is enabled', async () => {
  const webhookCalls = [];
  const mockFetch = async (url, opts) => {
    webhookCalls.push({ url, ...opts });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'x-request-id': 'req-webhook-1' }),
    };
  };

  const service = createOperationalNotificationService({
    fetchFn: mockFetch,
  });

  const actorId = 'usr-admin';
  service.updatePreferences(actorId, {
    channels: {
      webhook: {
        enabled: true,
        url: 'https://webhook.site/test-hook',
      },
    },
  });

  const res = await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.SERVICE_OUTAGE,
    severity: NOTIFICATION_SEVERITY.CRITICAL,
    title: 'Service Outage Detected',
    message: 'MariaDB crashed',
    recipients: [{ id: actorId, role: 'owner' }],
  });

  assert.equal(webhookCalls.length, 1);
  assert.equal(webhookCalls[0].url, 'https://webhook.site/test-hook');
  const payload = JSON.parse(webhookCalls[0].body);
  assert.equal(payload.event, NOTIFICATION_EVENT_TYPES.SERVICE_OUTAGE);
  assert.equal(payload.severity, NOTIFICATION_SEVERITY.CRITICAL);
});

// ============================================================================
// 10. Acceptance Criterion 3: Test Notification Dispatch & Error Visibility
// ============================================================================

test('test notification & error visibility: successful delivery returns delivered: true', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({ authMailer: mailer });

  const result = await service.dispatchTestNotification({
    channel: 'email',
    target: 'operator@example.com',
    message: 'Testing panel alert delivery',
  });

  assert.equal(result.delivered, true);
  assert.equal(result.status, DELIVERY_STATUS.DELIVERED);
  assert.equal(result.recipient, 'operator@example.com');
  assert.ok(result.messageId);
  assert.equal(result.error, null);
});

test('test notification & error visibility: captures delivery failure and exposes detailed error in history', async () => {
  const mailer = createMockAuthMailer({ fail: true, errorMessage: 'Connection timed out to mail.relay.net:587' });
  const service = createOperationalNotificationService({ authMailer: mailer });

  const result = await service.dispatchTestNotification({
    channel: 'email',
    target: 'failed@example.com',
  });

  assert.equal(result.delivered, false);
  assert.equal(result.status, DELIVERY_STATUS.FAILED);
  assert.ok(result.error);
  assert.ok(result.error.message.includes('Connection timed out'));

  // Verify delivery history records the failure with error visibility
  const failedDeliveries = service.getDeliveryHistory({ filter: { status: DELIVERY_STATUS.FAILED } });
  assert.ok(failedDeliveries.length >= 1);
  const failureRecord = failedDeliveries[0];
  assert.equal(failureRecord.status, DELIVERY_STATUS.FAILED);
  assert.equal(failureRecord.recipient.email, 'failed@example.com');
  assert.ok(failureRecord.error.message.includes('Connection timed out'));
});

// ============================================================================
// 11. Acceptance Criterion 5: HTTP Endpoints Integration Tests
// ============================================================================

test('HTTP routes: GET & PATCH /api/notifications/preferences manages preferences', async () => {
  const service = createOperationalNotificationService();
  const app = createTestExpressApp({ notificationService: service, role: 'owner', userId: 'usr-admin' });
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET preferences
    const getRes = await fetch(`${baseUrl}/api/notifications/preferences`);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.data.minSeverity, 'info');
    assert.equal(getBody.data.channels.email.enabled, true);

    // 2. PATCH preferences
    const patchRes = await fetch(`${baseUrl}/api/notifications/preferences`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        minSeverity: 'critical',
        categories: { ssl: false },
        channels: {
          email: { address: 'alerts@domain.com' },
          webhook: { enabled: true, url: 'https://alerts.domain.com/hook' },
        },
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json();
    assert.equal(patchBody.data.minSeverity, 'critical');
    assert.equal(patchBody.data.categories.ssl, false);
    assert.equal(patchBody.data.channels.email.address, 'alerts@domain.com');
    assert.equal(patchBody.data.channels.webhook.url, 'https://alerts.domain.com/hook');

    // 3. GET reflects updated preferences
    const get2Res = await fetch(`${baseUrl}/api/notifications/preferences`);
    const get2Body = await get2Res.json();
    assert.equal(get2Body.data.minSeverity, 'critical');
  } finally {
    server.close();
  }
});

test('HTTP routes: GET /api/notifications/history returns deliveries with filtering and tenant scoping', async () => {
  const service = createOperationalNotificationService();
  // Record some history
  await service.dispatch({
    eventType: NOTIFICATION_EVENT_TYPES.BACKUP_FAILED,
    severity: NOTIFICATION_SEVERITY.CRITICAL,
    title: 'Backup failed',
    message: 'Site backup error',
    websiteId: 'site-my-app',
    recipients: [{ id: 'usr-admin', role: 'owner', email: 'owner@yunpanel.local' }],
  });

  const app = createTestExpressApp({ notificationService: service, role: 'owner', userId: 'usr-admin' });
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/api/notifications/history?eventType=backup_failed`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 1);
    assert.equal(body.data[0].eventType, NOTIFICATION_EVENT_TYPES.BACKUP_FAILED);
  } finally {
    server.close();
  }
});

test('HTTP routes: POST /api/notifications/test sends verified delivery and handles failure', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({ authMailer: mailer });
  const app = createTestExpressApp({ notificationService: service, role: 'owner', userId: 'usr-admin' });
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Success test
    const okRes = await fetch(`${baseUrl}/api/notifications/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'email', target: 'dev@test.local' }),
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.data.delivered, true);

    // 2. Failure test
    mailer.setFail(true, 'SMTP host unreachable');
    const failRes = await fetch(`${baseUrl}/api/notifications/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'email', target: 'dev@test.local' }),
    });
    assert.equal(failRes.status, 502);
    const failBody = await failRes.json();
    assert.equal(failBody.data.delivered, false);
    assert.ok(failBody.data.error.message.includes('SMTP host unreachable'));
  } finally {
    server.close();
  }
});

test('HTTP routes: POST /api/notifications/check executes sweep; rejects non-owners', async () => {
  const certRegistry = createMockCertificateRegistry();
  const service = createOperationalNotificationService({ certificateRegistry: certRegistry });

  // Owner app
  const ownerApp = createTestExpressApp({ notificationService: service, role: 'owner', userId: 'usr-admin' });
  const ownerServer = ownerApp.listen(0);
  const ownerPort = ownerServer.address().port;

  // Customer app
  const customerApp = createTestExpressApp({
    notificationService: service,
    role: 'customer',
    userId: 'usr-cust',
    hosting: { kind: 'customer', id: 'usr-cust', websiteIds: ['site-1'] },
  });
  const customerServer = customerApp.listen(0);
  const customerPort = customerServer.address().port;

  try {
    // 1. Owner can execute sweep
    const ownerRes = await fetch(`http://127.0.0.1:${ownerPort}/api/notifications/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        disks: [{ mountPoint: '/', usedBytes: 50, totalBytes: 100 }],
      }),
    });
    assert.equal(ownerRes.status, 200);
    const ownerBody = await ownerRes.json();
    assert.equal(ownerBody.data.checked.disks, 1);

    // 2. Customer is forbidden (403) from running sweep
    const custRes = await fetch(`http://127.0.0.1:${customerPort}/api/notifications/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(custRes.status, 403);
    const custBody = await custRes.json();
    assert.equal(custBody.error.code, 'forbidden');
  } finally {
    ownerServer.close();
    customerServer.close();
  }
});

test('HTTP routes: GET /api/notifications/status returns system readiness and channel stats', async () => {
  const mailer = createMockAuthMailer();
  const service = createOperationalNotificationService({ authMailer: mailer });
  const app = createTestExpressApp({ notificationService: service, role: 'owner', userId: 'usr-admin' });
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, 'active');
    assert.equal(body.data.channels.email.available, true);
    assert.equal(body.data.channels.panel.available, true);
  } finally {
    server.close();
  }
});

test('HTTP routes: unauthenticated requests return 401 unauthorized', async () => {
  const service = createOperationalNotificationService();
  const app = createTestExpressApp({ notificationService: service, role: 'unauthenticated' });
  const server = app.listen(0);
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notifications/preferences`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'unauthorized');
  } finally {
    server.close();
  }
});
