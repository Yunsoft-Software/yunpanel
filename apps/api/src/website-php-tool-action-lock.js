import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WebsitePhpToolActionLockError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsitePhpToolActionLockError';
    this.code = code;
    this.status = status;
  }
}

export function createWebsitePhpToolActionLock({
  root,
  pid = process.pid,
  signalProcess = process.kill.bind(process),
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof signalProcess !== 'function') {
    throw new WebsitePhpToolActionLockError('website_php_action_lock_invalid', 'PHP action lock configuration is invalid', 500);
  }
  async function withApplicationLock(applicationId, operation) {
    if (typeof applicationId !== 'string' || !UUID.test(applicationId) || typeof operation !== 'function') {
      throw new WebsitePhpToolActionLockError('website_php_action_lock_input_invalid', 'PHP action lock input is invalid', 400);
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, `${applicationId.toLowerCase()}.lock`);
    const value = JSON.stringify({ pid, applicationId: applicationId.toLowerCase() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let handle;
      try {
        handle = await open(target, 'wx', 0o600);
        await writeFile(handle, value, { encoding: 'utf8' });
        await handle.close(); handle = null;
        try { return await operation(); }
        finally { await rm(target, { force: true }).catch(() => {}); }
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error instanceof WebsitePhpToolActionLockError) throw error;
        if (error?.code !== 'EEXIST') {
          throw new WebsitePhpToolActionLockError('website_php_action_lock_failed', 'PHP action lock could not be acquired', 503);
        }
        let existing;
        try { existing = JSON.parse(await readFile(target, 'utf8')); } catch {
          throw new WebsitePhpToolActionLockError('website_php_action_lock_unreadable', 'Existing PHP action lock requires inspection', 503);
        }
        if (!Number.isSafeInteger(existing?.pid) || existing.pid < 1 || existing.applicationId !== applicationId.toLowerCase()) {
          throw new WebsitePhpToolActionLockError('website_php_action_lock_unreadable', 'Existing PHP action lock is invalid', 503);
        }
        let alive = true;
        try { signalProcess(existing.pid, 0); } catch (processError) { if (processError?.code === 'ESRCH') alive = false; }
        if (alive) throw new WebsitePhpToolActionLockError('website_php_action_locked', 'Another process is preparing an action for this Application', 409);
        await rm(target, { force: true });
      }
    }
    throw new WebsitePhpToolActionLockError('website_php_action_lock_race', 'PHP action lock changed while it was being acquired', 409);
  }
  return Object.freeze({ withApplicationLock });
}
