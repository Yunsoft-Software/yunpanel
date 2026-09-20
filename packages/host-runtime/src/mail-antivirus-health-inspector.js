import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import { mailAntivirusTemplatePolicy } from '@yunpanel/config-templates';

const execFileAsync = promisify(execFile);
const DPKG_QUERY = '/usr/bin/dpkg-query';
const SYSTEMCTL = '/usr/bin/systemctl';
const MAX_OUTPUT = 128 * 1024;

export class MailAntivirusHealthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailAntivirusHealthError';
    this.code = code;
    this.status = status;
  }
}

export function createMailAntivirusHealthInspector({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
  statFn = stat,
  totalMemFn = () => os.totalmem(),
} = {}) {
  async function runText(file, args) {
    try {
      const result = await run(file, args, { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      return { ok: true, output: String(result?.stdout ?? result ?? '').trim() };
    } catch {
      return { ok: false, output: '' };
    }
  }

  async function pathExists(filePath) {
    if (!filePath) return false;
    try {
      await statFn(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async function inspect({ profile = mailAntivirusTemplatePolicy.defaultProfile } = {}) {
    if (!mailAntivirusTemplatePolicy.profiles.includes(profile)) {
      throw new MailAntivirusHealthError('invalid_antivirus_profile', `Unsupported antivirus profile: ${profile}`);
    }

    if (profile === 'disabled') {
      return Object.freeze({
        profile: 'disabled',
        enabled: false,
        active: false,
        healthy: false,
        status: 'disabled',
        blockers: Object.freeze([]),
      });
    }

    const blockers = [];

    // 1. Package check
    const [dpkgResult, clamdBinary, clamdscanBinary] = await Promise.all([
      runText(DPKG_QUERY, ['-W', '-f=${Status}', mailAntivirusTemplatePolicy.packageName]),
      pathExists('/usr/sbin/clamd'),
      pathExists('/usr/bin/clamdscan'),
    ]);
    const packageInstalled = (dpkgResult.ok && dpkgResult.output.includes('install ok installed'))
      || clamdBinary || clamdscanBinary;
    if (!packageInstalled) {
      blockers.push('clamav_package_missing');
    }

    // 2. Service check
    const serviceActive = await runText(SYSTEMCTL, ['is-active', '--quiet', mailAntivirusTemplatePolicy.serviceUnit]);
    if (!serviceActive.ok) {
      blockers.push('clamav_service_inactive');
    }

    // 3. Socket check
    const [primarySocket, fallbackSocket] = await Promise.all([
      pathExists(mailAntivirusTemplatePolicy.clamavSocketPath),
      pathExists(mailAntivirusTemplatePolicy.clamavFallbackSocketPath),
    ]);
    if (!primarySocket && !fallbackSocket) {
      blockers.push('clamav_socket_missing');
    }

    // 4. Memory resource check
    let memoryBytes = 0;
    try { memoryBytes = Number(totalMemFn()) || 0; } catch { memoryBytes = 0; }
    if (memoryBytes < mailAntivirusTemplatePolicy.minMemoryBytes) {
      blockers.push('clamav_insufficient_memory');
    }

    const healthy = blockers.length === 0;
    return Object.freeze({
      profile: 'clamav',
      enabled: true,
      active: healthy,
      healthy,
      status: healthy ? 'ready' : 'unhealthy',
      blockers: Object.freeze(blockers),
    });
  }

  return Object.freeze({ inspect });
}
