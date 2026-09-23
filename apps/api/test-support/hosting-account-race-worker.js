import { parentPort, workerData } from 'node:worker_threads';
import { hostingAuthFixture } from './hosting-auth-fixture.js';
import { createHostingAccountStore } from '../src/hosting-account-store.js';

const f = hostingAuthFixture(workerData.filePath);
const store = createHostingAccountStore(f);
parentPort.postMessage({ ready: true });
parentPort.once('message', () => {
  try {
    const result = store.registerCustomer(workerData.token, f.requireManagement, {
      userId: workerData.userId, expectedUserRevision: 1, resellerId: 'reseller-a',
    });
    parentPort.postMessage({ result: 'created', id: result.id });
  } catch (error) {
    parentPort.postMessage({ result: error.code ?? 'unexpected_error', message: error.message });
  } finally { f.db.close(); parentPort.close(); }
});
