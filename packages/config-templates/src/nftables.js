import { createHash } from 'node:crypto';

export const nftablesTemplatePolicy = Object.freeze({
  configPath: '/etc/nftables.conf',
  configMode: 0o644,
  serviceUnit: 'nftables.service',
  tableName: 'yunpanel',
  standardPorts: Object.freeze({
    ssh: 22,
    http: 80,
    https: 443,
    dns: 53,
    smtp: 25,
    submission: 587,
    smtps: 465,
    imap: 143,
    imaps: 993,
  }),
});

export class NftablesTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NftablesTemplateError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function normalizePorts(ports, fieldName) {
  if (!Array.isArray(ports)) {
    throw new NftablesTemplateError('nftables_ports_invalid', `${fieldName} must be an array of port numbers`);
  }
  const normalized = [];
  for (const port of ports) {
    const num = Number(port);
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
      throw new NftablesTemplateError('nftables_port_invalid', `Port ${port} in ${fieldName} is not between 1 and 65535`);
    }
    normalized.push(num);
  }
  return [...new Set(normalized)].sort((a, b) => a - b);
}

export function renderNftablesConfig({
  sshPorts = [22],
  webPorts = [80, 443],
  dnsPorts = [53],
  mailPorts = [25, 143, 465, 587, 993],
  additionalTcpPorts = [],
  additionalUdpPorts = [],
} = {}) {
  const normalizedSsh = normalizePorts(sshPorts, 'sshPorts');
  if (normalizedSsh.length === 0) {
    throw new NftablesTemplateError(
      'nftables_ssh_port_required',
      'At least one SSH port must be specified to prevent lockout',
    );
  }
  const normalizedWeb = normalizePorts(webPorts, 'webPorts');
  const normalizedDns = normalizePorts(dnsPorts, 'dnsPorts');
  const normalizedMail = normalizePorts(mailPorts, 'mailPorts');
  const normalizedAddTcp = normalizePorts(additionalTcpPorts, 'additionalTcpPorts');
  const normalizedAddUdp = normalizePorts(additionalUdpPorts, 'additionalUdpPorts');

  const tcpPorts = [...new Set([
    ...normalizedSsh,
    ...normalizedWeb,
    ...normalizedDns,
    ...normalizedMail,
    ...normalizedAddTcp,
  ])].sort((a, b) => a - b);

  const udpPorts = [...new Set([
    ...normalizedDns,
    ...normalizedAddUdp,
  ])].sort((a, b) => a - b);

  const tcpPortsString = tcpPorts.join(', ');
  const udpPortsString = udpPorts.join(', ');

  return [
    '#!/usr/sbin/nft -f',
    '',
    '# Managed by YunPanel. Manual edits are overwritten.',
    'flush ruleset',
    '',
    'table inet yunpanel {',
    '    set crowdsec-blacklists {',
    '        type ipv4_addr',
    '        flags interval',
    '    }',
    '',
    '    set crowdsec6-blacklists {',
    '        type ipv6_addr',
    '        flags interval',
    '    }',
    '',
    '    chain input {',
    '        type filter hook input priority filter; policy drop;',
    '',
    '        # Early drop for CrowdSec blocklists',
    '        ip saddr @crowdsec-blacklists drop',
    '        ip6 saddr @crowdsec6-blacklists drop',
    '',
    '        # Established and related connections',
    '        ct state established,related accept',
    '        ct state invalid drop',
    '',
    '        # Loopback traffic',
    '        iif "lo" accept',
    '',
    '        # ICMP and ICMPv6',
    '        ip protocol icmp accept',
    '        ip6 nexthdr ipv6-icmp accept',
    '',
    `        # Allowed TCP ports (SSH, Web, DNS, Mail, Custom)`,
    `        tcp dport { ${tcpPortsString} } accept`,
    '',
    udpPorts.length > 0 ? `        # Allowed UDP ports (DNS, Custom)\n        udp dport { ${udpPortsString} } accept\n` : '',
    '    }',
    '',
    '    chain forward {',
    '        type filter hook forward priority filter; policy drop;',
    '    }',
    '',
    '    chain output {',
    '        type filter hook output priority filter; policy accept;',
    '    }',
    '}',
    '',
  ].filter(line => line !== null).join('\n');
}

export function previewNftablesConfiguration(options = {}) {
  const content = renderNftablesConfig(options);
  const digest = sha256(content);
  return Object.freeze({
    version: 1,
    sha256: digest,
    artifact: Object.freeze({
      path: nftablesTemplatePolicy.configPath,
      sha256: digest,
      bytes: Buffer.byteLength(content, 'utf8'),
      mode: nftablesTemplatePolicy.configMode,
      sensitive: false,
    }),
  });
}
