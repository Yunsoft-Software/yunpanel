import { randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const CONFIG_DIRECTORY = '.yunpanel';
const CONFIG_FILE = 'database.json';
const MAX_CONFIG_BYTES = 4_096;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INVALID = 'php_copy_connection_invalid';
const EXISTS = 'php_copy_connection_exists';

function fail(code = INVALID) {
  throw Object.assign(new Error('PHP connection file check failed'), { code });
}

function connectionConfig(value) {
  if (!value || value.version !== 1 || !UUID.test(value.bindingId ?? '') || !UUID.test(value.credentialId ?? '')
    || !/^[A-Za-z0-9_]{1,64}$/.test(value.databaseName ?? '') || value.host !== 'localhost'
    || !/^ydb_[a-f0-9]{24}$/.test(value.username ?? '') || typeof value.password !== 'string'
    || !/^[A-Za-z0-9_!@#%^*+=.:,-]{16,128}$/.test(value.password) || Object.keys(value).length !== 7) fail();
  const { bindingId, credentialId, databaseName, host, username, password } = value;
  return { version: 1, bindingId, credentialId, databaseName, host, username, password };
}

async function checkedDirectory(directory, uid, privateMode) {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.uid !== uid || (entry.mode & 0o7022) !== 0
    || (privateMode && (entry.mode & 0o777) !== 0o700)) fail();
  return entry;
}

async function missing(operation) {
  try { return await operation(); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readPrivateFile(uid) {
  const handle = await missing(() => open(CONFIG_FILE, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  if (!handle) return null;
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.uid !== uid || entry.nlink !== 1 || (entry.mode & 0o7777) !== 0o600
      || entry.size < 1 || entry.size > MAX_CONFIG_BYTES) fail();
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer);
    const current = await lstat(CONFIG_FILE);
    if (entry.dev !== current.dev || entry.ino !== current.ino || entry.mtimeMs !== current.mtimeMs
      || entry.ctimeMs !== current.ctimeMs || bytesRead !== entry.size) fail();
    return connectionConfig(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } finally { await handle.close(); }
}

async function createPrivateFile(config) {
  const temporary = `.database-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config)}\n`, 'utf8');
    await handle.sync();
    await link(temporary, CONFIG_FILE);
  } catch (error) {
    if (error.code === 'EEXIST') fail(EXISTS);
    throw error;
  } finally {
    await handle.close();
    await unlink(temporary);
  }
  if (process.platform === 'linux') {
    const directory = await open('.', constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); }
    finally { await directory.close(); }
  }
}

async function operate({ action, home, config } = {}) {
  const uid = process.getuid?.();
  if (!['inspect', 'create'].includes(action) || !uid
    || typeof home !== 'string' || !path.isAbsolute(home) || home === '/' || await realpath(home) !== home) fail();
  const expected = connectionConfig(config);
  const homeEntry = await checkedDirectory(home, uid, false);
  process.chdir(home);
  const entered = await stat('.');
  if (homeEntry.dev !== entered.dev || homeEntry.ino !== entered.ino) fail();
  if (action === 'create') {
    try { await mkdir(CONFIG_DIRECTORY, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const directory = await missing(() => checkedDirectory(CONFIG_DIRECTORY, uid, true));
  if (!directory) return null;
  process.chdir(CONFIG_DIRECTORY);
  async function confirmLocation() {
    const [working, parent, current] = await Promise.all([
      stat('.'), stat('..'), checkedDirectory(path.join(home, CONFIG_DIRECTORY), uid, true),
    ]);
    if (working.dev !== directory.dev || working.ino !== directory.ino || parent.dev !== homeEntry.dev
      || parent.ino !== homeEntry.ino || current.dev !== directory.dev || current.ino !== directory.ino) fail();
  }
  await confirmLocation();

  if (action === 'create') await createPrivateFile(expected);
  const actual = await readPrivateFile(uid);
  if (!actual && action === 'inspect') return null;
  const expectedData = Buffer.from(JSON.stringify(expected));
  const actualData = Buffer.from(JSON.stringify(actual));
  if (expectedData.length !== actualData.length || !timingSafeEqual(expectedData, actualData)) fail();
  await confirmLocation();
  return { version: 1, bindingId: expected.bindingId, credentialId: expected.credentialId };
}

try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_CONFIG_BYTES) fail();
    chunks.push(chunk);
  }
  const data = await operate(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(JSON.stringify({ ok: true, data }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.code === EXISTS ? EXISTS : INVALID }));
}
