import path from 'node:path';
import { formatProxyHostForUrl, normalizeDomainSet } from '@yunpanel/shared';

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

function assertUpstreamHost(value) {
  try { return formatProxyHostForUrl(value); }
  catch { throw new NginxTemplateError('invalid_upstream_host', 'Proxy upstream must use a safe IP address or DNS hostname'); }
}

function serverNames(primaryDomain, aliases) {
  const domains = normalizeDomainSet(primaryDomain, aliases);
  return { primary: domains.primary, aliases: domains.aliases, all: [domains.primary, ...domains.aliases].join(' ') };
}

function acmeLocation(acmeRoot) {
  const root = assertSafeAbsolutePath(acmeRoot, 'acmeRoot');
  return `  location ^~ /.well-known/acme-challenge/ {\n    root ${root};\n    default_type text/plain;\n    try_files $uri =404;\n  }`;
}

function normalizeTls(tls) {
  if (tls == null) return null;
  if (!tls || typeof tls !== 'object' || Array.isArray(tls)) {
    throw new NginxTemplateError('invalid_tls', 'tls must be an object');
  }

  return {
    fullchainPath: assertSafeAbsolutePath(tls.fullchainPath, 'tls.fullchainPath'),
    privateKeyPath: assertSafeAbsolutePath(tls.privateKeyPath, 'tls.privateKeyPath'),
  };
}

function redirectBody(destination) {
  return `  location / {\n    return 301 ${destination}$request_uri;\n  }`;
}

function serverBlock({ names, body, acmeRoot = null, tls = null }) {
  const listen = tls
    ? '  listen 443 ssl;\n  listen [::]:443 ssl;'
    : '  listen 80;\n  listen [::]:80;';
  const acme = acmeRoot ? `\n\n${acmeLocation(acmeRoot)}` : '';
  const certificates = tls
    ? `\n\n  ssl_certificate ${tls.fullchainPath};\n  ssl_certificate_key ${tls.privateKeyPath};`
    : '';
  return `server {\n${listen}\n  server_name ${names};${acme}${certificates}\n\n${body}\n}`;
}

function renderServerSet({ primaryDomain, aliases, acmeRoot, tls, body, canonicalRedirect, httpsRedirect }) {
  if (typeof canonicalRedirect !== 'boolean' || typeof httpsRedirect !== 'boolean') {
    throw new NginxTemplateError('invalid_redirect_policy', 'Redirect policies must be boolean values');
  }
  const names = serverNames(primaryDomain, aliases);
  const blocks = [];
  if (!canonicalRedirect) {
    const httpBody = tls && httpsRedirect ? redirectBody('https://$host') : body;
    blocks.push(serverBlock({ names: names.all, body: httpBody, acmeRoot }));
    if (tls) blocks.push(serverBlock({ names: names.all, body, tls }));
    return `${blocks.join('\n\n')}\n`;
  }

  const primaryHttpBody = tls && httpsRedirect ? redirectBody(`https://${names.primary}`) : body;
  blocks.push(serverBlock({ names: names.primary, body: primaryHttpBody, acmeRoot }));
  if (names.aliases.length > 0) {
    const aliasScheme = tls && httpsRedirect ? 'https' : 'http';
    blocks.push(serverBlock({
      names: names.aliases.join(' '),
      body: redirectBody(`${aliasScheme}://${names.primary}`),
      acmeRoot,
    }));
  }
  if (tls) {
    blocks.push(serverBlock({ names: names.primary, body, tls }));
    if (names.aliases.length > 0) {
      blocks.push(serverBlock({ names: names.aliases.join(' '), body: redirectBody(`https://${names.primary}`), tls }));
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

function staticBody({ root, spaFallback }) {
  const fallback = spaFallback ? 'try_files $uri $uri/ /index.html;' : 'try_files $uri $uri/ =404;';
  return `  root ${root};\n  index index.html;\n\n  location / {\n    ${fallback}\n  }\n\n  location ~* \\.(?:css|js|mjs|jpg|jpeg|png|gif|svg|webp|ico|woff|woff2)$ {\n    expires 7d;\n    add_header Cache-Control \"public, max-age=604800, immutable\";\n    try_files $uri =404;\n    access_log off;\n  }`;
}

function proxyBody({ host, port, websocket }) {
  const websocketHeaders = websocket
    ? '\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";'
    : '';

  return `  location / {\n    proxy_pass http://${host}:${port};\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;${websocketHeaders}\n  }`;
}

export function renderStaticSiteConfig({
  primaryDomain,
  aliases = [],
  root,
  spaFallback = true,
  acmeRoot = '/var/lib/yunpanel/acme',
  tls = null,
  canonicalRedirect = false,
  httpsRedirect = true,
}) {
  const safeRoot = assertSafeAbsolutePath(root, 'root');
  const normalizedTls = normalizeTls(tls);
  const body = staticBody({ root: safeRoot, spaFallback });
  return renderServerSet({ primaryDomain, aliases, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect });
}

export function renderProxySiteConfig({
  primaryDomain,
  aliases = [],
  upstreamHost = '127.0.0.1',
  upstreamPort,
  websocket = true,
  acmeRoot = '/var/lib/yunpanel/acme',
  tls = null,
  canonicalRedirect = false,
  httpsRedirect = true,
}) {
  const host = assertUpstreamHost(upstreamHost);
  const port = assertUpstreamPort(upstreamPort);
  const normalizedTls = normalizeTls(tls);
  const body = proxyBody({ host, port, websocket });
  return renderServerSet({ primaryDomain, aliases, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect });
}

export function nginxConfigFileName(primaryDomain) {
  const { primary } = normalizeDomainSet(primaryDomain, []);
  return `${primary}.conf`;
}
