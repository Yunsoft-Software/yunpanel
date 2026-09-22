// Shared infrastructure schemas are outside the Website database lifecycle.
// Roundcube is normally backed by SQLite, but older installations may retain
// a MariaDB schema. Never expose or mutate that schema through panel DB routes.
const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const ROUNDCUBE_SCHEMA = /^roundcube(?:mail)?(?:_|$)/i;

export function isInfrastructureDatabase(name) {
  return typeof name === 'string'
    && (SYSTEM_SCHEMAS.has(name.toLowerCase()) || ROUNDCUBE_SCHEMA.test(name));
}
