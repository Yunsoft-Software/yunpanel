import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOperationalNotificationService } from '../src/operational-notification-service.js';
import { createOperationalNotificationSweep } from '../src/operational-notification-sweep.js';
import { NOTIFICATION_EVENT_TYPES, NOTIFICATION_SEVERITY } from '../src/operational-notification-types.js';

const HOUR = 60 * 60 * 1000;
const silent = { error() {}, warn() {}, info() {} };

function mailer({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    fail,
    async sendMail(mail) {
      if (this.fail) throw new Error('SMTP connection refused');
      sent.push(mail);
      return { messageId: `m-${sent.length}` };
    },
  };
}

function outage(extra = {}) {
  return {
    eventType: NOTIFICATION_EVENT_TYPES.SERVICE_OUTAGE,
    severity: NOTIFICATION_SEVERITY.CRITICAL,
    title: 'Servis Kesintisi: nginx',
    targetKey: 'service:nginx',
    ...extra,
  };
}

async function tempStore(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yp-notify-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'operational-notifications.json');
}

test('the address saved in settings wins over the account address', async () => {
  const mail = mailer();
  const service = createOperationalNotificationService({
    authMailer: mail, defaultOwnerEmail: null, ownerEmailLookup: async () => 'account@example.com', logger: silent,
  });
  service.updatePreferences('usr-owner', { channels: { email: { address: 'alerts@example.com' } } });
  await service.dispatch(outage());
  assert.deepEqual(mail.sent.map((entry) => entry.to), ['alerts@example.com']);
});

test('the account address is used when none was saved, and a missing address is recorded', async () => {
  const mail = mailer();
  const withAccount = createOperationalNotificationService({
    authMailer: mail, defaultOwnerEmail: null, ownerEmailLookup: async () => 'account@example.com', logger: silent,
  });
  await withAccount.dispatch(outage());
  assert.deepEqual(mail.sent.map((entry) => entry.to), ['account@example.com']);

  const without = createOperationalNotificationService({ authMailer: mail, defaultOwnerEmail: null, logger: silent });
  const result = await without.dispatch(outage());
  const email = result.deliveries.find((entry) => entry.channel === 'email');
  assert.equal(email.status, 'failed');
  assert.equal(email.error.code, 'recipient_email_missing');
});

test('a failed email is retried on the next check instead of being silenced for the window', async () => {
  const mail = mailer({ fail: true });
  let clock = 1_000_000;
  const service = createOperationalNotificationService({
    authMailer: mail, defaultOwnerEmail: 'owner@example.com', now: () => clock, logger: silent,
  });
  await service.dispatch(outage());
  assert.equal(mail.sent.length, 0);

  mail.fail = false;
  clock += 60_000;
  await service.dispatch(outage());
  assert.equal(mail.sent.length, 1);

  clock += 60_000;
  await service.dispatch(outage());
  assert.equal(mail.sent.length, 1, 'a delivered alert stays throttled');
});

test('preferences, feed, history and throttling survive an API restart in a private file', async (t) => {
  const filePath = await tempStore(t);
  const mail = mailer();
  let clock = 5_000_000;
  const options = { authMailer: mail, defaultOwnerEmail: 'owner@example.com', now: () => clock, filePath, logger: silent };
  const first = createOperationalNotificationService(options);
  first.updatePreferences('usr-owner', { categories: { disk: false } });
  await first.dispatch(outage());
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const reopened = createOperationalNotificationService(options);
  assert.equal(reopened.getPreferences('usr-owner').categories.disk, false);
  assert.equal(reopened.getFeed('usr-owner').length, 1);
  assert.ok(reopened.getDeliveryHistory({}).length >= 2);
  clock += 60_000;
  await reopened.dispatch(outage());
  assert.equal(mail.sent.length, 1, 'a restart must not resend the same alert');
});

test('an unreadable notification file is logged and never stops the API', async (t) => {
  const filePath = await tempStore(t);
  await writeFile(filePath, '{ not json');
  const logged = [];
  const service = createOperationalNotificationService({
    filePath, defaultOwnerEmail: null, logger: { ...silent, error: (...args) => logged.push(args) },
  });
  assert.equal(service.getPreferences('usr-owner').enabled, true);
  assert.equal(logged.length, 1);
});

test('retired certificates raise no alerts and expiry warnings repeat once a day', async () => {
  const mail = mailer();
  let clock = Date.parse('2026-11-01T00:00:00.000Z');
  const validTo = new Date(clock + 10 * 24 * HOUR).toISOString();
  const service = createOperationalNotificationService({
    authMailer: mail,
    defaultOwnerEmail: 'owner@example.com',
    now: () => clock,
    logger: silent,
    certificateRegistry: {
      async listCertificates() {
        return [
          { id: 'live', state: 'active', certName: 'live.example', validTo },
          { id: 'old', state: 'retired', certName: 'old.example', validTo },
          { id: 'replaced', state: 'superseded', certName: 'replaced.example', validTo },
        ];
      },
    },
  });
  await service.checkCertificateExpirations({ now: clock });
  assert.equal(mail.sent.length, 1);
  assert.match(mail.sent[0].subject, /live\.example/);

  clock += 2 * HOUR;
  await service.checkCertificateExpirations({ now: clock });
  assert.equal(mail.sent.length, 1);

  clock += 23 * HOUR;
  await service.checkCertificateExpirations({ now: clock });
  assert.equal(mail.sent.length, 2);
});

test('the alert address is stored for the independent sentinel', async (t) => {
  const filePath = await tempStore(t);
  const service = createOperationalNotificationService({
    filePath, defaultOwnerEmail: null, ownerEmailLookup: async () => 'account@example.com', logger: silent,
  });
  await service.refreshAlertAddress();
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).alertAddress, 'account@example.com');

  service.updatePreferences('usr-owner', { channels: { email: { address: 'alerts@example.com' } } });
  await service.refreshAlertAddress();
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).alertAddress, 'alerts@example.com');
});

test('the sweep checks certificates and the disk, and a failure is logged without stopping later runs', async () => {
  const calls = [];
  const logged = [];
  let failCertificates = true;
  const sweep = createOperationalNotificationSweep({
    service: {
      async refreshAlertAddress() { calls.push('address'); },
      async checkCertificateExpirations() {
        if (failCertificates) throw new Error('registry unavailable');
        calls.push('certificates');
      },
      async checkDiskAndInodeThresholds({ disks }) { calls.push(['disks', disks[0].usagePercent, disks[0].inodeUsagePercent]); },
    },
    readDisks: async () => [{ mountPoint: '/', usagePercent: 91, inodeUsagePercent: 12 }],
    logger: { ...silent, error: (...args) => logged.push(args) },
  });

  await sweep.runOnce();
  assert.equal(logged.length, 1);
  assert.deepEqual(calls.at(-1), ['disks', 91, 12], 'a certificate failure must not skip the disk check');

  failCertificates = false;
  await sweep.runOnce();
  assert.ok(calls.includes('certificates'));
});

test('the feed route returns the owner feed and saving preferences refreshes the sentinel address', async () => {
  const { default: express } = await import('express');
  const { mountOperationalNotificationRoutes } = await import('../src/operational-notification-http.js');
  const service = createOperationalNotificationService({ defaultOwnerEmail: 'owner@example.com', logger: silent });
  let refreshed = 0;
  const original = service.refreshAlertAddress;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.auth = {
      user: { id: 'real-owner-id', role: 'owner' },
      access: { mode: 'management', permissions: ['*'] },
      security: { managementAllowed: true },
    }; next(); });
  mountOperationalNotificationRoutes(app, {
    notificationService: { ...service, refreshAlertAddress: async () => { refreshed += 1; return original(); } },
  });
  await service.dispatch(outage());
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/notifications`;
    const feed = await (await fetch(`${base}/feed`)).json();
    assert.equal(feed.data.length, 1);
    assert.equal(feed.data[0].title, 'Servis Kesintisi: nginx');

    const saved = await fetch(`${base}/preferences`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ categories: { disk: false } }),
    });
    assert.equal(saved.status, 200);
    assert.equal(refreshed, 1);
    assert.equal(service.getPreferences('usr-owner').categories.disk, false, 'saved under the recipient that alerts read');
  } finally {
    server.close();
  }
});

test('a test email goes to the saved address, then the account address, without a typed target', async () => {
  const mail = mailer();
  const service = createOperationalNotificationService({
    authMailer: mail, defaultOwnerEmail: null, ownerEmailLookup: async () => 'account@example.com', logger: silent,
  });
  const actor = { user: { id: 'real-owner-id', role: 'owner' } };

  const first = await service.dispatchTestNotification({ actor, channel: 'email' });
  assert.equal(first.delivered, true);
  assert.equal(mail.sent.at(-1).to, 'account@example.com');

  service.updatePreferences('usr-owner', { channels: { email: { address: 'alerts@example.com' } } });
  await service.dispatchTestNotification({ actor, channel: 'email' });
  assert.equal(mail.sent.at(-1).to, 'alerts@example.com');

  await service.dispatchTestNotification({ actor, channel: 'email', target: 'typed@example.com' });
  assert.equal(mail.sent.at(-1).to, 'typed@example.com');
});
