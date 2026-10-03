import { requestJson } from '../session-client.js';

function firewallBasePath(serverId) {
  if (serverId && typeof serverId === 'string' && serverId !== 'local') {
    return `/api/servers/${encodeURIComponent(serverId)}/firewall`;
  }
  return '/api/firewall';
}

export async function fetchFirewallStatus(options = {}) {
  const base = firewallBasePath(options.serverId);
  return requestJson(`${base}/status`, { signal: options.signal });
}

export async function fetchFirewallPorts(options = {}) {
  const base = firewallBasePath(options.serverId);
  return requestJson(`${base}/ports`, { signal: options.signal });
}

export async function addFirewallPortRule({
  port,
  protocol = 'tcp',
  source = '0.0.0.0/0',
  policy = 'allow',
  serviceProfile = null,
  serverId = null,
} = {}) {
  const base = firewallBasePath(serverId);
  return requestJson(`${base}/ports`, {
    method: 'POST',
    body: {
      port: Number(port),
      protocol,
      source,
      policy,
      serviceProfile,
    },
  });
}

export async function removeFirewallPortRule({
  port,
  protocol = 'tcp',
  serverId = null,
} = {}) {
  const base = firewallBasePath(serverId);
  const q = new URLSearchParams({ protocol }).toString();
  return requestJson(`${base}/ports/${encodeURIComponent(port)}?${q}`, {
    method: 'DELETE',
  });
}

export async function fetchServiceProfiles(options = {}) {
  const base = firewallBasePath(options.serverId);
  return requestJson(`${base}/service-profiles`, { signal: options.signal });
}

export async function updateServiceProfiles({
  profiles,
  serverId = null,
} = {}) {
  const base = firewallBasePath(serverId);
  return requestJson(`${base}/service-profiles`, {
    method: 'PUT',
    body: { profiles },
  });
}

export async function scanFirewallPort({
  host = '127.0.0.1',
  port,
  protocol = 'tcp',
  timeoutMs = 3000,
  serverId = null,
} = {}) {
  const base = firewallBasePath(serverId);
  return requestJson(`${base}/scan`, {
    method: 'POST',
    body: {
      host,
      target: host,
      port: Number(port),
      protocol,
      timeoutMs,
    },
  });
}

export async function fetchCrowdsecBans(options = {}) {
  const base = firewallBasePath(options.serverId);
  return requestJson(`${base}/bans`, { signal: options.signal });
}

export async function addCrowdsecBan({
  ip,
  duration = '4h',
  reason = 'Manuel engelleme',
  serverId = null,
} = {}) {
  const base = firewallBasePath(serverId);
  return requestJson(`${base}/bans`, {
    method: 'POST',
    body: {
      ip,
      duration,
      reason,
      type: 'ban',
    },
  });
}

export async function removeCrowdsecBan({
  ip = null,
  id = null,
  serverId = null,
} = {}) {
  const base = firewallBasePath(serverId);
  if (id) {
    return requestJson(`${base}/bans/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  return requestJson(`${base}/unban`, {
    method: 'POST',
    body: { ip },
  });
}
