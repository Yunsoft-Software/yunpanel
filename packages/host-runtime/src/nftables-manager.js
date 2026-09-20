import { execFile } from 'node:child_process';
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { renderNftablesConfig, nftablesTemplatePolicy } from '@yunpanel/config-templates';

const execFileAsync = promisify(execFile);

export class NftablesManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NftablesManagerError';
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

function computeSha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function createNftablesManager({
  nftPath = '/usr/sbin/nft',
  configPath = nftablesTemplatePolicy.configPath,
  systemctlPath = '/bin/systemctl',
  ufwPath = '/usr/sbin/ufw',
  defaultSshPort = nftablesTemplatePolicy.defaultSshPort,
  readFileFn = readFile,
  writeFileFn = writeFile,
  renameFn = rename,
  chmodFn = chmod,
  rmFn = rm,
  statFn = stat,
  execFn = execFileSafe,
} = {}) {
  async function atomicWrite(targetPath, content, mode = 0o755) {
    const tempPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFileFn(tempPath, content, { encoding: 'utf8', mode });
      await chmodFn(tempPath, mode);
      await renameFn(tempPath, targetPath);
    } catch (error) {
      try { await rmFn(tempPath, { force: true }); } catch {}
      throw error;
    }
  }

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

  async function inspectConflictingFirewalls() {
    let ufwInstalled = false;
    let ufwServiceActive = false;
    let ufwStatusActive = false;
    let firewalldInstalled = false;
    let firewalldActive = false;

    // Check UFW
    try {
      await statFn(ufwPath);
      ufwInstalled = true;
    } catch {
      ufwInstalled = false;
    }

    if (ufwInstalled) {
      const ufwService = await checkSystemdService('ufw');
      ufwServiceActive = ufwService.active;
      try {
        const { stdout } = await execFn(ufwPath, ['status']);
        ufwStatusActive = /status:\s*active/i.test(stdout);
      } catch {
        ufwStatusActive = false;
      }
    }

    // Check firewalld
    try {
      const firewalldService = await checkSystemdService('firewalld');
      firewalldInstalled = firewalldService.active || firewalldService.enabled;
      firewalldActive = firewalldService.active;
    } catch {
      firewalldActive = false;
    }

    const conflictDetected = ufwStatusActive || firewalldActive;

    return Object.freeze({
      ufw: Object.freeze({
        installed: ufwInstalled,
        serviceActive: ufwServiceActive,
        statusActive: ufwStatusActive,
      }),
      firewalld: Object.freeze({
        installed: firewalldInstalled,
        active: firewalldActive,
      }),
      conflictDetected,
    });
  }

  async function getLiveRuleset() {
    try {
      const { stdout } = await execFn(nftPath, ['list', 'ruleset']);
      return stdout;
    } catch (error) {
      return '';
    }
  }

  function parseRulesetMetadata(rulesetText) {
    if (!rulesetText || typeof rulesetText !== 'string') {
      return Object.freeze({
        loaded: false,
        tableNames: [],
        hasYunpanelTable: false,
        hasCrowdsecSets: false,
      });
    }

    const tableNames = [];
    const tableRegex = /table\s+(?:inet|ip|ip6|bridge|netdev)\s+([a-zA-Z0-9_-]+)/g;
    let match;
    while ((match = tableRegex.exec(rulesetText)) !== null) {
      tableNames.push(match[1]);
    }

    const hasYunpanelTable = tableNames.includes('yunpanel');
    const hasCrowdsecSets = /set\s+crowdsec(?:6)?-blacklists/i.test(rulesetText);

    return Object.freeze({
      loaded: tableNames.length > 0,
      tableNames,
      hasYunpanelTable,
      hasCrowdsecSets,
    });
  }

  async function inspectNftables() {
    let satisfied = false;
    let version = null;

    try {
      const { stdout } = await execFn(nftPath, ['--version']);
      const versionMatch = stdout.match(/nftables\s+v?([0-9]+(?:\.[0-9]+)+)/i);
      satisfied = true;
      version = versionMatch ? versionMatch[1] : null;
    } catch {
      satisfied = false;
    }

    const serviceStatus = await checkSystemdService('nftables');
    const conflictingFirewalls = await inspectConflictingFirewalls();
    const liveRuleset = await getLiveRuleset();
    const rulesetMetadata = parseRulesetMetadata(liveRuleset);

    return Object.freeze({
      satisfied,
      binaryPath: nftPath,
      version,
      serviceStatus: Object.freeze(serviceStatus),
      conflictingFirewalls,
      ruleset: rulesetMetadata,
    });
  }

  function assertSshPortAllowed(candidateContent, sshPort) {
    const portNum = Number(sshPort);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new NftablesManagerError('invalid_ssh_port', `SSH port must be a valid integer between 1 and 65535: ${sshPort}`);
    }

    // Check for SSH port in accept rule (either "tcp dport { ... <port> ... } accept" or "tcp dport <port> accept")
    const singlePortPattern = new RegExp(`tcp\\s+dport\\s+${portNum}\\s+accept`, 'i');
    const multiPortPattern = /tcp\s+dport\s+\{([^}]+)\}\s+accept/gi;

    if (singlePortPattern.test(candidateContent)) {
      return true;
    }

    let multiMatch;
    while ((multiMatch = multiPortPattern.exec(candidateContent)) !== null) {
      const portsList = multiMatch[1].split(',').map((p) => p.trim());
      if (portsList.includes(String(portNum)) || portsList.includes(portNum.toString())) {
        return true;
      }
    }

    throw new NftablesManagerError(
      'ssh_lockout_risk',
      `Candidate ruleset does not explicitly allow SSH port ${portNum} in TCP accept rules. Apply aborted to prevent server lockout.`,
    );
  }

  async function validateRulesetCandidate(candidateContent, { allowedSshPort = defaultSshPort } = {}) {
    if (typeof candidateContent !== 'string' || !candidateContent.trim()) {
      throw new NftablesManagerError('invalid_candidate', 'Candidate ruleset content cannot be empty');
    }

    // 1. Check lockout prevention
    assertSshPortAllowed(candidateContent, allowedSshPort);

    // 2. Syntax check via nft -c -f
    const tempPath = `/tmp/nftables-check.${process.pid}.${randomBytes(6).toString('hex')}.nft`;
    try {
      await writeFileFn(tempPath, candidateContent, { encoding: 'utf8', mode: 0o600 });
      await execFn(nftPath, ['-c', '-f', tempPath]);
      return Object.freeze({ valid: true, allowedSshPort });
    } catch (error) {
      const errMsg = error.stderr || error.stdout || error.message;
      throw new NftablesManagerError(
        'candidate_syntax_error',
        `nft syntax validation failed: ${errMsg.trim()}`,
      );
    } finally {
      try { await rmFn(tempPath, { force: true }); } catch {}
    }
  }

  async function applyRuleset({
    candidateContent = null,
    allowedSshPort = defaultSshPort,
    renderOptions = {},
    forceConflictOverride = false,
    persist = true,
    enableService = true,
  } = {}) {
    // 1. Check conflicting firewalls
    const conflicts = await inspectConflictingFirewalls();
    if (conflicts.conflictDetected && !forceConflictOverride) {
      throw new NftablesManagerError(
        'conflicting_firewall_detected',
        'Conflicting firewall (UFW or firewalld) is currently active. UFW must be disabled to ensure nftables remains the single firewall authority.',
      );
    }

    // 2. Resolve candidate content
    const contentToApply = candidateContent ?? renderNftablesConfig({
      sshPort: allowedSshPort,
      ...renderOptions,
    });

    // 3. Validate candidate (lockout + syntax)
    await validateRulesetCandidate(contentToApply, { allowedSshPort });

    // 4. Snapshot current ruleset for rollback
    const currentRuleset = await getLiveRuleset();
    const backupRulesetSha256 = currentRuleset ? computeSha256(currentRuleset) : null;

    // 5. Apply live
    const tempPath = `/tmp/nftables-apply.${process.pid}.${randomBytes(6).toString('hex')}.nft`;
    try {
      await writeFileFn(tempPath, contentToApply, { encoding: 'utf8', mode: 0o600 });
      await execFn(nftPath, ['-f', tempPath]);
    } catch (applyError) {
      // Rollback immediately if backup exists
      if (currentRuleset && currentRuleset.trim()) {
        try {
          const rollbackTemp = `/tmp/nftables-rollback.${process.pid}.${randomBytes(6).toString('hex')}.nft`;
          await writeFileFn(rollbackTemp, currentRuleset, { encoding: 'utf8', mode: 0o600 });
          await execFn(nftPath, ['-f', rollbackTemp]);
          try { await rmFn(rollbackTemp, { force: true }); } catch {}
        } catch {}
      }
      throw new NftablesManagerError(
        'apply_failed',
        `Failed to apply nftables ruleset: ${applyError.stderr || applyError.stdout || applyError.message}`,
      );
    } finally {
      try { await rmFn(tempPath, { force: true }); } catch {}
    }

    // 6. Persist to /etc/nftables.conf if requested
    if (persist) {
      await atomicWrite(configPath, contentToApply, 0o755);
    }

    // 7. Enable and start nftables.service if requested
    if (enableService) {
      try {
        await execFn(systemctlPath, ['enable', 'nftables']);
        await execFn(systemctlPath, ['start', 'nftables']);
      } catch (svcError) {
        // Warning: service enable/start failed, but ruleset is loaded live
      }
    }

    return Object.freeze({
      success: true,
      appliedAt: new Date().toISOString(),
      appliedRulesetSha256: computeSha256(contentToApply),
      backupRulesetSha256,
      persisted: persist,
      serviceEnabled: enableService,
      allowedSshPort,
    });
  }

  async function rollbackRuleset(previousRuleset, { persist = true } = {}) {
    if (!previousRuleset || typeof previousRuleset !== 'string' || !previousRuleset.trim()) {
      // If previous ruleset is empty, flush ruleset
      await execFn(nftPath, ['flush', 'ruleset']);
      return Object.freeze({ success: true, rolledBack: true, flushed: true });
    }

    const tempPath = `/tmp/nftables-rollback.${process.pid}.${randomBytes(6).toString('hex')}.nft`;
    try {
      await writeFileFn(tempPath, previousRuleset, { encoding: 'utf8', mode: 0o600 });
      await execFn(nftPath, ['-f', tempPath]);
      if (persist) {
        await atomicWrite(configPath, previousRuleset, 0o755);
      }
      return Object.freeze({
        success: true,
        rolledBack: true,
        rulesetSha256: computeSha256(previousRuleset),
      });
    } catch (error) {
      throw new NftablesManagerError(
        'rollback_failed',
        `Failed to rollback nftables ruleset: ${error.stderr || error.stdout || error.message}`,
      );
    } finally {
      try { await rmFn(tempPath, { force: true }); } catch {}
    }
  }

  return Object.freeze({
    inspectNftables,
    validateRulesetCandidate,
    applyRuleset,
    rollbackRuleset,
    getLiveRuleset,
    configPath,
  });
}
