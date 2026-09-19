import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeDomainSet } from '@yunpanel/shared';

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export class RoundcubeNginxTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoundcubeNginxTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hostname(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch {
    throw new RoundcubeNginxTemplateError('invalid_roundcube_nginx_hostname', 'Roundcube web hostname is invalid');
  }
}

function safePath(value, field) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value)
    || path.posix.normalize(value) !== value || value === '/' || value.includes('/../') || value.endsWith('/..')) {
    throw new RoundcubeNginxTemplateError('invalid_roundcube_nginx_path', `${field} is invalid`);
  }
  return value;
}

function webMappings(value, primaryHost) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 1000) {
    throw new RoundcubeNginxTemplateError(
      'invalid_roundcube_nginx_mappings',
      'Roundcube web mappings are invalid',
    );
  }
  const mappings = value.map((entry) => {
    const fields = new Set(['hostname', 'fullchainPath', 'privateKeyPath']);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== fields.size
      || Object.keys(entry).some((field) => !fields.has(field))) {
      throw new RoundcubeNginxTemplateError(
        'invalid_roundcube_nginx_mapping',
        'Roundcube web mapping is invalid',
      );
    }
    return Object.freeze({
      hostname: hostname(entry.hostname),
      fullchainPath: safePath(entry.fullchainPath, 'mapping.fullchainPath'),
      privateKeyPath: safePath(entry.privateKeyPath, 'mapping.privateKeyPath'),
    });
  }).sort((left, right) => left.hostname.localeCompare(right.hostname));
  if (mappings.some((entry) => entry.hostname === primaryHost)
    || new Set(mappings.map((entry) => entry.hostname)).size !== mappings.length) {
    throw new RoundcubeNginxTemplateError(
      'invalid_roundcube_nginx_mappings',
      'Roundcube web mapping hostnames must be unique and distinct from the primary host',
    );
  }
  return Object.freeze(mappings);
}

function serverBlocks({
  webHostname,
  fullchainPath,
  privateKeyPath,
  publicRoot,
  fpmSocketPath,
  includeHttpRedirect = true,
}) {
  const http = includeHttpRedirect ? `server {
  listen 80;
  listen [::]:80;
  server_name ${webHostname};
  return 301 https://${webHostname}$request_uri;
}

` : '';
  return `${http}server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name ${webHostname};
  server_tokens off;

  ssl_certificate ${fullchainPath};
  ssl_certificate_key ${privateKeyPath};
  ssl_protocols TLSv1.2 TLSv1.3;

  root ${publicRoot};
  index index.php;
  client_max_body_size 25m;

  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header Referrer-Policy "same-origin" always;

  location / {
    try_files $uri $uri/ /index.php?$query_string;
  }

  location ~ \\.php$ {
    try_files $uri =404;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_param HTTP_PROXY "";
    fastcgi_pass unix:${fpmSocketPath};
    fastcgi_connect_timeout 10s;
    fastcgi_send_timeout 30s;
    fastcgi_read_timeout 30s;
  }

  location ~ /\\. {
    deny all;
  }
}
`;
}

export const roundcubeNginxTemplatePolicy = Object.freeze({
  configPath: '/etc/nginx/sites-enabled/yunpanel-roundcube.conf',
  publicRoot: '/var/lib/roundcube/public_html',
  fpmSocketPath: '/run/php/yunpanel-roundcube.sock',
  serviceUnit: 'nginx.service',
  configMode: 0o640,
  healthPath: '/',
});

export function renderRoundcubeNginxConfig({
  webHostname,
  fullchainPath,
  privateKeyPath,
  publicRoot = roundcubeNginxTemplatePolicy.publicRoot,
  fpmSocketPath = roundcubeNginxTemplatePolicy.fpmSocketPath,
  mappings = [],
} = {}) {
  const host = hostname(webHostname);
  const fullchain = safePath(fullchainPath, 'fullchainPath');
  const privateKey = safePath(privateKeyPath, 'privateKeyPath');
  const root = safePath(publicRoot, 'publicRoot');
  const socket = safePath(fpmSocketPath, 'fpmSocketPath');
  if (root !== roundcubeNginxTemplatePolicy.publicRoot || socket !== roundcubeNginxTemplatePolicy.fpmSocketPath) {
    throw new RoundcubeNginxTemplateError(
      'invalid_roundcube_nginx_managed_path',
      'Roundcube Nginx must use the managed document root and PHP-FPM socket',
    );
  }
  const aliases = webMappings(mappings, host);
  return [
    serverBlocks({
      webHostname: host,
      fullchainPath: fullchain,
      privateKeyPath: privateKey,
      publicRoot: root,
      fpmSocketPath: socket,
    }),
    ...aliases.map((mapping) => serverBlocks({
      webHostname: mapping.hostname,
      fullchainPath: mapping.fullchainPath,
      privateKeyPath: mapping.privateKeyPath,
      publicRoot: root,
      fpmSocketPath: socket,
      includeHttpRedirect: false,
    })),
  ].join('\n');
}

export function previewRoundcubeNginxConfig(input = {}) {
  const host = hostname(input.webHostname);
  const mappings = webMappings(input.mappings ?? [], host);
  const content = renderRoundcubeNginxConfig({ ...input, mappings });
  return Object.freeze({
    version: 1,
    sha256: sha256(content),
    artifact: Object.freeze({
      path: roundcubeNginxTemplatePolicy.configPath,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
      sensitive: false,
      mode: roundcubeNginxTemplatePolicy.configMode,
    }),
    webHostname: host,
    publicRoot: roundcubeNginxTemplatePolicy.publicRoot,
    fpmSocketPath: roundcubeNginxTemplatePolicy.fpmSocketPath,
    serviceUnit: roundcubeNginxTemplatePolicy.serviceUnit,
    healthPath: roundcubeNginxTemplatePolicy.healthPath,
    endpoint: `https://${host}/`,
    mappings: Object.freeze(mappings.map((mapping) => Object.freeze({
      hostname: mapping.hostname,
      endpoint: `https://${mapping.hostname}/`,
    }))),
  });
}

export const roundcubeNginxTemplateInternals = Object.freeze({
  hostname,
  safePath,
  sha256,
  webMappings,
  serverBlocks,
});
