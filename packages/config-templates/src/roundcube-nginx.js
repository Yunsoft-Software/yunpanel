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

  return `server {\n  listen 80;\n  listen [::]:80;\n  server_name ${host};\n  return 301 https://${host}$request_uri;\n}\n\nserver {\n  listen 443 ssl;\n  listen [::]:443 ssl;\n  server_name ${host};\n  server_tokens off;\n\n  ssl_certificate ${fullchain};\n  ssl_certificate_key ${privateKey};\n  ssl_protocols TLSv1.2 TLSv1.3;\n\n  root ${root};\n  index index.php;\n  client_max_body_size 25m;\n\n  add_header X-Content-Type-Options \"nosniff\" always;\n  add_header X-Frame-Options \"SAMEORIGIN\" always;\n  add_header Referrer-Policy \"same-origin\" always;\n\n  location / {\n    try_files $uri $uri/ /index.php?$query_string;\n  }\n\n  location ~ \\.php$ {\n    try_files $uri =404;\n    include fastcgi_params;\n    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;\n    fastcgi_param HTTP_PROXY \"\";\n    fastcgi_pass unix:${socket};\n    fastcgi_connect_timeout 10s;\n    fastcgi_send_timeout 30s;\n    fastcgi_read_timeout 30s;\n  }\n\n  location ~ /\\. {\n    deny all;\n  }\n}\n`;
}

export function previewRoundcubeNginxConfig(input = {}) {
  const content = renderRoundcubeNginxConfig(input);
  const host = hostname(input.webHostname);
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
  });
}

export const roundcubeNginxTemplateInternals = Object.freeze({ hostname, safePath, sha256 });
