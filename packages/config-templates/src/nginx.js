import path from 'node:path';
import { formatProxyHostForUrl, normalizeDomainSet, normalizeNginxSettings } from '@yunpanel/shared';
import { renderPassengerNodeDirectives } from './passenger-nginx.js';

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const MAIL_DISCOVERY_SOCKET = '/run/yunpanel-mail-discovery/discovery.sock';
const MAIL_DISCOVERY_PATHS = Object.freeze([
  '/autodiscover/autodiscover.xml',
  '/mail/config-v1.1.xml',
  '/.well-known/autoconfig/mail/config-v1.1.xml',
]);

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

function acmeOnlyNames(primaryDomain, aliases, hostnames = []) {
  if (!Array.isArray(hostnames)) {
    throw new NginxTemplateError('invalid_acme_only_hostnames', 'acmeOnlyHostnames must be an array');
  }
  const routed = new Set(serverNames(primaryDomain, aliases).all.split(' '));
  const normalized = hostnames.map((hostname) => normalizeDomainSet(hostname, []).primary);
  if (new Set(normalized).size !== normalized.length || normalized.some((hostname) => routed.has(hostname))) {
    throw new NginxTemplateError(
      'invalid_acme_only_hostnames',
      'ACME-only hostnames must be unique and outside the Website route names',
    );
  }
  return Object.freeze(normalized);
}

function acmeLocation(acmeRoot) {
  const root = assertSafeAbsolutePath(acmeRoot, 'acmeRoot');
  return `  location ^~ /.well-known/acme-challenge/ {\n    root ${root};\n    default_type text/plain;\n    try_files $uri =404;\n  }`;
}

function normalizeMailDiscoverySocket(value) {
  if (value == null) return null;
  const socketPath = assertSafeAbsolutePath(value, 'mailDiscoverySocketPath');
  if (socketPath !== MAIL_DISCOVERY_SOCKET) {
    throw new NginxTemplateError(
      'invalid_mail_discovery_socket',
      'Mail discovery upstream must use the managed YunPanel socket',
    );
  }
  return socketPath;
}

function mailDiscoveryLocations(socketPath) {
  if (socketPath === null) return '';
  return MAIL_DISCOVERY_PATHS.map((requestPath) => `  location = ${requestPath} {
    client_max_body_size 16k;
    proxy_pass http://unix:${socketPath};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host $host;
    proxy_connect_timeout 5s;
    proxy_send_timeout 5s;
    proxy_read_timeout 5s;
  }`).join('\n\n');
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

function headerLines(headers, indent = '    ') {
  return headers.map((header) => `${indent}add_header ${header.name} "${header.value}"${header.always ? ' always' : ''};`).join('\n');
}

function redirectBody(destination, headers) {
  const renderedHeaders = headerLines(headers);
  return `  location / {${renderedHeaders ? `\n${renderedHeaders}` : ''}\n    return 301 ${destination}$request_uri;\n  }`;
}

function serverBlock({ names, body, acmeRoot = null, tls = null, clientMaxBodySizeMb = null }) {
  const listen = tls
    ? '  listen 443 ssl;\n  listen [::]:443 ssl;'
    : '  listen 80;\n  listen [::]:80;';
  const acme = acmeRoot ? `\n\n${acmeLocation(acmeRoot)}` : '';
  const certificates = tls
    ? `\n\n  ssl_certificate ${tls.fullchainPath};\n  ssl_certificate_key ${tls.privateKeyPath};`
    : '';
  const bodySize = clientMaxBodySizeMb === null ? '' : `\n  client_max_body_size ${clientMaxBodySizeMb}m;`;
  return `server {\n${listen}\n  server_name ${names};${bodySize}${acme}${certificates}\n\n${body}\n}`;
}

function renderServerSet({
  primaryDomain,
  aliases,
  acmeRoot,
  tls,
  body,
  canonicalRedirect,
  httpsRedirect,
  nginxSettings,
  acmeOnlyHostnames = [],
  mailDiscoverySocketPath = null,
  mailDiscoverySocketPath = null,
}) {
  if (typeof canonicalRedirect !== 'boolean' || typeof httpsRedirect !== 'boolean') {
    throw new NginxTemplateError('invalid_redirect_policy', 'Redirect policies must be boolean values');
  }
  const names = serverNames(primaryDomain, aliases);
  const blocks = [];
  const challengeOnlyNames = acmeOnlyNames(primaryDomain, aliases, acmeOnlyHostnames);
  const discoverySocket = normalizeMailDiscoverySocket(mailDiscoverySocketPath);
  const discoveryLocations = mailDiscoveryLocations(discoverySocket);
  const tlsBody = discoveryLocations ? `${discoveryLocations}\n\n${body}` : body;
  if (!canonicalRedirect) {
    const httpBody = tls && httpsRedirect ? redirectBody('https://$host', nginxSettings.headers) : body;
    blocks.push(serverBlock({ names: names.all, body: httpBody, acmeRoot, clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb }));
    if (tls) blocks.push(serverBlock({ names: names.all, body: tlsBody, tls, clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb }));
    for (const hostname of challengeOnlyNames) {
      blocks.push(serverBlock({
        names: hostname,
        body: '  location / {\n    return 301 https://$host$request_uri;\n  }',
        acmeRoot,
      }));
    }
    return `${blocks.join('\n\n')}\n`;
  }

  const primaryHttpBody = tls && httpsRedirect ? redirectBody(`https://${names.primary}`, nginxSettings.headers) : body;
  blocks.push(serverBlock({ names: names.primary, body: primaryHttpBody, acmeRoot, clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb }));
  if (names.aliases.length > 0) {
    const aliasScheme = tls && httpsRedirect ? 'https' : 'http';
    blocks.push(serverBlock({
      names: names.aliases.join(' '),
      body: redirectBody(`${aliasScheme}://${names.primary}`, nginxSettings.headers),
      acmeRoot,
      clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb,
    }));
  }
  if (tls) {
    blocks.push(serverBlock({ names: names.primary, body: tlsBody, tls, clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb }));
    if (names.aliases.length > 0) {
      blocks.push(serverBlock({
        names: names.aliases.join(' '),
        body: redirectBody(`https://${names.primary}`, nginxSettings.headers),
        tls,
        clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb,
      }));
    }
  }
  for (const hostname of challengeOnlyNames) {
    blocks.push(serverBlock({
      names: hostname,
      body: '  location / {\n    return 301 https://$host$request_uri;\n  }',
      acmeRoot,
    }));
  }
  return `${blocks.join('\n\n')}\n`;
}

function staticBody({ root, nginxSettings }) {
  const { spaFallback, staticAssetCacheSeconds, headers } = nginxSettings;
  const fallback = spaFallback ? 'try_files $uri $uri/ /index.html;' : 'try_files $uri $uri/ =404;';
  const renderedHeaders = headerLines(headers);
  let cache = '';
  if (staticAssetCacheSeconds === 0) {
    cache = '    expires -1;\n    add_header Cache-Control "no-store" always;\n';
  } else if (staticAssetCacheSeconds !== null) {
    const expiry = staticAssetCacheSeconds === 604_800 ? '7d' : `${staticAssetCacheSeconds}s`;
    cache = `    expires ${expiry};\n    add_header Cache-Control "public, max-age=${staticAssetCacheSeconds}, immutable";\n`;
  }
  return `  root ${root};\n  index index.html;\n\n  location / {${renderedHeaders ? `\n${renderedHeaders}` : ''}\n    ${fallback}\n  }\n\n  location ~* \\.(?:css|js|mjs|jpg|jpeg|png|gif|svg|webp|ico|woff|woff2)$ {\n${cache}${renderedHeaders ? `${renderedHeaders}\n` : ''}    try_files $uri =404;\n    access_log off;\n  }`;
}

function proxyBody({ host, port, nginxSettings }) {
  const websocketHeaders = nginxSettings.websocket
    ? '\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";'
    : '';
  const timeout = nginxSettings.proxyTimeoutSeconds === null ? ''
    : `\n    proxy_connect_timeout ${nginxSettings.proxyTimeoutSeconds}s;\n    proxy_send_timeout ${nginxSettings.proxyTimeoutSeconds}s;\n    proxy_read_timeout ${nginxSettings.proxyTimeoutSeconds}s;`;
  const renderedHeaders = headerLines(nginxSettings.headers);

  return `  location / {\n    proxy_pass http://${host}:${port};\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;${websocketHeaders}${timeout}${renderedHeaders ? `\n${renderedHeaders}` : ''}\n  }`;
}

function passengerBody({ target, nginxSettings }) {
  const directives = renderPassengerNodeDirectives(target);
  const renderedHeaders = headerLines(nginxSettings.headers, '  ');
  return `${directives}${renderedHeaders ? `\n${renderedHeaders}` : ''}`;
}

function phpBody({ root, socketPath, nginxSettings }) {
  const renderedHeaders = headerLines(nginxSettings.headers);
  const phpHeaders = headerLines(nginxSettings.headers);
  return `  root ${root};\n  index index.php index.html;\n\n  location / {${renderedHeaders ? `\n${renderedHeaders}` : ''}\n    try_files $uri $uri/ /index.php?$query_string;\n  }\n\n  location ~ \\.php$ {${phpHeaders ? `\n${phpHeaders}` : ''}\n    try_files $uri =404;\n    include fastcgi_params;\n    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;\n    fastcgi_param DOCUMENT_ROOT $document_root;\n    fastcgi_param HTTPS $https if_not_empty;\n    fastcgi_pass unix:${socketPath};\n  }\n\n  location ~ /\\.(?!well-known/) {\n    deny all;\n  }`;
}

export function renderStaticSiteConfig({
  primaryDomain,
  aliases = [],
  acmeOnlyHostnames = [],
  mailDiscoverySocketPath = null,
  root,
  spaFallback = true,
  acmeRoot = '/var/lib/yunpanel/acme',
  tls = null,
  canonicalRedirect = false,
  httpsRedirect = true,
  nginxSettings = undefined,
}) {
  const safeRoot = assertSafeAbsolutePath(root, 'root');
  const normalizedTls = normalizeTls(tls);
  const settings = normalizeNginxSettings('static', nginxSettings ?? { spaFallback });
  const body = staticBody({ root: safeRoot, nginxSettings: settings });
  return renderServerSet({
    primaryDomain, aliases, acmeOnlyHostnames, mailDiscoverySocketPath, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect, nginxSettings: settings,
  });
}

export function renderProxySiteConfig({
  primaryDomain,
  aliases = [],
  acmeOnlyHostnames = [],
  mailDiscoverySocketPath = null,
  upstreamHost = '127.0.0.1',
  upstreamPort,
  websocket = true,
  acmeRoot = '/var/lib/yunpanel/acme',
  tls = null,
  canonicalRedirect = false,
  httpsRedirect = true,
  nginxSettings = undefined,
}) {
  const host = assertUpstreamHost(upstreamHost);
  const port = assertUpstreamPort(upstreamPort);
  const normalizedTls = normalizeTls(tls);
  const settings = normalizeNginxSettings('proxy', nginxSettings ?? { websocket });
  const body = proxyBody({ host, port, nginxSettings: settings });
  return renderServerSet({
    primaryDomain, aliases, acmeOnlyHostnames, mailDiscoverySocketPath, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect, nginxSettings: settings,
  });
}

export function renderPassengerSiteConfig({
  primaryDomain,
  aliases = [],
  acmeOnlyHostnames = [],
  mailDiscoverySocketPath = null,
  target,
  acmeRoot = '/var/lib/yunpanel/acme',
  tls = null,
  canonicalRedirect = false,
  httpsRedirect = true,
  nginxSettings = undefined,
}) {
  const normalizedTls = normalizeTls(tls);
  const settings = normalizeNginxSettings('passenger', nginxSettings ?? {});
  const body = passengerBody({ target, nginxSettings: settings });
  return renderServerSet({
    primaryDomain, aliases, acmeOnlyHostnames, mailDiscoverySocketPath, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect, nginxSettings: settings,
  });
}

export function renderPhpSiteConfig({
  primaryDomain,
  aliases = [],
  acmeOnlyHostnames = [],
  mailDiscoverySocketPath = null,
  root,
  socketPath,
  acmeRoot = '/var/lib/yunpanel/acme',
  tls = null,
  canonicalRedirect = false,
  httpsRedirect = true,
  nginxSettings = undefined,
}) {
  const safeRoot = assertSafeAbsolutePath(root, 'root');
  const safeSocket = assertSafeAbsolutePath(socketPath, 'socketPath');
  if (!safeSocket.startsWith('/run/php/yunpanel-yunapp-') || !safeSocket.endsWith('.sock')) {
    throw new NginxTemplateError('invalid_php_socket', 'PHP upstream must use a managed YunPanel Website socket');
  }
  const normalizedTls = normalizeTls(tls);
  const settings = normalizeNginxSettings('php', nginxSettings ?? {});
  const body = phpBody({ root: safeRoot, socketPath: safeSocket, nginxSettings: settings });
  return renderServerSet({
    primaryDomain, aliases, acmeOnlyHostnames, mailDiscoverySocketPath, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect, nginxSettings: settings,
  });
}

export function nginxConfigFileName(primaryDomain) {
  const { primary } = normalizeDomainSet(primaryDomain, []);
  return `${primary}.conf`;
}
