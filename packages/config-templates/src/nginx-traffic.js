import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeDomainSet } from '@yunpanel/shared';

export const YUNPANEL_TRAFFIC_LOG_PATH = '/var/log/nginx/yunpanel-site-traffic.log';
export const YUNPANEL_TRAFFIC_CONF_PATH = '/etc/nginx/conf.d/yunpanel-site-traffic.conf';
export const YUNPANEL_TRAFFIC_LOG_FORMAT = 'yunpanel_site_traffic';

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NginxTrafficTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NginxTrafficTemplateError';
    this.code = code;
  }
}

function assertSafeAbsolutePath(value, fieldName) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value)) {
    throw new NginxTrafficTemplateError('invalid_path', `${fieldName} must be a safe absolute POSIX path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '/' || normalized !== value || value.includes('/../') || value.endsWith('/..')) {
    throw new NginxTrafficTemplateError('invalid_path', `${fieldName} must not be root or contain traversal segments`);
  }
  return value;
}

function normalizeUuid(value, fieldName) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new NginxTrafficTemplateError(`invalid_${fieldName}`, `${fieldName} must be a valid UUID`);
  }
  return value.trim().toLowerCase();
}

function isAppliedDomain(domain, requireApplied) {
  if (domain.applied === false) return false;
  const rawState = domain.state ?? domain.status ?? null;
  if (requireApplied) return rawState === 'active';
  if (rawState !== null && rawState !== 'active') return false;
  return true;
}

export function renderNginxTrafficAccountingConfig({
  domains = [],
  blockedWebsiteIds = [],
  trafficLogPath = YUNPANEL_TRAFFIC_LOG_PATH,
  configPath = YUNPANEL_TRAFFIC_CONF_PATH,
  requireApplied = false,
} = {}) {
  const safeTrafficLogPath = assertSafeAbsolutePath(trafficLogPath, 'trafficLogPath');
  const safeConfigPath = assertSafeAbsolutePath(configPath, 'configPath');

  if (!Array.isArray(domains)) {
    throw new NginxTrafficTemplateError('invalid_domains', 'domains must be an array');
  }
  if (!Array.isArray(blockedWebsiteIds)) {
    throw new NginxTrafficTemplateError('invalid_blocked_website_ids', 'blockedWebsiteIds must be an array');
  }

  const hostToSiteId = new Map();
  const trackedSites = new Set();

  for (const domain of domains) {
    if (!domain || typeof domain !== 'object' || Array.isArray(domain)) {
      throw new NginxTrafficTemplateError('invalid_domain', 'Each domain entry must be an object');
    }
    if (!isAppliedDomain(domain, requireApplied)) {
      continue;
    }
    if (domain.websiteId === null || domain.websiteId === undefined || domain.websiteId === '') {
      continue;
    }
    const websiteId = normalizeUuid(domain.websiteId, 'website_id');
    let normalizedSet;
    try {
      normalizedSet = normalizeDomainSet(domain.primaryDomain, domain.aliases ?? []);
    } catch (error) {
      throw new NginxTrafficTemplateError('invalid_hostname', error.message || 'Domain hostname is invalid');
    }
    trackedSites.add(websiteId);
    for (const host of [normalizedSet.primary, ...normalizedSet.aliases]) {
      const existing = hostToSiteId.get(host);
      if (existing && existing !== websiteId) {
        throw new NginxTrafficTemplateError(
          'duplicate_traffic_hostname',
          `Hostname "${host}" cannot map to multiple Websites`,
        );
      }
      hostToSiteId.set(host, websiteId);
    }
  }

  const normalizedBlocked = [...new Set(
    blockedWebsiteIds.map((id) => normalizeUuid(id, 'blocked_website_id')),
  )].sort((a, b) => a.localeCompare(b));

  const sortedHosts = [...hostToSiteId.entries()].sort(([left], [right]) => left.localeCompare(right));
  const trackedWebsiteIds = [...trackedSites].sort((a, b) => a.localeCompare(b));

  const siteMapLines = [
    '  default "";',
    ...sortedHosts.map(([host, websiteId]) => `  "${host}" "${websiteId}";`),
  ];

  const blockedMapLines = [
    '  default 0;',
    ...normalizedBlocked.map((websiteId) => `  "${websiteId}" 1;`),
  ];

  const content = [
    '# Managed by YunPanel — monthly site outbound traffic accounting (no PII, no query string)',
    `log_format ${YUNPANEL_TRAFFIC_LOG_FORMAT} '$time_iso8601\\t$yunpanel_traffic_site_id\\t$body_bytes_sent';`,
    '',
    'map $server_name $yunpanel_traffic_site_id {',
    ...siteMapLines,
    '}',
    '',
    'map $yunpanel_traffic_site_id $yunpanel_traffic_log_enabled {',
    '  default 1;',
    '  "" 0;',
    '}',
    '',
    'map $yunpanel_traffic_site_id $yunpanel_traffic_blocked {',
    ...blockedMapLines,
    '}',
    '',
  ].join('\n');

  return Object.freeze({
    path: safeConfigPath,
    trafficLogPath: safeTrafficLogPath,
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    trackedHostCount: sortedHosts.length,
    trackedWebsiteIds: Object.freeze(trackedWebsiteIds),
    blockedWebsiteIds: Object.freeze(normalizedBlocked),
  });
}
