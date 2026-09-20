import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class CrowdsecManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CrowdsecManagerError';
    this.code = code;
  }
}

function execFileSafe(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
}

function isValidIpOrCidr(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (isIP(trimmed)) return true;

  // Check CIDR format (e.g. 192.168.1.0/24 or 2001:db8::/32)
  const parts = trimmed.split('/');
  if (parts.length === 2) {
    const [ip, prefix] = parts;
    const ipFamily = isIP(ip);
    const prefixNum = Number(prefix);
    if (!Number.isInteger(prefixNum) || prefixNum < 0) return false;
    if (ipFamily === 4 && prefixNum <= 32) return true;
    if (ipFamily === 6 && prefixNum <= 128) return true;
  }
  return false;
}

const DURATION_REGEX = /^[0-9]+[smhd]$/;

export function createCrowdsecManager({
  cscliPath = '/usr/bin/cscli',
  systemctlPath = '/bin/systemctl',
  execFn = execFileSafe,
} = {}) {
  async function checkSystemdService(serviceName) {
    let active = false;
    let enabled = false;
    try {
      const { stdout } = await execFn(systemctlPath, ['is-active', serviceName]);
      active = stdout.trim() === 'active';
    } catch (err) {
      active = err.stdout?.trim() === 'active';
    }
    try {
      const { stdout } = await execFn(systemctlPath, ['is-enabled', serviceName]);
      enabled = stdout.trim() === 'enabled';
    } catch (err) {
      enabled = err.stdout?.trim() === 'enabled';
    }
    return { active, enabled };
  }

  async function inspectCrowdsec() {
    let engineInstalled = false;
    let engineVersion = null;

    try {
      const { stdout } = await execFn(cscliPath, ['version']);
      const versionMatch = stdout.match(/version:\s*v?([0-9]+(?:\.[0-9]+)+)/i)
        || stdout.match(/CrowdSec\s+v?([0-9]+(?:\.[0-9]+)+)/i);
      engineInstalled = true;
      engineVersion = versionMatch ? versionMatch[1] : null;
    } catch {
      engineInstalled = false;
    }

    const engineService = await checkSystemdService('crowdsec');
    const bouncerService = await checkSystemdService('crowdsec-firewall-bouncer');
    const fail2banService = await checkSystemdService('fail2ban');

    const duplicateAuthorityDetected = fail2banService.active;
    const healthy = engineService.active && bouncerService.active && !duplicateAuthorityDetected;

    return Object.freeze({
      engine: Object.freeze({
        installed: engineInstalled,
        binaryPath: cscliPath,
        version: engineVersion,
        active: engineService.active,
        enabled: engineService.enabled,
      }),
      bouncer: Object.freeze({
        installed: bouncerService.active || bouncerService.enabled,
        active: bouncerService.active,
        enabled: bouncerService.enabled,
      }),
      conflicts: Object.freeze({
        fail2banActive: fail2banService.active,
        fail2banEnabled: fail2banService.enabled,
        duplicateAuthorityDetected,
      }),
      healthy,
    });
  }

  async function listDecisions() {
    try {
      const { stdout } = await execFn(cscliPath, ['decisions', 'list', '-o', 'json']);
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === 'null' || trimmed === '[]') {
        return [];
      }
      const rawDecisions = JSON.parse(trimmed);
      if (!Array.isArray(rawDecisions)) {
        return [];
      }
      return rawDecisions.map((d) => Object.freeze({
        id: d.id,
        source: d.origin ?? d.source ?? 'cscli',
        scope: d.scope ?? 'ip',
        value: d.value,
        reason: d.scenario ?? d.reason ?? 'manual',
        duration: d.duration,
        type: d.type ?? d.action ?? 'ban',
        simulated: Boolean(d.simulated),
        createdAt: d.created_at ?? null,
      }));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new CrowdsecManagerError('decisions_parse_error', `Failed to parse decisions JSON: ${error.message}`);
      }
      throw new CrowdsecManagerError('decisions_list_failed', `Failed to list decisions: ${error.stderr || error.stdout || error.message}`);
    }
  }

  async function addDecision({
    ip,
    duration = '4h',
    reason = 'manual ban from YunPanel',
    type = 'ban',
  } = {}) {
    if (!isValidIpOrCidr(ip)) {
      throw new CrowdsecManagerError('invalid_ip', `Target IP or CIDR is invalid: ${ip}`);
    }

    if (!DURATION_REGEX.test(duration)) {
      throw new CrowdsecManagerError('invalid_duration', `Duration must match [0-9]+[smhd]: ${duration}`);
    }

    const safeType = type === 'captcha' ? 'captcha' : 'ban';

    try {
      await execFn(cscliPath, [
        'decisions',
        'add',
        '--ip', ip.trim(),
        '--duration', duration,
        '--reason', reason,
        '--type', safeType,
      ]);
      return Object.freeze({
        success: true,
        ip: ip.trim(),
        duration,
        reason,
        type: safeType,
      });
    } catch (error) {
      throw new CrowdsecManagerError(
        'add_decision_failed',
        `Failed to add decision for ${ip}: ${error.stderr || error.stdout || error.message}`,
      );
    }
  }

  async function deleteDecision({ ip = null, id = null } = {}) {
    if (ip) {
      if (!isValidIpOrCidr(ip)) {
        throw new CrowdsecManagerError('invalid_ip', `Target IP or CIDR is invalid: ${ip}`);
      }
      try {
        await execFn(cscliPath, ['decisions', 'delete', '--ip', ip.trim()]);
        return Object.freeze({
          success: true,
          deleted: true,
          target: ip.trim(),
          targetType: 'ip',
        });
      } catch (error) {
        throw new CrowdsecManagerError(
          'delete_decision_failed',
          `Failed to delete decision for IP ${ip}: ${error.stderr || error.stdout || error.message}`,
        );
      }
    }

    if (id !== null && id !== undefined) {
      const idNum = Number(id);
      if (!Number.isInteger(idNum) || idNum < 1) {
        throw new CrowdsecManagerError('invalid_id', `Decision ID must be a positive integer: ${id}`);
      }
      try {
        await execFn(cscliPath, ['decisions', 'delete', '--id', String(idNum)]);
        return Object.freeze({
          success: true,
          deleted: true,
          target: idNum,
          targetType: 'id',
        });
      } catch (error) {
        throw new CrowdsecManagerError(
          'delete_decision_failed',
          `Failed to delete decision for ID ${id}: ${error.stderr || error.stdout || error.message}`,
        );
      }
    }

    throw new CrowdsecManagerError('missing_target', 'Either ip or id must be provided to delete decision');
  }

  async function getMetrics() {
    try {
      const { stdout } = await execFn(cscliPath, ['metrics', '-o', 'json']);
      const trimmed = stdout.trim();
      if (!trimmed) return {};
      return JSON.parse(trimmed);
    } catch (error) {
      throw new CrowdsecManagerError(
        'metrics_failed',
        `Failed to fetch CrowdSec metrics: ${error.stderr || error.stdout || error.message}`,
      );
    }
  }

  async function listAlerts({ limit = 50 } = {}) {
    const limitNum = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 50;
    try {
      const { stdout } = await execFn(cscliPath, ['alerts', 'list', '-o', 'json', '--limit', String(limitNum)]);
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === 'null' || trimmed === '[]') return [];
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      throw new CrowdsecManagerError(
        'alerts_list_failed',
        `Failed to list CrowdSec alerts: ${error.stderr || error.stdout || error.message}`,
      );
    }
  }

  return Object.freeze({
    inspectCrowdsec,
    listDecisions,
    addDecision,
    deleteDecision,
    getMetrics,
    listAlerts,
  });
}
