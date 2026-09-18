import { createHash } from 'node:crypto';
import path from 'node:path';

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export class ElFinderNginxTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ElFinderNginxTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactPath(value, expected, field) {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || path.posix.normalize(value) !== value
    || value === '/' || value.includes('/../') || value.endsWith('/..') || value !== expected) {
    throw new ElFinderNginxTemplateError(
      'invalid_elfinder_nginx_path',
      `${field} must use the managed elFinder path`,
    );
  }
  return value;
}

export const elFinderNginxTemplatePolicy = Object.freeze({
  configPath: '/etc/nginx/sites-enabled/yunpanel-elfinder.conf',
  documentRoot: '/usr/share/yunpanel/elfinder',
  jqueryRoot: '/usr/share/javascript/jquery',
  jqueryUiRoot: '/usr/share/javascript/jquery-ui',
  connectorPath: '/usr/share/yunpanel/elfinder/connector.php',
  gatewaySocketPath: '/run/yunpanel/elfinder-http.sock',
  fpmSocketPrefix: '/run/php/yunpanel-elfinder-',
  websiteRootPrefix: '/var/lib/yunpanel/data/',
  serviceUnit: 'nginx.service',
  configMode: 0o640,
  gatewaySocketMode: 0o660,
  gatewaySocketOwner: 'root',
  gatewaySocketGroup: 'yunpanel',
  healthPath: '/',
});

export function renderElFinderNginxConfig({
  documentRoot = elFinderNginxTemplatePolicy.documentRoot,
  jqueryRoot = elFinderNginxTemplatePolicy.jqueryRoot,
  jqueryUiRoot = elFinderNginxTemplatePolicy.jqueryUiRoot,
  connectorPath = elFinderNginxTemplatePolicy.connectorPath,
  gatewaySocketPath = elFinderNginxTemplatePolicy.gatewaySocketPath,
} = {}) {
  const root = exactPath(documentRoot, elFinderNginxTemplatePolicy.documentRoot, 'documentRoot');
  const jquery = exactPath(jqueryRoot, elFinderNginxTemplatePolicy.jqueryRoot, 'jqueryRoot');
  const jqueryUi = exactPath(jqueryUiRoot, elFinderNginxTemplatePolicy.jqueryUiRoot, 'jqueryUiRoot');
  const connector = exactPath(connectorPath, elFinderNginxTemplatePolicy.connectorPath, 'connectorPath');
  const gatewaySocket = exactPath(
    gatewaySocketPath,
    elFinderNginxTemplatePolicy.gatewaySocketPath,
    'gatewaySocketPath',
  );

  return `server {
  listen unix:${gatewaySocket};
  server_name localhost;
  server_tokens off;
  access_log off;

  root ${root};
  index index.html;
  client_max_body_size 128m;

  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
  add_header Cache-Control "no-store" always;

  location ~ /\\. {
    deny all;
  }

  location ~ ^/(?:VERSION|connector\\.php(?:/|$)|vendor/elfinder\\.html|vendor/php/|vendor/files/|vendor/README|vendor/LICENSE|vendor/composer|vendor/package) {
    deny all;
  }

  location = /connector.php {
    limit_except GET POST {
      deny all;
    }

    if ($http_x_yunpanel_elfinder_unix_user !~ "^yunapp-[a-f0-9]{12}$") {
      return 403;
    }
    if ($http_x_yunpanel_elfinder_website_id !~ "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") {
      return 403;
    }
    if ($http_x_yunpanel_elfinder_application_id !~ "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") {
      return 403;
    }

    set $yunpanel_elfinder_upstream "unix:${elFinderNginxTemplatePolicy.fpmSocketPrefix}$http_x_yunpanel_elfinder_unix_user.sock";

    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME ${connector};
    fastcgi_param SCRIPT_NAME /connector.php;
    fastcgi_param HTTPS on;
    fastcgi_param HTTP_PROXY "";
    fastcgi_param YUNPANEL_ELFINDER_ROOT "${elFinderNginxTemplatePolicy.websiteRootPrefix}$http_x_yunpanel_elfinder_application_id";
    fastcgi_param YUNPANEL_ELFINDER_WEBSITE_ID $http_x_yunpanel_elfinder_website_id;
    fastcgi_param YUNPANEL_ELFINDER_APPLICATION_ID $http_x_yunpanel_elfinder_application_id;
    fastcgi_param YUNPANEL_ELFINDER_UNIX_USER $http_x_yunpanel_elfinder_unix_user;
    fastcgi_pass $yunpanel_elfinder_upstream;
    fastcgi_connect_timeout 5s;
    fastcgi_send_timeout 120s;
    fastcgi_read_timeout 120s;
  }

  location ^~ /assets/jquery/ {
    alias ${jquery}/;
  }

  location ^~ /assets/jquery-ui/ {
    alias ${jqueryUi}/;
  }

  location ^~ /vendor/ {
    alias ${root}/vendor/elfinder/;
  }

  location = / {
    try_files /index.html =404;
  }

  location = /index.html {
    try_files /index.html =404;
  }

  location = /yunpanel-client.js {
    try_files /yunpanel-client.js =404;
  }

  location / {
    return 404;
  }
}
`;
}

export function previewElFinderNginxConfig(input = {}) {
  const content = renderElFinderNginxConfig(input);
  const digest = sha256(content);
  return Object.freeze({
    version: 1,
    sha256: digest,
    artifact: Object.freeze({
      path: elFinderNginxTemplatePolicy.configPath,
      sha256: digest,
      bytes: Buffer.byteLength(content),
      sensitive: false,
      mode: elFinderNginxTemplatePolicy.configMode,
    }),
    documentRoot: elFinderNginxTemplatePolicy.documentRoot,
    jqueryRoot: elFinderNginxTemplatePolicy.jqueryRoot,
    jqueryUiRoot: elFinderNginxTemplatePolicy.jqueryUiRoot,
    connectorPath: elFinderNginxTemplatePolicy.connectorPath,
    gatewaySocketPath: elFinderNginxTemplatePolicy.gatewaySocketPath,
    gatewaySocketMode: elFinderNginxTemplatePolicy.gatewaySocketMode,
    gatewaySocketOwner: elFinderNginxTemplatePolicy.gatewaySocketOwner,
    gatewaySocketGroup: elFinderNginxTemplatePolicy.gatewaySocketGroup,
    serviceUnit: elFinderNginxTemplatePolicy.serviceUnit,
    healthPath: elFinderNginxTemplatePolicy.healthPath,
  });
}

export const elFinderNginxTemplateInternals = Object.freeze({ exactPath, sha256 });
