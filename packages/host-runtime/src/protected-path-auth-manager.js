import { execFile, spawn } from 'node:child_process';
import { chmod, chown, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// htpasswd files for password-protected directories (nginx auth_basic). Only
// SHA-512 crypt hashes are stored, produced by openssl from stdin so a password
// never appears in argv, logs or files. Files are root-owned, group-readable by
// the nginx group (0640) and named by the random key of the protected path, as in
// packages/config-templates nginx.js.
const execFileAsync = promisify(execFile);
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KEY = /^[a-f0-9]{16}$/;
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_USERS = 50;

export class ProtectedPathAuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ProtectedPathAuthError';
    this.code = code;
    this.status = status;
  }
}

function invalid(field, message) {
  throw new ProtectedPathAuthError(`invalid_protected_path_${field}`, message);
}

export function createProtectedPathAuthManager({
  root = '/etc/nginx/yunpanel-auth',
  groupId = 'auto',
  groupName = 'www-data',
  openssl = '/usr/bin/openssl',
  execFileFn = execFileAsync,
} = {}) {
  const queues = new Map();
  let resolvedGroup = typeof groupId === 'number' || groupId === null ? groupId : undefined;

  function serialize(key, operation) {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    queues.set(key, run.catch(() => {}));
    return run;
  }

  function locate({ domain, key }) {
    if (typeof domain !== 'string' || !HOSTNAME.test(domain)) invalid('domain', 'Domain is invalid');
    if (typeof key !== 'string' || !KEY.test(key)) invalid('key', 'Protected path key is invalid');
    return { directory: path.join(root, domain), file: path.join(root, domain, `${key}.htpasswd`) };
  }

  async function group() {
    if (resolvedGroup !== undefined) return resolvedGroup;
    try {
      const { stdout } = await execFileFn('/usr/bin/getent', ['group', groupName]);
      const gid = Number(String(stdout).split(':')[2]);
      if (!Number.isInteger(gid)) throw new Error('invalid');
      resolvedGroup = gid;
      return gid;
    } catch {
      throw new ProtectedPathAuthError('protected_path_group_unavailable', `The ${groupName} group was not found on this host`, 503);
    }
  }

  async function read(file) {
    try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  }

  async function write(location, lines) {
    const gid = await group();
    // nginx workers must traverse both the root and the domain directory.
    for (const directory of [root, location.directory]) {
      await mkdir(directory, { recursive: true, mode: 0o750 });
      await chmod(directory, 0o750);
      if (gid !== null) await chown(directory, 0, gid);
    }
    const temporary = `${location.file}.${process.pid}.tmp`;
    await writeFile(temporary, lines.length ? `${lines.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o640 });
    await chmod(temporary, 0o640);
    if (gid !== null) await chown(temporary, 0, gid);
    await rename(temporary, location.file);
  }

  // execFile cannot feed stdin, so the password is written to the child directly.
  function hashWithOpenssl(password) {
    return new Promise((resolve, reject) => {
      const child = spawn(openssl, ['passwd', '-6', '-stdin'], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000 });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve(stdout) : reject(new Error(`openssl exited ${code}`))));
      child.stdin.end(password);
    });
  }

  async function hash(password) {
    try {
      const value = String(await hashWithOpenssl(password)).trim();
      if (!/^\$6\$[^$:\s]+\$[A-Za-z0-9./]{86}$/.test(value)) throw new Error('unexpected');
      return value;
    } catch {
      throw new ProtectedPathAuthError('protected_path_hash_failed', 'Password could not be hashed', 503);
    }
  }

  async function listUsers(target) {
    const location = locate(target);
    return (await read(location.file)).map(line => line.split(':')[0]);
  }

  async function setUser({ username, password, ...target }) {
    const location = locate(target);
    if (typeof username !== 'string' || !USERNAME.test(username)) invalid('username', 'Username must be 1-64 letters, digits, dot, dash or underscore');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128 || /[\u0000-\u001f\u007f]/.test(password)) {
      invalid('password', 'Password must be 8-128 characters without control characters');
    }
    return serialize(location.file, async () => {
      const lines = await read(location.file);
      const others = lines.filter(line => line.split(':')[0] !== username);
      if (others.length === lines.length && lines.length >= MAX_USERS) {
        throw new ProtectedPathAuthError('protected_path_user_limit', `A directory can have at most ${MAX_USERS} users`, 409);
      }
      await write(location, [...others, `${username}:${await hash(password)}`]);
      return { username };
    });
  }

  async function removeUser({ username, ...target }) {
    const location = locate(target);
    if (typeof username !== 'string' || !USERNAME.test(username)) invalid('username', 'Username is invalid');
    return serialize(location.file, async () => {
      const lines = await read(location.file);
      await write(location, lines.filter(line => line.split(':')[0] !== username));
      return { removed: lines.length };
    });
  }

  async function removePath(target) {
    const location = locate(target);
    return serialize(location.file, () => rm(location.file, { force: true }));
  }

  async function removeDomain({ domain }) {
    if (typeof domain !== 'string' || !HOSTNAME.test(domain)) invalid('domain', 'Domain is invalid');
    await rm(path.join(root, domain), { recursive: true, force: true });
  }

  return Object.freeze({ listUsers, setUser, removeUser, removePath, removeDomain });
}
