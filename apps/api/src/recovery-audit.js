import { lstatSync } from 'node:fs';
import path from 'node:path';
import { createAuthStore } from './auth-store.js';
import { localMigrationCliInternals, resolveLocalMigrationPaths } from './local-migration-cli.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function resolveAuthPath({ env = process.env, packaged = false, cwd = process.cwd() } = {}) {
  const { serverStore } = resolveLocalMigrationPaths({ env, packaged, cwd });
  const fallback = path.join(path.dirname(serverStore), 'auth', 'auth.sqlite');
  const raw = env.YUNPANEL_AUTH_DB || fallback;
  if (typeof raw !== 'string' || /[\u0000\r\n]/.test(raw)) return null;
  if (packaged && !path.isAbsolute(raw)) return null;
  const resolved = path.resolve(cwd, raw);
  if (packaged) {
    const root = localMigrationCliInternals.packagedStateRoot;
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  }
  return resolved;
}

export function recordRecoveryAuditOutcome({
  result,
  env = process.env,
  packaged = false,
  cwd = process.cwd(),
  authStoreFactory = createAuthStore,
} = {}) {
  if (!result || typeof result.jobId !== 'string' || !TERMINAL.has(result.status) || typeof authStoreFactory !== 'function') {
    return Object.freeze({ recorded: false });
  }
  const filePath = resolveAuthPath({ env, packaged, cwd });
  if (!filePath) return Object.freeze({ recorded: false });
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      return Object.freeze({ recorded: false });
    }
  } catch {
    return Object.freeze({ recorded: false });
  }

  let store;
  try {
    store = authStoreFactory({ filePath, masterKey: env.YUNPANEL_SECRET_MASTER_KEY ?? null });
    const event = store.audit.recordJobOutcome({
      jobId: result.jobId,
      outcome: result.status,
      code: result.status === 'failed' ? result.error?.code ?? null : null,
    });
    return Object.freeze({ recorded: Boolean(event) });
  } catch {
    return Object.freeze({ recorded: false });
  } finally {
    try { store?.close?.(); } catch {}
  }
}

export const recoveryAuditInternals = Object.freeze({
  terminalStatuses: Object.freeze([...TERMINAL]),
  resolveAuthPath,
});
