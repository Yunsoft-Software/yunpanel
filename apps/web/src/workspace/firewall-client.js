import { panelRequest } from '../api.js';

function firewallBasePath(serverId) {
  if (serverId && typeof serverId === 'string' && serverId !== 'local') {
    return `/servers/${encodeURIComponent(serverId)}/firewall`;
  }
  return '/firewall';
}

export async function fetchFirewallStatus(options = {}) {
  const base = firewallBasePath(options.serverId);
  return panelRequest(`${base}/status`, { signal: options.signal });
}

export async function fetchFirewallPorts(options = {}) {
  const base = firewallBasePath(options.serverId);
  return panelRequest(`${base}/ports`, { signal: options.signal });
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
  return panelRequest(`${base}/ports`, {
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
  return panelRequest(`${base}/ports/${encodeURIComponent(port)}?${q}`, {
    method: 'DELETE',
  });
}

export async function fetchServiceProfiles(options = {}) {
  const base = firewallBasePath(options.serverId);
  return panelRequest(`${base}/service-profiles`, { signal: options.signal });
}

export async function updateServiceProfiles({
  profiles,
  serverId = null,
} = {}) {
  const base = firewallBasePath(serverId);
  return panelRequest(`${base}/service-profiles`, {
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
  return panelRequest(`${base}/scan`, {
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
  return panelRequest(`${base}/bans`, { signal: options.signal });
}

export async function addCrowdsecBan({
  ip,
  duration = '4h',
  reason = 'Manuel engelleme',
  serverId = null,
} = {}) {
  const base = firewallBasePath(serverId);
  return panelRequest(`${base}/bans`, {
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
    return panelRequest(`${base}/bans/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  return panelRequest(`${base}/unban`, {
    method: 'POST',
    body: { ip },
  });
}
