import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';
import { createHostingAccountStore } from '../src/hosting-account-store.js';

test('two independent SQLite writers cannot consume the same final customer slot', { timeout: 15000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yunpanel-hosting-race-'));
  const filePath = join(directory, 'auth.sqlite');
  const f = hostingAuthFixture(filePath);
  const workers = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.terminate()));
    f.db.close(); rmSync(directory, { recursive: true, force: true });
  });
  f.addUser('owner', { role: 'owner' });
  for (const id of ['reseller-a', 'customer-a', 'customer-b']) f.addUser(id);
  const token = f.session('owner');
  const store = createHostingAccountStore(f);
  store.registerReseller(token, f.requireManagement, { userId: 'reseller-a', expectedUserRevision: 1, limits: { maxCustomers: 1, maxWebsites: 1 } });
  for (const userId of ['customer-a', 'customer-b']) workers.push(new Worker(new URL('../test-support/hosting-account-race-worker.js', import.meta.url), { workerData: { filePath, userId, token } }));
  const ready = await Promise.all(workers.map((worker) => once(worker, 'message')));
  assert.ok(ready.every(([message]) => message.ready === true));
  const results = workers.map((worker) => once(worker, 'message'));
  for (const worker of workers) worker.postMessage('register');
  const completed = (await Promise.all(results)).map(([message]) => message);
  assert.deepEqual(completed.map((message) => message.result).sort(), ['created', 'reseller_limit_reached']);
  assert.equal(store.get(token, f.requireManagement, 'reseller-a').usage.customers, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM fixture_audit WHERE action = 'hosting.customer_registered'").get().n, 1);
  const linked = completed.find((message) => message.result === 'created').id;
  const other = linked === 'customer-a' ? 'customer-b' : 'customer-a';
  assert.equal(f.db.prepare('SELECT revision FROM auth_user_revisions WHERE user_id = ?').get(linked).revision, 2);
  assert.equal(f.db.prepare('SELECT revision FROM auth_user_revisions WHERE user_id = ?').get(other), undefined);
});
