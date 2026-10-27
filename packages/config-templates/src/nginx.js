import path from 'node:path';
import { formatProxyHostForUrl, normalizeDomainSet, normalizeNginxSettings, normalizeRedirectTarget, stableHexKey } from '@yunpanel/shared';
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

// The distribution default compresses only text/html and never proxied responses.
// text/html is implicit in gzip_types, so listing it again would be a duplicate.
const GZIP_DIRECTIVES = [
  '  gzip on;', '  gzip_vary on;', '  gzip_proxied any;', '  gzip_comp_level 5;', '  gzip_min_length 1024;',
  '  gzip_types text/plain text/css text/xml text/javascript application/javascript application/json application/xml application/rss+xml application/manifest+json image/svg+xml font/woff font/woff2;',
].join('\n');

function assetCacheLines(seconds) {
  if (seconds === 0) return '    expires -1;\n    add_header Cache-Control "no-store" always;\n';
  if (seconds === null || seconds === undefined) return '';
  const expiry = seconds === 604_800 ? '7d' : `${seconds}s`;
  return `    expires ${expiry};\n    add_header Cache-Control "public, max-age=${seconds}, immutable";\n`;
}

// Rules are validated by normalizeNginxSettings to a closed character set, so they
// are safe to interpolate. `=` and `^~` locations win over the regex locations below.
function redirectLocations(rules = []) {
  return rules.map(({ source, target, status, match }) => {
    if (match === 'exact') {
      const query = target.includes('?') ? '' : '$is_args$args';
      return `  location = ${source} {\n    return ${status} ${target}${query};\n  }`;
    }
    const pattern = source.replace(/[.]/g, '\\.');
    return `  location ^~ ${source} {\n    rewrite ^${pattern}(.*)$ ${target}$1 ${status === 301 ? 'permanent' : 'redirect'};\n  }`;
  }).join('\n\n');
}

export const PROTECTED_PATH_AUTH_DIRECTORY = '/etc/nginx/yunpanel-auth';

// Password-protected directories for every target type without duplicating the
// serving locations: http-level maps pick the realm and htpasswd file from the
// normalized $uri, and "off" disables auth everywhere else. The access phase
// runs before try_files, so an internal redirect to index.php cannot skip it.
function protectedPathAuth(primaryDomain, paths = []) {
  if (!paths.length) return null;
  const id = stableHexKey(primaryDomain).slice(0, 12);
  const pattern = (path) => `"~^${path.replace(/[.]/g, '\\.')}"`;
  const realm = `$yp_auth_realm_${id}`;
  const file = `$yp_auth_file_${id}`;
  const maps = `map $uri ${realm} {\n  default off;\n${paths.map(({ path }) => `  ${pattern(path)} "Restricted";`).join('\n')}\n}\n\n`
    + `map $uri ${file} {\n  default /dev/null;\n${paths.map(({ path, key }) => `  ${pattern(path)} ${PROTECTED_PATH_AUTH_DIRECTORY}/${primaryDomain}/${key}.htpasswd;`).join('\n')}\n}`;
  return { maps, directives: `  auth_basic ${realm};\n  auth_basic_user_file ${file};` };
}

function serverBlock({
  names,
  body,
  acmeRoot = null,
  tls = null,
  clientMaxBodySizeMb = null,
  accessLog = null,
  errorLog = null,
}) {
  const listen = tls
    ? '  listen 443 ssl;\n  listen [::]:443 ssl;'
    : '  listen 80;\n  listen [::]:80;';
  const acme = acmeRoot ? `\n\n${acmeLocation(acmeRoot)}` : '';
  const certificates = tls
    ? `\n\n  ssl_certificate ${tls.fullchainPath};\n  ssl_certificate_key ${tls.privateKeyPath};`
    : '';
  const bodySize = clientMaxBodySizeMb === null ? '' : `\n  client_max_body_size ${clientMaxBodySizeMb}m;`;
  const access = accessLog === null ? '' : `\n  access_log ${accessLog};`;
  const error = errorLog === null ? '' : `\n  error_log ${errorLog};`;
  return `server {\n${listen}\n  server_name ${names};${bodySize}${access}${error}${acme}${certificates}\n\n${body}\n}`;
}

function serviceOverrideBody(override, headers) {
  if (!override) return null;
  const renderedHeaders = headerLines(headers);
  const action = override.mode === 'unavailable' ? 'return 503;'
    : `return ${override.status} ${override.url}${override.preservePath ? '$request_uri' : ''};`;
  return `  location / {${renderedHeaders ? `\n${renderedHeaders}` : ''}\n    ${action}\n  }`;
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
  accessLogPath = undefined,
  errorLogPath = undefined,
}) {
  if (typeof canonicalRedirect !== 'boolean' || typeof httpsRedirect !== 'boolean') {
    throw new NginxTemplateError('invalid_redirect_policy', 'Redirect policies must be boolean values');
  }
  let names = serverNames(primaryDomain, aliases);
  const preferred = nginxSettings.preferredDomain;
  if (preferred != null) {
    if (![names.primary, ...names.aliases].includes(preferred)) {
      throw new NginxTemplateError('nginx_preferred_domain_unbound', 'Preferred Domain must already belong to this Website');
    }
    names = serverNames(preferred, [names.primary, ...names.aliases].filter(name => name !== preferred));
  }
  const accessLog = accessLogPath === null ? null : assertSafeAbsolutePath(accessLogPath ?? `/var/log/nginx/${names.primary}.access.log`, 'accessLogPath');
  const errorLog = errorLogPath === null ? null : assertSafeAbsolutePath(errorLogPath ?? `/var/log/nginx/${names.primary}.error.log`, 'errorLogPath');
  const blocks = [];
  const challengeOnlyNames = acmeOnlyNames(primaryDomain, aliases, acmeOnlyHostnames);
  const discoverySocket = normalizeMailDiscoverySocket(mailDiscoverySocketPath);
  const discoveryLocations = mailDiscoveryLocations(discoverySocket);
  // A service override replaces everything the site serves, so path rules and auth cannot bypass it.
  const override = serviceOverrideBody(nginxSettings.serviceOverride, nginxSettings.headers);
  const rules = override ? '' : redirectLocations(nginxSettings.redirectRules ?? []);
  if (override) body = override;
  if (rules) body = `${rules}\n\n${body}`;
  if (!override && nginxSettings.gzip === true) body = `${GZIP_DIRECTIVES}\n\n${body}`;
  const auth = override ? null : protectedPathAuth(primaryDomain, nginxSettings.protectedPaths ?? []);
  if (auth) body = `${auth.directives}\n\n${body}`;
  const prelude = auth ? `${auth.maps}\n\n` : '';
  const tlsBody = discoveryLocations ? `${discoveryLocations}\n\n${body}` : body;
  if (!canonicalRedirect) {
    const httpBody = tls && httpsRedirect ? redirectBody('https://$host', nginxSettings.headers) : body;
    blocks.push(serverBlock({ names: names.all, body: httpBody, acmeRoot, clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb, accessLog, errorLog }));
    if (tls) blocks.push(serverBlock({ names: names.all, body: tlsBody, tls, clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb, accessLog, errorLog }));
    for (const hostname of challengeOnlyNames) {
      blocks.push(serverBlock({
        names: hostname,
        body: '  location / {\n    return 301 https://$host$request_uri;\n  }',
        acmeRoot,
        accessLog,
        errorLog,
      }));
    }
    return `${prelude}${blocks.join('\n\n')}\n`;
  }

  const primaryHttpBody = tls && httpsRedirect ? redirectBody(`https://${names.primary}`, nginxSettings.headers) : body;
  blocks.push(serverBlock({ names: names.primary, body: primaryHttpBody, acmeRoot, clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb, accessLog, errorLog }));
  if (names.aliases.length > 0) {
    const aliasScheme = tls && httpsRedirect ? 'https' : 'http';
    blocks.push(serverBlock({
      names: names.aliases.join(' '),
      body: redirectBody(`${aliasScheme}://${names.primary}`, nginxSettings.headers),
      acmeRoot,
      clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb,
      accessLog,
      errorLog,
    }));
  }
  if (tls) {
    blocks.push(serverBlock({ names: names.primary, body: tlsBody, tls, clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb, accessLog, errorLog }));
    if (names.aliases.length > 0) {
      blocks.push(serverBlock({
        names: names.aliases.join(' '),
        body: redirectBody(`https://${names.primary}`, nginxSettings.headers),
        tls,
        clientMaxBodySizeMb: nginxSettings.clientMaxBodySizeMb,
        accessLog,
        errorLog,
      }));
    }
  }
  for (const hostname of challengeOnlyNames) {
    blocks.push(serverBlock({
      names: hostname,
      body: '  location / {\n    return 301 https://$host$request_uri;\n  }',
      acmeRoot,
      accessLog,
      errorLog,
    }));
  }
  return `${prelude}${blocks.join('\n\n')}\n`;
}

function errorPageBody(nginxSettings) {
  const pages = Object.entries(nginxSettings.errorPages ?? {});
  if (!pages.length) return '';
  const directives = pages.map(([code, uri]) => `  error_page ${code} ${uri};`).join('\n');
  const renderedHeaders = headerLines(nginxSettings.headers);
  const locations = [...new Set(pages.map(([, uri]) => uri))].map(uri =>
    `  location = ${uri} {\n    internal;\n    try_files $uri =404;${renderedHeaders ? `\n${renderedHeaders}` : ''}\n  }`).join('\n\n');
  return `\n\n${directives}\n\n${locations}`;
}

function staticBody({ root, nginxSettings }) {
  const { spaFallback, staticAssetCacheSeconds, headers } = nginxSettings;
  const fallback = spaFallback ? 'try_files $uri $uri/ /index.html;' : 'try_files $uri $uri/ =404;';
  const renderedHeaders = headerLines(headers);
  const cache = assetCacheLines(staticAssetCacheSeconds);
  return `  root ${root};\n  index ${(nginxSettings.indexFiles ?? ['index.html']).join(' ')};\n\n  location / {${renderedHeaders ? `\n${renderedHeaders}` : ''}\n    ${fallback}\n  }\n\n  location ~* \\.(?:css|js|mjs|jpg|jpeg|png|gif|svg|webp|ico|woff|woff2)$ {\n${cache}${renderedHeaders ? `${renderedHeaders}\n` : ''}    try_files $uri =404;\n    access_log off;\n  }${errorPageBody(nginxSettings)}`;
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
  const intercept = Object.keys(nginxSettings.errorPages ?? {}).length ? '\n    fastcgi_intercept_errors on;' : '';
  const cache = assetCacheLines(nginxSettings.staticAssetCacheSeconds);
  const assets = cache ? `\n\n  location ~* \\.(?:css|js|mjs|jpg|jpeg|png|gif|svg|webp|ico|woff|woff2)$ {\n${cache}${renderedHeaders ? `${renderedHeaders}\n` : ''}    try_files $uri =404;\n    access_log off;\n  }` : '';
  return `  root ${root};\n  index ${(nginxSettings.indexFiles ?? ['index.php', 'index.html']).join(' ')};\n\n  location / {${renderedHeaders ? `\n${renderedHeaders}` : ''}\n    try_files $uri $uri/ /index.php?$query_string;\n  }${assets}\n\n  location ~ \\.php$ {${phpHeaders ? `\n${phpHeaders}` : ''}${intercept}\n    try_files $uri =404;\n    include fastcgi_params;\n    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;\n    fastcgi_param DOCUMENT_ROOT $document_root;\n    fastcgi_param HTTPS $https if_not_empty;\n    fastcgi_pass unix:${socketPath};\n  }\n\n  location ~ /\\.(?!well-known/) {\n    deny all;\n    access_log off;\n    log_not_found off;\n  }${errorPageBody(nginxSettings)}`;
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
  accessLogPath = undefined,
  errorLogPath = undefined,
}) {
  const safeRoot = assertSafeAbsolutePath(root, 'root');
  const normalizedTls = normalizeTls(tls);
  const settings = normalizeNginxSettings('static', nginxSettings ?? { spaFallback });
  const scopedRoot = settings.documentRoot ? `${safeRoot}/${settings.documentRoot}` : safeRoot;
  const body = `${settings.documentRoot ? `  disable_symlinks on from=${safeRoot};\n` : ''}${staticBody({ root: scopedRoot, nginxSettings: settings })}`;
  return renderServerSet({
    primaryDomain, aliases, acmeOnlyHostnames, mailDiscoverySocketPath, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect, nginxSettings: settings, accessLogPath, errorLogPath,
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
  accessLogPath = undefined,
  errorLogPath = undefined,
}) {
  const host = assertUpstreamHost(upstreamHost);
  const port = assertUpstreamPort(upstreamPort);
  const normalizedTls = normalizeTls(tls);
  const settings = normalizeNginxSettings('proxy', nginxSettings ?? { websocket });
  const body = proxyBody({ host, port, nginxSettings: settings });
  return renderServerSet({
    primaryDomain, aliases, acmeOnlyHostnames, mailDiscoverySocketPath, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect, nginxSettings: settings, accessLogPath, errorLogPath,
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
  accessLogPath = undefined,
  errorLogPath = undefined,
}) {
  const normalizedTls = normalizeTls(tls);
  const settings = normalizeNginxSettings('passenger', nginxSettings ?? {});
  const body = passengerBody({ target, nginxSettings: settings });
  return renderServerSet({
    primaryDomain, aliases, acmeOnlyHostnames, mailDiscoverySocketPath, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect, nginxSettings: settings, accessLogPath, errorLogPath,
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
  accessLogPath = undefined,
  errorLogPath = undefined,
}) {
  const safeRoot = assertSafeAbsolutePath(root, 'root');
  const safeSocket = assertSafeAbsolutePath(socketPath, 'socketPath');
  if (!safeSocket.startsWith('/run/php/yunpanel-yunapp-') || !safeSocket.endsWith('.sock')) {
    throw new NginxTemplateError('invalid_php_socket', 'PHP upstream must use a managed YunPanel Website socket');
  }
  const normalizedTls = normalizeTls(tls);
  const settings = normalizeNginxSettings('php', nginxSettings ?? {});
  const scopedRoot = settings.documentRoot ? `${safeRoot}/${settings.documentRoot}` : safeRoot;
  const body = `${settings.documentRoot ? `  disable_symlinks on from=${safeRoot};\n` : ''}${phpBody({ root: scopedRoot, socketPath: safeSocket, nginxSettings: settings })}`;
  return renderServerSet({
    primaryDomain, aliases, acmeOnlyHostnames, mailDiscoverySocketPath, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect, nginxSettings: settings, accessLogPath, errorLogPath,
  });
}

// Forwarding-only Domain: every name answers with one redirect; only ACME is served.
// HTTP forwards directly too, because a detour through HTTPS on the same host adds a hop.
export function renderRedirectSiteConfig({
  primaryDomain,
  aliases = [],
  acmeOnlyHostnames = [],
  mailDiscoverySocketPath = null,
  target,
  acmeRoot = '/var/lib/yunpanel/acme',
  tls = null,
  nginxSettings = undefined,
  accessLogPath = undefined,
  errorLogPath = undefined,
}) {
  let forward;
  try { forward = normalizeRedirectTarget(target); }
  catch (error) { throw new NginxTemplateError(error.code ?? 'invalid_redirect_target', error.message); }
  const settings = normalizeNginxSettings('redirect', nginxSettings ?? {});
  const renderedHeaders = headerLines(settings.headers);
  const body = `  location / {${renderedHeaders ? `\n${renderedHeaders}` : ''}\n    return ${forward.status} ${forward.url}${forward.preservePath ? '$request_uri' : ''};\n  }`;
  return renderServerSet({
    primaryDomain, aliases, acmeOnlyHostnames, mailDiscoverySocketPath, acmeRoot, tls: normalizeTls(tls), body,
    canonicalRedirect: false, httpsRedirect: false, nginxSettings: settings, accessLogPath, errorLogPath,
  });
}

function pythonBody({ socketPath, upstreamPort, nginxSettings }) {
  const websocketHeaders = nginxSettings.websocket
    ? '\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";'
    : '';
  const timeout = nginxSettings.proxyTimeoutSeconds === null ? ''
    : `\n    proxy_connect_timeout ${nginxSettings.proxyTimeoutSeconds}s;\n    proxy_send_timeout ${nginxSettings.proxyTimeoutSeconds}s;\n    proxy_read_timeout ${nginxSettings.proxyTimeoutSeconds}s;`;
  const renderedHeaders = headerLines(nginxSettings.headers);

  const upstream = socketPath ? `http://unix:${socketPath}` : `http://127.0.0.1:${upstreamPort}`;

  return `  location / {\n    proxy_pass ${upstream};\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;${websocketHeaders}${timeout}${renderedHeaders ? `\n${renderedHeaders}` : ''}\n  }`;
}

export function renderPythonSiteConfig({
  primaryDomain,
  aliases = [],
  acmeOnlyHostnames = [],
  mailDiscoverySocketPath = null,
  socketPath = null,
  upstreamPort = null,
  acmeRoot = '/var/lib/yunpanel/acme',
  tls = null,
  canonicalRedirect = false,
  httpsRedirect = true,
  nginxSettings = undefined,
  accessLogPath = undefined,
  errorLogPath = undefined,
}) {
  if (!socketPath && !upstreamPort) {
    throw new NginxTemplateError('invalid_upstream', 'Python upstream requires either a socketPath or upstreamPort');
  }
  let safeSocket = null;
  let port = null;
  if (socketPath) {
    safeSocket = assertSafeAbsolutePath(socketPath, 'socketPath');
    if (!safeSocket.startsWith('/run/yunpanel/python-') || !safeSocket.endsWith('.sock')) {
      throw new NginxTemplateError('invalid_python_socket', 'Python upstream must use a managed YunPanel socket');
    }
  } else {
    port = assertUpstreamPort(upstreamPort);
  }
  const normalizedTls = normalizeTls(tls);
  const settings = normalizeNginxSettings('python', nginxSettings ?? {});
  const body = pythonBody({ socketPath: safeSocket, upstreamPort: port, nginxSettings: settings });
  return renderServerSet({
    primaryDomain, aliases, acmeOnlyHostnames, mailDiscoverySocketPath, acmeRoot, tls: normalizedTls, body, canonicalRedirect, httpsRedirect, nginxSettings: settings, accessLogPath, errorLogPath,
  });
}

export function nginxConfigFileName(primaryDomain) {
  const { primary } = normalizeDomainSet(primaryDomain, []);
  return `${primary}.conf`;
}
