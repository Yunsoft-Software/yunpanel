import { requirePanelRouteAccess } from './panel-http-guard.js';
import { TerminalCapabilityError } from './terminal-capability-registry.js';
import { TtydSessionError } from './ttyd-session-manager.js';

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function mountTtydSessionRoutes(app, {
  terminalCapabilityRegistry,
  ttydSessionManager,
} = {}) {
  if (!app || typeof app.post !== 'function' || typeof app.delete !== 'function') {
    throw new TypeError('Express application is required');
  }
  if (!terminalCapabilityRegistry || typeof terminalCapabilityRegistry.consume !== 'function'
    || !ttydSessionManager || typeof ttydSessionManager.start !== 'function'
    || typeof ttydSessionManager.terminateOwned !== 'function') {
    throw new TypeError('ttyd session HTTP dependencies are required');
  }

  app.post('/api/terminal/ttyd-sessions', requirePanelRouteAccess, async (request, response) => {
    const auth = request.auth;
    if (typeof auth?.id !== 'string' || typeof auth?.user?.id !== 'string' || auth.user.role !== 'owner') {
      throw new TerminalCapabilityError(
        'terminal_session_invalid',
        'Terminal requires an authenticated Owner session',
        401,
      );
    }
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
      || Object.keys(request.body).length !== 1
      || typeof request.body.capability !== 'string'
      || !CAPABILITY_PATTERN.test(request.body.capability)) {
      throw new TtydSessionError(
        'ttyd_session_request_invalid',
        'ttyd session request is invalid',
        400,
      );
    }

    const consumed = terminalCapabilityRegistry.consume(request.body.capability, {
      sessionId: auth.id,
      userId: auth.user.id,
    });
    const session = await ttydSessionManager.start({
      ownerSessionId: auth.id,
      userId: auth.user.id,
      target: consumed.target,
    });

    return response.status(201).json({ data: session });
  });

  app.delete('/api/terminal/ttyd-sessions/:sessionId', requirePanelRouteAccess, (request, response) => {
    const auth = request.auth;
    if (typeof auth?.id !== 'string' || typeof auth?.user?.id !== 'string' || auth.user.role !== 'owner') {
      throw new TerminalCapabilityError(
        'terminal_session_invalid',
        'Terminal requires an authenticated Owner session',
        401,
      );
    }
    if (request.body !== undefined && request.body !== null
      && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)
        || Object.keys(request.body).length !== 0)) {
      throw new TtydSessionError(
        'ttyd_session_close_request_invalid',
        'ttyd close request must not contain mutable arguments',
        400,
      );
    }
    const closed = ttydSessionManager.terminateOwned(request.params.sessionId, {
      ownerSessionId: auth.id,
      userId: auth.user.id,
    });
    if (!closed) {
      throw new TtydSessionError(
        'ttyd_session_not_found',
        'ttyd session was not found',
        404,
      );
    }
    return response.status(204).end();
  });
}

export const ttydSessionHttpInternals = Object.freeze({
  capabilityPattern: CAPABILITY_PATTERN,
});
