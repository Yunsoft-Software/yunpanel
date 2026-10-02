import { execFile } from 'node:child_process';
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { renderNftablesConfig, nftablesTemplatePolicy } from '@yunpanel/config-templates';
import {
  createFirewallStatusInspector,
  inspectFirewallStatus,
  FirewallStatusInspectorError,
} from './firewall-status-inspector.js';

const execFileAsync = promisify(execFile);

export class NftablesManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NftablesManagerError';
    this.code = code;
  }
}

export const RESOLVED_DEFAULT_SSH_PORT = nftablesTemplatePolicy.defaultSshPort
  ?? nftablesTemplatePolicy.standardPorts?.ssh
  ?? 22;

export const MANAGED_FIREWALL_TABLE = 'yunpanel';
export const MANAGED_FIREWALL_FAMILY = 'inet';
export const DOCKER_BRIDGE_INTERFACES = Object.freeze(['docker0', 'br-*']);
export const CROWDSEC_SET_NAMES = Object.freeze(['crowdsec-blacklists', 'crowdsec6-blacklists']);

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

export function normalizeSshPorts(input, defaultPorts = [RESOLVED_DEFAULT_SSH_PORT]) {
  if (input === undefined) {
    const defaults = Array.isArray(defaultPorts) ? defaultPorts : [defaultPorts];
    return [...defaults].map((p) => {
      const num = Number(p);
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        throw new NftablesManagerError(
          'invalid_ssh_port',
          `Default SSH port must be a valid integer between 1 and 65535: ${p}`,
        );
      }
      return num;
    });
  }

  if (input === null || input === '') {
    throw new NftablesManagerError('invalid_ssh_port', 'SSH port parameter cannot be empty or null');
  }

  let rawList = [];
  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new NftablesManagerError('invalid_ssh_port', 'SSH ports array cannot be empty to prevent lockout');
    }
    rawList = input;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new NftablesManagerError('invalid_ssh_port', 'SSH port parameter cannot be empty or whitespace');
    }
    if (trimmed.includes(',')) {
      rawList = trimmed.split(',').map((p) => p.trim());
    } else {
      rawList = [trimmed];
    }
  } else if (typeof input === 'number') {
    rawList = [input];
  } else {
    throw new NftablesManagerError('invalid_ssh_port', `Invalid SSH port parameter type: ${typeof input}`);
  }

  const normalized = [];
  for (const raw of rawList) {
    const num = Number(raw);
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
      throw new NftablesManagerError(
        'invalid_ssh_port',
        `SSH port must be a valid integer between 1 and 65535: ${raw}`,
      );
    }
    normalized.push(num);
  }

  return [...new Set(normalized)].sort((a, b) => a - b);
}

export function inspectPortCoverageInRuleset(candidateContent, portNum) {
  let hasIpv4 = false;
  let hasIpv6 = false;
  let hasGeneric = false;

  const lines = candidateContent.split('\n');
  let currentTableFamily = 'inet';

  for (const line of lines) {
    const trimmed = line.trim();
    const tableMatch = trimmed.match(/^table\s+(inet|ip|ip6|bridge|netdev)\s+/i);
    if (tableMatch) {
      currentTableFamily = tableMatch[1].toLowerCase();
    }

    if (!trimmed.includes('accept') || !trimmed.includes('dport')) {
      continue;
    }

    let lineAllowsPort = false;

    // 1. Single port pattern
    const singleRegex = new RegExp(`tcp\\s+dport\\s+${portNum}\\b`, 'i');
    if (singleRegex.test(trimmed)) {
      lineAllowsPort = true;
    }

    // 2. Set of ports pattern e.g. tcp dport { 22, 80 } accept
    const setRegex = /tcp\s+dport\s+\{([^}]+)\}/i;
    const setMatch = trimmed.match(setRegex);
    if (setMatch) {
      const items = setMatch[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      for (const item of items) {
        if (item === String(portNum)) {
          lineAllowsPort = true;
          break;
        }
        if (item.includes('-')) {
          const [l, h] = item.split('-').map(Number);
          if (Number.isInteger(l) && Number.isInteger(h) && portNum >= l && portNum <= h) {
            lineAllowsPort = true;
            break;
          }
        }
      }
    }

    // 3. Port range pattern e.g. tcp dport 20-25 accept
    const rangeRegex = /tcp\s+dport\s+(\d+)[-..]+(\d+)/i;
    const rangeMatch = trimmed.match(rangeRegex);
    if (rangeMatch) {
      const l = Number(rangeMatch[1]);
      const h = Number(rangeMatch[2]);
      if (portNum >= l && portNum <= h) {
        lineAllowsPort = true;
      }
    }

    if (lineAllowsPort) {
      const isIpExplicit = /ip\s+protocol\s+tcp|ip\s+saddr|ip\s+daddr/i.test(trimmed);
      const isIp6Explicit = /ip6\s+nexthdr\s+tcp|ip6\s+saddr|ip6\s+daddr/i.test(trimmed);

      if (currentTableFamily === 'ip' || isIpExplicit) {
        hasIpv4 = true;
      } else if (currentTableFamily === 'ip6' || isIp6Explicit) {
        hasIpv6 = true;
      } else if (currentTableFamily === 'inet') {
        hasGeneric = true;
        hasIpv4 = true;
        hasIpv6 = true;
      }
    }
  }

  const allowed = hasGeneric || (hasIpv4 && hasIpv6) || hasIpv4 || hasIpv6;

  return Object.freeze({
    port: portNum,
    allowed,
    hasGeneric,
    hasIpv4,
    hasIpv6,
    dualStack: hasGeneric || (hasIpv4 && hasIpv6),
  });
}

export function assertSshPortAllowed(candidateContent, sshPort, options = {}) {
  const portNum = Number(sshPort);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new NftablesManagerError(
      'invalid_ssh_port',
      `SSH port must be a valid integer between 1 and 65535: ${sshPort}`,
    );
  }

  const coverage = inspectPortCoverageInRuleset(candidateContent, portNum);
  if (!coverage.allowed) {
    throw new NftablesManagerError(
      'ssh_lockout_risk',
      `Candidate ruleset does not explicitly allow SSH port ${portNum} in TCP accept rules. Apply aborted to prevent server lockout.`,
    );
  }

  if (options.requireDualStack && !coverage.dualStack) {
    throw new NftablesManagerError(
      'ssh_lockout_risk',
      `Candidate ruleset does not allow SSH port ${portNum} on both IPv4 and IPv6. Dual-stack coverage is required.`,
    );
  }

  if (options.requireIpv4 && !coverage.hasIpv4) {
    throw new NftablesManagerError(
      'ssh_lockout_risk',
      `Candidate ruleset does not allow SSH port ${portNum} on IPv4. Apply aborted to prevent lockout.`,
    );
  }

  if (options.requireIpv6 && !coverage.hasIpv6) {
    throw new NftablesManagerError(
      'ssh_lockout_risk',
      `Candidate ruleset does not allow SSH port ${portNum} on IPv6. Apply aborted to prevent lockout.`,
    );
  }

  return true;
}

export function assertSshPortsAllowed(candidateContent, sshPorts, options = {}) {
  const normalizedPorts = normalizeSshPorts(sshPorts);
  if (normalizedPorts.length === 0) {
    throw new NftablesManagerError(
      'invalid_ssh_port',
      'At least one SSH port must be specified to prevent lockout',
    );
  }

  for (const port of normalizedPorts) {
    assertSshPortAllowed(candidateContent, port, options);
  }

  return true;
}

export async function inspectSshListeners({
  ssPath = '/usr/bin/ss',
  sshdConfigPath = '/etc/ssh/sshd_config',
  execFn = execFileSafe,
  readFileFn = readFile,
  defaultSshPort = RESOLVED_DEFAULT_SSH_PORT,
} = {}) {
  const listeners = [];
  const configuredPorts = [];

  // 1. Try reading sshd_config for configured Port directives
  try {
    const configContent = await readFileFn(sshdConfigPath, 'utf8');
    for (const line of configContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const portMatch = trimmed.match(/^Port\s+(\d+)/i);
      if (portMatch) {
        const portNum = Number(portMatch[1]);
        if (Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535) {
          configuredPorts.push(portNum);
        }
      }
    }
  } catch {
    // Config unreadable or does not exist
  }

  if (configuredPorts.length === 0) {
    configuredPorts.push(defaultSshPort);
  }

  // 2. Try inspecting live listening sockets via ss
  try {
    const { stdout } = await execFn(ssPath, ['-H', '-ltn']);
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tokens = trimmed.split(/\s+/);
      const localAddress = tokens.length >= 4 ? tokens[3] : null;
      if (!localAddress) continue;

      let addr = null;
      let port = null;
      let family = null;

      if (localAddress.startsWith('[')) {
        const closeIdx = localAddress.indexOf(']');
        if (closeIdx > 0 && localAddress[closeIdx + 1] === ':') {
          addr = localAddress.slice(1, closeIdx);
          port = Number(localAddress.slice(closeIdx + 2));
          family = 'IPv6';
        }
      } else if (localAddress.startsWith(':::') || (localAddress.includes('::') && localAddress.includes(':'))) {
        const lastColon = localAddress.lastIndexOf(':');
        addr = localAddress.slice(0, lastColon);
        port = Number(localAddress.slice(lastColon + 1));
        family = 'IPv6';
      } else if (localAddress.includes(':')) {
        const lastColon = localAddress.lastIndexOf(':');
        addr = localAddress.slice(0, lastColon);
        port = Number(localAddress.slice(lastColon + 1));
        family = 'IPv4';
      }

      if (port !== null && Number.isInteger(port) && configuredPorts.includes(port)) {
        listeners.push({
          address: addr,
          port,
          family: family ?? (addr?.includes(':') ? 'IPv6' : 'IPv4'),
        });
      }
    }
  } catch {
    // ss failed or not available in environment
  }

  // 3. Fallback: if ss was not executed or returned 0 listeners, project listeners
  if (listeners.length === 0) {
    for (const port of configuredPorts) {
      listeners.push(
        { address: '0.0.0.0', port, family: 'IPv4' },
        { address: '::', port, family: 'IPv6' },
      );
    }
  }

  const uniquePorts = [...new Set(listeners.map((l) => l.port))].sort((a, b) => a - b);
  const hasIpv4 = listeners.some((l) => l.family === 'IPv4');
  const hasIpv6 = listeners.some((l) => l.family === 'IPv6');

  return Object.freeze({
    satisfied: listeners.length > 0,
    binaryPath: ssPath,
    listeners: Object.freeze(listeners),
    ports: Object.freeze(uniquePorts),
    hasIpv4,
    hasIpv6,
    dualStack: hasIpv4 && hasIpv6,
  });
}

export async function verifySshListenerContract(candidateContent, {
  listeners = null,
  allowedSshPorts = undefined,
  sshPorts = undefined,
  allowedSshPort = undefined,
  sshPort = undefined,
  ssPath = '/usr/bin/ss',
  sshdConfigPath = '/etc/ssh/sshd_config',
  execFn = execFileSafe,
  readFileFn = readFile,
  defaultSshPort = RESOLVED_DEFAULT_SSH_PORT,
} = {}) {
  const activeListeners = listeners ?? (await inspectSshListeners({
    ssPath,
    sshdConfigPath,
    execFn,
    readFileFn,
    defaultSshPort,
  }));

  const explicitInput = allowedSshPorts ?? sshPorts ?? allowedSshPort ?? sshPort;
  const targetPorts = explicitInput !== undefined
    ? normalizeSshPorts(explicitInput, [defaultSshPort])
    : (activeListeners.ports.length > 0 ? activeListeners.ports : [defaultSshPort]);

  for (const port of targetPorts) {
    const portListeners = activeListeners.listeners.filter((l) => l.port === port);
    const requireIpv4 = portListeners.length > 0
      ? portListeners.some((l) => l.family === 'IPv4')
      : activeListeners.hasIpv4;
    const requireIpv6 = portListeners.length > 0
      ? portListeners.some((l) => l.family === 'IPv6')
      : activeListeners.hasIpv6;

    assertSshPortAllowed(candidateContent, port, {
      requireIpv4,
      requireIpv6,
    });
  }

  return Object.freeze({
    verified: true,
    targetPorts: Object.freeze(targetPorts),
    activeListeners,
  });
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

function updateSetWithElements(rulesetText, setName, mergedElements) {
  if (!mergedElements || mergedElements.length === 0) return rulesetText;
  const blocks = findNamedBlocks(rulesetText, 'set', setName);
  if (blocks.length === 0) return rulesetText;

  let result = rulesetText;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    let newBody;
    if (/elements\s*=\s*\{[^{}]*\}/i.test(block.body)) {
      newBody = block.body.replace(
        /elements\s*=\s*\{[^{}]*\}/i,
        `elements = { ${mergedElements.join(', ')} }`,
      );
    } else if (!block.body.includes('\n')) {
      const trimmed = block.body.trim();
      const semi = trimmed.endsWith(';') ? '' : ';';
      newBody = ` ${trimmed}${semi} elements = { ${mergedElements.join(', ')} }; `;
    } else {
      const indentMatch = block.body.match(/\n([ \t]+)\S/);
      const indent = indentMatch ? indentMatch[1] : '    ';
      const closingMatch = block.body.match(/\n([ \t]*)$/);
      const closingIndent = closingMatch ? closingMatch[1] : '  ';
      newBody = `${block.body.trimEnd()}\n${indent}elements = { ${mergedElements.join(', ')} }\n${closingIndent}`;
    }

    result = result.slice(0, block.openBraceIndex + 1) + newBody + result.slice(block.closeBraceIndex);
  }
  return result;
}

export function preserveCrowdsecSetElements(candidateContent, liveRulesetText) {
  if (!candidateContent || typeof candidateContent !== 'string') return candidateContent;
  if (!liveRulesetText || typeof liveRulesetText !== 'string') return candidateContent;

  const ipv4Elements = extractSetElements(liveRulesetText, 'crowdsec-blacklists');
  const ipv6Elements = extractSetElements(liveRulesetText, 'crowdsec6-blacklists');

  let updated = candidateContent;

  if (ipv4Elements.length > 0) {
    const candidateIpv4 = extractSetElements(candidateContent, 'crowdsec-blacklists');
    const mergedIpv4 = [...new Set([...candidateIpv4, ...ipv4Elements])];
    updated = updateSetWithElements(updated, 'crowdsec-blacklists', mergedIpv4);
  }

  if (ipv6Elements.length > 0) {
    const candidateIpv6 = extractSetElements(candidateContent, 'crowdsec6-blacklists');
    const mergedIpv6 = [...new Set([...candidateIpv6, ...ipv6Elements])];
    updated = updateSetWithElements(updated, 'crowdsec6-blacklists', mergedIpv6);
  }

  return updated;
}

export function sanitizeManagedRuleset(content, {
  tableName = MANAGED_FIREWALL_TABLE,
  family = MANAGED_FIREWALL_FAMILY,
} = {}) {
  if (typeof content !== 'string') return content;

  let sanitized = content;

  // 1. Remove any global flush ruleset lines
  sanitized = sanitized.replace(/^[ \t]*flush[ \t]+ruleset[ \t]*(?:;[ \t]*)?(?:#[^\n]*)?$/gm, '');

  // 2. Identify target table: use specified tableName if present, or detect first table
  let targetTable = tableName;
  let targetFamily = family;
  const detected = detectTableNames(sanitized);
  const foundExplicit = detected.find((t) => t.name === tableName && t.family === family);
  if (!foundExplicit && detected.length > 0) {
    targetTable = detected[0].name;
    targetFamily = detected[0].family;
  }

  // 3. Ensure targeted table initialization and deletion before the table definition
  const deleteTableRegex = new RegExp(`delete\\s+table\\s+${targetFamily}\\s+${targetTable}\\b`, 'i');
  if (!deleteTableRegex.test(sanitized)) {
    const tableDefRegex = new RegExp(`(^|[\\n;])([ \\t]*table\\s+${targetFamily}\\s+${targetTable}\\s*\\{)`, 'i');
    const match = sanitized.match(tableDefRegex);
    if (match) {
      const idx = match.index + match[1].length;
      const prefix = sanitized.slice(0, idx);
      const rest = sanitized.slice(idx);
      const scopedReset = `table ${targetFamily} ${targetTable}\ndelete table ${targetFamily} ${targetTable}\n`;
      sanitized = `${prefix}${scopedReset}${rest}`;
    }
  }

  // 4. Clean up leading blank lines
  sanitized = sanitized.replace(/^(\s*[\r\n]){2,}/, '\n');

  return sanitized.trim() + '\n';
}

export function verifyDockerCoexistence(candidateContent, {
  liveRuleset = null,
} = {}) {
  if (typeof candidateContent !== 'string') return Object.freeze({ verified: true, dockerProtected: true });

  // 1. Prohibit global flush ruleset (would flush Docker's iptables-nft tables)
  if (/^[ \t]*flush[ \t]+ruleset\b/m.test(candidateContent)) {
    throw new NftablesManagerError(
      'global_flush_prohibited',
      'Candidate ruleset uses "flush ruleset" which destroys Docker iptables/nftables tables, NAT, and network isolation.',
    );
  }

  // 2. Prohibit deleting Docker's own tables directly
  const deleteTableRegex = /delete\s+table\s+(?:ip|ip6)\s+(?:nat|filter)\b/gi;
  if (deleteTableRegex.test(candidateContent)) {
    throw new NftablesManagerError(
      'docker_table_interference',
      'Candidate ruleset explicitly deletes Docker tables. Docker coexistence requires leaving Docker tables untouched.',
    );
  }

  // 3. Verify Docker bridge interface traffic is permitted in forward chain
  const forwardBlocks = findNamedBlocks(candidateContent, 'chain', 'forward');
  for (const block of forwardBlocks) {
    const chainBody = block.body;
    const hasDocker0 = /iifname\s+"docker0"\s+accept/i.test(chainBody) || /oifname\s+"docker0"\s+accept/i.test(chainBody);
    const hasBr = /iifname\s+"br-\*"\s+accept/i.test(chainBody) || /oifname\s+"br-\*"\s+accept/i.test(chainBody);

    if (!hasDocker0 || !hasBr) {
      throw new NftablesManagerError(
        'docker_interface_isolation_risk',
        'Candidate forward chain does not permit traffic for Docker bridge interfaces ("docker0" and "br-*"). Container access and networking would be blocked.',
      );
    }
  }

  return Object.freeze({
    verified: true,
    dockerProtected: true,
    bridgeInterfacesAllowed: true,
  });
}

export function verifyCrowdsecCoexistence(candidateContent, {
  liveRuleset = null,
} = {}) {
  if (typeof candidateContent !== 'string') return Object.freeze({ verified: true, crowdsecProtected: true });

  // 1. Prohibit global flush ruleset (would flush CrowdSec's table / sets)
  if (/^[ \t]*flush[ \t]+ruleset\b/m.test(candidateContent)) {
    throw new NftablesManagerError(
      'global_flush_prohibited',
      'Candidate ruleset uses "flush ruleset" which wipes CrowdSec bouncer tables, sets, and active blocklists.',
    );
  }

  // 2. Prohibit deleting CrowdSec's own tables directly
  if (/delete\s+table\s+(?:inet|ip|ip6)\s+crowdsec\b/i.test(candidateContent)) {
    throw new NftablesManagerError(
      'crowdsec_table_interference',
      'Candidate ruleset explicitly deletes CrowdSec tables. CrowdSec coexistence requires leaving CrowdSec tables untouched.',
    );
  }

  // 3. In table inet yunpanel, verify CrowdSec sets and early drop rules exist
  if (/table\s+inet\s+yunpanel\b/i.test(candidateContent)) {
    const hasIpv4Set = /set\s+crowdsec-blacklists\b/i.test(candidateContent);
    const hasIpv6Set = /set\s+crowdsec6-blacklists\b/i.test(candidateContent);
    const hasIpv4Drop = /ip\s+saddr\s+@crowdsec-blacklists\s+drop/i.test(candidateContent);
    const hasIpv6Drop = /ip6\s+saddr\s+@crowdsec6-blacklists\s+drop/i.test(candidateContent);

    if (!hasIpv4Set || !hasIpv6Set || !hasIpv4Drop || !hasIpv6Drop) {
      throw new NftablesManagerError(
        'crowdsec_integration_missing',
        'Candidate table inet yunpanel must define crowdsec-blacklists and crowdsec6-blacklists sets and early drop rules to maintain CrowdSec bouncer protection.',
      );
    }
  }

  return Object.freeze({
    verified: true,
    crowdsecProtected: true,
    setsPreserved: true,
  });
}

export async function inspectDockerFirewall({
  execFn = execFileSafe,
  nftPath = '/usr/sbin/nft',
} = {}) {
  let liveRuleset = '';
  try {
    const { stdout } = await execFn(nftPath, ['list', 'ruleset']);
    liveRuleset = stdout;
  } catch {
    liveRuleset = '';
  }

  const hasDockerIptables = /table\s+ip\s+filter\b/i.test(liveRuleset)
    || /chain\s+DOCKER\b/i.test(liveRuleset)
    || /chain\s+DOCKER-USER\b/i.test(liveRuleset);

  const hasDockerNat = /table\s+ip\s+nat\b/i.test(liveRuleset)
    && /chain\s+POSTROUTING\b/i.test(liveRuleset);

  const hasDockerBridgeForwarding = /iifname\s+"docker0"\s+accept/i.test(liveRuleset)
    || /oifname\s+"docker0"\s+accept/i.test(liveRuleset)
    || /iifname\s+"br-\*"\s+accept/i.test(liveRuleset)
    || /oifname\s+"br-\*"\s+accept/i.test(liveRuleset);

  const dockerDetected = hasDockerIptables || hasDockerNat || hasDockerBridgeForwarding;

  return Object.freeze({
    dockerDetected,
    hasDockerIptables,
    hasDockerNat,
    hasDockerBridgeForwarding,
    tablesProtected: true,
    bridgeInterfaces: DOCKER_BRIDGE_INTERFACES,
  });
}

export async function inspectCrowdsecFirewall({
  execFn = execFileSafe,
  nftPath = '/usr/sbin/nft',
  systemctlPath = '/bin/systemctl',
} = {}) {
  let liveRuleset = '';
  try {
    const { stdout } = await execFn(nftPath, ['list', 'ruleset']);
    liveRuleset = stdout;
  } catch {
    liveRuleset = '';
  }

  let bouncerActive = false;
  try {
    const { stdout } = await execFn(systemctlPath, ['is-active', 'crowdsec-firewall-bouncer']);
    bouncerActive = stdout.trim() === 'active';
  } catch {
    bouncerActive = false;
  }

  const hasCrowdsecTable = /table\s+(?:ip|ip6|inet)\s+crowdsec\b/i.test(liveRuleset);
  const hasCrowdsecSets = /set\s+crowdsec(?:6)?-blacklists/i.test(liveRuleset);
  const ipv4Bans = extractSetElements(liveRuleset, 'crowdsec-blacklists');
  const ipv6Bans = extractSetElements(liveRuleset, 'crowdsec6-blacklists');

  return Object.freeze({
    bouncerActive,
    hasCrowdsecTable,
    hasCrowdsecSets,
    bannedIpsCount: ipv4Bans.length + ipv6Bans.length,
    ipv4Bans: Object.freeze(ipv4Bans),
    ipv6Bans: Object.freeze(ipv6Bans),
    earlyDropActive: /ip\s+saddr\s+@crowdsec-blacklists\s+drop/i.test(liveRuleset),
  });
}

export function migrateRulesetToManagedScope(rulesetContent, {
  tableName = MANAGED_FIREWALL_TABLE,
  family = MANAGED_FIREWALL_FAMILY,
  liveRuleset = null,
} = {}) {
  if (typeof rulesetContent !== 'string' || !rulesetContent.trim()) {
    throw new NftablesManagerError('invalid_candidate', 'Ruleset content to migrate cannot be empty');
  }

  const hadGlobalFlush = /^[ \t]*flush[ \t]+ruleset\b/m.test(rulesetContent);

  // 1. Sanitize to managed scope
  let migrated = sanitizeManagedRuleset(rulesetContent, { tableName, family });

  // 2. Preserve CrowdSec elements if live ruleset is provided
  if (liveRuleset) {
    migrated = preserveCrowdsecSetElements(migrated, liveRuleset);
  }

  // 3. Verify Docker and CrowdSec coexistence
  verifyDockerCoexistence(migrated);
  verifyCrowdsecCoexistence(migrated);

  return Object.freeze({
    migratedContent: migrated,
    hadGlobalFlush,
    globalFlushEliminated: hadGlobalFlush,
    managedTable: tableName,
    managedFamily: family,
    sha256: computeSha256(migrated),
  });
}

export async function checkSystemdService(serviceName, {
  systemctlPath = '/bin/systemctl',
  execFn = execFileSafe,
} = {}) {
  let active = false;
  let enabled = false;
  let activeState = 'unknown';
  let unitFileState = 'unknown';
  let verified = false;
  let error = null;

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
    const stdoutTrimmed = (err.stdout || err.message || '').trim();
    if (stdoutTrimmed === 'active') {
      active = true;
      activeState = 'active';
      verified = true;
    } else if (['inactive', 'failed'].includes(stdoutTrimmed) || /inactive|disabled|failed/i.test(stdoutTrimmed)) {
      active = false;
      activeState = stdoutTrimmed;
      verified = true;
    } else {
      active = false;
      activeState = 'unknown';
      verified = false;
      error = err.message;
    }
  }

  try {
    const { stdout } = await execFn(systemctlPath, ['is-enabled', serviceName]);
    const trimmed = (stdout || '').trim();
    unitFileState = trimmed || 'unknown';
    if (trimmed === 'enabled') {
      enabled = true;
      verified = true;
    } else if (['disabled', 'masked', 'static', 'indirect', 'generated', 'transient'].includes(trimmed)) {
      enabled = false;
      verified = true;
    } else if (trimmed === '' || trimmed === 'inactive') {
      enabled = false;
      unitFileState = 'disabled';
      verified = true;
    } else {
      if (!error) error = `Unrecognized is-enabled state: ${trimmed}`;
    }
  } catch (err) {
    const stdoutTrimmed = (err.stdout || err.message || '').trim();
    if (stdoutTrimmed === 'enabled') {
      enabled = true;
      unitFileState = 'enabled';
      verified = true;
    } else if (['disabled', 'masked', 'static'].includes(stdoutTrimmed) || /disabled|inactive|failed/i.test(stdoutTrimmed)) {
      enabled = false;
      unitFileState = stdoutTrimmed;
      verified = true;
    } else {
      enabled = false;
      unitFileState = 'unknown';
      if (!error) error = err.message;
    }
  }

  const status = error ? 'error' : (active && enabled ? 'active' : (active ? 'running_not_enabled' : (enabled ? 'enabled_not_running' : 'inactive')));

  return Object.freeze({
    serviceName,
    active,
    enabled,
    activeState,
    unitFileState,
    verified,
    status,
    error,
  });
}

export async function inspectConflictingFirewalls({
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

  // Check UFW binary presence
  try {
    await statFn(ufwPath);
    ufwInstalled = true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      ufwInstalled = false;
    } else {
      ufwInstalled = 'unknown';
      ufwError = `Failed to stat UFW binary: ${err.message}`;
    }
  }

  if (ufwInstalled === true) {
    const ufwService = await checkSystemdService('ufw', { systemctlPath, execFn });
    ufwServiceActive = ufwService.active;
    try {
      const { stdout } = await execFn(ufwPath, ['status']);
      if (typeof stdout === 'string') {
        if (/status:\s*active/i.test(stdout)) {
          ufwStatusActive = true;
          ufwStatus = 'active';
        } else if (/status:\s*inactive/i.test(stdout)) {
          ufwStatusActive = false;
          ufwStatus = 'inactive';
        } else {
          ufwStatusActive = 'unknown';
          ufwStatus = 'unknown';
          ufwError = `Unrecognized ufw status output: ${stdout.trim()}`;
        }
      } else {
        ufwStatusActive = 'unknown';
        ufwStatus = 'unknown';
        ufwError = 'Empty or non-string ufw status output';
      }
    } catch (err) {
      ufwStatusActive = 'unknown';
      ufwStatus = 'error';
      ufwError = `Failed to execute ufw status: ${err.message}`;
    }
  } else if (ufwInstalled === 'unknown') {
    ufwStatusActive = 'unknown';
    ufwStatus = 'error';
  }

  // Check firewalld service
  try {
    const firewalldService = await checkSystemdService('firewalld', { systemctlPath, execFn });
    if (firewalldService.error && !firewalldService.verified) {
      firewalldInstalled = 'unknown';
      firewalldActive = 'unknown';
      firewalldStatus = 'error';
      firewalldError = firewalldService.error;
    } else {
      firewalldInstalled = firewalldService.active || firewalldService.enabled;
      firewalldActive = firewalldService.active;
      firewalldStatus = firewalldService.active ? 'active' : 'inactive';
    }
  } catch (err) {
    firewalldInstalled = 'unknown';
    firewalldActive = 'unknown';
    firewalldStatus = 'error';
    firewalldError = err.message;
  }

  const conflictDetected = ufwStatusActive === true || firewalldActive === true;
  let conflictStatus = 'none';
  if (conflictDetected) {
    conflictStatus = 'conflict';
  } else if (ufwStatus === 'error' || firewalldStatus === 'error' || ufwStatusActive === 'unknown' || firewalldActive === 'unknown') {
    conflictStatus = 'unknown';
  }

  const errors = [ufwError, firewalldError].filter(Boolean);
  const error = errors.length > 0 ? errors.join('; ') : null;

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
    error,
  });
}

export async function getLiveRuleset({
  nftPath = '/usr/sbin/nft',
  execFn = execFileSafe,
  requireSnapshot = false,
} = {}) {
  try {
    const { stdout } = await execFn(nftPath, ['list', 'ruleset']);
    return stdout;
  } catch (error) {
    if (requireSnapshot) {
      throw new NftablesManagerError(
        'ruleset_snapshot_failed',
        `Failed to snapshot live nftables ruleset: ${error.stderr || error.stdout || error.message}`,
      );
    }
    return null;
  }
}

export function parseRulesetMetadata(rulesetText, readError = null) {
  if (readError !== null || rulesetText === null) {
    return Object.freeze({
      loaded: 'unknown',
      tableNames: [],
      hasYunpanelTable: false,
      hasCrowdsecSets: false,
      status: 'error',
      error: readError || 'Ruleset read failed or ruleset is unavailable',
    });
  }

  if (typeof rulesetText !== 'string' || rulesetText.trim() === '') {
    return Object.freeze({
      loaded: false,
      tableNames: [],
      hasYunpanelTable: false,
      hasCrowdsecSets: false,
      status: 'empty',
      error: null,
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
    status: tableNames.length > 0 ? 'loaded' : 'empty',
    error: null,
  });
}

export function createNftablesManager({
  nftPath = '/usr/sbin/nft',
  configPath = nftablesTemplatePolicy.configPath,
  systemctlPath = '/bin/systemctl',
  ufwPath = '/usr/sbin/ufw',
  ssPath = '/usr/bin/ss',
  sshdConfigPath = '/etc/ssh/sshd_config',
  defaultSshPort = undefined,
  defaultSshPorts = undefined,
  sshPort = undefined,
  sshPorts = undefined,
  standardPorts = undefined,
  readFileFn = readFile,
  writeFileFn = writeFile,
  renameFn = rename,
  chmodFn = chmod,
  rmFn = rm,
  statFn = stat,
  execFn = execFileSafe,
} = {}) {
  const initialPortInput = defaultSshPorts ?? sshPorts ?? defaultSshPort ?? sshPort
    ?? standardPorts?.ssh ?? nftablesTemplatePolicy.defaultSshPort ?? nftablesTemplatePolicy.standardPorts?.ssh;

  const resolvedDefaultSshPorts = normalizeSshPorts(initialPortInput, [RESOLVED_DEFAULT_SSH_PORT]);
  const resolvedDefaultSshPort = resolvedDefaultSshPorts[0];

  const checkService = (serviceName, opts = {}) => checkSystemdService(serviceName, { systemctlPath, execFn, ...opts });
  const inspectConflicts = (opts = {}) => inspectConflictingFirewalls({ ufwPath, systemctlPath, statFn, execFn, ...opts });
  const getRuleset = (options = {}) => {
    const { requireSnapshot = false } = (typeof options === 'boolean' ? { requireSnapshot: options } : options);
    return getLiveRuleset({ nftPath, execFn, requireSnapshot });
  };

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

    const serviceStatus = await checkService('nftables');
    const conflictingFirewalls = await inspectConflicts();
    let liveRuleset = null;
    let rulesetReadError = null;
    try {
      const { stdout } = await execFn(nftPath, ['list', 'ruleset']);
      liveRuleset = stdout;
    } catch (err) {
      rulesetReadError = err.message;
    }
    const rulesetMetadata = parseRulesetMetadata(liveRuleset, rulesetReadError);
    const dockerFirewall = await inspectDockerFirewall({ execFn, nftPath });
    const crowdsecFirewall = await inspectCrowdsecFirewall({ execFn, nftPath, systemctlPath });

    const managedBoundary = Object.freeze({
      table: MANAGED_FIREWALL_TABLE,
      family: MANAGED_FIREWALL_FAMILY,
      scope: `${MANAGED_FIREWALL_FAMILY} ${MANAGED_FIREWALL_TABLE}`,
      managedTablesPresent: rulesetMetadata.hasYunpanelTable,
      prohibitsGlobalFlush: true,
      dockerProtected: dockerFirewall.tablesProtected,
      crowdsecProtected: true,
    });

    let sshListeners;
    try {
      sshListeners = await inspectSshListeners({
        ssPath,
        sshdConfigPath,
        execFn,
        readFileFn,
        defaultSshPort: resolvedDefaultSshPort,
      });
    } catch {
      sshListeners = Object.freeze({
        satisfied: false,
        binaryPath: ssPath,
        listeners: Object.freeze([]),
        ports: Object.freeze(resolvedDefaultSshPorts),
        hasIpv4: true,
        hasIpv6: true,
        dualStack: true,
      });
    }

    const statusInspector = createFirewallStatusInspector({
      nftPath,
      configPath,
      systemctlPath,
      ufwPath,
      execFn,
      statFn,
      readFileFn,
    });
    let firewallStatus = null;
    try {
      firewallStatus = await statusInspector.inspectStatus();
    } catch {
      firewallStatus = null;
    }

    return Object.freeze({
      satisfied,
      binaryPath: nftPath,
      version,
      serviceStatus: Object.freeze(serviceStatus),
      conflictingFirewalls,
      dockerFirewall,
      crowdsecFirewall,
      managedBoundary,
      ruleset: rulesetMetadata,
      sshListeners,
      firewallStatus,
      defaultSshPort: resolvedDefaultSshPort,
      defaultSshPorts: resolvedDefaultSshPorts,
    });
  }

  async function validateRulesetCandidate(candidateContent, {
    allowedSshPort = undefined,
    allowedSshPorts = undefined,
    sshPort = undefined,
    sshPorts = undefined,
    listeners = null,
    verifyListeners = false,
  } = {}) {
    if (typeof candidateContent !== 'string' || !candidateContent.trim()) {
      throw new NftablesManagerError('invalid_candidate', 'Candidate ruleset content cannot be empty');
    }

    // 1. Prohibit global flush ruleset (Acceptance Criterion 1)
    if (/^[ \t]*flush[ \t]+ruleset\b/m.test(candidateContent)) {
      throw new NftablesManagerError(
        'global_flush_prohibited',
        'Candidate ruleset uses "flush ruleset" which violates YunPanel managed resource boundary and destroys Docker/CrowdSec rules.',
      );
    }

    // 2. Verify Docker and CrowdSec coexistence (Acceptance Criteria 2 & 3)
    verifyDockerCoexistence(candidateContent);
    verifyCrowdsecCoexistence(candidateContent);

    const explicitPortInput = allowedSshPorts ?? sshPorts ?? allowedSshPort ?? sshPort;
    const targetPorts = normalizeSshPorts(explicitPortInput, resolvedDefaultSshPorts);

    // 3. Check lockout prevention
    if (verifyListeners) {
      await verifySshListenerContract(candidateContent, {
        listeners,
        allowedSshPorts: targetPorts,
        execFn,
        readFileFn,
        defaultSshPort: resolvedDefaultSshPort,
      });
    } else {
      assertSshPortsAllowed(candidateContent, targetPorts);
    }

    // 4. Syntax check via nft -c -f
    const tempPath = `/tmp/nftables-check.${process.pid}.${randomBytes(6).toString('hex')}.nft`;
    try {
      await writeFileFn(tempPath, candidateContent, { encoding: 'utf8', mode: 0o600 });
      await execFn(nftPath, ['-c', '-f', tempPath]);
      return Object.freeze({
        valid: true,
        allowedSshPort: targetPorts[0],
        allowedSshPorts: targetPorts,
        sshPort: targetPorts[0],
        sshPorts: targetPorts,
      });
    } catch (error) {
      if (error instanceof NftablesManagerError) {
        throw error;
      }
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
    allowedSshPort = undefined,
    allowedSshPorts = undefined,
    sshPort = undefined,
    sshPorts = undefined,
    renderOptions = {},
    forceConflictOverride = false,
    persist = true,
    enableService = true,
    verifyListeners = false,
    requireSnapshot = true,
    requireServiceVerification = false,
  } = {}) {
    // 1. Check conflicting firewalls
    const conflicts = await inspectConflicts();
    if (conflicts.conflictDetected && !forceConflictOverride) {
      throw new NftablesManagerError(
        'conflicting_firewall_detected',
        'Conflicting firewall (UFW or firewalld) is currently active. UFW must be disabled to ensure nftables remains the single firewall authority.',
      );
    }
    if (conflicts.conflictStatus === 'unknown' && !forceConflictOverride) {
      throw new NftablesManagerError(
        'conflicting_firewall_unknown',
        `Cannot reliably verify conflicting firewalls (UFW/firewalld read error: ${conflicts.error || 'unknown error'}). Aborting to fail-closed.`,
      );
    }

    // 2. Resolve SSH ports from all supported aliases
    const explicitPortInput = allowedSshPorts ?? sshPorts ?? allowedSshPort ?? sshPort
      ?? renderOptions.sshPorts ?? renderOptions.sshPort;
    const targetPorts = normalizeSshPorts(explicitPortInput, resolvedDefaultSshPorts);

    // 3. Snapshot current ruleset for element preservation and scoped rollback (AC-4 fail-closed)
    let currentRuleset = null;
    try {
      currentRuleset = await getRuleset({ requireSnapshot: true });
    } catch (snapshotError) {
      if (requireSnapshot !== false) {
        throw new NftablesManagerError(
          'ruleset_snapshot_failed',
          `Failed to snapshot current ruleset before applying changes: ${snapshotError.message}`,
        );
      }
    }
    const backupRulesetSha256 = currentRuleset ? computeSha256(currentRuleset) : null;

    // 4. Resolve candidate content
    let contentToApply = candidateContent;
    if (!contentToApply) {
      const rendered = renderNftablesConfig({
        ...renderOptions,
        sshPorts: targetPorts,
      });
      // Sanitize rendered template to remove any global flush ruleset and enforce managed table scope
      contentToApply = sanitizeManagedRuleset(rendered);
    }

    // 5. If live ruleset has active CrowdSec bans and candidate defines crowdsec sets, preserve them
    if (currentRuleset) {
      contentToApply = preserveCrowdsecSetElements(contentToApply, currentRuleset);
    }

    // 6. Validate candidate (rejection of global flush, coexistence, lockout + syntax)
    await validateRulesetCandidate(contentToApply, {
      allowedSshPorts: targetPorts,
      verifyListeners,
    });

    // 7. Apply live within managed scope
    const tempPath = `/tmp/nftables-apply.${process.pid}.${randomBytes(6).toString('hex')}.nft`;
    try {
      await writeFileFn(tempPath, contentToApply, { encoding: 'utf8', mode: 0o600 });
      await execFn(nftPath, ['-f', tempPath]);
    } catch (applyError) {
      // Scoped rollback immediately if backup exists
      if (currentRuleset && currentRuleset.trim()) {
        try {
          const rollbackScoped = sanitizeManagedRuleset(currentRuleset);
          const rollbackTemp = `/tmp/nftables-rollback.${process.pid}.${randomBytes(6).toString('hex')}.nft`;
          await writeFileFn(rollbackTemp, rollbackScoped, { encoding: 'utf8', mode: 0o600 });
          await execFn(nftPath, ['-f', rollbackTemp]);
          try { await rmFn(rollbackTemp, { force: true }); } catch {}
        } catch {}
      } else {
        try {
          const cleanupScript = `table ${MANAGED_FIREWALL_FAMILY} ${MANAGED_FIREWALL_TABLE}\ndelete table ${MANAGED_FIREWALL_FAMILY} ${MANAGED_FIREWALL_TABLE}\n`;
          const rollbackTemp = `/tmp/nftables-rollback.${process.pid}.${randomBytes(6).toString('hex')}.nft`;
          await writeFileFn(rollbackTemp, cleanupScript, { encoding: 'utf8', mode: 0o600 });
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

    // 8. Persist to /etc/nftables.conf if requested
    if (persist) {
      await atomicWrite(configPath, contentToApply, 0o755);
    }

    // 9. Enable and start nftables.service if requested (only when persisted)
    // AC-4: Failed service operations must NOT be swallowed!
    if (enableService && persist) {
      try {
        await execFn(systemctlPath, ['enable', 'nftables']);
      } catch (svcError) {
        throw new NftablesManagerError(
          'service_operation_failed',
          `Failed to enable nftables service: ${svcError.stderr || svcError.stdout || svcError.message}`,
        );
      }
      try {
        await execFn(systemctlPath, ['start', 'nftables']);
      } catch (svcError) {
        throw new NftablesManagerError(
          'service_operation_failed',
          `Failed to start nftables service: ${svcError.stderr || svcError.stdout || svcError.message}`,
        );
      }
    }

    // 10. AC-1: Obtain verified systemd service evidence
    const verifiedService = await checkService('nftables');
    if (requireServiceVerification && (!verifiedService.verified || !verifiedService.enabled)) {
      throw new NftablesManagerError(
        'service_verification_failed',
        `Systemd service verification failed after enable/start: ${verifiedService.error || `unit is not enabled (state: ${verifiedService.unitFileState})`}`,
      );
    }

    // 11. AC-3: Independent reports for live apply, persistent file, boot loading, and CrowdSec bouncer
    const statusInspector = createFirewallStatusInspector({
      nftPath,
      configPath,
      systemctlPath,
      ufwPath,
      execFn,
      statFn,
      readFileFn,
    });
    let liveApplyReport = null;
    let persistentFileReport = null;
    let bootLoadingReport = null;
    let crowdsecBouncerReport = null;
    let firewallStatus = null;
    try {
      firewallStatus = await statusInspector.inspectStatus({ expectedContent: contentToApply });
      liveApplyReport = firewallStatus.liveApply;
      persistentFileReport = firewallStatus.persistentFile;
      bootLoadingReport = firewallStatus.bootLoading;
      crowdsecBouncerReport = firewallStatus.crowdsecBouncer;
    } catch {
      bootLoadingReport = verifiedService;
    }

    return Object.freeze({
      success: true,
      appliedAt: new Date().toISOString(),
      appliedRulesetSha256: computeSha256(contentToApply),
      backupRulesetSha256,
      persisted: persist,
      // AC-1: serviceEnabled is derived STRICTLY from verified systemd evidence, never request option
      serviceEnabled: verifiedService.enabled,
      serviceActive: verifiedService.active,
      systemdEvidence: verifiedService,
      // AC-3: Independent reports
      liveApply: liveApplyReport,
      persistentFile: persistentFileReport,
      bootLoading: bootLoadingReport,
      crowdsecBouncer: crowdsecBouncerReport,
      firewallStatus,
      allowedSshPort: targetPorts[0],
      allowedSshPorts: targetPorts,
      sshPort: targetPorts[0],
      sshPorts: targetPorts,
      managedBoundary: Object.freeze({
        table: MANAGED_FIREWALL_TABLE,
        family: MANAGED_FIREWALL_FAMILY,
        scope: `${MANAGED_FIREWALL_FAMILY} ${MANAGED_FIREWALL_TABLE}`,
      }),
    });
  }

  async function rollbackRuleset(previousRuleset, { persist = true } = {}) {
    if (!previousRuleset || typeof previousRuleset !== 'string' || !previousRuleset.trim()) {
      // If previous ruleset is empty, delete ONLY the YunPanel-managed table
      // NEVER execute global flush ruleset (which would wipe Docker / CrowdSec tables)
      const tempPath = `/tmp/nftables-rollback.${process.pid}.${randomBytes(6).toString('hex')}.nft`;
      const cleanupScript = `table ${MANAGED_FIREWALL_FAMILY} ${MANAGED_FIREWALL_TABLE}\ndelete table ${MANAGED_FIREWALL_FAMILY} ${MANAGED_FIREWALL_TABLE}\n`;
      try {
        await writeFileFn(tempPath, cleanupScript, { encoding: 'utf8', mode: 0o600 });
        await execFn(nftPath, ['-f', tempPath]);
      } catch {
        // Table might not exist, ignore
      } finally {
        try { await rmFn(tempPath, { force: true }); } catch {}
      }
      return Object.freeze({
        success: true,
        rolledBack: true,
        flushed: false,
        tableDeleted: true,
        managedBoundary: Object.freeze({
          table: MANAGED_FIREWALL_TABLE,
          family: MANAGED_FIREWALL_FAMILY,
        }),
      });
    }

    // Ensure candidate to restore is strictly scoped to managed table and strips any global flush ruleset
    let contentToRestore = sanitizeManagedRuleset(previousRuleset);

    // If live ruleset has CrowdSec bans, preserve them during rollback too
    const currentRuleset = await getRuleset();
    if (currentRuleset) {
      contentToRestore = preserveCrowdsecSetElements(contentToRestore, currentRuleset);
    }

    const tempPath = `/tmp/nftables-rollback.${process.pid}.${randomBytes(6).toString('hex')}.nft`;
    try {
      await writeFileFn(tempPath, contentToRestore, { encoding: 'utf8', mode: 0o600 });
      await execFn(nftPath, ['-f', tempPath]);
      if (persist) {
        await atomicWrite(configPath, contentToRestore, 0o755);
      }
      return Object.freeze({
        success: true,
        rolledBack: true,
        rulesetSha256: computeSha256(contentToRestore),
        managedBoundary: Object.freeze({
          table: MANAGED_FIREWALL_TABLE,
          family: MANAGED_FIREWALL_FAMILY,
        }),
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

  async function migrateFirewallConfiguration({
    configPathOverride = null,
    applyLive = false,
    persist = true,
  } = {}) {
    const targetConfigPath = configPathOverride ?? configPath;
    let existingContent = '';
    try {
      existingContent = await readFileFn(targetConfigPath, 'utf8');
    } catch {
      existingContent = '';
    }

    const liveRuleset = await getRuleset();
    const sourceContent = existingContent.trim() ? existingContent : (liveRuleset?.trim() ? liveRuleset : '');

    if (!sourceContent) {
      return Object.freeze({
        migrated: false,
        reason: 'no_existing_ruleset',
      });
    }

    const migrationResult = migrateRulesetToManagedScope(sourceContent, {
      tableName: MANAGED_FIREWALL_TABLE,
      family: MANAGED_FIREWALL_FAMILY,
      liveRuleset,
    });

    let applied = false;
    if (applyLive) {
      await applyRuleset({
        candidateContent: migrationResult.migratedContent,
        persist,
      });
      applied = true;
    } else if (persist) {
      await atomicWrite(targetConfigPath, migrationResult.migratedContent, 0o755);
    }

    return Object.freeze({
      migrated: true,
      globalFlushEliminated: migrationResult.globalFlushEliminated,
      hadGlobalFlush: migrationResult.hadGlobalFlush,
      appliedLive: applied,
      persisted: persist,
      configPath: targetConfigPath,
      sha256: migrationResult.sha256,
      migratedContent: migrationResult.migratedContent,
    });
  }

  return Object.freeze({
    inspectNftables,
    inspectFirewallStatus: (opts) => inspectFirewallStatus({
      nftPath,
      configPath,
      systemctlPath,
      ufwPath,
      execFn,
      statFn,
      readFileFn,
      ...opts,
    }),
    inspectStatus: (opts) => inspectFirewallStatus({
      nftPath,
      configPath,
      systemctlPath,
      ufwPath,
      execFn,
      statFn,
      readFileFn,
      ...opts,
    }),
    validateRulesetCandidate,
    applyRuleset,
    rollbackRuleset,
    getLiveRuleset: getRuleset,
    migrateFirewallConfiguration,
    inspectConflictingFirewalls: inspectConflicts,
    checkSystemdService: checkService,
    parseRulesetMetadata,
    inspectDockerFirewall: () => inspectDockerFirewall({ execFn, nftPath }),
    inspectCrowdsecFirewall: () => inspectCrowdsecFirewall({ execFn, nftPath, systemctlPath }),
    verifyDockerCoexistence: (candidate, opts) => verifyDockerCoexistence(candidate, opts),
    verifyCrowdsecCoexistence: (candidate, opts) => verifyCrowdsecCoexistence(candidate, opts),
    inspectSshListeners: (opts) => inspectSshListeners({
      ssPath,
      sshdConfigPath,
      execFn,
      readFileFn,
      defaultSshPort: resolvedDefaultSshPort,
      ...opts,
    }),
    verifySshListenerContract: (candidate, opts) => verifySshListenerContract(candidate, {
      ssPath,
      sshdConfigPath,
      execFn,
      readFileFn,
      defaultSshPort: resolvedDefaultSshPort,
      ...opts,
    }),
    assertSshPortAllowed: (candidate, port, opts) => assertSshPortAllowed(candidate, port, opts),
    assertSshPortsAllowed: (candidate, ports, opts) => assertSshPortsAllowed(candidate, ports, opts),
    managedTable: MANAGED_FIREWALL_TABLE,
    managedFamily: MANAGED_FIREWALL_FAMILY,
    configPath,
    defaultSshPort: resolvedDefaultSshPort,
    defaultSshPorts: resolvedDefaultSshPorts,
    standardPorts: nftablesTemplatePolicy.standardPorts,
  });
}

export const nftablesManagerInternals = Object.freeze({
  RESOLVED_DEFAULT_SSH_PORT,
  MANAGED_FIREWALL_TABLE,
  MANAGED_FIREWALL_FAMILY,
  DOCKER_BRIDGE_INTERFACES,
  CROWDSEC_SET_NAMES,
  normalizeSshPorts,
  inspectPortCoverageInRuleset,
  assertSshPortAllowed,
  assertSshPortsAllowed,
  inspectSshListeners,
  verifySshListenerContract,
  detectTableNames,
  findNamedBlocks,
  extractSetElements,
  preserveCrowdsecSetElements,
  sanitizeManagedRuleset,
  verifyDockerCoexistence,
  verifyCrowdsecCoexistence,
  inspectDockerFirewall,
  inspectCrowdsecFirewall,
  migrateRulesetToManagedScope,
  checkSystemdService,
  inspectConflictingFirewalls,
  getLiveRuleset,
  parseRulesetMetadata,
  execFileSafe,
  computeSha256,
});
