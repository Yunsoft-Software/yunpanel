import { createHash } from 'node:crypto';
import path from 'node:path';

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export class PhpMyAdminNginxTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpMyAdminNginxTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactPath(value, expected, field) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || path.posix.normalize(value) !== value
    || value === '/' || value.includes('/../') || value.endsWith('/..') || value !== expected) {
    throw new PhpMyAdminNginxTemplateError(
      'invalid_phpmyadmin_nginx_path',
      `${field} must use the managed phpMyAdmin path`,
    );
  }
  return value;
}

export const phpMyAdminNginxTemplatePolicy = Object.freeze({
  configPath: '/etc/nginx/sites-enabled/yunpanel-phpmyadmin.conf',
  documentRoot: '/usr/share/phpmyadmin',
  fpmSocketPath: '/run/php/yunpanel-phpmyadmin.sock',
  gatewaySocketPath: '/run/yunpanel/phpmyadmin-http.sock',
  serviceUnit: 'nginx.service',
  configMode: 0o640,
  gatewaySocketMode: 0o660,
  gatewaySocketOwner: 'root',
  gatewaySocketGroup: 'yunpanel-web',
  healthPath: '/',
});

export function renderPhpMyAdminNginxConfig({
  documentRoot = phpMyAdminNginxTemplatePolicy.documentRoot,
  fpmSocketPath = phpMyAdminNginxTemplatePolicy.fpmSocketPath,
  gatewaySocketPath = phpMyAdminNginxTemplatePolicy.gatewaySocketPath,
} = {}) {
  const root = exactPath(documentRoot, phpMyAdminNginxTemplatePolicy.documentRoot, 'documentRoot');
  const fpmSocket = exactPath(fpmSocketPath, phpMyAdminNginxTemplatePolicy.fpmSocketPath, 'fpmSocketPath');
  const gatewaySocket = exactPath(
    gatewaySocketPath,
    phpMyAdminNginxTemplatePolicy.gatewaySocketPath,
    'gatewaySocketPath',
  );

  return `server {\n  listen unix:${gatewaySocket};\n  server_name localhost;\n  server_tokens off;\n  access_log off;\n\n  root ${root};\n  index index.php;\n  client_max_body_size 128m;\n\n  add_header X-Content-Type-Options "nosniff" always;\n  add_header X-Frame-Options "SAMEORIGIN" always;\n  add_header Referrer-Policy "same-origin" always;\n  add_header X-Robots-Tag "noindex, nofollow, noarchive" always;\n\n  location ~ ^/(?:setup|test|libraries|templates)(?:/|$) {\n    deny all;\n  }\n\n  location ~ /\\. {\n    deny all;\n  }\n\n  location / {\n    try_files $uri $uri/ /index.php?$query_string;\n  }\n\n  location ~ \\.php$ {\n    try_files $uri =404;\n    include fastcgi_params;\n    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;\n    fastcgi_param HTTPS on;\n    fastcgi_param HTTP_PROXY "";\n    fastcgi_pass unix:${fpmSocket};\n    fastcgi_connect_timeout 10s;\n    fastcgi_send_timeout 120s;\n    fastcgi_read_timeout 120s;\n  }\n}\n`;
}

export function previewPhpMyAdminNginxConfig(input = {}) {
  const content = renderPhpMyAdminNginxConfig(input);
  const digest = sha256(content);
  return Object.freeze({
    version: 1,
    sha256: digest,
    artifact: Object.freeze({
      path: phpMyAdminNginxTemplatePolicy.configPath,
      sha256: digest,
      bytes: Buffer.byteLength(content),
      sensitive: false,
      mode: phpMyAdminNginxTemplatePolicy.configMode,
    }),
    documentRoot: phpMyAdminNginxTemplatePolicy.documentRoot,
    fpmSocketPath: phpMyAdminNginxTemplatePolicy.fpmSocketPath,
    gatewaySocketPath: phpMyAdminNginxTemplatePolicy.gatewaySocketPath,
    gatewaySocketMode: phpMyAdminNginxTemplatePolicy.gatewaySocketMode,
    gatewaySocketOwner: phpMyAdminNginxTemplatePolicy.gatewaySocketOwner,
    gatewaySocketGroup: phpMyAdminNginxTemplatePolicy.gatewaySocketGroup,
    serviceUnit: phpMyAdminNginxTemplatePolicy.serviceUnit,
    healthPath: phpMyAdminNginxTemplatePolicy.healthPath,
  });
}

export const phpMyAdminNginxTemplateInternals = Object.freeze({ exactPath, sha256 });
