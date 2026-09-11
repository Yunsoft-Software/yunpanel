import { randomUUID } from 'node:crypto';

function identity(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

export function createLiveSessionRegistry() {
  const connections = new Map();

  function remove(connectionId) {
    return connections.delete(connectionId);
  }

  function register({ sessionId, userId, terminate } = {}) {
    const normalizedSessionId = identity(sessionId, 'sessionId');
    const normalizedUserId = identity(userId, 'userId');
    if (typeof terminate !== 'function') throw new TypeError('Live session terminate callback is required');
    const connectionId = randomUUID();
    connections.set(connectionId, {
      id: connectionId,
      sessionId: normalizedSessionId,
      userId: normalizedUserId,
      terminate,
    });
    return Object.freeze({ connectionId, unregister: () => remove(connectionId) });
  }

  function terminateWhere(predicate, reason) {
    let count = 0;
    for (const [connectionId, connection] of connections) {
      if (!predicate(connection)) continue;
      connections.delete(connectionId);
      count += 1;
      try { connection.terminate(reason); } catch {}
    }
    return count;
  }

  return {
    register,
    revokeSession(sessionId, reason = 'session_revoked') {
      const normalized = identity(sessionId, 'sessionId');
      return terminateWhere((connection) => connection.sessionId === normalized, reason);
    },
    revokeUser(userId, reason = 'user_sessions_revoked') {
      const normalized = identity(userId, 'userId');
      return terminateWhere((connection) => connection.userId === normalized, reason);
    },
    closeAll(reason = 'server_shutdown') {
      return terminateWhere(() => true, reason);
    },
    size() { return connections.size; },
  };
}
