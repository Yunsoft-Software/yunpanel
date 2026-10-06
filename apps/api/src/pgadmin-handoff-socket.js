import { execFile } from 'node:child_process';
import { chmod, chown, lstat, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { PgAdminHandoffError } from './pgadmin-handoff-service.js';

const execFileAsync = promisify(execFile);
const SOCKET_DIRECTORY = '/run/yunpanel-pgadmin';
const SOCKET_PATH = `${SOCKET_DIRECTORY}/handoff.sock`;
const SOCKET_GROUP = 'yunpanel-pgadmin';
const DIRECTORY_MODE = 0o750;
const SOCKET_MODE = 0o660;
const ROOT_UID = 0;
const GROUP_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 1024;
const GETENT = '/usr/bin/getent';

export class PgAdminHandoffSocketError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PgAdminHandoffSocketError';
    this.code = code;
  }
}

function socketError(code, message) {
  return new PgAdminHandoffSocketError(code, message);
}

function parseGroupIdentity(value, expectedName) {
  if (typeof expectedName !== 'string' || !GROUP_NAME_PATTERN.test(expectedName)) return null;
  const fields = String(value ?? '').trim().split(':');
  if (fields.length !== 4 || fields[0] !== expectedName || !/^\d+$/.test(fields[2])) return null;
  const gid = Number.parseInt(fields[2], 10);
  if (!Number.isSafeInteger(gid) || gid <= 0) return null;
  return Object.freeze({ gid });
}

function exactBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2
    || typeof value.capability !== 'string' || !CAPABILITY_PATTERN.test(value.capability)
    || typeof value.sessionDigest !== 'string' || !DIGEST_PATTERN.test(value.sessionDigest)) {
    throw socketError(
      'pgadmin_handoff_consume_request_invalid',
      'pgAdmin handoff consume request is invalid',
    );
  }
  return value;
}

function responseHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'content-type': contentType,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...responseHeaders(),
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function errorStatus(error) {
  if (error instanceof PgAdminHandoffError) {
    if ([400, 401, 403, 404, 409, 429, 503].includes(error.status)) return error.status;
    return 400;
  }
  if (error instanceof PgAdminHandoffSocketError) return 400;
  return 503;
}

function publicError(error) {
  if (error instanceof PgAdminHandoffError || error instanceof PgAdminHandoffSocketError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'pgadmin_handoff_consumer_unavailable',
    message: 'pgAdmin handoff consumer is unavailable',
  };
}

async function readJsonBody(request) {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw socketError(
      'pgadmin_handoff_consume_content_type_invalid',
      'pgAdmin handoff consume requires application/json',
    );
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw socketError(
        'pgadmin_handoff_consume_body_too_large',
        'pgAdmin handoff consume request is too large',
      );
    }
    chunks.push(chunk);
  }
  if (bytes < 2) {
    throw socketError(
      'pgadmin_handoff_consume_request_invalid',
      'pgAdmin handoff consume request is invalid',
    );
  }
  try {
    return exactBody(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
  } catch (error) {
    if (error instanceof PgAdminHandoffSocketError) throw error;
    throw socketError(
      'pgadmin_handoff_consume_request_invalid',
      'pgAdmin handoff consume request is invalid',
    );
  }
}

export function createPgAdminHandoffConsumerHandler({ pgAdminHandoffService } = {}) {
  if (!pgAdminHandoffService || typeof pgAdminHandoffService.consume !== 'function') {
    throw new TypeError('pgAdmin handoff consumer service is required');
  }

  return async function handle(request, response) {
    try {
      if (request.method !== 'POST' || request.url !== '/consume') {
        json(response, 404, { error: {
          code: 'pgadmin_handoff_consume_not_found',
          message: 'Not found',
        } });
        return;
      }
      const body = await readJsonBody(request);
      const bundle = await pgAdminHandoffService.consume(body.capability, {
        sessionDigest: body.sessionDigest,
      });
      if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
        || bundle.version !== 1 || bundle.protocol !== 'yunpanel-pgadmin-signon-v1'
        || typeof bundle.databaseName !== 'string' || !bundle.databaseName
        || typeof bundle.username !== 'string' || !bundle.username
        || typeof bundle.password !== 'string' || !bundle.password
        || typeof bundle.gatewaySession !== 'string' || !CAPABILITY_PATTERN.test(bundle.gatewaySession)
        || !Number.isSafeInteger(bundle.expiresAt)
        || bundle.host !== 'localhost') {
        throw socketError(
          'pgadmin_handoff_consume_bundle_invalid',
          'pgAdmin handoff consume result is invalid',
        );
      }
      json(response, 200, {
        data: {
          version: 1,
          protocol: bundle.protocol,
          databaseName: bundle.databaseName,
          username: bundle.username,
          password: bundle.password,
          host: 'localhost',
          gatewaySession: bundle.gatewaySession,
          expiresAt: bundle.expiresAt,
        },
      });
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      json(response, errorStatus(error), { error: publicError(error) });
    }
  };
}

function boundedStdout(result) {
  const stdout = String(result?.stdout ?? result ?? '');
  if (Buffer.byteLength(stdout) > 8 * 1024) throw new Error('group lookup output too large');
  return stdout.trim();
}

export async function startPgAdminHandoffSocket({
  pgAdminHandoffService,
  socketDirectory = SOCKET_DIRECTORY,
  socketPath = SOCKET_PATH,
  socketGroup = SOCKET_GROUP,
  run = (file, args) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 8 * 1024,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
  }),
  chmodFn = chmod,
  chownFn = chown,
  lstatFn = lstat,
  mkdirFn = mkdir,
  rmFn = rm,
  createServer = http.createServer,
} = {}) {
  if (!pgAdminHandoffService || typeof pgAdminHandoffService.consume !== 'function') {
    throw new TypeError('pgAdmin handoff service is required');
  }
  if (typeof socketDirectory !== 'string' || !path.isAbsolute(socketDirectory)
    || path.resolve(socketDirectory) !== socketDirectory || socketDirectory === '/'
    || typeof socketPath !== 'string' || path.dirname(socketPath) !== socketDirectory
    || path.resolve(socketPath) !== socketPath
    || typeof socketGroup !== 'string' || !GROUP_NAME_PATTERN.test(socketGroup)) {
    throw socketError(
      'pgadmin_handoff_socket_policy_invalid',
      'pgAdmin handoff socket policy is invalid',
    );
  }

  let group;
  try {
    group = parseGroupIdentity(boundedStdout(await run(GETENT, ['group', socketGroup])), socketGroup);
  } catch {
    group = null;
  }
  if (!group) {
    throw socketError(
      'pgadmin_handoff_socket_group_missing',
      'pgAdmin runtime group is unavailable',
    );
  }

  async function inspectDirectory() {
    try {
      const metadata = await lstatFn(socketDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
      return metadata;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  let directoryMetadata;
  try { directoryMetadata = await inspectDirectory(); }
  catch {
    throw socketError(
      'pgadmin_handoff_socket_directory_unavailable',
      'pgAdmin handoff socket directory could not be inspected',
    );
  }
  if (directoryMetadata === null) {
    throw socketError(
      'pgadmin_handoff_socket_directory_insecure',
      'pgAdmin handoff socket directory is insecure',
    );
  }
  if (directoryMetadata === false) {
    try {
      await mkdirFn(socketDirectory, { recursive: false, mode: DIRECTORY_MODE });
      await chownFn(socketDirectory, ROOT_UID, group.gid);
      await chmodFn(socketDirectory, DIRECTORY_MODE);
    } catch {
      throw socketError(
        'pgadmin_handoff_socket_directory_unavailable',
        'pgAdmin handoff socket directory could not be created',
      );
    }
    const freshMetadata = await inspectDirectory();
    if (!freshMetadata || freshMetadata.uid !== ROOT_UID || freshMetadata.gid !== group.gid
      || (freshMetadata.mode & 0o777) !== DIRECTORY_MODE) {
      throw socketError(
        'pgadmin_handoff_socket_directory_insecure',
        'pgAdmin handoff socket directory has invalid permissions',
      );
    }
  } else if (directoryMetadata.uid !== ROOT_UID || directoryMetadata.gid !== group.gid
    || (directoryMetadata.mode & 0o777) !== DIRECTORY_MODE) {
    throw socketError(
      'pgadmin_handoff_socket_directory_insecure',
      'pgAdmin handoff socket directory has invalid permissions',
    );
  }

  try {
    const socketMetadata = await lstatFn(socketPath);
    if (!socketMetadata.isSocket() || socketMetadata.isSymbolicLink()) {
      throw socketError(
        'pgadmin_handoff_socket_path_insecure',
        'Existing pgAdmin handoff socket path is insecure',
      );
    }
    await rmFn(socketPath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof PgAdminHandoffSocketError) throw error;
      throw socketError(
        'pgadmin_handoff_socket_unavailable',
        'Stale pgAdmin handoff socket could not be removed',
      );
    }
  }

  const handler = createPgAdminHandoffConsumerHandler({ pgAdminHandoffService });
  const server = createServer(handler);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  }).catch((error) => {
    throw socketError(
      'pgadmin_handoff_socket_listen_failed',
      `pgAdmin handoff socket could not listen: ${error?.message ?? 'unknown error'}`,
    );
  });

  try {
    await chownFn(socketPath, ROOT_UID, group.gid);
    await chmodFn(socketPath, SOCKET_MODE);
    const postListenMetadata = await lstatFn(socketPath);
    if (!postListenMetadata.isSocket() || postListenMetadata.isSymbolicLink()
      || postListenMetadata.uid !== ROOT_UID || postListenMetadata.gid !== group.gid
      || (postListenMetadata.mode & 0o777) !== SOCKET_MODE) {
      throw socketError(
        'pgadmin_handoff_socket_insecure',
        'pgAdmin handoff socket permissions could not be established',
      );
    }
  } catch (error) {
    try { server.close(); } catch {}
    try { await rmFn(socketPath, { force: true }); } catch {}
    if (error instanceof PgAdminHandoffSocketError) throw error;
    throw socketError(
      'pgadmin_handoff_socket_insecure',
      'pgAdmin handoff socket permissions could not be established',
    );
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      const metadata = await lstatFn(socketPath);
      if (metadata.isSocket() && !metadata.isSymbolicLink()
        && metadata.uid === ROOT_UID && metadata.gid === group.gid
        && (metadata.mode & 0o7777) === SOCKET_MODE) {
        await rmFn(socketPath);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw socketError(
          'pgadmin_handoff_socket_cleanup_failed',
          'pgAdmin handoff socket cleanup failed',
        );
      }
    }
  }

  return Object.freeze({
    socketPath,
    socketDirectory,
    socketGroup,
    mode: SOCKET_MODE,
    directoryMode: DIRECTORY_MODE,
    close,
  });
}

export const pgAdminHandoffSocketInternals = Object.freeze({
  socketDirectory: SOCKET_DIRECTORY,
  socketPath: SOCKET_PATH,
  socketGroup: SOCKET_GROUP,
  directoryMode: DIRECTORY_MODE,
  socketMode: SOCKET_MODE,
  groupNamePattern: GROUP_NAME_PATTERN,
  capabilityPattern: CAPABILITY_PATTERN,
  digestPattern: DIGEST_PATTERN,
  maxBodyBytes: MAX_BODY_BYTES,
  parseGroupIdentity,
  exactBody,
});
