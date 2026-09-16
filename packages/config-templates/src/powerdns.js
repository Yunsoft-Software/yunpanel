import { isIP } from 'node:net';

const POLICY = Object.freeze({
  configPath: '/etc/powerdns/pdns.d/yunpanel.conf',
  includeDirectory: '/etc/powerdns/pdns.d',
  databasePath: '/var/lib/powerdns/pdns.sqlite3',
  apiAddress: '127.0.0.1',
  apiPort: 8081,
  serviceUnit: 'pdns.service',
  packages: Object.freeze(['pdns-server', 'pdns-backend-sqlite3', 'sqlite3', 'bind9-dnsutils']),
});

export class PowerDnsTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PowerDnsTemplateError';
    this.code = code;
  }
}

function apiKeyHash(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 512 || /[\r\n\u0000]/.test(value)) {
    throw new PowerDnsTemplateError('invalid_powerdns_api_key_hash', 'PowerDNS API key hash is invalid');
  }
  return value;
}

function secondaryAddresses(value = []) {
  if (!Array.isArray(value) || value.length > 8 || value.some((entry) => typeof entry !== 'string' || !isIP(entry))) {
    throw new PowerDnsTemplateError('invalid_powerdns_secondary_addresses', 'PowerDNS secondary DNS addresses are invalid');
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) {
    throw new PowerDnsTemplateError('invalid_powerdns_secondary_addresses', 'PowerDNS secondary DNS addresses must be unique');
  }
  return Object.freeze(unique.sort());
}

export function renderManagedPowerDnsConfig({ apiKeyHash: rawApiKeyHash, secondaryDns = [] } = {}) {
  const secretHash = apiKeyHash(rawApiKeyHash);
  const secondary = secondaryAddresses(secondaryDns);
  const axfr = ['127.0.0.0/8', '::1', ...secondary].join(', ');
  const notify = secondary.length > 0 ? secondary.join(', ') : null;

  return [
    '# Managed by YunPanel. Manual edits are overwritten.',
    'launch=gsqlite3',
    `gsqlite3-database=${POLICY.databasePath}`,
    'gsqlite3-dnssec=yes',
    'primary=yes',
    'secondary=no',
    'autosecondary=no',
    'api=yes',
    `api-key=${secretHash}`,
    'webserver=yes',
    `webserver-address=${POLICY.apiAddress}`,
    `webserver-port=${POLICY.apiPort}`,
    'webserver-allow-from=127.0.0.1',
    'webserver-max-bodysize=2',
    'local-address=0.0.0.0, ::',
    'local-port=53',
    'version-string=anonymous',
    `allow-axfr-ips=${axfr}`,
    ...(notify ? [`also-notify=${notify}`] : []),
    '',
  ].join('\n');
}

export function previewManagedPowerDnsConfig(input = {}) {
  const content = renderManagedPowerDnsConfig(input);
  return Object.freeze({
    path: POLICY.configPath,
    databasePath: POLICY.databasePath,
    api: Object.freeze({ address: POLICY.apiAddress, port: POLICY.apiPort, public: false }),
    authoritative: true,
    recursive: false,
    content,
  });
}

export const powerDnsTemplatePolicy = POLICY;
export const powerDnsTemplateInternals = Object.freeze({ apiKeyHash, secondaryAddresses });
