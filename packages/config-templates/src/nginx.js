import path from 'node:path';
import { normalizeDomainSet } from '@yunpanel/shared';

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export class NginxTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NginxTemplateError';
    this.code = code;
  }
}

function assertSafeAbsolutePath(value, fieldName) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value)) {
    throw new NginxTemplateError('invalid_path', `${fieldName} must be a safe absolute path`);
  }

  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.includes('/../') || value.endsWith('/..')) {
    throw new NginxTemplateError('invalid_path', `${fieldName} must not contain traversal segments`);
  }

  return value;
}

function assertUpstreamPort(value) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new NginxTemplateError('invalid_upstream_port', 'upstreamPort must be an integer between 1024 and 65535');
  }
  return value;
}

function assertLoopbackHost(value) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(value)) {
    throw new NginxTemplateError('invalid_upstream_host', 'V1 proxy upstream must use a loopback host');
  }
  return value === '::1' ? '[::1]' : value;
}

function serverNames(primaryDomain, aliases) {
  const domains = normalizeDomainSet(primaryDomain, aliases);
  return [domains.primary, ...domains.aliases].join(' ');
}

function acmeLocation(acmeRoot) {
  const root = assertSafeAbsolutePath(acmeRoot, 'acmeRoot');
  return `  location ^~ /.well-known/acme-challenge/ {\n    root ${root};\n    default_type text/plain;\n    try_files $uri =404;\n  }`;
}

export function renderStaticSiteConfig({
  primaryDomain,
  aliases = [],
  root,
  spaFallback = true,
  acmeRoot = '/var/lib/yunpanel/acme',
}) {
  const safeRoot = assertSafeAbsolutePath(root, 'root');
  const names = serverNames(primaryDomain, aliases);
  const fallback = spaFallback ? 'try_files $uri $uri/ /index.html;' : 'try_files $uri $uri/ =404;';

  return `server {\n  listen 80;\n  listen [::]:80;\n  server_name ${names};\n\n${acmeLocation(acmeRoot)}\n\n  root ${safeRoot};\n  index index.html;\n\n  location / {\n    ${fallback}\n  }\n\n  location ~* \\.(?:css|js|mjs|jpg|jpeg|png|gif|svg|webp|ico|woff|woff2)$ {\n    expires 7d;\n    add_header Cache-Control \"public, max-age=604800, immutable\";\n    try_files $uri =404;\n    access_log off;\n  }\n}\n`;
}

export function renderProxySiteConfig({
  primaryDomain,
  aliases = [],
  upstreamHost = '127.0.0.1',
  upstreamPort,
  websocket = true,
  acmeRoot = '/var/lib/yunpanel/acme',
}) {
  const names = serverNames(primaryDomain, aliases);
  const host = assertLoopbackHost(upstreamHost);
  const port = assertUpstreamPort(upstreamPort);
  const websocketHeaders = websocket
    ? '\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";'
    : '';

  return `server {\n  listen 80;\n  listen [::]:80;\n  server_name ${names};\n\n${acmeLocation(acmeRoot)}\n\n  location / {\n    proxy_pass http://${host}:${port};\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;${websocketHeaders}\n  }\n}\n`;
}

export function nginxConfigFileName(primaryDomain) {
  const { primary } = normalizeDomainSet(primaryDomain, []);
  return `${primary}.conf`;
}
