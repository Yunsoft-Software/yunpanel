import { execFile } from 'node:child_process';
import { chmod, chown, lstat, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { ElFinderHandoffError } from './elfinder-handoff-service.js';

const execFileAsync = promisify(execFile);
const SOCKET_DIRECTORY = '/run/yunpanel-elfinder';
const SOCKET_PATH = `${SOCKET_DIRECTORY}/handoff.sock`;
const SOCKET_GROUP = 'yunpanel-elfinder';
const DIRECTORY_MODE = 0o750;
const SOCKET_MODE = 0o660;
const ROOT_UID = 0;
const GROUP_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const ROOT_PATTERN = /^\/var\/lib\/yunpanel\/data\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_BODY_BYTES = 1024;
const GETENT = '/usr/bin/getent';

export class ElFinderHandoffSocketError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ElFinderHandoffSocketError';
    this.code = code;
  }
}

function socketError(code, message) {
  return new ElFinderHandoffSocketError(code, message);
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
    || Object.keys(value).length !== 1 || typeof value.capability !== 'string'
    || !CAPABILITY_PATTERN.test(value.capability)) {
    throw socketError(
      'elfinder_handoff_consume_request_invalid',
      'elFinder handoff consume request is invalid',
    );
  }
  return value;
}

function responseHeaders() {
  return {
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'content-type': 'application/json; charset=utf-8',
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
  if (error instanceof ElFinderHandoffError) {
    if ([400, 401, 403, 404, 409, 429, 503].includes(error.status)) return error.status;
    return 400;
  }
  if (error instanceof ElFinderHandoffSocketError) return 400;
  return 503;
}

function publicError(error) {
  if (error instanceof ElFinderHandoffError || error instanceof ElFinderHandoffSocketError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'elfinder_handoff_consumer_unavailable',
    message: 'elFinder handoff consumer is unavailable',
  };
}

async function readJsonBody(request) {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw socketError(
      'elfinder_handoff_consume_content_type_invalid',
      'elFinder handoff consume requires application/json',
    );
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw socketError(
        'elfinder_handoff_consume_body_too_large',
        'elFinder handoff consume request is too large',
      );
    }
    chunks.push(chunk);
  }
  if (bytes < 2) {
    throw socketError(
      'elfinder_handoff_consume_request_invalid',
      'elFinder handoff consume request is invalid',
    );
  }
  try {
    return exactBody(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
  } catch (error) {
    if (error instanceof ElFinderHandoffSocketError) throw error;
    throw socketError(
      'elfinder_handoff_consume_request_invalid',
      'elFinder handoff consume request is invalid',
    );
  }
}

function validBundle(bundle) {
  return bundle && typeof bundle === 'object' && !Array.isArray(bundle)
    && bundle.version === 1
    && bundle.protocol === 'yunpanel-elfinder-handoff-v1'
    && bundle.audience === 'elfinder'
    && UUID_PATTERN.test(bundle.serverId ?? '')
    && UUID_PATTERN.test(bundle.websiteId ?? '')
    && Number.isSafeInteger(bundle.websiteRevision) && bundle.websiteRevision > 0
    && UUID_PATTERN.test(bundle.applicationId ?? '')
    && APP_USER_PATTERN.test(bundle.unixUser ?? '')
    && ROOT_PATTERN.test(bundle.root ?? '')
    && Number.isSafeInteger(bundle.expiresAt);
}

export function createElFinderHandoffConsumerHandler({ elFinderHandoffService } = {}) {
  if (!elFinderHandoffService || typeof elFinderHandoffService.consume !== 'function') {
    throw new TypeError('elFinder handoff consumer service is required');
  }

  return async function handle(request, response) {
    try {
      if (request.method !== 'POST' || request.url !== '/consume') {
        json(response, 404, { error: {
          code: 'elfinder_handoff_consume_not_found',
          message: 'Not found',
        } });
        return;
      }
      const body = await readJsonBody(request);
      const bundle = await elFinderHandoffService.consume(body.capability);
      if (!validBundle(bundle)) {
        throw socketError(
          'elfinder_handoff_consume_bundle_invalid',
          'elFinder handoff consume result is invalid',
        );
      }
      json(response, 200, { data: {
        version: 1,
        protocol: bundle.protocol,
        audience: 'elfinder',
        serverId: bundle.serverId,
        websiteId: bundle.websiteId,
        websiteRevision: bundle.websiteRevision,
        applicationId: bundle.applicationId,
        unixUser: bundle.unixUser,
        root: bundle.root,
        expiresAt: bundle.expiresAt,
      } });
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

export async function startElFinderHandoffSocket({
  elFinderHandoffService,
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
  if (!elFinderHandoffService || typeof elFinderHandoffService.consume !== 'function') {
    throw new TypeError('elFinder handoff service is required');
  }
  if (typeof socketDirectory !== 'string' || !path.isAbsolute(socketDirectory)
    || path.resolve(socketDirectory) !== socketDirectory || socketDirectory === '/'
    || typeof socketPath !== 'string' || path.dirname(socketPath) !== socketDirectory
    || path.resolve(socketPath) !== socketPath
    || typeof socketGroup !== 'string' || !GROUP_NAME_PATTERN.test(socketGroup)) {
    throw socketError(
      'elfinder_handoff_socket_policy_invalid',
      'elFinder handoff socket policy is invalid',
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
      'elfinder_handoff_socket_group_missing',
      'elFinder runtime group is unavailable',
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
      'elfinder_handoff_socket_directory_unavailable',
      'elFinder handoff socket directory could not be inspected',
    );
  }
  if (directoryMetadata === null) {
    throw socketError(
      'elfinder_handoff_socket_directory_unsafe',
      'elFinder handoff socket directory is unsafe',
    );
  }
  if (directoryMetadata === false) {
    try { await mkdirFn(socketDirectory, { mode: DIRECTORY_MODE }); }
    catch {
      throw socketError(
        'elfinder_handoff_socket_directory_unavailable',
        'elFinder handoff socket directory could not be created',
      );
    }
  }
  try {
    await chownFn(socketDirectory, ROOT_UID, group.gid);
    await chmodFn(socketDirectory, DIRECTORY_MODE);
    const metadata = await lstatFn(socketDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || metadata.uid !== ROOT_UID || metadata.gid !== group.gid
      || (metadata.mode & 0o7777) !== DIRECTORY_MODE) {
      throw new Error('directory metadata mismatch');
    }
  } catch {
    throw socketError(
      'elfinder_handoff_socket_directory_unsafe',
      'elFinder handoff socket directory metadata is unsafe',
    );
  }

  try {
    const stale = await lstatFn(socketPath);
    if (!stale.isSocket() || stale.isSymbolicLink()
      || stale.uid !== ROOT_UID || stale.gid !== group.gid
      || (stale.mode & 0o7777) !== SOCKET_MODE) {
      throw socketError(
        'elfinder_handoff_socket_path_unsafe',
        'Existing elFinder handoff socket path is unsafe',
      );
    }
    await rmFn(socketPath);
  } catch (error) {
    if (error instanceof ElFinderHandoffSocketError) throw error;
    if (error?.code !== 'ENOENT') {
      throw socketError(
        'elfinder_handoff_socket_path_unavailable',
        'Existing elFinder handoff socket could not be prepared',
      );
    }
  }

  const handler = createElFinderHandoffConsumerHandler({ elFinderHandoffService });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(socketPath);
    });
    await chownFn(socketPath, ROOT_UID, group.gid);
    await chmodFn(socketPath, SOCKET_MODE);
    const metadata = await lstatFn(socketPath);
    if (!metadata.isSocket() || metadata.isSymbolicLink()
      || metadata.uid !== ROOT_UID || metadata.gid !== group.gid
      || (metadata.mode & 0o7777) !== SOCKET_MODE) {
      throw new Error('socket metadata mismatch');
    }
  } catch {
    try { server.close(); } catch {}
    try { await rmFn(socketPath, { force: true }); } catch {}
    throw socketError(
      'elfinder_handoff_socket_start_failed',
      'elFinder handoff socket could not be started safely',
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
          'elfinder_handoff_socket_cleanup_failed',
          'elFinder handoff socket cleanup failed',
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

export const elFinderHandoffSocketInternals = Object.freeze({
  socketDirectory: SOCKET_DIRECTORY,
  socketPath: SOCKET_PATH,
  socketGroup: SOCKET_GROUP,
  directoryMode: DIRECTORY_MODE,
  socketMode: SOCKET_MODE,
  maxBodyBytes: MAX_BODY_BYTES,
  parseGroupIdentity,
  exactBody,
  validBundle,
});
