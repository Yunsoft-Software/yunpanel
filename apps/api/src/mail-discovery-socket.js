import { execFile } from 'node:child_process';
import { chmod, chown, lstat, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { MailDiscoveryServiceError } from './mail-discovery-service.js';

const execFileAsync = promisify(execFile);
const SOCKET_DIRECTORY = '/run/yunpanel-mail-discovery';
const SOCKET_PATH = `${SOCKET_DIRECTORY}/discovery.sock`;
const SOCKET_GROUP = 'www-data';
const DIRECTORY_MODE = 0o750;
const SOCKET_MODE = 0o660;
const ROOT_UID = 0;
const GETENT = '/usr/bin/getent';
const MAX_BODY_BYTES = 16 * 1024;
const AUTODISCOVER_PATH = '/autodiscover/autodiscover.xml';
const AUTOCONFIG_PATHS = new Set([
  '/mail/config-v1.1.xml',
  '/.well-known/autoconfig/mail/config-v1.1.xml',
]);

export class MailDiscoverySocketError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDiscoverySocketError';
    this.code = code;
    this.status = status;
  }
}

function parseGroupIdentity(value, expectedName) {
  const fields = String(value ?? '').trim().split(':');
  if (fields.length !== 4 || fields[0] !== expectedName || !/^\d+$/.test(fields[2])) return null;
  const gid = Number.parseInt(fields[2], 10);
  if (!Number.isSafeInteger(gid) || gid <= 0) return null;
  return Object.freeze({ gid });
}

function responseHeaders(contentType) {
  return {
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'content-type': contentType,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

function send(response, status, contentType, body) {
  const payload = String(body);
  response.writeHead(status, {
    ...responseHeaders(contentType),
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function errorStatus(error) {
  if (error instanceof MailDiscoveryServiceError || error instanceof MailDiscoverySocketError) {
    return [400, 404, 405, 409, 413, 415, 503].includes(error.status) ? error.status : 400;
  }
  return 503;
}

function publicErrorCode(error) {
  if (error instanceof MailDiscoveryServiceError || error instanceof MailDiscoverySocketError) {
    return error.code;
  }
  return 'mail_discovery_unavailable';
}

function requestHostname(request) {
  const value = request.headers.host;
  if (typeof value !== 'string' || !value || value.includes(':')) {
    throw new MailDiscoverySocketError(
      'mail_discovery_host_invalid',
      'Mail discovery Host header is invalid',
      400,
    );
  }
  return value;
}

function requireHttpsProxy(request) {
  if (request.headers['x-forwarded-proto'] !== 'https') {
    throw new MailDiscoverySocketError(
      'mail_discovery_https_required',
      'Mail discovery is available only through the managed HTTPS route',
      404,
    );
  }
}

function requestUrl(request) {
  try {
    return new URL(request.url ?? '/', 'http://unix.local');
  } catch {
    throw new MailDiscoverySocketError(
      'mail_discovery_url_invalid',
      'Mail discovery request URL is invalid',
      400,
    );
  }
}

function autoconfigAddress(url) {
  const values = url.searchParams.getAll('emailaddress');
  if (values.length !== 1 || !values[0]) {
    throw new MailDiscoverySocketError(
      'mail_discovery_address_missing',
      'Mail discovery emailaddress query is required',
      400,
    );
  }
  return values[0];
}

function validXmlContentType(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase().trim();
  return /^(?:text|application)\/xml(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/.test(normalized)
    || /^application\/x-www-form-urlencoded(?:\s*;.*)?$/.test(normalized);
}

async function readAutodiscoverBody(request) {
  if (!validXmlContentType(request.headers['content-type'])) {
    throw new MailDiscoverySocketError(
      'mail_discovery_content_type_invalid',
      'Autodiscover requires an XML request body',
      415,
    );
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new MailDiscoverySocketError(
        'mail_discovery_body_too_large',
        'Autodiscover request body is too large',
        413,
      );
    }
    chunks.push(chunk);
  }
  if (bytes < 1) {
    throw new MailDiscoverySocketError(
      'mail_discovery_body_invalid',
      'Autodiscover request body is invalid',
      400,
    );
  }
  const body = Buffer.concat(chunks, bytes).toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) {
    throw new MailDiscoverySocketError(
      'mail_discovery_body_invalid',
      'Autodiscover request body is invalid',
      400,
    );
  }
  return body;
}

function autodiscoverAddress(body) {
  const pattern = /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?EMailAddress\b[^>]*>([^<]{3,254})<\/(?:[A-Za-z_][A-Za-z0-9_.-]*:)?EMailAddress\s*>/gi;
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new MailDiscoverySocketError(
      'mail_discovery_address_missing',
      'Autodiscover request must contain exactly one EMailAddress',
      400,
    );
  }
  return matches[0][1].trim();
}

export function createMailDiscoveryHttpHandler({ mailDiscoveryService } = {}) {
  if (!mailDiscoveryService
    || typeof mailDiscoveryService.autoconfig !== 'function'
    || typeof mailDiscoveryService.autodiscover !== 'function') {
    throw new TypeError('Mail discovery service is required');
  }

  return async function handle(request, response) {
    try {
      requireHttpsProxy(request);
      const hostname = requestHostname(request);
      const url = requestUrl(request);

      if (url.pathname === AUTODISCOVER_PATH) {
        if (request.method !== 'POST') {
          throw new MailDiscoverySocketError(
            'mail_discovery_method_not_allowed',
            'Autodiscover requires POST',
            405,
          );
        }
        const body = await readAutodiscoverBody(request);
        const result = await mailDiscoveryService.autodiscover({
          domainName: hostname,
          emailAddress: autodiscoverAddress(body),
        });
        send(response, 200, result.contentType, result.body);
        return;
      }

      if (AUTOCONFIG_PATHS.has(url.pathname)) {
        if (request.method !== 'GET') {
          throw new MailDiscoverySocketError(
            'mail_discovery_method_not_allowed',
            'Autoconfig requires GET',
            405,
          );
        }
        const result = await mailDiscoveryService.autoconfig({
          domainName: hostname,
          emailAddress: autoconfigAddress(url),
        });
        send(response, 200, result.contentType, result.body);
        return;
      }

      throw new MailDiscoverySocketError(
        'mail_discovery_not_found',
        'Mail discovery route was not found',
        404,
      );
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      send(
        response,
        errorStatus(error),
        'text/plain; charset=utf-8',
        `${publicErrorCode(error)}\n`,
      );
    }
  };
}

function boundedStdout(result) {
  const stdout = String(result?.stdout ?? result ?? '');
  if (Buffer.byteLength(stdout) > 8 * 1024) return '';
  return stdout.trim();
}

export async function startMailDiscoverySocket({
  mailDiscoveryService,
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
  if (!mailDiscoveryService
    || typeof mailDiscoveryService.autoconfig !== 'function'
    || typeof mailDiscoveryService.autodiscover !== 'function') {
    throw new TypeError('Mail discovery service is required');
  }
  if (socketDirectory !== SOCKET_DIRECTORY || socketPath !== SOCKET_PATH || socketGroup !== SOCKET_GROUP
    || path.dirname(socketPath) !== socketDirectory) {
    throw new MailDiscoverySocketError(
      'mail_discovery_socket_policy_invalid',
      'Mail discovery socket policy is invalid',
      503,
    );
  }

  let group = null;
  try {
    group = parseGroupIdentity(
      boundedStdout(await run(GETENT, ['group', socketGroup])),
      socketGroup,
    );
  } catch {
    group = null;
  }
  if (!group) {
    throw new MailDiscoverySocketError(
      'mail_discovery_socket_group_missing',
      'Mail discovery Nginx group is unavailable',
      503,
    );
  }

  let existingDirectory = null;
  try {
    existingDirectory = await lstatFn(socketDirectory);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new MailDiscoverySocketError(
        'mail_discovery_socket_directory_unavailable',
        'Mail discovery socket directory is unavailable',
        503,
      );
    }
  }
  if (existingDirectory && (!existingDirectory.isDirectory() || existingDirectory.isSymbolicLink())) {
    throw new MailDiscoverySocketError(
      'mail_discovery_socket_directory_unsafe',
      'Mail discovery socket directory is unsafe',
      503,
    );
  }
  if (!existingDirectory) {
    await mkdirFn(socketDirectory, { mode: DIRECTORY_MODE });
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
    throw new MailDiscoverySocketError(
      'mail_discovery_socket_directory_unsafe',
      'Mail discovery socket directory metadata is unsafe',
      503,
    );
  }

  try {
    const stale = await lstatFn(socketPath);
    if (!stale.isSocket() || stale.isSymbolicLink()
      || stale.uid !== ROOT_UID || stale.gid !== group.gid
      || (stale.mode & 0o7777) !== SOCKET_MODE) {
      throw new MailDiscoverySocketError(
        'mail_discovery_socket_path_unsafe',
        'Existing mail discovery socket path is unsafe',
        503,
      );
    }
    await rmFn(socketPath);
  } catch (error) {
    if (error instanceof MailDiscoverySocketError) throw error;
    if (error?.code !== 'ENOENT') {
      throw new MailDiscoverySocketError(
        'mail_discovery_socket_path_unavailable',
        'Existing mail discovery socket could not be prepared',
        503,
      );
    }
  }

  const handler = createMailDiscoveryHttpHandler({ mailDiscoveryService });
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
    throw new MailDiscoverySocketError(
      'mail_discovery_socket_start_failed',
      'Mail discovery socket could not be started safely',
      503,
    );
  }

  let closed = false;
  async function inspect() {
    if (closed) {
      return Object.freeze({
        version: 1,
        ready: false,
        socketPath,
        blocker: 'mail_discovery_socket_closed',
        sideEffects: false,
      });
    }
    try {
      const metadata = await lstatFn(socketPath);
      const ready = metadata.isSocket() && !metadata.isSymbolicLink()
        && metadata.uid === ROOT_UID && metadata.gid === group.gid
        && (metadata.mode & 0o7777) === SOCKET_MODE;
      return Object.freeze({
        version: 1,
        ready,
        socketPath,
        blocker: ready ? null : 'mail_discovery_socket_drift',
        sideEffects: false,
      });
    } catch {
      return Object.freeze({
        version: 1,
        ready: false,
        socketPath,
        blocker: 'mail_discovery_socket_unavailable',
        sideEffects: false,
      });
    }
  }

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
        throw new MailDiscoverySocketError(
          'mail_discovery_socket_cleanup_failed',
          'Mail discovery socket cleanup failed',
          503,
        );
      }
    }
  }

  return Object.freeze({
    socketDirectory,
    socketPath,
    socketGroup,
    mode: SOCKET_MODE,
    directoryMode: DIRECTORY_MODE,
    inspect,
    close,
  });
}

export const mailDiscoverySocketInternals = Object.freeze({
  socketDirectory: SOCKET_DIRECTORY,
  socketPath: SOCKET_PATH,
  socketGroup: SOCKET_GROUP,
  directoryMode: DIRECTORY_MODE,
  socketMode: SOCKET_MODE,
  maxBodyBytes: MAX_BODY_BYTES,
  autodiscoverPath: AUTODISCOVER_PATH,
  autoconfigPaths: Object.freeze([...AUTOCONFIG_PATHS]),
  parseGroupIdentity,
  requestHostname,
  requestUrl,
  autoconfigAddress,
  validXmlContentType,
  autodiscoverAddress,
});
