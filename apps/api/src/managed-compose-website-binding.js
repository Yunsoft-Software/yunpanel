import { isIP } from 'node:net';
import { assertUuid } from '@yunpanel/shared';

const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const SUPPORTED_PROTOCOL = 'tcp';

export class ManagedComposeWebsiteBindingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ManagedComposeWebsiteBindingError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new ManagedComposeWebsiteBindingError(
      `invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      `${field} is invalid`,
    );
  }
}

function serviceName(value) {
  if (typeof value !== 'string' || !SERVICE_NAME_PATTERN.test(value)) {
    throw new ManagedComposeWebsiteBindingError('invalid_managed_compose_service_name', 'Managed Compose service name is invalid');
  }
  return value;
}

function targetPort(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new ManagedComposeWebsiteBindingError('invalid_managed_compose_target_port', 'Managed Compose target port must be between 1 and 65535');
  }
  return value;
}

function protocol(value) {
  const normalized = value ?? SUPPORTED_PROTOCOL;
  if (normalized !== SUPPORTED_PROTOCOL) {
    throw new ManagedComposeWebsiteBindingError('managed_compose_protocol_unsupported', 'Managed Compose Website bindings currently support TCP only');
  }
  return normalized;
}

export function normalizeManagedComposeWebsiteBinding(value, { persisted = false } = {}) {
  if (value === null) return null;
  const allowed = new Set(['projectId', 'serviceName', 'targetPort', 'protocol']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))
    || (persisted && Object.keys(value).length !== allowed.size)) {
    throw new ManagedComposeWebsiteBindingError(
      'invalid_managed_compose_binding',
      'Managed Compose binding must contain only projectId, serviceName, targetPort and protocol',
    );
  }
  return Object.freeze({
    projectId: uuid(value.projectId, 'dockerProjectId'),
    serviceName: serviceName(value.serviceName),
    targetPort: targetPort(value.targetPort),
    protocol: protocol(value.protocol),
  });
}

function normalizedHost(hostIp) {
  if (hostIp === null || hostIp === '0.0.0.0') return '127.0.0.1';
  if (hostIp === '::') return '::1';
  if (typeof hostIp !== 'string' || isIP(hostIp) === 0) {
    throw new ManagedComposeWebsiteBindingError(
      'managed_compose_published_binding_invalid',
      'Managed Compose published host binding is invalid',
      409,
    );
  }
  return hostIp;
}

export function resolveManagedComposeWebsiteBinding({ binding, serverId, project } = {}) {
  const normalizedBinding = normalizeManagedComposeWebsiteBinding(binding, { persisted: true });
  if (!normalizedBinding) return null;
  const normalizedServerId = uuid(serverId, 'serverId');
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new ManagedComposeWebsiteBindingError('managed_compose_project_not_found', 'Managed Compose project was not found', 404);
  }
  if (uuid(project.id, 'dockerProjectId') !== normalizedBinding.projectId) {
    throw new ManagedComposeWebsiteBindingError('managed_compose_project_identity_mismatch', 'Managed Compose project identity does not match the Website binding', 409);
  }
  if (uuid(project.serverId, 'serverId') !== normalizedServerId) {
    throw new ManagedComposeWebsiteBindingError('website_managed_compose_server_mismatch', 'Managed Compose project belongs to a different server', 409);
  }
  if (!Array.isArray(project.services)) {
    throw new ManagedComposeWebsiteBindingError('managed_compose_project_state_invalid', 'Managed Compose project service state is unavailable', 409);
  }
  const service = project.services.find((candidate) => candidate?.name === normalizedBinding.serviceName) ?? null;
  if (!service) {
    throw new ManagedComposeWebsiteBindingError('managed_compose_service_not_found', 'Managed Compose service was not found', 409);
  }
  if (!Array.isArray(service.publishedPorts)) {
    throw new ManagedComposeWebsiteBindingError('managed_compose_project_state_invalid', 'Managed Compose published port state is unavailable', 409);
  }
  const matches = service.publishedPorts.filter((candidate) => candidate?.targetPort === normalizedBinding.targetPort
    && candidate?.protocol === normalizedBinding.protocol);
  if (matches.length === 0) {
    throw new ManagedComposeWebsiteBindingError(
      'managed_compose_binding_not_ready',
      'Managed Compose service does not currently publish the selected target port',
      409,
    );
  }
  if (matches.length !== 1) {
    throw new ManagedComposeWebsiteBindingError(
      'managed_compose_binding_ambiguous',
      'Managed Compose service publishes the selected target port more than once',
      409,
    );
  }
  const published = matches[0];
  if (!Number.isSafeInteger(published.publishedPort) || published.publishedPort < 1 || published.publishedPort > 65535) {
    throw new ManagedComposeWebsiteBindingError(
      'managed_compose_published_binding_invalid',
      'Managed Compose published port binding is invalid',
      409,
    );
  }
  return Object.freeze({
    binding: normalizedBinding,
    proxyTarget: Object.freeze({
      host: normalizedHost(published.hostIp ?? null),
      port: published.publishedPort,
      websocket: true,
    }),
  });
}

export const managedComposeWebsiteBindingInternals = Object.freeze({
  serviceName,
  targetPort,
  protocol,
  normalizedHost,
});
