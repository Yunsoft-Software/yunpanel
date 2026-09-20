import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteCronManager,
  WebsiteCronManagerError,
  websiteCronManagerInternals,
} from '../src/index.js';

const task = Object.freeze({
  taskId: '07b0be89-f855-4c61-8132-3a73eb39888b',
  user: 'yunapp-0123456789ab',
  schedule: '*/5 * * * *',
  command: 'node worker.js',
  enabled: true,
});

function regularStat(content) {
  return {
    uid: 0,
    gid: 0,
    mode: 0o100644,
    size: Buffer.byteLength(content),
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function fixture({ serviceActive = true, initial = null, directoryEntry = null } = {}) {
  const files = new Map();
  if (initial !== null) {
    files.set(
      `${websiteCronManagerInternals.cronDirectory}/yunpanel-${task.taskId}`,
      initial,
    );
  }
  const calls = [];
  const manager = createWebsiteCronManager({
    run: async (file, args) => {
      calls.push(['run', file, [...args]]);
      if (!serviceActive) {
        const error = new Error('inactive');
        error.code = 3;
        throw error;
      }
      return { stdout: 'active\n' };
    },
    lstatFn: async (filePath) => {
      if (!files.has(filePath)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return regularStat(files.get(filePath));
    },
    readFileFn: async (filePath) => Buffer.from(files.get(filePath)),
    readdirFn: async () => [...files.keys()].map((filePath) => ({
      name: filePath.split('/').at(-1),
      isFile: () => directoryEntry !== 'symlink',
      isSymbolicLink: () => directoryEntry === 'symlink',
    })),
    mkdirFn: async (...args) => { calls.push(['mkdir', ...args]); },
    writeFileFn: async (filePath, content) => {
      calls.push(['write', filePath]);
      files.set(filePath, String(content));
    },
    chownFn: async (...args) => { calls.push(['chown', ...args]); },
    chmodFn: async (...args) => { calls.push(['chmod', ...args]); },
    renameFn: async (from, to) => {
      calls.push(['rename', from, to]);
      const content = files.get(from);
      files.delete(from);
      files.set(to, content);
    },
    rmFn: async (filePath, options = {}) => {
      calls.push(['rm', filePath, options]);
      if (!files.has(filePath) && !options.force) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      files.delete(filePath);
    },
  });
  return { manager, files, calls };
}

test('Website cron manager applies and inspects exact managed cron.d state', async () => {
  const f = fixture();
  const applied = await f.manager.apply(task);

  assert.equal(applied.changed, true);
  assert.equal(applied.ready, true);
  assert.equal(applied.exact, true);
  assert.equal(applied.cronServiceActive, true);
  assert.equal(applied.sideEffects, true);
  assert.match(applied.desiredSha256, /^[a-f0-9]{64}$/);

  const inspected = await f.manager.inspect(task);
  assert.equal(inspected.ready, true);
  assert.equal(inspected.currentSha256, applied.desiredSha256);

  const again = await f.manager.apply(task);
  assert.equal(again.changed, false);
  assert.equal(again.sideEffects, false);
  assert.equal(f.calls.some((call) => call[0] === 'chown' && call[2] === 0 && call[3] === 0), true);
  assert.equal(f.calls.some((call) => call[0] === 'chmod' && call[2] === 0o644), true);
});

test('Website cron manager rolls back a new file when cron service is unavailable', async () => {
  const f = fixture({ serviceActive: false });

  await assert.rejects(
    f.manager.apply(task),
    (error) => error instanceof WebsiteCronManagerError
      && error.code === 'website_cron_service_unavailable',
  );
  const target = `${websiteCronManagerInternals.cronDirectory}/yunpanel-${task.taskId}`;
  assert.equal(f.files.has(target), false);
});

test('Website cron manager refuses foreign or incorrectly owned files', async () => {
  const target = `${websiteCronManagerInternals.cronDirectory}/yunpanel-${task.taskId}`;
  const foreign = fixture({ initial: '* * * * * root echo foreign\n' });
  await assert.rejects(
    foreign.manager.inspect(task),
    (error) => error instanceof WebsiteCronManagerError
      && error.code === 'website_cron_file_conflict',
  );

  const managed = fixture();
  managed.files.set(target, '# Managed by YunPanel. Manual edits are overwritten.\n');
  managed.manager = createWebsiteCronManager({
    run: async () => ({ stdout: 'active\n' }),
    lstatFn: async () => ({
      ...regularStat(managed.files.get(target)),
      uid: 1000,
    }),
    readFileFn: async () => Buffer.from(managed.files.get(target)),
  });
  await assert.rejects(
    managed.manager.inspect(task),
    (error) => error instanceof WebsiteCronManagerError
      && error.code === 'website_cron_file_ownership_invalid',
  );
});

test('Website cron manager removes only the exact expected managed state', async () => {
  const f = fixture();
  const applied = await f.manager.apply(task);
  assert.equal(applied.ready, true);

  await assert.rejects(
    f.manager.remove({ ...task, command: 'node changed.js' }),
    (error) => error instanceof WebsiteCronManagerError
      && error.code === 'website_cron_remove_drift',
  );

  const removed = await f.manager.remove(task);
  assert.deepEqual(removed, {
    taskId: task.taskId,
    removed: true,
    previousSha256: applied.desiredSha256,
    sideEffects: true,
  });
  const again = await f.manager.remove(task);
  assert.deepEqual(again, {
    taskId: task.taskId,
    removed: false,
    previousSha256: null,
    sideEffects: false,
  });
});

test('read-only cron inventory enumerates exact managed files and exposes only identity and digests', async () => {
  const f = fixture();
  assert.deepEqual(await f.manager.listManagedFiles(), {
    version: 1, files: [], cronServiceActive: true, sideEffects: false,
  });
  const applied = await f.manager.apply(task);
  f.calls.length = 0;
  assert.deepEqual(await f.manager.listManagedFiles(), {
    version: 1,
    files: [{
      taskId: task.taskId,
      fileName: `yunpanel-${task.taskId}`,
      contentSha256: applied.desiredSha256,
    }],
    cronServiceActive: true,
    sideEffects: false,
  });
  assert.deepEqual(f.calls.map((entry) => entry[0]), ['run']);
});

test('cron inventory refuses foreign, incomplete and symlinked YunPanel entries', async () => {
  const f = fixture();
  const target = `${websiteCronManagerInternals.cronDirectory}/yunpanel-${task.taskId}`;
  f.files.set(target, '* * * * * root echo foreign\n');
  await assert.rejects(f.manager.listManagedFiles(), { code: 'website_cron_file_conflict' });

  f.files.delete(target);
  f.files.set(`${target}.tmp`, 'orphaned temp');
  await assert.rejects(f.manager.listManagedFiles(), { code: 'website_cron_directory_conflict' });

  const symlink = fixture({
    initial: '# Managed by YunPanel. Manual edits are overwritten.\n',
    directoryEntry: 'symlink',
  });
  await assert.rejects(symlink.manager.listManagedFiles(), { code: 'website_cron_directory_conflict' });
});
