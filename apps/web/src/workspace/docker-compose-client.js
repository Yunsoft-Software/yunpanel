import { panelRequest } from '../api.js';

const ACTIONS = new Set(['build', 'pull', 'start', 'stop', 'restart', 'remove']);

function projectPath(projectId) {
  if (typeof projectId !== 'string' || !projectId) throw new Error('dockerProjectId is required');
  return `/docker/projects/${encodeURIComponent(projectId)}`;
}

function action(value) {
  if (typeof value !== 'string' || !ACTIONS.has(value)) throw new Error('Unsupported Docker Compose action');
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${field} is invalid`);
  return value;
}

export function listDockerProjects() {
  return panelRequest('/docker/projects');
}

export function getDockerProject(projectId) {
  return panelRequest(projectPath(projectId));
}

export function getDockerProjectDocument(projectId) {
  return panelRequest(`${projectPath(projectId)}/document`);
}

export async function getDockerCatalog(query = '', { live = true, signal } = {}) {
  const params = new URLSearchParams();
  if (typeof query === 'string' && query.trim()) {
    params.set('q', query.trim());
  }
  if (live) {
    params.set('live', '1');
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const result = await panelRequest(`/docker/catalog${suffix}`, { signal });
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.data)) return result.data;
  return [];
}

export function generateDockerComposeFromImage({
  image,
  serviceName = '',
  targetPort = 80,
  publishedPort = 18080,
  hostIp = '127.0.0.1',
  protocol = 'tcp',
  environment = {},
} = {}) {
  if (typeof image !== 'string' || !image.trim()) {
    throw new Error('Docker image is required');
  }
  const cleanImage = image.trim();
  const baseImageName = cleanImage.split(':')[0].split('/').pop() || 'app';
  const rawService = typeof serviceName === 'string' && serviceName.trim()
    ? serviceName.trim().toLowerCase()
    : baseImageName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const resolvedService = /^[a-z0-9][a-z0-9_-]{0,62}$/.test(rawService) ? rawService : 'app';
  const innerPort = integer(Number(targetPort), 'targetPort', 1, 65535);
  const outerPort = integer(Number(publishedPort), 'publishedPort', 1024, 65535);
  const cleanHost = typeof hostIp === 'string' && hostIp.trim() ? hostIp.trim() : '127.0.0.1';
  const cleanProtocol = protocol === 'udp' ? 'udp' : 'tcp';

  const envEntries = environment && typeof environment === 'object' && !Array.isArray(environment)
    ? Object.entries(environment).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/i.test(k))
    : [];
  const envBlock = envEntries.length > 0
    ? `    environment:\n${envEntries.map(([k, v]) => `      ${k}: "${String(v ?? '').replace(/"/g, '\\"')}"`).join('\n')}\n`
    : '';

  const document = [
    'services:',
    `  ${resolvedService}:`,
    `    image: ${cleanImage}`,
    '    restart: unless-stopped',
    '    ports:',
    `      - "${cleanHost}:${outerPort}:${innerPort}/${cleanProtocol}"`,
  ].join('\n') + '\n' + envBlock;

  return Object.freeze({
    serviceName: resolvedService,
    image: cleanImage,
    targetPort: innerPort,
    publishedPort: outerPort,
    hostIp: cleanHost,
    protocol: cleanProtocol,
    document,
    toString() {
      return document;
    },
  });
}

export function resolveDockerProxyRule({
  projectId = null,
  serviceName = 'web',
  targetPort = 80,
  publishedPort = 18080,
  hostIp = '127.0.0.1',
  pathPrefix = '/',
  domainName = null,
  websocket = true,
} = {}) {
  const innerPort = integer(Number(targetPort), 'targetPort', 1, 65535);
  const outerPort = integer(Number(publishedPort ?? targetPort), 'publishedPort', 1, 65535);
  const cleanHost = typeof hostIp === 'string' && hostIp.trim() ? hostIp.trim() : '127.0.0.1';
  const rawPath = typeof pathPrefix === 'string' && pathPrefix.trim() ? pathPrefix.trim() : '/';
  const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return Object.freeze({
    projectId: projectId || null,
    serviceName: typeof serviceName === 'string' && serviceName.trim() ? serviceName.trim() : 'web',
    innerPort,
    outerPort,
    upstreamHost: cleanHost,
    upstreamPort: outerPort,
    upstreamUrl: `http://${cleanHost}:${outerPort}`,
    pathPrefix: normalizedPath,
    domainName: domainName || null,
    websocket: Boolean(websocket),
  });
}

export function getDockerStorageBackup(projectId) {
  return panelRequest(`${projectPath(projectId)}/storage-backup`);
}

export function validateDockerProject({ serverId, projectName, document, environment = {} } = {}) {
  if (typeof serverId !== 'string' || !serverId) throw new Error('serverId is required');
  if (typeof projectName !== 'string' || !projectName) throw new Error('projectName is required');
  if (typeof document !== 'string' || !document) throw new Error('document is required');
  return panelRequest('/docker/projects/validate', {
    method: 'POST',
    body: { serverId, projectName, document, environment },
  });
}

export function createDockerProject({ serverId, projectName, document } = {}) {
  if (typeof serverId !== 'string' || !serverId) throw new Error('serverId is required');
  if (typeof projectName !== 'string' || !projectName) throw new Error('projectName is required');
  if (typeof document !== 'string' || !document) throw new Error('document is required');
  return panelRequest('/docker/projects', { method: 'POST', body: { serverId, projectName, document } });
}

export function updateDockerProject(projectId, { expectedRevision, document } = {}) {
  integer(expectedRevision, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER);
  if (typeof document !== 'string' || !document) throw new Error('document is required');
  return panelRequest(projectPath(projectId), { method: 'PUT', body: { expectedRevision, document } });
}

export function getDockerEnvironment(projectId) {
  return panelRequest(`${projectPath(projectId)}/environment`);
}

export function replaceDockerEnvironment(projectId, { expectedRevision, variables } = {}) {
  integer(expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER);
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('variables are required');
  return panelRequest(`${projectPath(projectId)}/environment`, {
    method: 'PUT',
    body: { expectedRevision, variables },
  });
}

export function validateSavedDockerProject(projectId) {
  return panelRequest(`${projectPath(projectId)}/validate`, { method: 'POST', body: {} });
}

export function getDockerHistory(projectId) {
  return panelRequest(`${projectPath(projectId)}/history`);
}

export function getDockerRuntime(projectId) {
  return panelRequest(`${projectPath(projectId)}/runtime`);
}

export function getDockerDiagnosis(projectId, { service, targetPort } = {}) {
  if (typeof service !== 'string' || !service) throw new Error('service is required');
  integer(targetPort, 'targetPort', 1, 65535);
  const query = new URLSearchParams({ service, targetPort: String(targetPort) });
  return panelRequest(`${projectPath(projectId)}/diagnosis?${query}`);
}

export function getDockerLogs(projectId, { service = null, tail = 200 } = {}) {
  integer(tail, 'tail', 1, 9999);
  if (service !== null && (typeof service !== 'string' || !service)) throw new Error('service is invalid');
  const query = new URLSearchParams({ tail: String(tail) });
  if (service) query.set('service', service);
  return panelRequest(`${projectPath(projectId)}/logs?${query}`);
}

export function previewDockerAction(projectId, requestedAction) {
  const selected = action(requestedAction);
  return panelRequest(`${projectPath(projectId)}/operations/${selected}/preview`, { method: 'POST', body: {} });
}

export function applyDockerAction(projectId, requestedAction, preview) {
  const selected = action(requestedAction);
  if (!preview || typeof preview.previewDigest !== 'string' || typeof preview.confirmation !== 'string') {
    throw new Error('Current Docker Compose operation preview is required');
  }
  return panelRequest(`${projectPath(projectId)}/operations/${selected}`, {
    method: 'POST',
    body: { expectedPreviewDigest: preview.previewDigest, confirmation: preview.confirmation },
  });
}

export function getDockerCredentials(projectId) {
  return panelRequest(`${projectPath(projectId)}/credentials`);
}

export function setDockerCredential(projectId, { registryHost, expectedRevision, username, secret } = {}) {
  if (typeof registryHost !== 'string' || !registryHost) throw new Error('registryHost is required');
  integer(expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER);
  if (typeof username !== 'string' || typeof secret !== 'string') throw new Error('Docker registry credential is invalid');
  return panelRequest(`${projectPath(projectId)}/credentials`, {
    method: 'PUT',
    body: { registryHost, expectedRevision, username, secret },
  });
}

export const dockerComposeClientInternals = Object.freeze({ projectPath, action, integer });
