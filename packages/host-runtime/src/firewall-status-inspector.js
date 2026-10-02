import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { nftablesTemplatePolicy } from '@yunpanel/config-templates';

const execFileAsync = promisify(execFile);

export const MANAGED_FIREWALL_TABLE = 'yunpanel';
export const MANAGED_FIREWALL_FAMILY = 'inet';
export const RESOLVED_DEFAULT_SSH_PORT = nftablesTemplatePolicy.defaultSshPort
  ?? nftablesTemplatePolicy.standardPorts?.ssh
  ?? 22;

export class FirewallStatusInspectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FirewallStatusInspectorError';
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
  if (typeof content !== 'string') return null;
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function detectTableNames(rulesetText) {
  if (!rulesetText || typeof rulesetText !== 'string') return [];
  const results = [];
  const regex = /table\s+(inet|ip|ip6|bridge|netdev)\s+([a-zA-Z0-9_-]+)/gi;
  let m;
  while ((m = regex.exec(rulesetText)) !== null) {
    results.push({ family: m[1].toLowerCase(), name: m[2] });
  }
  return results;
}

function findNamedBlocks(rulesetText, type, name) {
  if (!rulesetText || typeof rulesetText !== 'string') return [];
  const escapedName = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const headerRegex = new RegExp(`(?:^|[\\s;])(${type}\\s+${escapedName}\\s*\\{)`, 'gi');
  const blocks = [];
  let match;
  while ((match = headerRegex.exec(rulesetText)) !== null) {
    const startIndex = match.index + match[0].indexOf(match[1]);
    const openBrace = rulesetText.indexOf('{', startIndex);
    if (openBrace === -1) continue;

    let depth = 0;
    let inComment = false;
    let closeBrace = -1;

    for (let i = openBrace; i < rulesetText.length; i++) {
      const ch = rulesetText[i];
      if (inComment) {
        if (ch === '\n') inComment = false;
        continue;
      }
      if (ch === '#') {
        inComment = true;
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          closeBrace = i;
          break;
        }
      }
    }

    if (closeBrace !== -1) {
      blocks.push({
        start: startIndex,
        end: closeBrace + 1,
        openBraceIndex: openBrace,
        closeBraceIndex: closeBrace,
        body: rulesetText.slice(openBrace + 1, closeBrace),
      });
      headerRegex.lastIndex = closeBrace + 1;
    }
  }
  return blocks;
}

export function extractSetElements(rulesetText, setName) {
  if (!rulesetText || typeof rulesetText !== 'string') return [];
  const blocks = findNamedBlocks(rulesetText, 'set', setName);
  if (blocks.length === 0) return [];
  const elements = [];
  for (const block of blocks) {
    const elementsMatch = block.body.match(/elements\s*=\s*\{([^{}]*)\}/i);
    if (elementsMatch) {
      const items = elementsMatch[1]
        .split(/[,\s;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const item of items) {
        if (!elements.includes(item)) {
          elements.push(item);
        }
      }
    }
  }
  return elements;
}

export async function checkSystemdUnit(serviceName, {
  systemctlPath = '/bin/systemctl',
  execFn = execFileSafe,
} = {}) {
  let active = false;
  let enabled = false;
  let activeState = 'unknown';
  let unitFileState = 'unknown';
  let verified = false;
  let error = null;

  // 1. Check is-active
  try {
    const { stdout } = await execFn(systemctlPath, ['is-active', serviceName]);
    const trimmed = (stdout || '').trim();
    activeState = trimmed || 'unknown';
    if (trimmed === 'active') {
      active = true;
      verified = true;
    } else if (['inactive', 'failed', 'activating', 'deactivating'].includes(trimmed)) {
      active = false;
      verified = true;
    } else if (trimmed === '') {
      active = false;
      activeState = 'inactive';
      verified = true;
    } else {
      verified = false;
      error = `Unrecognized is-active state: ${trimmed}`;
    }
  } catch (err) {
    const stdoutTrimmed = (err.stdout || '').trim();
    const msgTrimmed = (err.message || '').trim();
    const candidate = stdoutTrimmed || msgTrimmed;
    if (candidate === 'active') {
      active = true;
      activeState = candidate;
      verified = true;
    } else if (['inactive', 'failed', 'activating', 'deactivating'].includes(candidate)) {
      active = false;
      activeState = candidate;
      verified = true;
    } else {
      const errMsg = (err.stderr || err.stdout || err.message || 'systemctl_error').trim();
      activeState = 'unknown';
      active = false;
      verified = false;
      error = errMsg;
    }
  }

  // 2. Check is-enabled
  try {
    const { stdout } = await execFn(systemctlPath, ['is-enabled', serviceName]);
    const trimmed = (stdout || '').trim();
    unitFileState = trimmed || 'unknown';
    if (trimmed === 'enabled' || trimmed === 'enabled-runtime') {
      enabled = true;
      verified = verified && true;
    } else if (['disabled', 'masked', 'static', 'indirect', 'generated', 'disabled-runtime', 'masked-runtime'].includes(trimmed)) {
      enabled = false;
      verified = verified && true;
    } else if (trimmed === 'inactive' || trimmed === '') {
      enabled = false;
      unitFileState = trimmed === '' ? 'disabled' : trimmed;
      verified = true;
    } else {
      verified = false;
      error = error || `Unrecognized is-enabled state: ${trimmed}`;
    }
  } catch (err) {
    const stdoutTrimmed = (err.stdout || '').trim();
    const msgTrimmed = (err.message || '').trim();
    const candidate = stdoutTrimmed || msgTrimmed;
    if (candidate === 'enabled' || candidate === 'enabled-runtime') {
      enabled = true;
      unitFileState = candidate;
      verified = verified && true;
    } else if (['disabled', 'masked', 'static', 'indirect', 'generated', 'disabled-runtime', 'masked-runtime'].includes(candidate)) {
      enabled = false;
      unitFileState = candidate;
      verified = verified && true;
    } else {
      const errMsg = (err.stderr || err.stdout || err.message || 'systemctl_error').trim();
      unitFileState = 'unknown';
      enabled = false;
      verified = false;
      error = error || errMsg;
    }
  }

  let status = 'unknown';
  if (error && !verified) {
    status = 'error';
  } else if (active) {
    status = 'active';
  } else {
    status = 'inactive';
  }

  return Object.freeze({
    service: serviceName,
    active,
    enabled,
    activeState,
    unitFileState,
    verified,
    error,
    status,
  });
}

export async function inspectLiveApply({
  nftPath = '/usr/sbin/nft',
  execFn = execFileSafe,
  managedTable = MANAGED_FIREWALL_TABLE,
} = {}) {
  let stdout = '';
  let readError = null;

  try {
    const res = await execFn(nftPath, ['list', 'ruleset']);
    stdout = typeof res?.stdout === 'string' ? res.stdout : '';
  } catch (err) {
    readError = err.stderr || err.stdout || err.message || 'nft_list_ruleset_failed';
  }

  if (readError) {
    return Object.freeze({
      status: 'error',
      applied: false,
      loaded: 'unknown',
      error: String(readError).trim(),
      tableNames: Object.freeze([]),
      hasYunpanelTable: false,
      hasCrowdsecSets: false,
      sha256: null,
      rulesetText: null,
    });
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return Object.freeze({
      status: 'empty',
      applied: false,
      loaded: false,
      error: null,
      tableNames: Object.freeze([]),
      hasYunpanelTable: false,
      hasCrowdsecSets: false,
      sha256: null,
      rulesetText: '',
    });
  }

  const detectedTables = detectTableNames(stdout);
  const tableNames = detectedTables.map((t) => t.name);
  const hasYunpanelTable = tableNames.includes(managedTable);
  const hasCrowdsecSets = /set\s+crowdsec(?:6)?-blacklists/i.test(stdout);
  const sha256 = computeSha256(stdout);

  return Object.freeze({
    status: hasYunpanelTable ? 'applied' : 'unmanaged_rules',
    applied: hasYunpanelTable,
    loaded: true,
    error: null,
    tableNames: Object.freeze(tableNames),
    hasYunpanelTable,
    hasCrowdsecSets,
    sha256,
    rulesetSha256: sha256,
    rulesetText: stdout,
  });
}

export async function inspectPersistentFile({
  configPath = nftablesTemplatePolicy.configPath,
  nftPath = '/usr/sbin/nft',
  liveSha256 = null,
  statFn = stat,
  readFileFn = readFile,
  execFn = execFileSafe,
} = {}) {
  let fileExists = false;
  let statError = null;

  try {
    await statFn(configPath);
    fileExists = true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      fileExists = false;
    } else {
      statError = err.message || 'stat_failed';
    }
  }

  if (statError) {
    return Object.freeze({
      status: 'error',
      path: configPath,
      exists: 'unknown',
      sha256: null,
      matchesLive: false,
      syntaxValid: null,
      error: statError,
    });
  }

  if (!fileExists) {
    return Object.freeze({
      status: 'missing',
      path: configPath,
      exists: false,
      sha256: null,
      matchesLive: false,
      syntaxValid: null,
      error: null,
    });
  }

  let content = '';
  try {
    content = await readFileFn(configPath, 'utf8');
  } catch (readErr) {
    return Object.freeze({
      status: 'error',
      path: configPath,
      exists: true,
      sha256: null,
      matchesLive: false,
      syntaxValid: null,
      error: readErr.message || 'read_failed',
    });
  }

  const sha256 = computeSha256(content);
  const matchesLive = Boolean(liveSha256 && sha256 && liveSha256 === sha256);

  let syntaxValid = true;
  let syntaxError = null;
  try {
    await execFn(nftPath, ['-c', '-f', configPath]);
  } catch (err) {
    syntaxValid = false;
    syntaxError = (err.stderr || err.stdout || err.message || 'syntax_error').trim();
  }

  let status = 'persisted';
  if (!syntaxValid) {
    status = 'syntax_error';
  }

  return Object.freeze({
    status,
    path: configPath,
    exists: true,
    sha256,
    matchesLive,
    syntaxValid,
    valid: syntaxValid,
    error: syntaxError,
  });
}

export async function inspectBootLoading({
  serviceName = 'nftables',
  systemctlPath = '/bin/systemctl',
  execFn = execFileSafe,
} = {}) {
  const service = await checkSystemdUnit(serviceName, { systemctlPath, execFn });

  let bootStatus = 'disabled';
  if (service.error && !service.verified) {
    bootStatus = 'error';
  } else if (service.active && service.enabled) {
    bootStatus = 'active';
  } else if (service.enabled) {
    bootStatus = 'enabled_inactive';
  } else if (service.active) {
    bootStatus = 'active_not_enabled';
  } else {
    bootStatus = 'disabled';
  }

  return Object.freeze({
    status: bootStatus,
    service: serviceName,
    enabled: service.enabled,
    active: service.active,
    unitFileState: service.unitFileState,
    activeState: service.activeState,
    verified: service.verified,
    error: service.error,
  });
}

export async function inspectCrowdsecBouncerHealth({
  serviceName = 'crowdsec-firewall-bouncer',
  systemctlPath = '/bin/systemctl',
  execFn = execFileSafe,
  liveRulesetText = '',
} = {}) {
  const bouncerUnit = await checkSystemdUnit(serviceName, { systemctlPath, execFn });

  let installed = false;
  let active = false;
  let enabled = false;
  let error = null;

  if (bouncerUnit.error && !bouncerUnit.verified) {
    installed = 'unknown';
    active = 'unknown';
    enabled = 'unknown';
    error = bouncerUnit.error;
  } else {
    installed = bouncerUnit.active || bouncerUnit.enabled;
    active = bouncerUnit.active;
    enabled = bouncerUnit.enabled;
  }

  const ruleset = typeof liveRulesetText === 'string' ? liveRulesetText : '';
  const hasCrowdsecTable = /table\s+(?:ip|ip6|inet)\s+crowdsec\b/i.test(ruleset);
  const hasCrowdsecSets = /set\s+crowdsec(?:6)?-blacklists/i.test(ruleset);
  const earlyDropActive = /ip\s+saddr\s+@crowdsec-blacklists\s+drop/i.test(ruleset);
  const ipv4Bans = extractSetElements(ruleset, 'crowdsec-blacklists');
  const ipv6Bans = extractSetElements(ruleset, 'crowdsec6-blacklists');
  const bannedIpsCount = ipv4Bans.length + ipv6Bans.length;

  let healthy = false;
  let status = 'inactive';

  if (error && active === 'unknown') {
    status = 'error';
    healthy = false;
  } else if (active === true) {
    if (hasCrowdsecSets) {
      status = 'healthy';
      healthy = true;
    } else {
      status = 'degraded';
      healthy = false;
      error = 'CrowdSec bouncer service is active, but firewall blacklist sets are missing';
    }
  } else if (installed === true) {
    status = 'bouncer_inactive';
    healthy = false;
  } else {
    status = 'not_installed';
    healthy = false;
  }

  return Object.freeze({
    status,
    healthy,
    installed,
    active,
    enabled,
    hasCrowdsecTable,
    hasCrowdsecSets,
    hasLiveSets: hasCrowdsecSets,
    earlyDropActive,
    bannedIpsCount,
    ipv4Bans: Object.freeze(ipv4Bans),
    ipv6Bans: Object.freeze(ipv6Bans),
    error,
  });
}

export async function inspectConflictingFirewallsSafe({
  ufwPath = '/usr/sbin/ufw',
  systemctlPath = '/bin/systemctl',
  statFn = stat,
  execFn = execFileSafe,
} = {}) {
  let ufwInstalled = false;
  let ufwServiceActive = false;
  let ufwStatusActive = false;
  let ufwStatus = 'inactive';
  let ufwError = null;

  let firewalldInstalled = false;
  let firewalldActive = false;
  let firewalldStatus = 'inactive';
  let firewalldError = null;

  // Check UFW binary
  try {
    await statFn(ufwPath);
    ufwInstalled = true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      ufwInstalled = false;
      ufwStatus = 'not_installed';
    } else {
      ufwInstalled = 'unknown';
      ufwStatus = 'error';
      ufwError = err.message || 'stat_failed';
    }
  }

  if (ufwInstalled === true) {
    const ufwService = await checkSystemdUnit('ufw', { systemctlPath, execFn });
    ufwServiceActive = ufwService.active;
    if (ufwService.error && !ufwService.verified) {
      ufwStatusActive = 'unknown';
      ufwStatus = 'error';
      ufwError = ufwService.error;
    }

    try {
      const { stdout } = await execFn(ufwPath, ['status']);
      const trimmed = (stdout || '').trim();
      if (/status:\s*active/i.test(trimmed)) {
        ufwStatusActive = true;
        ufwStatus = 'active';
      } else if (/status:\s*inactive/i.test(trimmed)) {
        ufwStatusActive = false;
        if (ufwStatus !== 'error') ufwStatus = 'inactive';
      } else {
        ufwStatusActive = 'unknown';
        ufwStatus = 'unknown';
        ufwError = ufwError || `Unrecognized UFW status output: ${trimmed}`;
      }
    } catch (err) {
      ufwStatusActive = 'unknown';
      ufwStatus = 'error';
      ufwError = (err.stderr || err.stdout || err.message || 'ufw_status_failed').trim();
    }
  }

  // Check firewalld
  try {
    const firewalldService = await checkSystemdUnit('firewalld', { systemctlPath, execFn });
    if (firewalldService.error && !firewalldService.verified) {
      firewalldInstalled = 'unknown';
      firewalldActive = 'unknown';
      firewalldStatus = 'error';
      firewalldError = firewalldService.error;
    } else {
      firewalldInstalled = firewalldService.active || firewalldService.enabled;
      firewalldActive = firewalldService.active;
      firewalldStatus = firewalldService.active ? 'active' : (firewalldInstalled ? 'inactive' : 'not_installed');
    }
  } catch (err) {
    firewalldInstalled = 'unknown';
    firewalldActive = 'unknown';
    firewalldStatus = 'error';
    firewalldError = err.message || 'firewalld_check_failed';
  }

  const conflictDetected = ufwStatusActive === true || firewalldActive === true;
  let conflictStatus = 'clean';
  if (conflictDetected) {
    conflictStatus = 'conflict';
  } else if (
    ufwStatus === 'error' || firewalldStatus === 'error'
    || ufwStatus === 'unknown' || firewalldStatus === 'unknown'
  ) {
    conflictStatus = 'unknown';
  }

  return Object.freeze({
    ufw: Object.freeze({
      installed: ufwInstalled,
      serviceActive: ufwServiceActive,
      statusActive: ufwStatusActive,
      status: ufwStatus,
      error: ufwError,
    }),
    firewalld: Object.freeze({
      installed: firewalldInstalled,
      active: firewalldActive,
      status: firewalldStatus,
      error: firewalldError,
    }),
    conflictDetected,
    conflictStatus,
  });
}

export function createFirewallStatusInspector({
  nftPath = '/usr/sbin/nft',
  configPath = nftablesTemplatePolicy.configPath,
  systemctlPath = '/bin/systemctl',
  ufwPath = '/usr/sbin/ufw',
  execFn = execFileSafe,
  readFileFn = readFile,
  statFn = stat,
  defaultSshPort = RESOLVED_DEFAULT_SSH_PORT,
} = {}) {
  async function inspectStatus({
    requireSnapshot = false,
    requireVerification = false,
  } = {}) {
    // 1. Canlı kural uygulaması (live apply)
    const liveApply = await inspectLiveApply({ nftPath, execFn });
    if (requireSnapshot && liveApply.status === 'error') {
      throw new FirewallStatusInspectorError(
        'ruleset_snapshot_failed',
        `Live ruleset snapshot failed: ${liveApply.error}`,
      );
    }

    // 2. Kalıcı kural dosyası (persistent rule file)
    const persistentFile = await inspectPersistentFile({
      configPath,
      nftPath,
      liveSha256: liveApply.sha256,
      statFn,
      readFileFn,
      execFn,
    });

    // 3. Önyükleme yüklemesi (boot loading)
    const bootLoading = await inspectBootLoading({
      serviceName: 'nftables',
      systemctlPath,
      execFn,
    });
    if (requireVerification && (!bootLoading.verified || bootLoading.error)) {
      throw new FirewallStatusInspectorError(
        'service_verification_failed',
        `Failed to verify nftables systemd service status: ${bootLoading.error || 'unverified'}`,
      );
    }

    // 4. CrowdSec bouncer sağlığı (crowdsec bouncer health)
    const crowdsecBouncer = await inspectCrowdsecBouncerHealth({
      serviceName: 'crowdsec-firewall-bouncer',
      systemctlPath,
      execFn,
      liveRulesetText: liveApply.rulesetText,
    });

    // 5. Çakışan güvenlik duvarları (conflicting firewalls)
    const conflictingFirewalls = await inspectConflictingFirewallsSafe({
      ufwPath,
      systemctlPath,
      statFn,
      execFn,
    });

    // Determine overall firewall status
    let overallStatus = 'unknown';
    let healthy = false;

    if (liveApply.status === 'error' || bootLoading.status === 'error') {
      overallStatus = 'error';
      healthy = false;
    } else if (conflictingFirewalls.conflictDetected) {
      overallStatus = 'conflict';
      healthy = false;
    } else if (conflictingFirewalls.conflictStatus === 'unknown') {
      overallStatus = 'unknown';
      healthy = false;
    } else if (liveApply.applied && bootLoading.enabled && bootLoading.active) {
      if (persistentFile.status === 'persisted' && persistentFile.matchesLive && (crowdsecBouncer.healthy || crowdsecBouncer.status === 'not_installed')) {
        overallStatus = 'active';
        healthy = true;
      } else {
        overallStatus = 'degraded';
        healthy = false;
      }
    } else if (liveApply.applied) {
      overallStatus = 'degraded';
      healthy = false;
    } else if (!liveApply.applied && !bootLoading.active && liveApply.status !== 'error') {
      overallStatus = 'inactive';
      healthy = false;
    }

    // AC-1: serviceEnabled is derived strictly from verified systemd evidence
    const serviceEnabled = bootLoading.enabled;
    const serviceActive = bootLoading.active;

    return Object.freeze({
      status: overallStatus,
      healthy,
      serviceEnabled,
      serviceActive,
      liveApply,
      persistentFile,
      bootLoading,
      crowdsecBouncer,
      conflictingFirewalls,
      systemdEvidence: bootLoading,
      summary: Object.freeze({
        liveApplyStatus: liveApply.status,
        persistentFileStatus: persistentFile.status,
        bootLoadingStatus: bootLoading.status,
        crowdsecBouncerStatus: crowdsecBouncer.status,
        conflictStatus: conflictingFirewalls.conflictStatus,
      }),
    });
  }

  return Object.freeze({
    inspectStatus,
    inspectFirewallStatus: inspectStatus,
    inspectLiveApply: () => inspectLiveApply({ nftPath, execFn }),
    inspectPersistentFile: (opts) => inspectPersistentFile({ configPath, nftPath, statFn, readFileFn, execFn, ...opts }),
    inspectBootLoading: () => inspectBootLoading({ systemctlPath, execFn }),
    inspectCrowdsecBouncerHealth: (opts) => inspectCrowdsecBouncerHealth({ systemctlPath, execFn, ...opts }),
    inspectConflictingFirewalls: () => inspectConflictingFirewallsSafe({ ufwPath, systemctlPath, statFn, execFn }),
  });
}

export async function inspectFirewallStatus(options = {}) {
  const inspector = createFirewallStatusInspector(options);
  return inspector.inspectStatus(options);
}

export const firewallStatusInspectorInternals = Object.freeze({
  checkSystemdUnit,
  inspectLiveApply,
  inspectPersistentFile,
  inspectBootLoading,
  inspectCrowdsecBouncerHealth,
  inspectConflictingFirewallsSafe,
  computeSha256,
});
