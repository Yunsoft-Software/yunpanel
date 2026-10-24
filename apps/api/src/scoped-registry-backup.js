import { assertUuid } from '@yunpanel/shared';

const failure = () => Object.assign(new Error('Scoped backup catalog does not match its resource'), { code: 'backup_catalog_scope_invalid', status: 409 });
function scopeIds(ids) {
  if (!Array.isArray(ids) || ids.length > 10_000) throw failure();
  try { return [...new Set(ids.map(id => assertUuid(id, 'backup scope')))].sort(); }
  catch { throw failure(); }
}
export function exportScopedCatalog(records, ids, scopeField) {
  const scope = scopeIds(ids);
  return { version: 1, scope, records: structuredClone(records.filter(record => scope.includes(record[scopeField]))) };
}
export function restoreScopedCatalog(current, snapshot, ids, { scopeField, identityField, validate, now }) {
  const scope = scopeIds(ids);
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.records) || snapshot.records.length > 10_000
    || JSON.stringify(snapshot.scope) !== JSON.stringify(scope)) throw failure();
  const selected = snapshot.records.map(validate);
  if (selected.some(record => !scope.includes(record[scopeField]))
    || new Set(selected.map(record => record[identityField])).size !== selected.length) throw failure();
  const siblings = current.filter(record => !scope.includes(record[scopeField]));
  const siblingIds = new Set(siblings.map(record => record[identityField]));
  if (selected.some(record => siblingIds.has(record[identityField]))) throw failure();
  const clock = now();
  if (!Number.isSafeInteger(clock) || clock < 0) throw failure();
  const timestamp = new Date(clock).toISOString();
  const restored = selected.map(record => {
    const previous = current.find(candidate => candidate[identityField] === record[identityField]);
    // A deleted record has no live revision to compare. Keep pre-deletion
    // requests stale even when an older snapshot recreates the same UUID.
    const revision = Math.max(previous?.revision ?? 0, record.revision, clock) + 1;
    if (!Number.isSafeInteger(revision)) throw failure();
    return { ...record, revision, updatedAt: timestamp };
  });
  return [...siblings, ...restored];
}
