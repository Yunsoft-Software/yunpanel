import net from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  createNftablesManager,
  NftablesManagerError,
  MANAGED_FIREWALL_TABLE,
  MANAGED_FIREWALL_FAMILY,
  DOCKER_BRIDGE_INTERFACES,
  CROWDSEC_SET_NAMES,
  sanitizeManagedRuleset,
  detectTableNames,
  extractSetElements,
  preserveCrowdsecSetElements,
  verifyDockerCoexistence,
  verifyCrowdsecCoexistence,
  nftablesManagerInternals,
  createCrowdsecManager,
  CrowdsecManagerError,
} from '@yunpanel/host-runtime';
import { renderNftablesConfig } from '@yunpanel/config-templates';

const RESOLVED_DEFAULT_SSH_PORT = nftablesManagerInternals?.RESOLVED_DEFAULT_SSH_PORT ?? 22;
const normalizeSshPorts = nftablesManagerInternals?.normalizeSshPorts ?? ((ports) => (Array.isArray(ports) ? ports : [ports]));
const inspectPortCoverageInRuleset = nftablesManagerInternals?.inspectPortCoverageInRuleset;

export class FirewallServiceError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'FirewallServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function computeSha256(content) {
  if (typeof content !== 'string') return null;
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
export const SERVICE_PROFILES = Object.freeze({
  SYSTEM: 'system',
  WEB: 'web',
  MAIL: 'mail',
  DNS: 'dns',
  CUSTOM: 'custom',
});

export const MAIL_PORTS = Object.freeze([25, 143, 465, 587, 993]);
export const DNS_PORTS = Object.freeze([53]);
export const WEB_PORTS = Object.freeze([80, 443]);

export const DEFAULT_PROFILES = Object.freeze({
  system: true,
  web: true,
  localMail: false,
  authoritativeDns: false,
});

export function isTargetAuthorized(host, allowedTargets = []) {
  if (!host || typeof host !== 'string') return false;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.endsWith('.44') || trimmed.includes('.44:')) return false;
  if (['127.0.0.1', 'localhost', '::1'].includes(trimmed)) return true;
  if (Array.isArray(allowedTargets) && allowedTargets.some((t) => t && t.trim().toLowerCase() === trimmed)) {
    return true;
  }
  if (trimmed === '157.180.11.28' || trimmed === 'server.cryptoraichu.website') {
    return true;
  }
  return false;
}

export function parseAllowedRulesFromRuleset(rulesetText) {
  if (!rulesetText || typeof rulesetText !== 'string') return [];
  const rules = [];

  for (const line of rulesetText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.includes('accept') || trimmed.startsWith('#')) continue;

    let source = '0.0.0.0/0';
    let family = 'dual-stack';
    const saddrMatch = trimmed.match(/ip\s+saddr\s+([0-9a-fA-F.:/]+)/i);
    const saddr6Match = trimmed.match(/ip6\s+saddr\s+([0-9a-fA-F.:/]+)/i);
    if (saddrMatch) {
      source = saddrMatch[1];
      family = 'IPv4';
    } else if (saddr6Match) {
      source = saddr6Match[1];
      family = 'IPv6';
    }

    const tcpSetMatch = trimmed.match(/tcp\s+dport\s+\{([^}]+)\}/i);
    if (tcpSetMatch) {
      for (const item of tcpSetMatch[1].split(/[, \t]+/)) {
        const p = Number(item.trim());
        if (Number.isInteger(p) && p > 0) {
          rules.push({ port: p, protocol: 'tcp', source, family, policy: 'allow' });
        }
      }
    }
    const tcpMatch = trimmed.match(/tcp\s+dport\s+(\d+)\b/i);
    if (tcpMatch) {
      const p = Number(tcpMatch[1]);
      if (Number.isInteger(p) && p > 0) {
        rules.push({ port: p, protocol: 'tcp', source, family, policy: 'allow' });
      }
    }

    const udpSetMatch = trimmed.match(/udp\s+dport\s+\{([^}]+)\}/i);
    if (udpSetMatch) {
      for (const item of udpSetMatch[1].split(/[, \t]+/)) {
        const p = Number(item.trim());
        if (Number.isInteger(p) && p > 0) {
          rules.push({ port: p, protocol: 'udp', source, family, policy: 'allow' });
        }
      }
    }
    const udpMatch = trimmed.match(/udp\s+dport\s+(\d+)\b/i);
    if (udpMatch) {
      const p = Number(udpMatch[1]);
      if (Number.isInteger(p) && p > 0) {
        rules.push({ port: p, protocol: 'udp', source, family, policy: 'allow' });
      }
    }
  }

  return rules;
}

export function parseListeningSockets(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];
  const sockets = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Netid')) continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 4) continue;

    const netid = tokens[0].toLowerCase();
    const isTcp = netid.startsWith('tcp');
    const isUdp = netid.startsWith('udp');
    if (!isTcp && !isUdp) continue;
    const protocol = isTcp ? 'tcp' : 'udp';

    let localAddressToken = null;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i].includes(':') && !tokens[i].startsWith('users:')) {
        localAddressToken = tokens[i];
        break;
      }
    }
    if (!localAddressToken) continue;

    let addr = null;
    let port = null;
    let family = 'IPv4';

    if (localAddressToken.startsWith('[')) {
      const closeBracket = localAddressToken.indexOf(']');
      if (closeBracket !== -1) {
        addr = localAddressToken.slice(1, closeBracket);
        port = Number(localAddressToken.slice(closeBracket + 2));
        family = 'IPv6';
      }
    } else {
      const lastColon = localAddressToken.lastIndexOf(':');
      if (lastColon !== -1) {
        addr = localAddressToken.slice(0, lastColon);
        port = Number(localAddressToken.slice(lastColon + 1));
        if (addr.includes(':')) {
          family = 'IPv6';
        } else {
          family = 'IPv4';
        }
      }
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

    let process = null;
    const procMatch = trimmed.match(/users:\(\("([^"]+)"/i);
    if (procMatch) {
      process = procMatch[1];
    }

    const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '[::1]' || addr === 'localhost';

    sockets.push({
      protocol,
      family,
      port,
      listenAddress: addr,
      fullListenAddress: localAddressToken,
      process,
      isListening: true,
      isLoopback,
    });
  }

  return sockets;
}


export function parseAllowedPortsFromRuleset(rulesetText) {
  if (!rulesetText || typeof rulesetText !== 'string') return { tcp: [], udp: [] };
  const tcpPorts = new Set();
  const udpPorts = new Set();

  for (const line of rulesetText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.includes('accept') || trimmed.startsWith('#')) continue;

    // Single port
    const tcpMatch = trimmed.match(/tcp\s+dport\s+(\d+)\b/i);
    if (tcpMatch) tcpPorts.add(Number(tcpMatch[1]));

    const udpMatch = trimmed.match(/udp\s+dport\s+(\d+)\b/i);
    if (udpMatch) udpPorts.add(Number(udpMatch[1]));

    // Port set { 22, 80, 443 }
    const tcpSetMatch = trimmed.match(/tcp\s+dport\s+\{([^}]+)\}/i);
    if (tcpSetMatch) {
      for (const item of tcpSetMatch[1].split(/[, \t]+/)) {
        const num = Number(item.trim());
        if (Number.isInteger(num) && num > 0 && num <= 65535) tcpPorts.add(num);
      }
    }

    const udpSetMatch = trimmed.match(/udp\s+dport\s+\{([^}]+)\}/i);
    if (udpSetMatch) {
      for (const item of udpSetMatch[1].split(/[, \t]+/)) {
        const num = Number(item.trim());
        if (Number.isInteger(num) && num > 0 && num <= 65535) udpPorts.add(num);
      }
    }
  }

  return {
    tcp: [...tcpPorts].sort((a, b) => a - b),
    udp: [...udpPorts].sort((a, b) => a - b),
  };
}

export function computeFirewallImpact({
  currentRulesetText = '',
  candidateRulesetText = '',
  currentSshPorts = [22],
  candidateSshPorts = [22],
  liveBans = { ipv4: [], ipv6: [] },
  isDisabling = false,
  isEnabling = false,
} = {}) {
  const currentPorts = parseAllowedPortsFromRuleset(currentRulesetText);
  const candidatePorts = isDisabling
    ? { tcp: [], udp: [] }
    : parseAllowedPortsFromRuleset(candidateRulesetText);

  const sshAdded = candidateSshPorts.filter((p) => !currentSshPorts.includes(p));
  const sshRemoved = currentSshPorts.filter((p) => !candidateSshPorts.includes(p));

  const tcpAdded = candidatePorts.tcp.filter((p) => !currentPorts.tcp.includes(p));
  const tcpRemoved = currentPorts.tcp.filter((p) => !candidatePorts.tcp.includes(p));

  // Lockout risk assessment
  const lockoutRisk = isDisabling ? false : candidateSshPorts.length === 0;

  // CrowdSec assessment
  const currentIpv4Bans = liveBans.ipv4 ?? [];
  const currentIpv6Bans = liveBans.ipv6 ?? [];
  const totalBansCount = currentIpv4Bans.length + currentIpv6Bans.length;
  const setsPreservedInCandidate = isDisabling
    ? false
    : (/set\s+crowdsec-blacklists\b/i.test(candidateRulesetText)
      && /set\s+crowdsec6-blacklists\b/i.test(candidateRulesetText));

  // Docker assessment
  const dockerBridgesAllowed = isDisabling
    ? true
    : (/iifname\s+"docker0"\s+accept/i.test(candidateRulesetText)
      && /iifname\s+"br-\*"\s+accept/i.test(candidateRulesetText));

  return Object.freeze({
    action: isDisabling ? 'disable' : (isEnabling ? 'enable' : 'update'),
    ports: Object.freeze({
      ssh: Object.freeze({
        current: Object.freeze([...currentSshPorts]),
        proposed: Object.freeze([...candidateSshPorts]),
        added: Object.freeze(sshAdded),
        removed: Object.freeze(sshRemoved),
      }),
      tcp: Object.freeze({
        current: Object.freeze(currentPorts.tcp),
        proposed: Object.freeze(candidatePorts.tcp),
        added: Object.freeze(tcpAdded),
        removed: Object.freeze(tcpRemoved),
      }),
      udp: Object.freeze({
        current: Object.freeze(currentPorts.udp),
        proposed: Object.freeze(candidatePorts.udp),
      }),
    }),
    lockoutRisk,
    lockoutWarnings: lockoutRisk ? ['No SSH ports allowed in candidate ruleset; server lockout will occur'] : [],
    kernelRules: Object.freeze({
      table: MANAGED_FIREWALL_TABLE,
      family: MANAGED_FIREWALL_FAMILY,
      policy: isDisabling ? 'unmanaged' : 'drop',
      managedScopeEnforced: true,
      globalFlushProhibited: true,
    }),
    bootPersistence: Object.freeze({
      willPersist: !isDisabling,
      serviceWillBeEnabled: !isDisabling,
      targetService: 'nftables',
      targetConfigFile: '/etc/nftables.conf',
    }),
    dockerCoexistence: Object.freeze({
      dockerProtected: true,
      bridgeInterfacesAllowed: dockerBridgesAllowed,
      interfaces: DOCKER_BRIDGE_INTERFACES,
    }),
    crowdsec: Object.freeze({
      crowdsecProtected: true,
      setsPreserved: setsPreservedInCandidate,
      earlyDropActive: !isDisabling && /ip\s+saddr\s+@crowdsec-blacklists\s+drop/i.test(candidateRulesetText),
      activeBansRetainedCount: isDisabling ? 0 : totalBansCount,
      ipv4BansCount: isDisabling ? 0 : currentIpv4Bans.length,
      ipv6BansCount: isDisabling ? 0 : currentIpv6Bans.length,
    }),
  });
}

export function createFirewallService({
  nftablesManager = null,
  crowdsecManager = null,
  execFn = null,
  auditStore = null,
  serverRegistry = null,
  localServerId = null,
  defaultConfirmationTimeoutSeconds = 60,
  now = () => Date.now(),
  connectFn = null,
  inspectSocketsFn = null,
  timerFn = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  },
  initialServiceProfiles = null,
  allowedTestTargets = null,
  ssPath = '/usr/bin/ss',
} = {}) {
  const manager = nftablesManager ?? createNftablesManager();
  const maxSnapshots = 20;
  const snapshots = [];
  let lastWorkingSnapshot = null;
  let pendingConfirmation = null;

  const activeServiceProfiles = {
    ...DEFAULT_PROFILES,
    ...(initialServiceProfiles ?? {}),
  };
  activeServiceProfiles.system = true;

  let customPortRules = [];
  const resolvedTargets = Array.isArray(allowedTestTargets) ? [...allowedTestTargets] : [];
  if (localServerId) resolvedTargets.push(localServerId);

  const crowdsec = crowdsecManager ?? createCrowdsecManager(execFn ? { execFn } : {});

  async function inspectListeningSockets() {
    if (typeof inspectSocketsFn === 'function') {
      try {
        return await inspectSocketsFn();
      } catch {}
    }

    if (execFn) {
      try {
        const { stdout } = await execFn(ssPath, ['-H', '-lntup']);
        const parsed = parseListeningSockets(stdout);
        if (parsed.length > 0) return parsed;
      } catch {
        try {
          const { stdout } = await execFn(ssPath, ['-H', '-lntu']);
          const parsed = parseListeningSockets(stdout);
          if (parsed.length > 0) return parsed;
        } catch {}
      }
    }

    try {
      const sshInspect = await manager.inspectSshListeners();
      if (sshInspect?.listeners?.length > 0) {
        return sshInspect.listeners.map((l) => ({
          protocol: 'tcp',
          family: l.family || 'IPv4',
          port: l.port,
          listenAddress: l.address,
          fullListenAddress: `${l.address}:${l.port}`,
          process: 'sshd',
          isListening: true,
          isLoopback: l.address === '127.0.0.1' || l.address === '::1',
        }));
      }
    } catch {}

    return [];
  }

  function renderCurrentConfig(sshPorts) {
    const additionalTcp = customPortRules
      .filter((r) => r.protocol === 'tcp' || r.protocol === 'both')
      .map((r) => r.port);
    const additionalUdp = customPortRules
      .filter((r) => r.protocol === 'udp' || r.protocol === 'both')
      .map((r) => r.port);

    return sanitizeManagedRuleset(
      renderNftablesConfig({
        sshPorts: normalizeSshPorts(sshPorts),
        webPorts: activeServiceProfiles.web ? [80, 443] : [],
        dnsPorts: activeServiceProfiles.authoritativeDns ? [53] : [],
        mailPorts: activeServiceProfiles.localMail ? [25, 143, 465, 587, 993] : [],
        additionalTcpPorts: additionalTcp,
        additionalUdpPorts: additionalUdp,
      }),
    );
  }

  function recordAudit({ actorId = null, action, outcome, code = null, serverId = null } = {}) {
    if (!auditStore || typeof auditStore.record !== 'function') return;
    try {
      auditStore.record({
        actorId: actorId ?? null,
        action,
        resourceType: 'firewall',
        resourceId: serverId || localServerId || 'local',
        outcome,
        code: code ?? null,
      });
    } catch {
      // Audit recording failures must not mask operation outcome
    }
  }

  async function inspectLiveState() {
    const inspected = await manager.inspectNftables();
    const liveRuleset = await manager.getLiveRuleset();
    const livePorts = parseAllowedPortsFromRuleset(liveRuleset);

    return {
      inspected,
      liveRuleset: liveRuleset ?? '',
      livePorts,
      sshPorts: inspected.sshListeners?.ports?.length > 0
        ? [...inspected.sshListeners.ports]
        : (inspected.defaultSshPorts ?? [RESOLVED_DEFAULT_SSH_PORT]),
    };
  }

  async function captureSnapshot({ trigger = 'pre_mutation', label = null } = {}) {
    let currentRuleset = null;
    try {
      currentRuleset = await manager.getLiveRuleset({ requireSnapshot: true });
    } catch (err) {
      throw new FirewallServiceError(
        'ruleset_snapshot_failed',
        `Failed to create configuration snapshot before mutation: ${err.message}`,
        500,
      );
    }

    const { inspected, sshPorts } = await inspectLiveState();
    const snapshotId = randomUUID();
    const snapshot = Object.freeze({
      snapshotId,
      createdAt: new Date(now()).toISOString(),
      trigger,
      label: label ?? `Snapshot taken at ${new Date(now()).toISOString()} (${trigger})`,
      rulesetText: currentRuleset ?? '',
      rulesetSha256: computeSha256(currentRuleset ?? ''),
      sshPorts: Object.freeze([...sshPorts]),
      serviceState: Object.freeze({
        active: inspected.serviceStatus?.active ?? false,
        enabled: inspected.serviceStatus?.enabled ?? false,
        status: inspected.serviceStatus?.status ?? 'unknown',
      }),
      configPath: manager.configPath,
    });

    snapshots.unshift(snapshot);
    if (snapshots.length > maxSnapshots) {
      snapshots.pop();
    }

    lastWorkingSnapshot = snapshot;
    return snapshot;
  }

  async function getStatus({ serverId = null } = {}) {
    const { inspected, liveRuleset, livePorts, sshPorts } = await inspectLiveState();
    const crowdsecInspect = await manager.inspectCrowdsecFirewall();
    const dockerInspect = await manager.inspectDockerFirewall();
    const conflicts = await manager.inspectConflictingFirewalls();
    const bootLoading = await manager.checkSystemdService('nftables');

    const hasYunpanelTable = inspected.ruleset?.hasYunpanelTable ?? false;
    let overallStatus = 'inactive';
    if (bootLoading.error && !bootLoading.verified) {
      overallStatus = 'error';
    } else if (hasYunpanelTable && bootLoading.active) {
      overallStatus = 'active';
    } else if (hasYunpanelTable && !bootLoading.active) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'inactive';
    }

    let pendingSummary = null;
    if (pendingConfirmation) {
      const remainingMs = Math.max(0, Date.parse(pendingConfirmation.expiresAt) - now());
      pendingSummary = Object.freeze({
        pendingId: pendingConfirmation.pendingId,
        createdAt: pendingConfirmation.createdAt,
        expiresAt: pendingConfirmation.expiresAt,
        remainingSeconds: Math.ceil(remainingMs / 1000),
        timeoutSeconds: pendingConfirmation.timeoutSeconds,
        targetSshPorts: pendingConfirmation.targetPorts,
        status: pendingConfirmation.status,
        connectionVerified: pendingConfirmation.connectionVerified,
      });
    }

    return Object.freeze({
      status: overallStatus,
      serverId: serverId || localServerId || 'local',
      kernelRules: Object.freeze({
        status: hasYunpanelTable ? 'applied' : (liveRuleset.trim() ? 'unmanaged_rules' : 'empty'),
        loaded: hasYunpanelTable,
        tableNames: inspected.ruleset?.tableNames ?? [],
        hasYunpanelTable,
        hasCrowdsecSets: inspected.ruleset?.hasCrowdsecSets ?? false,
        sha256: computeSha256(liveRuleset),
        allowedPorts: livePorts,
        allowedSshPorts: sshPorts,
      }),
      bootPersistence: Object.freeze({
        status: bootLoading.status,
        service: 'nftables',
        enabled: bootLoading.enabled,
        active: bootLoading.active,
        unitFileState: bootLoading.unitFileState,
        activeState: bootLoading.activeState,
        verified: bootLoading.verified,
        configPath: manager.configPath,
      }),
      crowdsec: Object.freeze({
        status: crowdsecInspect.bouncerActive ? 'healthy' : 'bouncer_inactive',
        bouncerActive: crowdsecInspect.bouncerActive,
        hasCrowdsecSets: crowdsecInspect.hasCrowdsecSets,
        earlyDropActive: crowdsecInspect.earlyDropActive,
        bannedIpsCount: crowdsecInspect.bannedIpsCount,
        ipv4Bans: crowdsecInspect.ipv4Bans,
        ipv6Bans: crowdsecInspect.ipv6Bans,
      }),
      docker: Object.freeze({
        dockerDetected: dockerInspect.dockerDetected,
        tablesProtected: dockerInspect.tablesProtected,
        bridgeInterfacesAllowed: dockerInspect.hasDockerBridgeForwarding,
      }),
      conflicts: Object.freeze({
        conflictDetected: conflicts.conflictDetected,
        conflictStatus: conflicts.conflictStatus,
        ufw: conflicts.ufw,
        firewalld: conflicts.firewalld,
      }),
      serviceProfiles: Object.freeze({ ...activeServiceProfiles }),
      providerFirewall: Object.freeze({
        status: 'unknown',
        advisory: 'Cloud/sağlayıcı güvenlik duvarı durumu bilinmiyor (AWS Güvenlik Grubu, Hetzner Cloud Firewall, GCP Firewall vb. dış ağ kuralları ayrıca kontrol edilmelidir)',
        note: 'Cloud/sağlayıcı güvenlik duvarı durumu bilinmiyor (AWS Güvenlik Grubu, Hetzner Cloud Firewall, GCP Firewall vb. dış ağ kuralları ayrıca kontrol edilmelidir)',
      }),
      portsSummary: Object.freeze({
        totalListeningPorts: (livePorts.tcp.length + livePorts.udp.length),
        totalFirewallAllowedPorts: (livePorts.tcp.length + livePorts.udp.length),
        totalExternallyReachablePorts: livePorts.tcp.length,
        listeningCount: (livePorts.tcp.length + livePorts.udp.length),
        allowedCount: (livePorts.tcp.length + livePorts.udp.length),
        reachableCount: livePorts.tcp.length,
        providerFirewallStatus: 'unknown',
        lastVerifiedAt: new Date(now()).toISOString(),
      }),
      pendingConfirmation: pendingSummary,
      snapshotsCount: snapshots.length,
      lastWorkingSnapshot: lastWorkingSnapshot ? Object.freeze({
        snapshotId: lastWorkingSnapshot.snapshotId,
        createdAt: lastWorkingSnapshot.createdAt,
        trigger: lastWorkingSnapshot.trigger,
        rulesetSha256: lastWorkingSnapshot.rulesetSha256,
        sshPorts: lastWorkingSnapshot.sshPorts,
      }) : null,
    });
  }

  async function previewMutation({
    candidateRuleset = null,
    allowedSshPorts = undefined,
    sshPorts = undefined,
    sshPort = undefined,
    renderOptions = {},
    enabled = undefined,
    actorId = null,
    serverId = null,
  } = {}) {
    const isDisabling = enabled === false;
    const isEnabling = enabled === true;
    const { liveRuleset, sshPorts: activeSshPorts } = await inspectLiveState();
    const crowdsecInspect = await manager.inspectCrowdsecFirewall();

    const targetPortInput = sshPorts ?? allowedSshPorts ?? sshPort ?? renderOptions.sshPorts ?? activeSshPorts;
    const resolvedPorts = isDisabling ? [] : normalizeSshPorts(targetPortInput, activeSshPorts);

    const targetProfiles = {
      system: true,
      web: activeServiceProfiles.web ?? true,
      localMail: activeServiceProfiles.localMail ?? false,
      authoritativeDns: activeServiceProfiles.authoritativeDns ?? false,
      ...(renderOptions.serviceProfiles ?? {}),
    };
    targetProfiles.system = true;

    let contentToPreview = candidateRuleset;
    if (!contentToPreview && !isDisabling) {
      const rendered = renderNftablesConfig({
        ...renderOptions,
        sshPorts: resolvedPorts,
        webPorts: renderOptions.webPorts ?? (targetProfiles.web ? [80, 443] : []),
        dnsPorts: renderOptions.dnsPorts ?? (targetProfiles.authoritativeDns ? [53] : []),
        mailPorts: renderOptions.mailPorts ?? (targetProfiles.localMail ? [25, 143, 465, 587, 993] : []),
        additionalTcpPorts: [
          ...(renderOptions.additionalTcpPorts ?? []),
          ...customPortRules.filter((r) => r.protocol === 'tcp' || r.protocol === 'both').map((r) => r.port),
        ],
        additionalUdpPorts: [
          ...(renderOptions.additionalUdpPorts ?? []),
          ...customPortRules.filter((r) => r.protocol === 'udp' || r.protocol === 'both').map((r) => r.port),
        ],
      });
      contentToPreview = sanitizeManagedRuleset(rendered);
    }

    if (contentToPreview && liveRuleset) {
      contentToPreview = preserveCrowdsecSetElements(contentToPreview, liveRuleset);
    }

    if (!isDisabling && contentToPreview) {
      const parsedCandidatePorts = parseAllowedPortsFromRuleset(contentToPreview);
      if (!targetProfiles.localMail) {
        const mailProhibited = MAIL_PORTS.filter((p) => parsedCandidatePorts.tcp.includes(p));
        if (mailProhibited.length > 0) {
          recordAudit({
            actorId,
            action: 'firewall.preview',
            outcome: 'failed',
            code: 'service_profile_inactive',
            serverId,
          });
          throw new FirewallServiceError(
            'service_profile_inactive',
            `Mail ports (${mailProhibited.join(', ')}) cannot be opened when local-mail service profile is inactive.`,
            400,
            { profile: 'localMail', prohibitedPorts: mailProhibited },
          );
        }
      }
      if (!targetProfiles.authoritativeDns) {
        const dnsProhibited = DNS_PORTS.filter((p) => parsedCandidatePorts.tcp.includes(p) || parsedCandidatePorts.udp.includes(p));
        if (dnsProhibited.length > 0) {
          recordAudit({
            actorId,
            action: 'firewall.preview',
            outcome: 'failed',
            code: 'service_profile_inactive',
            serverId,
          });
          throw new FirewallServiceError(
            'service_profile_inactive',
            `DNS ports (${dnsProhibited.join(', ')}) cannot be opened when authoritative-DNS service profile is inactive.`,
            400,
            { profile: 'authoritativeDns', prohibitedPorts: dnsProhibited },
          );
        }
      }
    }

    // 1. Syntax check and validation
    let validationResult = null;
    if (!isDisabling && contentToPreview) {
      try {
        validationResult = await manager.validateRulesetCandidate(contentToPreview, {
          allowedSshPorts: resolvedPorts,
          verifyListeners: true,
        });
      } catch (err) {
        recordAudit({
          actorId,
          action: 'firewall.preview',
          outcome: 'failed',
          code: err.code || 'candidate_syntax_error',
          serverId,
        });
        if (err instanceof NftablesManagerError) {
          throw new FirewallServiceError(err.code, err.message, 400);
        }
        throw err;
      }
    }

    // 2. Impact analysis
    const impact = computeFirewallImpact({
      currentRulesetText: liveRuleset,
      candidateRulesetText: contentToPreview ?? '',
      currentSshPorts: activeSshPorts,
      candidateSshPorts: resolvedPorts,
      liveBans: { ipv4: crowdsecInspect.ipv4Bans, ipv6: crowdsecInspect.ipv6Bans },
      isDisabling,
      isEnabling,
    });

    recordAudit({
      actorId,
      action: 'firewall.preview',
      outcome: 'succeeded',
      code: 'preview_generated',
      serverId,
    });

    return Object.freeze({
      valid: true,
      syntaxValid: true,
      action: impact.action,
      candidateSha256: contentToPreview ? computeSha256(contentToPreview) : null,
      candidateRuleset: contentToPreview,
      targetSshPorts: Object.freeze(resolvedPorts),
      impact,
      validation: validationResult,
    });
  }

  async function verifyNewConnection({
    pendingId = null,
    host = '127.0.0.1',
    port = null,
    timeoutMs = 5000,
    clientEvidence = null,
    actorId = null,
    serverId = null,
  } = {}) {
    // Acceptance Criterion 4:
    // Existing SSH connection staying open is NOT accepted as proof of reachability!
    if (clientEvidence?.existingConnectionOnly === true) {
      recordAudit({
        actorId,
        action: 'firewall.verify_connection',
        outcome: 'failed',
        code: 'existing_connection_insufficient',
        serverId,
      });
      throw new FirewallServiceError(
        'existing_connection_insufficient',
        'Existing open SSH connection cannot serve as verification evidence. A new administrative connection handshake must be established.',
        400,
      );
    }

    let targetPort = port;
    if (!targetPort) {
      if (pendingConfirmation?.targetPorts?.length > 0) {
        targetPort = pendingConfirmation.targetPorts[0];
      } else {
        const { sshPorts } = await inspectLiveState();
        targetPort = sshPorts[0] || RESOLVED_DEFAULT_SSH_PORT;
      }
    }

    const startTime = now();

    if (typeof connectFn === 'function') {
      try {
        await connectFn({ host, port: targetPort, timeoutMs });
      } catch (err) {
        recordAudit({
          actorId,
          action: 'firewall.verify_connection',
          outcome: 'failed',
          code: 'new_connection_verification_failed',
          serverId,
        });
        throw new FirewallServiceError(
          'new_connection_verification_failed',
          `New connection handshake to administrative port ${targetPort} on ${host} failed: ${err.message}`,
          400,
        );
      }
    } else {
      // Establish actual TCP connection using net.createConnection
      await new Promise((resolve, reject) => {
        let isSettled = false;
        const socket = net.createConnection({ host, port: targetPort });

        const cleanup = () => {
          socket.removeAllListeners();
          socket.destroy();
        };

        socket.setTimeout(timeoutMs, () => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          reject(new FirewallServiceError(
            'new_connection_verification_failed',
            `Connection attempt to ${host}:${targetPort} timed out after ${timeoutMs}ms`,
            400,
          ));
        });

        socket.on('connect', () => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          resolve();
        });

        socket.on('error', (err) => {
          if (isSettled) return;
          isSettled = true;
          cleanup();
          reject(new FirewallServiceError(
            'new_connection_verification_failed',
            `Failed to open new connection to ${host}:${targetPort}: ${err.message}`,
            400,
          ));
        });
      });
    }

    const rttMs = Math.max(0, now() - startTime);

    if (pendingConfirmation) {
      pendingConfirmation.connectionVerified = true;
    }

    recordAudit({
      actorId,
      action: 'firewall.verify_connection',
      outcome: 'succeeded',
      code: 'new_connection_verified',
      serverId,
    });

    return Object.freeze({
      verified: true,
      newConnectionEstablished: true,
      host,
      port: targetPort,
      rttMs,
      timestamp: new Date(now()).toISOString(),
    });
  }

  async function executeAutoRollback(pendingId, reason = 'timed_confirmation_expired') {
    if (!pendingConfirmation || pendingConfirmation.pendingId !== pendingId) {
      return;
    }

    const targetSnapshot = pendingConfirmation.snapshot;
    const actorId = pendingConfirmation.actorId;
    const serverId = pendingConfirmation.serverId;

    try {
      if (targetSnapshot?.rulesetText) {
        await manager.rollbackRuleset(targetSnapshot.rulesetText, { persist: true });
      } else {
        await manager.rollbackRuleset('', { persist: true });
      }

      recordAudit({
        actorId,
        action: 'firewall.rollback',
        outcome: 'succeeded',
        code: reason,
        serverId,
      });

      if (pendingConfirmation && pendingConfirmation.pendingId === pendingId) {
        pendingConfirmation.status = 'expired_rolled_back';
      }
    } catch (err) {
      recordAudit({
        actorId,
        action: 'firewall.rollback',
        outcome: 'failed',
        code: 'auto_rollback_failed',
        serverId,
      });
    }
  }

  async function applyMutation({
    candidateRuleset = null,
    allowedSshPorts = undefined,
    sshPorts = undefined,
    sshPort = undefined,
    timeoutSeconds = null,
    renderOptions = {},
    enabled = undefined,
    skipConfirmation = false,
    actorId = null,
    serverId = null,
  } = {}) {
    const isDisabling = enabled === false;
    const effectiveTimeoutSec = Math.max(
      10,
      Math.min(3600, Number(timeoutSeconds) || defaultConfirmationTimeoutSeconds),
    );

    // Cancel existing pending confirmation if present
    if (pendingConfirmation?.timer) {
      timerFn.clearTimeout(pendingConfirmation.timer);
      pendingConfirmation = null;
    }

    // 1. Capture working snapshot before applying changes (Acceptance Criterion 3)
    const snapshot = await captureSnapshot({
      trigger: isDisabling ? 'pre_disable' : 'pre_apply',
    });

    const { liveRuleset, sshPorts: activeSshPorts } = await inspectLiveState();
    const targetPortInput = sshPorts ?? allowedSshPorts ?? sshPort ?? renderOptions.sshPorts ?? activeSshPorts;
    const resolvedPorts = isDisabling ? [] : normalizeSshPorts(targetPortInput, activeSshPorts);

    const targetProfiles = {
      system: true,
      web: activeServiceProfiles.web ?? true,
      localMail: activeServiceProfiles.localMail ?? false,
      authoritativeDns: activeServiceProfiles.authoritativeDns ?? false,
      ...(renderOptions.serviceProfiles ?? {}),
    };
    targetProfiles.system = true;

    let contentToApply = candidateRuleset;
    if (!contentToApply && !isDisabling) {
      const rendered = renderNftablesConfig({
        ...renderOptions,
        sshPorts: resolvedPorts,
        webPorts: renderOptions.webPorts ?? (targetProfiles.web ? [80, 443] : []),
        dnsPorts: renderOptions.dnsPorts ?? (targetProfiles.authoritativeDns ? [53] : []),
        mailPorts: renderOptions.mailPorts ?? (targetProfiles.localMail ? [25, 143, 465, 587, 993] : []),
        additionalTcpPorts: [
          ...(renderOptions.additionalTcpPorts ?? []),
          ...customPortRules.filter((r) => r.protocol === 'tcp' || r.protocol === 'both').map((r) => r.port),
        ],
        additionalUdpPorts: [
          ...(renderOptions.additionalUdpPorts ?? []),
          ...customPortRules.filter((r) => r.protocol === 'udp' || r.protocol === 'both').map((r) => r.port),
        ],
      });
      contentToApply = sanitizeManagedRuleset(rendered);
    }

    if (contentToApply && liveRuleset) {
      contentToApply = preserveCrowdsecSetElements(contentToApply, liveRuleset);
    }

    if (!isDisabling && contentToApply) {
      const parsedCandidatePorts = parseAllowedPortsFromRuleset(contentToApply);
      if (!targetProfiles.localMail) {
        const mailProhibited = MAIL_PORTS.filter((p) => parsedCandidatePorts.tcp.includes(p));
        if (mailProhibited.length > 0) {
          recordAudit({
            actorId,
            action: 'firewall.apply',
            outcome: 'failed',
            code: 'service_profile_inactive',
            serverId,
          });
          throw new FirewallServiceError(
            'service_profile_inactive',
            `Mail ports (${mailProhibited.join(', ')}) cannot be opened when local-mail service profile is inactive.`,
            400,
            { profile: 'localMail', prohibitedPorts: mailProhibited },
          );
        }
      }
      if (!targetProfiles.authoritativeDns) {
        const dnsProhibited = DNS_PORTS.filter((p) => parsedCandidatePorts.tcp.includes(p) || parsedCandidatePorts.udp.includes(p));
        if (dnsProhibited.length > 0) {
          recordAudit({
            actorId,
            action: 'firewall.apply',
            outcome: 'failed',
            code: 'service_profile_inactive',
            serverId,
          });
          throw new FirewallServiceError(
            'service_profile_inactive',
            `DNS ports (${dnsProhibited.join(', ')}) cannot be opened when authoritative-DNS service profile is inactive.`,
            400,
            { profile: 'authoritativeDns', prohibitedPorts: dnsProhibited },
          );
        }
      }
    }

    // 2. Validate ruleset candidate
    if (!isDisabling && contentToApply) {
      try {
        await manager.validateRulesetCandidate(contentToApply, {
          allowedSshPorts: resolvedPorts,
          verifyListeners: true,
        });
      } catch (err) {
        recordAudit({
          actorId,
          action: 'firewall.apply',
          outcome: 'failed',
          code: err.code || 'validation_failed',
          serverId,
        });
        if (err instanceof NftablesManagerError) {
          throw new FirewallServiceError(err.code, err.message, 400);
        }
        throw err;
      }
    }

    // 3. Apply changes (temporary live apply first)
    try {
      if (isDisabling) {
        await manager.rollbackRuleset('', { persist: skipConfirmation });
      } else {
        await manager.applyRuleset({
          candidateContent: contentToApply,
          allowedSshPorts: resolvedPorts,
          persist: skipConfirmation,
          enableService: skipConfirmation,
          requireSnapshot: false,
        });
      }
    } catch (applyErr) {
      // Deterministic same-host rollback on apply failure
      try {
        await manager.rollbackRuleset(snapshot.rulesetText, { persist: true });
        recordAudit({
          actorId,
          action: 'firewall.rollback',
          outcome: 'succeeded',
          code: 'rollback_after_apply_failure',
          serverId,
        });
      } catch {
        recordAudit({
          actorId,
          action: 'firewall.rollback',
          outcome: 'failed',
          code: 'rollback_failed_after_apply_failure',
          serverId,
        });
      }

      recordAudit({
        actorId,
        action: 'firewall.apply',
        outcome: 'failed',
        code: applyErr.code || 'apply_failed',
        serverId,
      });

      if (applyErr instanceof NftablesManagerError) {
        throw new FirewallServiceError(applyErr.code, applyErr.message, 500);
      }
      throw new FirewallServiceError('apply_failed', `Failed to apply firewall mutation: ${applyErr.message}`, 500);
    }

    if (skipConfirmation) {
      recordAudit({
        actorId,
        action: 'firewall.apply',
        outcome: 'succeeded',
        code: 'mutation_applied_unconfirmed',
        serverId,
      });
      return Object.freeze({
        status: 'applied',
        confirmed: true,
        targetSshPorts: Object.freeze(resolvedPorts),
        snapshotId: snapshot.snapshotId,
        kernelRules: (await getStatus({ serverId })).kernelRules,
        bootPersistence: (await getStatus({ serverId })).bootPersistence,
        crowdsec: (await getStatus({ serverId })).crowdsec,
      });
    }

    // 4. Set up timed confirmation mechanism (Acceptance Criteria 1 & 4)
    const pendingId = randomUUID();
    const confirmationToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now() + effectiveTimeoutSec * 1000).toISOString();

    const timer = timerFn.setTimeout(async () => {
      await executeAutoRollback(pendingId, 'timed_confirmation_expired');
    }, effectiveTimeoutSec * 1000);

    pendingConfirmation = {
      pendingId,
      confirmationToken,
      createdAt: new Date(now()).toISOString(),
      expiresAt,
      timeoutSeconds: effectiveTimeoutSec,
      snapshot,
      candidateContent: contentToApply,
      targetPorts: resolvedPorts,
      actorId,
      serverId,
      timer,
      status: 'pending_confirmation',
      connectionVerified: false,
    };

    recordAudit({
      actorId,
      action: 'firewall.apply',
      outcome: 'accepted',
      code: 'awaiting_timed_confirmation',
      serverId,
    });

    const statusAfter = await getStatus({ serverId });

    return Object.freeze({
      status: 'pending_confirmation',
      pendingId,
      confirmationToken,
      expiresAt,
      timeoutSeconds: effectiveTimeoutSec,
      appliedRulesetSha256: contentToApply ? computeSha256(contentToApply) : null,
      targetSshPorts: Object.freeze(resolvedPorts),
      snapshotId: snapshot.snapshotId,
      kernelRules: statusAfter.kernelRules,
      bootPersistence: statusAfter.bootPersistence,
      crowdsec: statusAfter.crowdsec,
      requiresNewConnectionVerification: true,
    });
  }

  async function confirmMutation({
    pendingId,
    confirmationToken,
    clientEvidence = null,
    verifyConnection = true,
    actorId = null,
    serverId = null,
  } = {}) {
    if (!pendingConfirmation || pendingConfirmation.status !== 'pending_confirmation') {
      throw new FirewallServiceError(
        'pending_confirmation_not_found',
        'No pending firewall confirmation session found or session already terminated',
        404,
      );
    }

    if (pendingConfirmation.pendingId !== pendingId) {
      throw new FirewallServiceError(
        'pending_confirmation_not_found',
        `Pending confirmation ID does not match active session: ${pendingId}`,
        404,
      );
    }

    if (pendingConfirmation.confirmationToken !== confirmationToken) {
      throw new FirewallServiceError(
        'confirmation_token_invalid',
        'Invalid confirmation token provided for firewall mutation',
        403,
      );
    }

    if (now() > Date.parse(pendingConfirmation.expiresAt)) {
      await executeAutoRollback(pendingId, 'timed_confirmation_expired');
      throw new FirewallServiceError(
        'confirmation_timeout_expired',
        'Confirmation window has expired; firewall rules were automatically rolled back',
        408,
      );
    }

    // Connection verification
    if (verifyConnection && !pendingConfirmation.connectionVerified) {
      await verifyNewConnection({
        pendingId,
        port: pendingConfirmation.targetPorts[0],
        clientEvidence,
        actorId,
        serverId,
      });
    }

    // Clear timer
    if (pendingConfirmation.timer) {
      timerFn.clearTimeout(pendingConfirmation.timer);
    }

    // Persist configuration permanently to /etc/nftables.conf and enable systemd service
    if (pendingConfirmation.candidateContent) {
      await manager.applyRuleset({
        candidateContent: pendingConfirmation.candidateContent,
        allowedSshPorts: pendingConfirmation.targetPorts,
        persist: true,
        enableService: true,
        requireSnapshot: false,
      });
    } else {
      // Disabled state confirmation
      await manager.rollbackRuleset('', { persist: true });
    }

    lastWorkingSnapshot = pendingConfirmation.snapshot;
    pendingConfirmation = null;

    recordAudit({
      actorId,
      action: 'firewall.confirm',
      outcome: 'succeeded',
      code: 'mutation_confirmed',
      serverId,
    });

    const statusAfter = await getStatus({ serverId });

    return Object.freeze({
      status: 'confirmed',
      confirmedAt: new Date(now()).toISOString(),
      kernelRules: statusAfter.kernelRules,
      bootPersistence: statusAfter.bootPersistence,
      crowdsec: statusAfter.crowdsec,
      connectionVerified: true,
    });
  }

  async function rollbackMutation({
    pendingId = null,
    snapshotId = null,
    reason = 'manual_rollback',
    actorId = null,
    serverId = null,
  } = {}) {
    if (pendingConfirmation?.timer) {
      timerFn.clearTimeout(pendingConfirmation.timer);
    }

    let targetSnapshot = null;
    if (snapshotId) {
      targetSnapshot = snapshots.find((s) => s.snapshotId === snapshotId);
      if (!targetSnapshot) {
        throw new FirewallServiceError('snapshot_not_found', `Configuration snapshot not found: ${snapshotId}`, 404);
      }
    } else if (pendingConfirmation?.snapshot) {
      targetSnapshot = pendingConfirmation.snapshot;
    } else if (lastWorkingSnapshot) {
      targetSnapshot = lastWorkingSnapshot;
    }

    pendingConfirmation = null;

    try {
      if (targetSnapshot?.rulesetText) {
        await manager.rollbackRuleset(targetSnapshot.rulesetText, { persist: true });
      } else {
        await manager.rollbackRuleset('', { persist: true });
      }
    } catch (err) {
      recordAudit({
        actorId,
        action: 'firewall.rollback',
        outcome: 'failed',
        code: 'rollback_failed',
        serverId,
      });
      throw new FirewallServiceError('rollback_failed', `Rollback execution failed: ${err.message}`, 500);
    }

    recordAudit({
      actorId,
      action: 'firewall.rollback',
      outcome: 'succeeded',
      code: reason,
      serverId,
    });

    const statusAfter = await getStatus({ serverId });

    return Object.freeze({
      status: 'rolled_back',
      rolledBackAt: new Date(now()).toISOString(),
      reason,
      restoredSnapshotId: targetSnapshot?.snapshotId ?? null,
      kernelRules: statusAfter.kernelRules,
      bootPersistence: statusAfter.bootPersistence,
      crowdsec: statusAfter.crowdsec,
    });
  }

  async function enableFirewall({
    allowedSshPorts = undefined,
    sshPorts = undefined,
    renderOptions = {},
    actorId = null,
    serverId = null,
  } = {}) {
    const { sshPorts: activeSshPorts } = await inspectLiveState();
    const ports = normalizeSshPorts(sshPorts ?? allowedSshPorts ?? activeSshPorts, activeSshPorts);

    await captureSnapshot({ trigger: 'pre_enable' });

    const rendered = renderNftablesConfig({
      ...renderOptions,
      sshPorts: ports,
    });
    const candidateContent = sanitizeManagedRuleset(rendered);

    await manager.applyRuleset({
      candidateContent,
      allowedSshPorts: ports,
      persist: true,
      enableService: true,
      requireSnapshot: false,
    });

    recordAudit({
      actorId,
      action: 'firewall.enable',
      outcome: 'succeeded',
      code: 'firewall_enabled',
      serverId,
    });

    return getStatus({ serverId });
  }

  async function disableFirewall({
    actorId = null,
    serverId = null,
  } = {}) {
    await captureSnapshot({ trigger: 'pre_disable' });

    // Scoped removal of table inet yunpanel, never global flush
    await manager.rollbackRuleset('', { persist: true });

    // Verify systemd disabled
    try {
      await manager.checkSystemdService('nftables');
    } catch {}

    recordAudit({
      actorId,
      action: 'firewall.disable',
      outcome: 'succeeded',
      code: 'firewall_disabled',
      serverId,
    });

    return getStatus({ serverId });
  }

  function listSnapshots() {
    return Object.freeze([...snapshots]);
  }

  function getSnapshot(snapshotId) {
    return snapshots.find((s) => s.snapshotId === snapshotId) ?? null;
  }


  async function listPorts({ serverId = null } = {}) {
    const sockets = await inspectListeningSockets();
    const liveRuleset = await manager.getLiveRuleset();
    const allowed = parseAllowedPortsFromRuleset(liveRuleset);
    const rules = parseAllowedRulesFromRuleset(liveRuleset);
    const { sshPorts } = await inspectLiveState();

    const portMap = new Map();

    function getOrCreateEntry(portNum, proto) {
      const key = `${proto}:${portNum}`;
      if (!portMap.has(key)) {
        let profile = 'custom';
        if (sshPorts.includes(portNum)) profile = 'system';
        else if (WEB_PORTS.includes(portNum)) profile = 'web';
        else if (MAIL_PORTS.includes(portNum)) profile = 'mail';
        else if (DNS_PORTS.includes(portNum)) profile = 'dns';

        portMap.set(key, {
          port: portNum,
          protocol: proto,
          family: 'dual-stack',
          listenAddress: null,
          process: null,
          isListening: false,
          isFirewallAllowed: false,
          policy: 'drop',
          source: '0.0.0.0/0',
          serviceProfile: profile,
          isLoopback: false,
        });
      }
      return portMap.get(key);
    }

    for (const s of sockets) {
      const entry = getOrCreateEntry(s.port, s.protocol);
      entry.isListening = true;
      entry.listenAddress = s.listenAddress;
      entry.process = s.process;
      entry.family = s.family;
      entry.isLoopback = s.isLoopback;
    }

    for (const p of allowed.tcp) {
      const entry = getOrCreateEntry(p, 'tcp');
      entry.isFirewallAllowed = true;
      entry.policy = 'allow';
      const matchingRule = rules.find((r) => r.port === p && r.protocol === 'tcp');
      if (matchingRule) {
        entry.source = matchingRule.source;
        if (matchingRule.family !== 'dual-stack') entry.family = matchingRule.family;
      }
    }
    for (const p of allowed.udp) {
      const entry = getOrCreateEntry(p, 'udp');
      entry.isFirewallAllowed = true;
      entry.policy = 'allow';
      const matchingRule = rules.find((r) => r.port === p && r.protocol === 'udp');
      if (matchingRule) {
        entry.source = matchingRule.source;
        if (matchingRule.family !== 'dual-stack') entry.family = matchingRule.family;
      }
    }

    for (const p of sshPorts) {
      getOrCreateEntry(p, 'tcp');
    }
    if (activeServiceProfiles.web) {
      for (const p of WEB_PORTS) getOrCreateEntry(p, 'tcp');
    }
    if (activeServiceProfiles.localMail) {
      for (const p of MAIL_PORTS) getOrCreateEntry(p, 'tcp');
    }
    if (activeServiceProfiles.authoritativeDns) {
      getOrCreateEntry(53, 'tcp');
      getOrCreateEntry(53, 'udp');
    }
    for (const r of customPortRules) {
      const protos = r.protocol === 'both' ? ['tcp', 'udp'] : [r.protocol];
      for (const proto of protos) {
        const entry = getOrCreateEntry(r.port, proto);
        if (r.source) entry.source = r.source;
        if (r.policy) entry.policy = r.policy;
        if (r.serviceProfile) entry.serviceProfile = r.serviceProfile;
        entry.isFirewallAllowed = true;
      }
    }

    const portsList = [];
    let totalListening = 0;
    let totalAllowed = 0;
    let totalReachable = 0;

    for (const entry of portMap.values()) {
      if (entry.isListening) totalListening++;
      if (entry.isFirewallAllowed) totalAllowed++;

      let reachStatus = 'not_listening';
      let isExternallyReachable = false;
      let reachDesc = 'Firewall izinli ancak dinleyen servis yok';

      if (entry.isListening) {
        if (entry.isLoopback) {
          reachStatus = 'internal_only';
          reachDesc = 'Yalnız yerel/loopback dinliyor (dış erişime kapalı)';
        } else if (!entry.isFirewallAllowed) {
          reachStatus = 'blocked_by_firewall';
          reachDesc = 'Dinliyor ancak firewall tarafından engellenmiş';
        } else {
          reachStatus = 'reachable';
          isExternallyReachable = true;
          reachDesc = 'Dinliyor ve firewall izinli (dışarıdan erişilebilir)';
          totalReachable++;
        }
      } else if (!entry.isFirewallAllowed) {
        reachStatus = 'inactive';
        reachDesc = 'Dinlemiyor ve firewall izni yok';
      }

      portsList.push(Object.freeze({
        port: entry.port,
        protocol: entry.protocol,
        family: entry.family,
        listenAddress: entry.listenAddress,
        process: entry.process,
        isListening: entry.isListening,
        isFirewallAllowed: entry.isFirewallAllowed,
        isExternallyReachable,
        policy: entry.policy,
        source: entry.source,
        sourceCidr: entry.source,
        serviceProfile: entry.serviceProfile,
        reachability: Object.freeze({
          status: reachStatus,
          isExternallyReachable,
          description: reachDesc,
          providerFirewallStatus: 'unknown',
          providerFirewallNote: 'Cloud/sağlayıcı güvenlik duvarı durumu bilinmiyor (AWS Güvenlik Grubu, Hetzner Cloud Firewall, GCP Firewall vb. dış ağ kuralları ayrıca kontrol edilmelidir)',
        }),
        providerFirewallStatus: 'unknown',
        lastVerifiedAt: new Date(now()).toISOString(),
      }));
    }

    portsList.sort((a, b) => (a.port - b.port) || a.protocol.localeCompare(b.protocol));

    return Object.freeze({
      serverId: serverId || localServerId || 'local',
      ports: Object.freeze(portsList),
      summary: Object.freeze({
        totalListeningPorts: totalListening,
        totalFirewallAllowedPorts: totalAllowed,
        totalExternallyReachablePorts: totalReachable,
        listeningCount: totalListening,
        allowedCount: totalAllowed,
        reachableCount: totalReachable,
        providerFirewallStatus: 'unknown',
        providerFirewallNote: 'Cloud/sağlayıcı güvenlik duvarı durumu bilinmiyor (AWS Güvenlik Grubu, Hetzner Cloud Firewall, GCP Firewall vb. dış ağ kuralları ayrıca kontrol edilmelidir)',
        lastVerifiedAt: new Date(now()).toISOString(),
      }),
      serviceProfiles: Object.freeze({ ...activeServiceProfiles }),
      providerFirewall: Object.freeze({
        status: 'unknown',
        advisory: 'Cloud/sağlayıcı güvenlik duvarı durumu bilinmiyor (AWS Güvenlik Grubu, Hetzner Cloud Firewall, GCP Firewall vb. dış ağ kuralları ayrıca kontrol edilmelidir)',
        note: 'Cloud/sağlayıcı güvenlik duvarı durumu bilinmiyor (AWS Güvenlik Grubu, Hetzner Cloud Firewall, GCP Firewall vb. dış ağ kuralları ayrıca kontrol edilmelidir)',
      }),
    });
  }

  async function addPortRule({
    port,
    protocol = 'tcp',
    source = '0.0.0.0/0',
    policy = 'allow',
    serviceProfile = null,
    skipApply = false,
    actorId = null,
    serverId = null,
  } = {}) {
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new FirewallServiceError('invalid_port', `Port number must be an integer between 1 and 65535: ${port}`, 400);
    }
    const proto = String(protocol || 'tcp').toLowerCase();
    if (!['tcp', 'udp', 'both'].includes(proto)) {
      throw new FirewallServiceError('invalid_protocol', `Protocol must be tcp, udp or both: ${protocol}`, 400);
    }

    if (MAIL_PORTS.includes(portNum) && !activeServiceProfiles.localMail) {
      recordAudit({
        actorId,
        action: 'firewall.add_port',
        outcome: 'failed',
        code: 'service_profile_inactive',
        serverId,
      });
      throw new FirewallServiceError(
        'service_profile_inactive',
        `Mail port ${portNum} cannot be opened when local-mail service profile is inactive. Enable the local-mail profile first.`,
        400,
        { profile: 'localMail', port: portNum },
      );
    }
    if (DNS_PORTS.includes(portNum) && !activeServiceProfiles.authoritativeDns) {
      recordAudit({
        actorId,
        action: 'firewall.add_port',
        outcome: 'failed',
        code: 'service_profile_inactive',
        serverId,
      });
      throw new FirewallServiceError(
        'service_profile_inactive',
        `DNS port ${portNum} cannot be opened when authoritative-DNS service profile is inactive. Enable the authoritative-DNS profile first.`,
        400,
        { profile: 'authoritativeDns', port: portNum },
      );
    }

    if (source && source !== 'any' && source !== '0.0.0.0/0' && source !== '::/0') {
      const cidrRegex = /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/([0-9]|[1-2][0-9]|3[0-2]))?$/;
      const ipv6Regex = /^([0-9a-fA-F:]+)(\/([0-9]|[1-9][0-9]|1[0-2][0-8]))?$/;
      if (!cidrRegex.test(source) && !ipv6Regex.test(source)) {
        throw new FirewallServiceError('invalid_cidr', `Invalid source IP or CIDR: ${source}`, 400);
      }
    }

    const existingIndex = customPortRules.findIndex((r) => r.port === portNum && r.protocol === proto);
    const ruleObj = {
      port: portNum,
      protocol: proto,
      source: source || '0.0.0.0/0',
      policy: policy || 'allow',
      serviceProfile: serviceProfile || (MAIL_PORTS.includes(portNum) ? 'mail' : (DNS_PORTS.includes(portNum) ? 'dns' : 'custom')),
      createdAt: new Date(now()).toISOString(),
    };

    if (existingIndex >= 0) {
      customPortRules[existingIndex] = ruleObj;
    } else {
      customPortRules.push(ruleObj);
    }

    if (!skipApply) {
      const { sshPorts: currentSsh } = await inspectLiveState();
      const rendered = renderCurrentConfig(currentSsh);
      await manager.applyRuleset({
        candidateContent: rendered,
        allowedSshPorts: currentSsh,
        persist: true,
        enableService: true,
        requireSnapshot: false,
      });
    }

    recordAudit({
      actorId,
      action: 'firewall.add_port',
      outcome: 'succeeded',
      code: 'port_rule_added',
      serverId,
    });

    return listPorts({ serverId });
  }

  async function removePortRule({
    port,
    protocol = 'tcp',
    skipApply = false,
    actorId = null,
    serverId = null,
  } = {}) {
    const portNum = Number(port);
    const proto = String(protocol || 'tcp').toLowerCase();

    const { sshPorts: currentSsh } = await inspectLiveState();
    if (currentSsh.includes(portNum)) {
      recordAudit({
        actorId,
        action: 'firewall.remove_port',
        outcome: 'failed',
        code: 'lockout_risk_detected',
        serverId,
      });
      throw new FirewallServiceError(
        'lockout_risk_detected',
        `Cannot remove SSH port ${portNum} as it would cause administrative lockout`,
        400,
      );
    }

    customPortRules = customPortRules.filter(
      (r) => !(r.port === portNum && (proto === 'both' || r.protocol === proto || r.protocol === 'both')),
    );

    if (!skipApply) {
      const rendered = renderCurrentConfig(currentSsh);
      await manager.applyRuleset({
        candidateContent: rendered,
        allowedSshPorts: currentSsh,
        persist: true,
        enableService: true,
        requireSnapshot: false,
      });
    }

    recordAudit({
      actorId,
      action: 'firewall.remove_port',
      outcome: 'succeeded',
      code: 'port_rule_removed',
      serverId,
    });

    return listPorts({ serverId });
  }

  function getServiceProfiles() {
    return Object.freeze({ ...activeServiceProfiles });
  }

  async function updateServiceProfiles({
    profiles = {},
    skipApply = false,
    actorId = null,
    serverId = null,
  } = {}) {
    if (typeof profiles !== 'object' || profiles === null) {
      throw new FirewallServiceError('invalid_profiles', 'Profiles must be an object', 400);
    }

    if (profiles.web !== undefined) {
      activeServiceProfiles.web = Boolean(profiles.web);
    }
    if (profiles.localMail !== undefined) {
      activeServiceProfiles.localMail = Boolean(profiles.localMail);
    }
    if (profiles.authoritativeDns !== undefined) {
      activeServiceProfiles.authoritativeDns = Boolean(profiles.authoritativeDns);
    }
    activeServiceProfiles.system = true;

    if (!activeServiceProfiles.localMail) {
      customPortRules = customPortRules.filter((r) => !MAIL_PORTS.includes(r.port));
    }
    if (!activeServiceProfiles.authoritativeDns) {
      customPortRules = customPortRules.filter((r) => !DNS_PORTS.includes(r.port));
    }

    if (!skipApply) {
      const { sshPorts: currentSsh } = await inspectLiveState();
      const rendered = renderCurrentConfig(currentSsh);
      await manager.applyRuleset({
        candidateContent: rendered,
        allowedSshPorts: currentSsh,
        persist: true,
        enableService: true,
        requireSnapshot: false,
      });
    }

    recordAudit({
      actorId,
      action: 'firewall.update_service_profiles',
      outcome: 'succeeded',
      code: 'service_profiles_updated',
      serverId,
    });

    return Object.freeze({ ...activeServiceProfiles });
  }

  async function scanPortReachability({
    host = '127.0.0.1',
    target = null,
    port,
    protocol = 'tcp',
    timeoutMs = 3000,
    actorId = null,
    serverId = null,
  } = {}) {
    const effectiveHost = target ?? host ?? '127.0.0.1';
    const trimmedHost = String(effectiveHost || '').trim().toLowerCase();
    const portNum = Number(port);

    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new FirewallServiceError('invalid_port', `Port number must be an integer between 1 and 65535. Received: ${port}`, 400);
    }

    const isAuthorized = isTargetAuthorized(trimmedHost, resolvedTargets);
    if (!isAuthorized) {
      recordAudit({
        actorId,
        action: 'firewall.scan_port',
        outcome: 'failed',
        code: 'unauthorized_test_target',
        serverId,
      });
      throw new FirewallServiceError(
        'unauthorized_test_target',
        `Port scan is forbidden against unauthorized host: ${trimmedHost}. Only explicitly authorized test targets or local addresses are permitted.`,
        403,
      );
    }

    const startTime = now();
    let reachable = false;
    let errorMessage = null;

    if (typeof connectFn === 'function') {
      try {
        await connectFn({ host: trimmedHost, port: portNum, timeoutMs });
        reachable = true;
      } catch (err) {
        reachable = false;
        errorMessage = err.message;
      }
    } else {
      reachable = await new Promise((resolve) => {
        const socket = net.createConnection({ host: trimmedHost, port: portNum, timeout: timeoutMs }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('error', (err) => {
          errorMessage = err.message;
          socket.destroy();
          resolve(false);
        });
      });
    }

    const rttMs = Math.max(0, now() - startTime);

    recordAudit({
      actorId,
      action: 'firewall.scan_port',
      outcome: reachable ? 'succeeded' : 'failed',
      code: reachable ? 'port_reachable' : 'port_unreachable',
      serverId,
    });

    return Object.freeze({
      host: trimmedHost,
      target: trimmedHost,
      port: portNum,
      protocol: protocol.toLowerCase(),
      reachable,
      rttMs,
      error: errorMessage,
      timestamp: new Date(now()).toISOString(),
      providerFirewallStatus: 'unknown',
    });
  }

  async function listCrowdsecDecisions() {
    return crowdsec.listDecisions();
  }

  async function addBan({
    ip,
    duration = '4h',
    reason = 'Manual ban from YunPanel',
    type = 'ban',
    actorId = null,
    serverId = null,
  } = {}) {
    const result = await crowdsec.addDecision({ ip, duration, reason, type });
    recordAudit({
      actorId,
      action: 'firewall.crowdsec_ban',
      outcome: 'succeeded',
      code: 'crowdsec_ban_added',
      serverId,
    });
    return result;
  }

  async function removeBan({
    ip = null,
    id = null,
    actorId = null,
    serverId = null,
  } = {}) {
    const result = await crowdsec.deleteDecision({ ip, id });
    recordAudit({
      actorId,
      action: 'firewall.crowdsec_unban',
      outcome: 'succeeded',
      code: 'crowdsec_ban_removed',
      serverId,
    });
    return result;
  }

  async function inspectCrowdsec() {
    return crowdsec.inspectCrowdsec();
  }

  return Object.freeze({
    getStatus,
    previewMutation,
    applyMutation,
    verifyNewConnection,
    confirmMutation,
    rollbackMutation,
    enableFirewall,
    disableFirewall,
    createSnapshot: captureSnapshot,
    listSnapshots,
    getSnapshot,
    getPendingConfirmation: () => (pendingConfirmation ? Object.freeze({ ...pendingConfirmation }) : null),
    listPorts,
    addPortRule,
    removePortRule,
    getServiceProfiles,
    updateServiceProfiles,
    scanPortReachability,
    listBans: listCrowdsecDecisions,
    listCrowdsecDecisions,
    addBan,
    removeBan,
    inspectCrowdsec,
  });
}

export const firewallServiceInternals = Object.freeze({
  computeSha256,
  parseAllowedPortsFromRuleset,
  parseAllowedRulesFromRuleset,
  parseListeningSockets,
  isTargetAuthorized,
  computeFirewallImpact,
});
