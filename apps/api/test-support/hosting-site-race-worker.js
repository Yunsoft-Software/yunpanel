import { parentPort, workerData } from 'node:worker_threads';
import { hostingAuthFixture } from './hosting-auth-fixture.js';
import { createHostingAccountStore } from '../src/hosting-account-store.js';

const f = hostingAuthFixture(workerData.filePath);
const store = createHostingAccountStore(f);
parentPort.once('message', () => {
  try {
    const allocation = store.siteAllocations.reserve('token-owner', f.requireManagement, workerData.plan);
    parentPort.postMessage({ ok: true, state: allocation.state });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error.code });
  } finally { f.db.close(); }
});
parentPort.postMessage('ready');
