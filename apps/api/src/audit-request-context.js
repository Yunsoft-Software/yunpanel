import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const ACTOR_PATTERN = /^[A-Za-z0-9._@:+-]{1,128}$/;

export function withAuditActor(actorId, operation) {
  if (typeof actorId !== 'string' || !ACTOR_PATTERN.test(actorId)) throw new TypeError('Audit actor id is invalid');
  if (typeof operation !== 'function') throw new TypeError('Audit actor operation is invalid');
  return storage.run(Object.freeze({ actorId }), operation);
}

export function currentAuditActorId() {
  return storage.getStore()?.actorId ?? null;
}

export const auditRequestContextInternals = Object.freeze({ actorPattern: ACTOR_PATTERN });
