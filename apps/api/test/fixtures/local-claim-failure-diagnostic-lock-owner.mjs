import assert from 'node:assert/strict';
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProcessStoreLock } from '../../src/process-store-lock.js';

const [filePath, expectedDev, expectedIno] = process.argv.slice(2);
const root = path.dirname(filePath), temp = await realpath(os.tmpdir());
assert.equal(root.startsWith(path.join(temp, 'yunpanel-claim-diagnostic-')), true);
assert.equal(await realpath(root), root); assert.equal(path.basename(filePath), 'job-registry.json');
const metadata = await lstat(root);
assert.equal(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid() && (metadata.mode & 0o777) === 0o700, true);
assert.deepEqual([String(metadata.dev), String(metadata.ino)], [expectedDev, expectedIno]);
await createProcessStoreLock({ filePath }).withLock(async () => {
  process.send({ event: 'locked', pid: process.pid });
  await new Promise(resolve => process.once('message', message => { assert.equal(message.event, 'release'); resolve(); }));
});
process.disconnect();
