import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { siteFixture, allocation } from '../test-support/hosting-site-fixture.js';

for (const sameOperation of [false, true]) {
  test(`independent SQLite writers serialize the last site slot (same operation: ${sameOperation})`, { timeout: 15000 }, async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-site-race-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'auth.sqlite');
    const f = siteFixture(t, { filePath });
    const workers = [allocation(1), allocation(sameOperation ? 1 : 2, sameOperation ? 'customer-a' : 'customer-b')].map((plan) =>
      new Worker(new URL('../test-support/hosting-site-race-worker.js', import.meta.url), { workerData: { filePath, plan } }));
    t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
    let ready = 0;
    const results = await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('exit', (exitCode) => { if (exitCode) reject(new Error(`Worker exited ${exitCode}`)); });
      worker.on('message', (message) => {
        if (message !== 'ready') { resolve(message); return; }
        ready += 1;
        if (ready === workers.length) for (const item of workers) item.postMessage('reserve');
      });
    })));
    assert.equal(results.filter((item) => item.ok).length, sameOperation ? 2 : 1);
    if (!sameOperation) assert.equal(results.find((item) => !item.ok).code, 'reseller_limit_reached');
    assert.equal(f.count('auth_hosting_site_allocations'), 1);
    assert.equal(f.get().usage.websites, 1);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM fixture_audit WHERE action = 'hosting.website_reserved'").get().n, 1);
  });
}
