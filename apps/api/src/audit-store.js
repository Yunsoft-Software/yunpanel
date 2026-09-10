const ACTION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const OUTCOMES = new Set(['accepted', 'succeeded', 'failed', 'denied', 'cancelled']);
const MAX_ID_LENGTH = 128;
const RETENTION_MS = 90 * 24 * 60 * 60_000;

export class AuditStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditStoreError';
    this.code = code;
  }
}

function optionalId(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AuditStoreError('invalid_audit_event', `Audit ${field} is invalid`);
  }
  return value;
}

function optionalToken(value, field, pattern) {
  if (value == null) return null;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new AuditStoreError('invalid_audit_event', `Audit ${field} is invalid`);
  }
  return value;
}

function normalizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AuditStoreError('invalid_audit_event', 'Audit event must be an object');
  }
  const allowed = new Set(['actorId', 'action', 'resourceType', 'resourceId', 'outcome', 'code']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new AuditStoreError('invalid_audit_event', 'Audit event contains unsupported metadata');
  }
  if (typeof input.action !== 'string' || !ACTION_PATTERN.test(input.action)) {
    throw new AuditStoreError('invalid_audit_event', 'Audit action is invalid');
  }
  if (!OUTCOMES.has(input.outcome)) {
    throw new AuditStoreError('invalid_audit_event', 'Audit outcome is invalid');
  }
  const resourceType = optionalToken(input.resourceType, 'resource type', TYPE_PATTERN);
  const resourceId = optionalId(input.resourceId, 'resource id');
  if ((resourceType == null) !== (resourceId == null)) {
    throw new AuditStoreError('invalid_audit_event', 'Audit resource type and id must be supplied together');
  }
  return Object.freeze({
    actorId: optionalId(input.actorId, 'actor id'),
    action: input.action,
    resourceType,
    resourceId,
    outcome: input.outcome,
    code: optionalToken(input.code, 'code', CODE_PATTERN),
  });
}

function publicEvent(row) {
  return Object.freeze({
    id: row.id,
    actorId: row.actor_id ?? null,
    action: row.action,
    resourceType: row.resource_type ?? null,
    resourceId: row.resource_id ?? null,
    outcome: row.outcome,
    code: row.code ?? null,
    createdAt: row.created_at,
  });
}

export function createAuditStore({ db, now = Date.now } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function' || typeof now !== 'function') {
    throw new AuditStoreError('invalid_audit_dependencies', 'Audit store dependencies are invalid');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_schema (
      id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO audit_schema VALUES (1, 1);
  `);
  if (db.prepare('SELECT version FROM audit_schema WHERE id = 1').get().version !== 1) {
    throw new AuditStoreError('unsupported_audit_schema', 'Unsupported audit schema');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY,
      actor_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('accepted','succeeded','failed','denied','cancelled')),
      code TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_created ON audit_events(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS audit_events_resource ON audit_events(resource_type, resource_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_events_actor ON audit_events(actor_id, created_at DESC);
  `);

  function record(input) {
    const event = normalizeEvent(input);
    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new AuditStoreError('invalid_audit_time', 'Audit clock returned an invalid timestamp');
    }
    db.prepare('DELETE FROM audit_events WHERE created_at < ?').run(createdAt - RETENTION_MS);
    const result = db.prepare(`INSERT INTO audit_events(actor_id, action, resource_type, resource_id, outcome, code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      event.actorId,
      event.action,
      event.resourceType,
      event.resourceId,
      event.outcome,
      event.code,
      createdAt,
    );
    return publicEvent(db.prepare('SELECT * FROM audit_events WHERE id = ?').get(result.lastInsertRowid));
  }

  function list({ offset = 0, limit = 50, actorId = null, resourceType = null, resourceId = null } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AuditStoreError('invalid_audit_pagination', 'Audit pagination is invalid');
    }
    const actor = optionalId(actorId, 'actor id');
    const type = optionalToken(resourceType, 'resource type', TYPE_PATTERN);
    const resource = optionalId(resourceId, 'resource id');
    if ((type == null) !== (resource == null)) {
      throw new AuditStoreError('invalid_audit_filter', 'Audit resource type and id filters must be supplied together');
    }
    const clauses = [];
    const values = [];
    if (actor) { clauses.push('actor_id = ?'); values.push(actor); }
    if (type) { clauses.push('resource_type = ? AND resource_id = ?'); values.push(type, resource); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) AS count FROM audit_events${where}`).get(...values).count;
    const events = db.prepare(`SELECT * FROM audit_events${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset)
      .map(publicEvent);
    return Object.freeze({ events: Object.freeze(events), total, offset, limit });
  }

  return Object.freeze({ record, list });
}

export const auditStoreInternals = Object.freeze({
  outcomes: Object.freeze([...OUTCOMES]),
  retentionMs: RETENTION_MS,
  normalizeEvent,
});
