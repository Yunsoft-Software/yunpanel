import path from 'node:path';

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const IMAGE_NAME_PATTERN = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/i;
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const ALLOWED_BIND_HOSTS = new Set(['127.0.0.1', '0.0.0.0']);
const ALLOWED_RESTART_POLICIES = new Set(['unless-stopped', 'always', 'on-failure', 'no']);
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const URL_PATH_PATTERN = /^\/(?:[A-Za-z0-9._~:@!$&'()*+,;=-]+(?:\/[A-Za-z0-9._~:@!$&'()*+,;=-]+)*)?$/;

export class DockerPleskCatalogError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DockerPleskCatalogError';
    this.code = code;
    this.status = status;
  }
}

const RAW_CATALOG = [
  {
    id: 'redis',
    name: 'Redis',
    description: 'High-performance in-memory key-value data store, cache, and message broker.',
    category: 'cache',
    kind: 'image',
    image: 'redis',
    serviceName: 'redis',
    tags: ['7-alpine', '7.4-alpine', '7.2', 'latest'],
    defaultTag: '7-alpine',
    targetPort: 6379,
    publishedPort: 16379,
    volumes: [
      { source: 'redis_data', target: '/data', kind: 'named_volume', readOnly: false },
    ],
    environment: [],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Advanced open-source relational database container with persistent volume.',
    category: 'database',
    kind: 'image',
    image: 'postgres',
    serviceName: 'postgres',
    tags: ['16-alpine', '16', '15-alpine', '17-alpine'],
    defaultTag: '16-alpine',
    targetPort: 5432,
    publishedPort: 15432,
    volumes: [
      { source: 'postgres_data', target: '/var/lib/postgresql/data', kind: 'named_volume', readOnly: false },
    ],
    environment: [
      { key: 'POSTGRES_DB', defaultValue: 'app_db', secret: false },
      { key: 'POSTGRES_USER', defaultValue: 'app_user', secret: false },
      { key: 'POSTGRES_PASSWORD', defaultValue: 'change_me', secret: true },
    ],
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    description: 'MySQL-compatible relational database server for web applications.',
    category: 'database',
    kind: 'image',
    image: 'mariadb',
    serviceName: 'mariadb',
    tags: ['11.4', '10.11', 'latest'],
    defaultTag: '11.4',
    targetPort: 3306,
    publishedPort: 13306,
    volumes: [
      { source: 'mariadb_data', target: '/var/lib/mysql', kind: 'named_volume', readOnly: false },
    ],
    environment: [
      { key: 'MARIADB_DATABASE', defaultValue: 'app_db', secret: false },
      { key: 'MARIADB_USER', defaultValue: 'app_user', secret: false },
      { key: 'MARIADB_PASSWORD', defaultValue: 'change_me', secret: true },
      { key: 'MARIADB_ROOT_PASSWORD', defaultValue: 'change_root_me', secret: true },
    ],
  },
  {
    id: 'nginx',
    name: 'Nginx Web Server',
    description: 'Lightweight high-concurrency HTTP web server and static asset container.',
    category: 'web',
    kind: 'image',
    image: 'nginx',
    serviceName: 'nginx',
    tags: ['1.27-alpine', '1.28-alpine', 'stable-alpine', 'latest'],
    defaultTag: '1.27-alpine',
    targetPort: 80,
    publishedPort: 18080,
    volumes: [
      { source: './html', target: '/usr/share/nginx/html', kind: 'bind', readOnly: true },
    ],
    environment: [],
  },
  {
    id: 'n8n',
    name: 'n8n Workflow Automation',
    description: 'Self-hosted workflow automation and AI agent orchestration stack.',
    category: 'automation',
    kind: 'stack',
    image: 'n8nio/n8n',
    serviceName: 'n8n',
    tags: ['latest', '1.60.0'],
    defaultTag: 'latest',
    targetPort: 5678,
    publishedPort: 15678,
    volumes: [
      { source: 'n8n_data', target: '/home/node/.n8n', kind: 'named_volume', readOnly: false },
    ],
    environment: [
      { key: 'N8N_PORT', defaultValue: '5678', secret: false },
      { key: 'GENERIC_TIMEZONE', defaultValue: 'Europe/Istanbul', secret: false },
    ],
  },
  {
    id: 'ghost',
    name: 'Ghost Publishing Stack',
    description: 'Modern headless Node.js CMS and newsletter publishing platform.',
    category: 'cms',
    kind: 'stack',
    image: 'ghost',
    serviceName: 'ghost',
    tags: ['5-alpine', '5', 'latest'],
    defaultTag: '5-alpine',
    targetPort: 2368,
    publishedPort: 12368,
    volumes: [
      { source: 'ghost_content', target: '/var/lib/ghost/content', kind: 'named_volume', readOnly: false },
    ],
    environment: [
      { key: 'NODE_ENV', defaultValue: 'production', secret: false },
      { key: 'url', defaultValue: 'http://localhost:2368', secret: false },
    ],
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    description: 'Self-hosted uptime monitoring dashboard for HTTP, TCP, and DNS services.',
    category: 'monitoring',
    kind: 'stack',
    image: 'louislam/uptime-kuma',
    serviceName: 'uptime_kuma',
    tags: ['1', 'latest'],
    defaultTag: '1',
    targetPort: 3001,
    publishedPort: 13001,
    volumes: [
      { source: 'uptime_kuma_data', target: '/app/data', kind: 'named_volume', readOnly: false },
    ],
    environment: [],
  },
  {
    id: 'minio',
    name: 'MinIO Object Storage',
    description: 'High-performance S3-compatible object storage server.',
    category: 'storage',
    kind: 'stack',
    image: 'minio/minio',
    serviceName: 'minio',
    tags: ['latest', 'RELEASE.2025-01-20T14-49-07Z'],
    defaultTag: 'latest',
    targetPort: 9000,
    publishedPort: 19000,
    volumes: [
      { source: 'minio_data', target: '/data', kind: 'named_volume', readOnly: false },
    ],
    environment: [
      { key: 'MINIO_ROOT_USER', defaultValue: 'minioadmin', secret: false },
      { key: 'MINIO_ROOT_PASSWORD', defaultValue: 'minioadmin123', secret: true },
    ],
  },
  {
    id: 'wordpress-stack',
    name: 'WordPress Container Stack',
    description: 'Containerized WordPress runtime ready for domain or subdomain reverse proxy.',
    category: 'cms',
    kind: 'stack',
    image: 'wordpress',
    serviceName: 'wordpress',
    tags: ['6.7-php8.3-apache', 'php8.3-fpm-alpine', 'latest'],
    defaultTag: '6.7-php8.3-apache',
    targetPort: 80,
    publishedPort: 18081,
    volumes: [
      { source: 'wp_html', target: '/var/www/html', kind: 'named_volume', readOnly: false },
    ],
    environment: [
      { key: 'WORDPRESS_DB_HOST', defaultValue: '127.0.0.1:3306', secret: false },
      { key: 'WORDPRESS_DB_NAME', defaultValue: 'wordpress', secret: false },
      { key: 'WORDPRESS_DB_USER', defaultValue: 'wp_user', secret: false },
      { key: 'WORDPRESS_DB_PASSWORD', defaultValue: 'change_me', secret: true },
    ],
  },
  {
    id: 'node-app',
    name: 'Node.js Application Stack',
    description: 'Production Node.js web/API container bound to loopback for domain or subdomain proxy.',
    category: 'runtime',
    kind: 'stack',
    image: 'node',
    serviceName: 'node_app',
    tags: ['22-alpine', '20-alpine', '18-alpine'],
    defaultTag: '22-alpine',
    targetPort: 3000,
    publishedPort: 13000,
    volumes: [
      { source: './app', target: '/usr/src/app', kind: 'bind', readOnly: false },
    ],
    environment: [
      { key: 'NODE_ENV', defaultValue: 'production', secret: false },
      { key: 'PORT', defaultValue: '3000', secret: false },
    ],
  },
];

function yamlScalar(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./:@-]+$/.test(text) && !/^(?:true|false|null|yes|no|on|off|\d+)$/i.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function normalizePort(value, fieldName) {
  const num = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(num) || num < 1 || num > 65535) {
    throw new DockerPleskCatalogError(`invalid_${fieldName}`, `${fieldName} must be an integer between 1 and 65535`);
  }
  return num;
}

function normalizeVolumesInput(volumes = []) {
  if (volumes == null) return [];
  if (!Array.isArray(volumes) || volumes.length > 64) {
    throw new DockerPleskCatalogError('invalid_volumes', 'volumes must be an array of at most 64 volume mounts');
  }
  return volumes.map((entry) => {
    if (typeof entry === 'string') {
      const parts = entry.split(':');
      if (parts.length < 2 || parts.length > 3) {
        throw new DockerPleskCatalogError('invalid_volume_mount', 'Volume mount string must be source:target[:ro]');
      }
      const [source, target, mode] = parts;
      return validateVolumeObject({
        source,
        target,
        readOnly: mode === 'ro',
      });
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DockerPleskCatalogError('invalid_volume_mount', 'Volume mount entry must be an object or string');
    }
    return validateVolumeObject(entry);
  });
}

function validateVolumeObject({ source, target, kind, readOnly = false }) {
  if (typeof source !== 'string' || !source.trim() || source.includes('..') || /[\u0000-\u001f\u007f]/.test(source)) {
    throw new DockerPleskCatalogError('invalid_volume_source', 'Volume source is invalid');
  }
  if (typeof target !== 'string' || !path.posix.isAbsolute(target) || target.includes('..') || /[\u0000-\u001f\u007f]/.test(target)) {
    throw new DockerPleskCatalogError('invalid_volume_target', 'Volume target must be a safe absolute container path');
  }
  const trimmedSource = source.trim();
  const isBind = kind === 'bind' || trimmedSource.startsWith('./') || trimmedSource.startsWith('/');
  if (!isBind && !VOLUME_NAME_PATTERN.test(trimmedSource)) {
    throw new DockerPleskCatalogError('invalid_volume_source', 'Named volume source is invalid');
  }
  return Object.freeze({
    source: trimmedSource,
    target: path.posix.normalize(target),
    kind: isBind ? 'bind' : 'named_volume',
    readOnly: Boolean(readOnly),
  });
}

function normalizeEnvironmentInput(environment = {}) {
  if (environment == null) return {};
  const result = {};
  if (Array.isArray(environment)) {
    for (const item of environment) {
      if (!item || typeof item !== 'object') {
        throw new DockerPleskCatalogError('invalid_environment', 'Environment array items must be objects');
      }
      const key = item.key ?? item.name;
      const value = item.value ?? item.defaultValue ?? '';
      if (typeof key !== 'string' || !ENV_KEY_PATTERN.test(key)) {
        throw new DockerPleskCatalogError('invalid_environment_key', `Environment variable key "${key}" is invalid`);
      }
      result[key] = String(value);
    }
    return result;
  }
  if (typeof environment !== 'object') {
    throw new DockerPleskCatalogError('invalid_environment', 'environment must be an object or array');
  }
  for (const [key, value] of Object.entries(environment)) {
    if (!ENV_KEY_PATTERN.test(key) || value === null || typeof value === 'object') {
      throw new DockerPleskCatalogError('invalid_environment_key', `Environment variable "${key}" is invalid`);
    }
    result[key] = String(value);
  }
  return result;
}

function deriveServiceName(image, explicitServiceName = null) {
  if (explicitServiceName != null) {
    if (typeof explicitServiceName !== 'string' || !SERVICE_NAME_PATTERN.test(explicitServiceName)) {
      throw new DockerPleskCatalogError('invalid_service_name', 'Docker Compose service name is invalid');
    }
    return explicitServiceName;
  }
  const base = image.split('/').pop().split(':')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
  return SERVICE_NAME_PATTERN.test(base) ? base : 'app';
}

export function generateComposeFromCatalogInput({
  projectName,
  serviceName = null,
  image,
  tag = null,
  innerPort = null,
  outerPort = null,
  targetPort = null,
  publishedPort = null,
  bindHost = '127.0.0.1',
  restartPolicy = 'unless-stopped',
  volumes = null,
  environment = null,
} = {}) {
  if (typeof projectName !== 'string' || !PROJECT_NAME_PATTERN.test(projectName)) {
    throw new DockerPleskCatalogError('invalid_project_name', 'projectName must match /^[a-z0-9][a-z0-9_-]{0,62}$/');
  }
  if (typeof image !== 'string' || !image.trim()) {
    throw new DockerPleskCatalogError('invalid_image', 'Docker image name is required');
  }

  const trimmedImage = image.trim();
  const catalogMatch = RAW_CATALOG.find(
    (entry) => entry.id === trimmedImage.toLowerCase() || entry.image.toLowerCase() === trimmedImage.toLowerCase(),
  ) ?? null;

  let resolvedImage = catalogMatch ? catalogMatch.image : trimmedImage;
  let resolvedTag = tag;
  if (resolvedImage.includes(':') && !resolvedTag) {
    const [imgPart, tagPart] = resolvedImage.split(':', 2);
    resolvedImage = imgPart;
    resolvedTag = tagPart;
  }
  if (!IMAGE_NAME_PATTERN.test(resolvedImage)) {
    throw new DockerPleskCatalogError('invalid_image', 'Docker image reference is invalid');
  }
  resolvedTag = resolvedTag ?? catalogMatch?.defaultTag ?? 'latest';
  if (typeof resolvedTag !== 'string' || !IMAGE_TAG_PATTERN.test(resolvedTag)) {
    throw new DockerPleskCatalogError('invalid_image_tag', 'Docker image tag is invalid');
  }

  const resolvedServiceName = deriveServiceName(
    resolvedImage,
    serviceName ?? catalogMatch?.serviceName ?? null,
  );

  const rawInnerPort = innerPort ?? targetPort ?? catalogMatch?.targetPort;
  const rawOuterPort = outerPort ?? publishedPort ?? catalogMatch?.publishedPort;
  const resolvedInnerPort = normalizePort(rawInnerPort, 'inner_port');
  const resolvedOuterPort = normalizePort(rawOuterPort, 'outer_port');

  if (typeof bindHost !== 'string' || !ALLOWED_BIND_HOSTS.has(bindHost)) {
    throw new DockerPleskCatalogError('invalid_bind_host', 'bindHost must be 127.0.0.1 or 0.0.0.0');
  }
  if (typeof restartPolicy !== 'string' || !ALLOWED_RESTART_POLICIES.has(restartPolicy)) {
    throw new DockerPleskCatalogError(
      'invalid_restart_policy',
      'restartPolicy must be unless-stopped, always, on-failure, or no',
    );
  }

  const normalizedVolumes = normalizeVolumesInput(
    volumes !== null ? volumes : (catalogMatch?.volumes ?? []),
  );
  const normalizedEnvironment = normalizeEnvironmentInput(
    environment !== null ? environment : (catalogMatch?.environment ?? {}),
  );

  const lines = [
    'services:',
    `  ${resolvedServiceName}:`,
    `    image: ${resolvedImage}:${resolvedTag}`,
    `    restart: ${restartPolicy}`,
    '    ports:',
    `      - "${bindHost}:${resolvedOuterPort}:${resolvedInnerPort}/tcp"`,
  ];

  const envEntries = Object.entries(normalizedEnvironment);
  if (envEntries.length > 0) {
    lines.push('    environment:');
    for (const [key, value] of envEntries) {
      lines.push(`      ${key}: ${yamlScalar(value)}`);
    }
  }

  if (normalizedVolumes.length > 0) {
    lines.push('    volumes:');
    for (const mount of normalizedVolumes) {
      const suffix = mount.readOnly ? ':ro' : '';
      lines.push(`      - "${mount.source}:${mount.target}${suffix}"`);
    }
  }

  const namedVolumes = normalizedVolumes.filter((mount) => mount.kind === 'named_volume');
  if (namedVolumes.length > 0) {
    lines.push('volumes:');
    for (const mount of namedVolumes) {
      lines.push(`  ${mount.source}: {}`);
    }
  }

  const document = `${lines.join('\n')}\n`;

  return Object.freeze({
    projectName,
    serviceName: resolvedServiceName,
    image: `${resolvedImage}:${resolvedTag}`,
    imageRepository: resolvedImage,
    tag: resolvedTag,
    restartPolicy,
    document,
    portMapping: Object.freeze({
      innerPort: resolvedInnerPort,
      outerPort: resolvedOuterPort,
      targetPort: resolvedInnerPort,
      publishedPort: resolvedOuterPort,
      bindHost,
      protocol: 'tcp',
    }),
    volumes: Object.freeze(normalizedVolumes),
    environment: Object.freeze(normalizedEnvironment),
  });
}

export const PLESK_DOCKER_CATALOG = Object.freeze(
  RAW_CATALOG.map((item) => {
    const generated = generateComposeFromCatalogInput({
      projectName: item.id.replace(/[^a-z0-9_-]/g, '_'),
      serviceName: item.serviceName,
      image: item.image,
      tag: item.defaultTag,
      innerPort: item.targetPort,
      outerPort: item.publishedPort,
      bindHost: '127.0.0.1',
      volumes: item.volumes,
      environment: item.environment,
    });
    return Object.freeze({
      id: item.id,
      name: item.name,
      description: item.description,
      category: item.category,
      kind: item.kind,
      image: item.image,
      serviceName: item.serviceName,
      tags: Object.freeze([...item.tags]),
      defaultTag: item.defaultTag,
      innerPort: item.targetPort,
      targetPort: item.targetPort,
      outerPort: item.publishedPort,
      publishedPort: item.publishedPort,
      bindHost: '127.0.0.1',
      protocol: 'tcp',
      volumes: Object.freeze(item.volumes.map((v) => Object.freeze({ ...v }))),
      environment: Object.freeze(item.environment.map((e) => Object.freeze({ ...e }))),
      defaultComposeDocument: generated.document,
    });
  }),
);

export function searchDockerCatalog({ q = '', category = null, kind = null } = {}) {
  if (q !== undefined && q !== null && typeof q !== 'string') {
    throw new DockerPleskCatalogError('invalid_catalog_query', 'Catalog search query must be a string');
  }
  const term = String(q ?? '').trim().toLowerCase();
  const normalizedCategory = category ? String(category).trim().toLowerCase() : null;
  const normalizedKind = kind ? String(kind).trim().toLowerCase() : null;

  const filtered = PLESK_DOCKER_CATALOG.filter((item) => {
    if (normalizedCategory && item.category.toLowerCase() !== normalizedCategory) return false;
    if (normalizedKind && item.kind.toLowerCase() !== normalizedKind) return false;
    if (!term) return true;
    return (
      item.id.toLowerCase().includes(term)
      || item.name.toLowerCase().includes(term)
      || item.description.toLowerCase().includes(term)
      || item.image.toLowerCase().includes(term)
      || item.category.toLowerCase().includes(term)
      || item.tags.some((tag) => tag.toLowerCase().includes(term))
    );
  });

  return Object.freeze(filtered);
}

const KNOWN_HUB_PORT_PRESETS = [
  { match: /^(?:library\/)?(?:redis|valkey|dragonfly|keydb)(?:$|\/|-)/i, targetPort: 6379, publishedPort: 16379, category: 'cache' },
  { match: /^(?:library\/)?(?:postgres|postgis|timescale|pgvector)(?:$|\/|-)/i, targetPort: 5432, publishedPort: 15432, category: 'database' },
  { match: /^(?:library\/)?(?:mariadb|mysql|percona)(?:$|\/|-)/i, targetPort: 3306, publishedPort: 13306, category: 'database' },
  { match: /^(?:library\/)?(?:mongo|mongodb)(?:$|\/|-)/i, targetPort: 27017, publishedPort: 27017, category: 'database' },
  { match: /(?:^|\/)grafana(?:$|-)/i, targetPort: 3000, publishedPort: 13000, category: 'monitoring' },
  { match: /(?:^|\/)prometheus(?:$|-)/i, targetPort: 9090, publishedPort: 19090, category: 'monitoring' },
  { match: /(?:^|\/)uptime-kuma(?:$|-)/i, targetPort: 3001, publishedPort: 13001, category: 'monitoring' },
  { match: /(?:^|\/)portainer(?:$|-)/i, targetPort: 9000, publishedPort: 19000, category: 'management' },
  { match: /(?:^|\/)ghost(?:$|-)/i, targetPort: 2368, publishedPort: 12368, category: 'cms' },
  { match: /(?:^|\/)n8n(?:$|-)/i, targetPort: 5678, publishedPort: 15678, category: 'automation' },
  { match: /(?:^|\/)minio(?:$|-)/i, targetPort: 9000, publishedPort: 19000, category: 'storage' },
  { match: /(?:^|\/)(?:meilisearch)(?:$|-)/i, targetPort: 7700, publishedPort: 17700, category: 'search' },
  { match: /(?:^|\/)(?:elasticsearch|opensearch)(?:$|-)/i, targetPort: 9200, publishedPort: 19200, category: 'search' },
  { match: /(?:^|\/)kibana(?:$|-)/i, targetPort: 5601, publishedPort: 15601, category: 'monitoring' },
  { match: /(?:^|\/)rabbitmq(?:$|-)/i, targetPort: 15672, publishedPort: 15672, category: 'queue' },
  { match: /(?:^|\/)(?:keycloak|jenkins|adminer|open-webui|traefik)(?:$|-)/i, targetPort: 8080, publishedPort: 18080, category: 'web' },
  { match: /(?:^|\/)(?:gitea|metabase|node)(?:$|-)/i, targetPort: 3000, publishedPort: 13000, category: 'runtime' },
  { match: /(?:^|\/)(?:ollama)(?:$|-)/i, targetPort: 11434, publishedPort: 11434, category: 'ai' },
  { match: /(?:^|\/)(?:nginx|httpd|apache|caddy|wordpress|nextcloud|phpmyadmin|vaultwarden)(?:$|-)/i, targetPort: 80, publishedPort: 18080, category: 'web' },
];

export function inferDockerHubPortPreset(repoName = '') {
  const clean = String(repoName ?? '').trim().toLowerCase();
  for (const preset of KNOWN_HUB_PORT_PRESETS) {
    if (preset.match.test(clean)) {
      return preset;
    }
  }
  let hash = 0;
  for (let i = 0; i < clean.length; i += 1) {
    hash = ((hash << 5) - hash + clean.charCodeAt(i)) | 0;
  }
  const offset = Math.abs(hash) % 900;
  return {
    targetPort: 8080,
    publishedPort: 18100 + offset,
    category: 'container',
  };
}

export async function searchDockerCatalogLive({
  q = '',
  category = null,
  kind = null,
  pageSize = 24,
  fetchImpl = globalThis.fetch,
} = {}) {
  const localMatches = searchDockerCatalog({ q, category, kind });
  const term = String(q ?? '').trim();
  if (!term || typeof fetchImpl !== 'function') {
    return Object.freeze(localMatches.map((item) => Object.freeze({
      ...item,
      label: item.name,
      official: !item.image.includes('/'),
      source: 'curated',
    })));
  }

  const normalizedCategory = category ? String(category).trim().toLowerCase() : null;
  const limit = Math.max(1, Math.min(50, Number(pageSize) || 24));
  const url = `https://hub.docker.com/v2/search/repositories/?query=${encodeURIComponent(term)}&page_size=${limit}`;

  let hubResults = [];
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'YunPanel-Docker-Catalog/2.0',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (response.ok) {
      const payload = await response.json();
      if (Array.isArray(payload?.results)) {
        hubResults = payload.results;
      }
    }
  } catch {
    // Fall back gracefully to curated catalog if network/Docker Hub is unreachable
    return Object.freeze(localMatches.map((item) => Object.freeze({
      ...item,
      label: item.name,
      official: !item.image.includes('/'),
      source: 'curated',
    })));
  }

  const lowerTerm = term.toLowerCase();
  const sortedHub = [...hubResults].sort((a, b) => {
    const nameA = String(a?.repo_name ?? '').toLowerCase();
    const nameB = String(b?.repo_name ?? '').toLowerCase();
    const exactA = nameA === lowerTerm || nameA === `${lowerTerm}/${lowerTerm}` || nameA.endsWith(`/${lowerTerm}`) ? 1 : 0;
    const exactB = nameB === lowerTerm || nameB === `${lowerTerm}/${lowerTerm}` || nameB.endsWith(`/${lowerTerm}`) ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;
    const offA = a?.is_official ? 1 : 0;
    const offB = b?.is_official ? 1 : 0;
    if (offA !== offB) return offB - offA;
    return Number(b?.star_count ?? 0) - Number(a?.star_count ?? 0);
  });

  const merged = [];
  const seenImages = new Set();

  for (const curated of localMatches) {
    const baseImage = curated.image.split(':')[0].toLowerCase();
    seenImages.add(baseImage);
    const matchingHub = sortedHub.find((r) => String(r?.repo_name ?? '').toLowerCase() === baseImage);
    merged.push(Object.freeze({
      ...curated,
      label: curated.name,
      starCount: Number(matchingHub?.star_count ?? 0),
      pullCount: Number(matchingHub?.pull_count ?? 0),
      official: matchingHub ? Boolean(matchingHub.is_official) : !curated.image.includes('/'),
      source: 'curated',
    }));
  }

  for (const repo of sortedHub) {
    const repoName = String(repo?.repo_name ?? '').trim();
    if (!repoName || !IMAGE_NAME_PATTERN.test(repoName)) continue;
    const lowerRepo = repoName.toLowerCase();
    if (seenImages.has(lowerRepo)) continue;

    const preset = inferDockerHubPortPreset(repoName);
    if (normalizedCategory && preset.category !== normalizedCategory) continue;

    const shortName = repoName.split('/').pop() || 'app';
    const cleanService = shortName.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^[^a-z0-9]+/, '') || 'app';
    const safeServiceName = SERVICE_NAME_PATTERN.test(cleanService) ? cleanService : 'app';
    const safeProjectName = PROJECT_NAME_PATTERN.test(`${safeServiceName}_stack`) ? `${safeServiceName}_stack` : 'docker_stack';

    let generatedDoc = `services:\n  ${safeServiceName}:\n    image: ${repoName}:latest\n    restart: unless-stopped\n    ports:\n      - "127.0.0.1:${preset.publishedPort}:${preset.targetPort}/tcp"\n`;
    try {
      const generated = generateComposeFromCatalogInput({
        projectName: safeProjectName,
        serviceName: safeServiceName,
        image: repoName,
        tag: 'latest',
        innerPort: preset.targetPort,
        outerPort: preset.publishedPort,
        bindHost: '127.0.0.1',
      });
      generatedDoc = generated.document;
    } catch {
      // keep fallback YAML
    }

    seenImages.add(lowerRepo);
    merged.push(Object.freeze({
      id: `hub:${repoName}`,
      name: repoName,
      label: repoName,
      description: String(repo?.short_description ?? '').trim() || 'Docker Hub konteyner imajı',
      category: preset.category,
      kind: 'image',
      image: `${repoName}:latest`,
      repository: repoName,
      serviceName: safeServiceName,
      tags: Object.freeze(['latest', 'alpine', 'stable']),
      defaultTag: 'latest',
      innerPort: preset.targetPort,
      targetPort: preset.targetPort,
      outerPort: preset.publishedPort,
      publishedPort: preset.publishedPort,
      bindHost: '127.0.0.1',
      protocol: 'tcp',
      volumes: Object.freeze([]),
      environment: Object.freeze([]),
      starCount: Number(repo?.star_count ?? 0),
      pullCount: Number(repo?.pull_count ?? 0),
      official: Boolean(repo?.is_official),
      automated: Boolean(repo?.is_automated),
      source: 'docker_hub',
      defaultComposeDocument: generatedDoc,
    }));
  }

  return Object.freeze(merged);
}

function normalizeProxyHostname(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new DockerPleskCatalogError('invalid_proxy_hostname', 'A target domain or subdomain hostname is required');
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length > 253 || trimmed.includes('..') || trimmed.includes('/')) {
    throw new DockerPleskCatalogError('invalid_proxy_hostname', 'Proxy target hostname is invalid');
  }
  const labels = trimmed.split('.');
  if (labels.length < 2 || labels.some((label) => !DNS_LABEL_PATTERN.test(label))) {
    throw new DockerPleskCatalogError('invalid_proxy_hostname', 'Proxy target hostname must be a valid FQDN');
  }
  return trimmed;
}

function normalizeUrlPath(rawPath = '/') {
  if (rawPath === undefined || rawPath === null || rawPath === '') return '/';
  if (typeof rawPath !== 'string') {
    throw new DockerPleskCatalogError('invalid_proxy_url_path', 'urlPath must be a string starting with /');
  }
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('..') || trimmed.includes('//') || !URL_PATH_PATTERN.test(trimmed)) {
    throw new DockerPleskCatalogError('invalid_proxy_url_path', 'urlPath must be a normalized URL path starting with /');
  }
  return trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export async function resolveDockerProxyRule(
  input = {},
  {
    dockerComposeProjectRegistry = null,
    domainRegistry = null,
    localServerId = null,
  } = {},
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DockerPleskCatalogError('invalid_proxy_rule_input', 'Proxy rule payload must be an object');
  }

  let rawHostname = input.hostname ?? input.primaryDomain ?? null;
  let resolvedDomainId = input.domainId ?? null;

  if (!rawHostname && resolvedDomainId && domainRegistry && typeof domainRegistry.getDomain === 'function') {
    const domainRecord = await domainRegistry.getDomain(resolvedDomainId);
    if (!domainRecord) {
      throw new DockerPleskCatalogError('proxy_domain_not_found', 'Target domain or subdomain was not found', 404);
    }
    rawHostname = domainRecord.primaryDomain;
  } else if (!rawHostname && typeof resolvedDomainId === 'string' && resolvedDomainId.includes('.')) {
    rawHostname = resolvedDomainId;
  }

  const hostname = normalizeProxyHostname(rawHostname);
  const urlPath = normalizeUrlPath(input.urlPath ?? '/');

  let project = input.project ?? null;
  const projectId = input.projectId ?? project?.id ?? null;

  if (!project && projectId) {
    if (!dockerComposeProjectRegistry || typeof dockerComposeProjectRegistry.getProject !== 'function') {
      throw new DockerPleskCatalogError('docker_project_registry_unavailable', 'Docker project registry is required to resolve projectId', 503);
    }
    project = await dockerComposeProjectRegistry.getProject(projectId);
    if (!project || (localServerId && project.serverId && project.serverId !== localServerId)) {
      throw new DockerPleskCatalogError('docker_compose_project_not_found', 'Docker Compose project was not found', 404);
    }
  }

  let resolvedServiceName = input.serviceName ?? null;
  let resolvedInnerPort = input.innerPort ?? input.targetPort ?? null;
  let resolvedOuterPort = input.outerPort ?? input.publishedPort ?? null;

  if (project) {
    const services = Array.isArray(project.services) ? project.services : [];
    const service = resolvedServiceName
      ? services.find((candidate) => candidate?.name === resolvedServiceName)
      : (services.length === 1 ? services[0] : null);

    if (!service) {
      throw new DockerPleskCatalogError(
        'docker_proxy_service_not_found',
        'Specified service was not found in the Docker Compose project',
        404,
      );
    }
    resolvedServiceName = service.name;
    const publishedPorts = Array.isArray(service.publishedPorts) ? service.publishedPorts : [];
    if (resolvedInnerPort == null && publishedPorts.length === 1) {
      resolvedInnerPort = publishedPorts[0].targetPort;
    }
    resolvedInnerPort = normalizePort(resolvedInnerPort, 'inner_port');

    const matches = publishedPorts.filter(
      (port) => port?.targetPort === resolvedInnerPort && (port?.protocol ?? 'tcp') === 'tcp',
    );
    if (matches.length === 0) {
      throw new DockerPleskCatalogError(
        'docker_proxy_port_not_published',
        `Service "${resolvedServiceName}" does not publish inner port ${resolvedInnerPort}/tcp on the host`,
        409,
      );
    }
    const chosen = matches.find((port) => port.hostIp === '127.0.0.1') ?? matches[0];
    if (
      chosen.hostIp !== null
      && chosen.hostIp !== undefined
      && chosen.hostIp !== '127.0.0.1'
      && chosen.hostIp !== '0.0.0.0'
      && chosen.hostIp !== '::1'
      && chosen.hostIp !== '::'
    ) {
      throw new DockerPleskCatalogError(
        'docker_proxy_binding_not_loopback',
        'Container port must be bound to 127.0.0.1 or wildcard to proxy safely',
        409,
      );
    }
    resolvedOuterPort = normalizePort(chosen.publishedPort, 'outer_port');
  } else {
    if (typeof resolvedServiceName !== 'string' || !SERVICE_NAME_PATTERN.test(resolvedServiceName)) {
      throw new DockerPleskCatalogError('invalid_service_name', 'serviceName is required');
    }
    resolvedInnerPort = normalizePort(resolvedInnerPort, 'inner_port');
    resolvedOuterPort = normalizePort(resolvedOuterPort, 'outer_port');
  }

  return Object.freeze({
    domainId: resolvedDomainId,
    projectId: project?.id ?? projectId ?? null,
    projectName: project?.projectName ?? null,
    hostname,
    urlPath,
    serviceName: resolvedServiceName,
    innerPort: resolvedInnerPort,
    targetPort: resolvedInnerPort,
    outerPort: resolvedOuterPort,
    publishedPort: resolvedOuterPort,
    upstreamHost: '127.0.0.1',
    upstreamPort: resolvedOuterPort,
    websocket: true,
    protocol: 'tcp',
  });
}
