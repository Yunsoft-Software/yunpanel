import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthError } from './auth-error.js';
import { TerminalCapabilityError } from './terminal-capability-registry.js';
import { TerminalProcessError } from './terminal-process-manager.js';

const PROTOCOL = 'yunpanel-terminal-v1';
const CAPABILITY_PREFIX = 'yunpanel-terminal-capability.';
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_LIFETIME_MS = 4 * 60 * 60_000;
const DEFAULT_AUTH_CHECK_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_MAX_USER_SESSIONS = 5;

function exactObject(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && Object.keys(value).every((key) => fields.includes(key));
}

function parseProtocols(header) {
  if (typeof header !== 'string') throw new TerminalCapabilityError('terminal_protocol_invalid', 'Terminal protocol is invalid', 400);
  const entries = header.split(',').map((entry) => entry.trim()).filter(Boolean);
  const capabilities = entries.filter((entry) => entry.startsWith(CAPABILITY_PREFIX));
  if (entries.length !== 2 || new Set(entries).size !== 2 || !entries.includes(PROTOCOL) || capabilities.length !== 1) {
    throw new TerminalCapabilityError('terminal_protocol_invalid', 'Terminal protocol is invalid', 400);
  }
  const capability = capabilities[0].slice(CAPABILITY_PREFIX.length);
  if (!CAPABILITY_PATTERN.test(capability)) {
    throw new TerminalCapabilityError('terminal_protocol_invalid', 'Terminal protocol is invalid', 400);
  }
  return capability;
}

function rejectUpgrade(socket, status) {
  if (socket.destroyed) return;
  const normalized = [400, 401, 403, 404, 409, 429, 503].includes(status) ? status : 503;
  const labels = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 429: 'Too Many Requests', 503: 'Service Unavailable' };
  socket.end(`HTTP/1.1 ${normalized} ${labels[normalized]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
}

function auditResource(target) {
  return target.scope === 'server'
    ? { resourceType: 'server', resourceId: target.serverId, scope: 'server' }
    : { resourceType: 'website', resourceId: target.websiteId, scope: 'site' };
}

function safeSend(websocket, payload) {
  if (websocket.readyState !== WebSocket.OPEN) return false;
  websocket.send(JSON.stringify(payload));
  return true;
}

export function createTerminalWebSocketServer({
  authenticate,
  reauthorize,
  terminalCapabilityRegistry,
  terminalProcessManager,
  liveSessions,
  audit,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  idleMs = DEFAULT_IDLE_MS,
  lifetimeMs = DEFAULT_LIFETIME_MS,
  authCheckMs = DEFAULT_AUTH_CHECK_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxUserSessions = DEFAULT_MAX_USER_SESSIONS,
} = {}) {
  if (typeof authenticate !== 'function' || typeof reauthorize !== 'function'
    || typeof terminalCapabilityRegistry?.consume !== 'function' || typeof terminalProcessManager?.open !== 'function'
    || typeof liveSessions?.register !== 'function' || typeof audit?.record !== 'function'
    || typeof now !== 'function' || typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function') {
    throw new TypeError('Terminal WebSocket dependencies are invalid');
  }
  for (const [value, minimum, maximum] of [
    [idleMs, 1_000, 24 * 60 * 60_000], [lifetimeMs, 1_000, 24 * 60 * 60_000], [authCheckMs, 250, 60_000],
    [maxOutputBytes, 1024, 1024 * 1024 * 1024], [maxBufferedBytes, 1024, 64 * 1024 * 1024],
    [maxSessions, 1, 1_000], [maxUserSessions, 1, 100],
  ]) if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError('Terminal WebSocket policy is invalid');
  if (maxUserSessions > maxSessions) throw new TypeError('Terminal WebSocket policy is invalid');

  const sessions = new Map();
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });
  websocketServer.on('error', () => {});

  function userSessionCount(userId) {
    let count = 0;
    for (const session of sessions.values()) if (session.userId === userId) count += 1;
    return count;
  }

  function recordAudit(record, action, outcome, code = null) {
    const resource = auditResource(record.target);
    return audit.record({
      actorId: record.userId,
      action: `terminal.${resource.scope}.${action}`,
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      outcome,
      code,
    });
  }

  function terminate(record, reason, closeCode = 4000, notice = null) {
    if (record.closed) return false;
    record.closed = true;
    sessions.delete(record.id);
    if (record.interval !== null) clearIntervalFn(record.interval);
    record.unregister?.();
    record.terminal?.close();
    if (notice) safeSend(record.websocket, notice);
    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(record.websocket.readyState)) {
      record.websocket.close(closeCode, reason);
    }
    if (record.openAccepted) {
      try { recordAudit(record, 'closed', 'succeeded', reason); } catch {}
    }
    return true;
  }

  function sendOutput(record, data) {
    if (record.closed) return;
    record.outputBytes += Buffer.byteLength(data, 'utf8');
    if (record.outputBytes > maxOutputBytes) {
      terminate(record, 'output_limit', 4009, { type: 'error', code: 'terminal_output_limit', message: 'Terminal output limit reached.' });
      return;
    }
    if (record.websocket.bufferedAmount > maxBufferedBytes) {
      terminate(record, 'backpressure', 4009, { type: 'error', code: 'terminal_backpressure', message: 'Terminal client is not reading output.' });
      return;
    }
    if (!record.ready) record.pendingOutput.push(data);
    else safeSend(record.websocket, { type: 'output', data });
  }

  function decodeMessage(data, isBinary) {
    if (isBinary) throw new TerminalProcessError('terminal_message_invalid', 'Terminal messages must be JSON text');
    let message;
    try { message = JSON.parse(data.toString('utf8')); }
    catch { throw new TerminalProcessError('terminal_message_invalid', 'Terminal message is invalid'); }
    if (message?.type === 'input' && exactObject(message, ['type', 'data']) && typeof message.data === 'string') return message;
    if (message?.type === 'resize' && exactObject(message, ['type', 'cols', 'rows'])) return message;
    if (message?.type === 'ping' && exactObject(message, ['type'])) return message;
    throw new TerminalProcessError('terminal_message_invalid', 'Terminal message is invalid');
  }

  async function begin(websocket, auth, consumed) {
    const startedAt = now();
    const record = {
      id: randomUUID(),
      websocket,
      rawToken: auth.rawToken,
      sessionId: auth.session.id,
      userId: auth.session.user.id,
      target: consumed.target,
      startedAt,
      lastActivityAt: startedAt,
      lastTouchAt: startedAt,
      outputBytes: 0,
      pendingOutput: [],
      terminal: null,
      interval: null,
      unregister: null,
      ready: false,
      closed: false,
      openAccepted: false,
    };
    sessions.set(record.id, record);
    websocket.once('close', () => terminate(record, 'client_closed', 1000));
    websocket.once('error', () => terminate(record, 'socket_error', 1011));
    record.unregister = liveSessions.register({
      sessionId: record.sessionId,
      userId: record.userId,
      terminate: (reason) => terminate(record, reason, 4001, { type: 'revoked', reason }),
    }).unregister;
    websocket.on('message', (data, isBinary) => {
      if (record.closed) return;
      if (!record.ready) {
        terminate(record, 'terminal_not_ready', 1008, { type: 'error', code: 'terminal_not_ready', message: 'Wait for the terminal ready message.' });
        return;
      }
      try {
        const timestamp = now();
        if (timestamp - record.lastTouchAt >= 30_000) {
          reauthorize(record.rawToken, { sessionId: record.sessionId, userId: record.userId }, { touch: true });
          record.lastTouchAt = timestamp;
        }
        const message = decodeMessage(data, isBinary);
        record.lastActivityAt = timestamp;
        if (message.type === 'input') record.terminal.write(message.data);
        else if (message.type === 'resize') record.terminal.resize(message.cols, message.rows);
        else safeSend(websocket, { type: 'pong' });
      } catch (error) {
        if (error instanceof AuthError) terminate(record, 'session_revoked', 4001, { type: 'revoked', reason: 'session_revoked' });
        else terminate(record, 'invalid_message', 1008, { type: 'error', code: error.code ?? 'terminal_message_invalid', message: 'Terminal message is invalid.' });
      }
    });

    try {
      recordAudit(record, 'opened', 'accepted');
      record.openAccepted = true;
    } catch {
      terminate(record, 'audit_unavailable', 1011, { type: 'error', code: 'audit_unavailable', message: 'Terminal audit is unavailable.' });
      return;
    }

    try {
      record.terminal = await terminalProcessManager.open({
        target: record.target,
        onData: (data) => sendOutput(record, data),
        onExit: ({ exitCode, signal }) => {
          if (record.closed) return;
          safeSend(record.websocket, { type: 'exit', exitCode, signal });
          terminate(record, 'process_exit', 1000);
        },
      });
      if (record.closed) { record.terminal.close(); return; }
      recordAudit(record, 'opened', 'succeeded');
    } catch (error) {
      const code = error instanceof TerminalProcessError ? error.code : 'terminal_start_failed';
      try { recordAudit(record, 'opened', 'failed', code); } catch {}
      terminate(record, 'spawn_failed', 1011, { type: 'error', code, message: 'Terminal process could not be started.' });
      return;
    }

    record.ready = true;
    safeSend(websocket, { type: 'ready', sessionId: record.id, target: record.target });
    for (const data of record.pendingOutput.splice(0)) safeSend(websocket, { type: 'output', data });

    record.interval = setIntervalFn(() => {
      if (record.closed) return;
      const timestamp = now();
      if (timestamp - record.startedAt >= lifetimeMs) { terminate(record, 'session_timeout', 4008); return; }
      if (timestamp - record.lastActivityAt >= idleMs) { terminate(record, 'idle_timeout', 4008); return; }
      try { reauthorize(record.rawToken, { sessionId: record.sessionId, userId: record.userId }); }
      catch { terminate(record, 'session_revoked', 4001, { type: 'revoked', reason: 'session_revoked' }); }
    }, authCheckMs);
    record.interval?.unref?.();
  }

  function handleUpgrade(request, socket, head) {
    socket.on('error', () => {});
    try {
      const url = new URL(request.url ?? '/', 'http://api.local');
      if (request.method !== 'GET' || url.pathname !== '/api/terminal' || url.search) {
        rejectUpgrade(socket, 404);
        return;
      }
      const auth = authenticate(request);
      if (sessions.size >= maxSessions || userSessionCount(auth.session.user.id) >= maxUserSessions) {
        rejectUpgrade(socket, 429);
        return;
      }
      const capability = parseProtocols(request.headers['sec-websocket-protocol']);
      const consumed = terminalCapabilityRegistry.consume(capability, {
        sessionId: auth.session.id,
        userId: auth.session.user.id,
      });
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        void begin(websocket, auth, consumed).catch(() => websocket.close(1011, 'terminal_unavailable'));
      });
    } catch (error) {
      const status = error instanceof AuthError || error instanceof TerminalCapabilityError ? error.status : 503;
      rejectUpgrade(socket, status);
    }
  }

  function closeAll(reason = 'server_shutdown') {
    for (const record of [...sessions.values()]) terminate(record, reason, 1012);
    websocketServer.close();
  }

  return Object.freeze({ handleUpgrade, closeAll, size: () => sessions.size });
}

export const terminalWebSocketInternals = Object.freeze({
  protocol: PROTOCOL,
  capabilityPrefix: CAPABILITY_PREFIX,
  parseProtocols,
  auditResource,
});
