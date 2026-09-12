import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid, normalizeDomainSet } from '@yunpanel/shared';

const STORE_VERSION = 1;

export class MailServiceIdentityRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailServiceIdentityRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new MailServiceIdentityRegistryError(
      `invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      `${field} is invalid`,
    );
  }
}

function hostname(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch { throw new MailServiceIdentityRegistryError('invalid_mail_service_hostname', 'Mail service hostname is invalid'); }
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length !== 24 || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new MailServiceIdentityRegistryError('mail_service_identity_state_invalid', `${field} is invalid`, 409);
  }
  return value;
}

function certificateCoversHostname(certificate, value) {
  const names = certificate?.certificateNames ?? certificate?.domains;
  if (!Array.isArray(names)) return false;
  return names.some((name) => {
    if (name === value) return true;
    if (typeof name !== 'string' || !name.startsWith('*.')) return false;
    const suffix = name.slice(2);
    if (!value.endsWith(`.${suffix}`)) return false;
    return value.split('.').length === suffix.split('.').length + 1;
  });
}

function validatePersisted(value) {
  const fields = new Set(['serverId', 'webDomainId', 'hostname', 'revision', 'createdAt', 'updatedAt']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size || Object.keys(value).some((field) => !fields.has(field))
    || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new MailServiceIdentityRegistryError('mail_service_identity_state_invalid', 'Mail service identity state is invalid', 409);
  }
  return Object.freeze({
    serverId: uuid(value.serverId, 'serverId'),
    webDomainId: uuid(value.webDomainId, 'webDomainId'),
    hostname: hostname(value.hostname),
    revision: value.revision,
    createdAt: timestamp(value.createdAt, 'createdAt'),
    updatedAt: timestamp(value.updatedAt, 'updatedAt'),
  });
}

export function createMailServiceIdentityRegistry({
  filePath = null,
  now = () => Date.now(),
  getWebDomain = async () => null,
  getCertificate = async () => null,
} = {}) {
  if (typeof now !== 'function' || typeof getWebDomain !== 'function' || typeof getCertificate !== 'function') {
    throw new MailServiceIdentityRegistryError(
      'mail_service_identity_dependencies_invalid',
      'Mail service identity dependencies are unavailable',
      503,
    );
  }
  let state = { version: STORE_VERSION, bindings: [] };
  let initialized = false;
  let writeChain = Promise.resolve();

  async function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
      await chmod(filePath, 0o600);
    });
    return writeChain;
  }

  async function requireDomain(binding, { persisted = false } = {}) {
    let domain;
    try { domain = await getWebDomain(binding.webDomainId); }
    catch {
      throw new MailServiceIdentityRegistryError(
        'mail_service_domain_unavailable',
        'Mail service Web Domain could not be verified',
        503,
      );
    }
    if (!domain) {
      throw new MailServiceIdentityRegistryError(
        persisted ? 'mail_service_identity_state_invalid' : 'domain_not_found',
        persisted ? 'Persisted mail service Web Domain no longer exists' : 'Web Domain was not found',
        persisted ? 409 : 404,
      );
    }
    if (domain.serverId !== binding.serverId || domain.primaryDomain !== binding.hostname) {
      throw new MailServiceIdentityRegistryError(
        persisted ? 'mail_service_identity_state_invalid' : 'mail_service_domain_mismatch',
        'Mail service Web Domain does not match the bound server and hostname',
        409,
      );
    }
    return domain;
  }

  async function resolveCertificate(binding, domain, { requireReady = false } = {}) {
    const certificateId = domain.certificateId ?? null;
    if (!certificateId) {
      if (requireReady) {
        throw new MailServiceIdentityRegistryError(
          'mail_service_certificate_required',
          'Mail service hostname requires an active certificate',
          409,
        );
      }
      return { certificate: null, blockers: ['mail_service_certificate_required'] };
    }
    let certificate;
    try { certificate = await getCertificate(certificateId); }
    catch {
      throw new MailServiceIdentityRegistryError(
        'mail_service_certificate_unavailable',
        'Mail service certificate could not be verified',
        503,
      );
    }
    const valid = certificate
      && certificate.id === certificateId
      && certificate.domainId === binding.webDomainId
      && certificate.serverId === binding.serverId
      && certificate.state === 'active'
      && certificate.staging !== true
      && Number.isFinite(Date.parse(certificate.validTo ?? ''))
      && Date.parse(certificate.validTo) > now()
      && certificateCoversHostname(certificate, binding.hostname);
    if (!valid) {
      if (requireReady) {
        throw new MailServiceIdentityRegistryError(
          'mail_service_certificate_not_ready',
          'Mail service certificate is not active, current and hostname-compatible',
          409,
        );
      }
      return { certificate: null, blockers: ['mail_service_certificate_not_ready'] };
    }
    return { certificate, blockers: [] };
  }

  function publicBinding(binding, domain, certificate, blockers) {
    return Object.freeze({
      serverId: binding.serverId,
      webDomainId: binding.webDomainId,
      hostname: binding.hostname,
      certificateId: certificate?.id ?? domain?.certificateId ?? null,
      revision: binding.revision,
      ready: blockers.length === 0,
      blockers: Object.freeze([...blockers]),
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    });
  }

  async function inspect(binding) {
    const domain = await requireDomain(binding, { persisted: true });
    const { certificate, blockers } = await resolveCertificate(binding, domain);
    return publicBinding(binding, domain, certificate, blockers);
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.bindings)
          || Object.keys(parsed).length !== 2 || Object.keys(parsed).some((field) => !['version', 'bindings'].includes(field))) {
          throw new MailServiceIdentityRegistryError('mail_service_identity_state_invalid', 'Mail service identity store is invalid', 409);
        }
        const bindings = parsed.bindings.map(validatePersisted);
        if (new Set(bindings.map((binding) => binding.serverId)).size !== bindings.length
          || new Set(bindings.map((binding) => binding.webDomainId)).size !== bindings.length) {
          throw new MailServiceIdentityRegistryError('mail_service_identity_state_invalid', 'Mail service identity bindings are not unique', 409);
        }
        for (const binding of bindings) await requireDomain(binding, { persisted: true });
        state = { version: STORE_VERSION, bindings };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await persist();
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  async function getForServer(serverId) {
    await ensureInitialized();
    const normalizedServerId = uuid(serverId, 'serverId');
    const binding = state.bindings.find((candidate) => candidate.serverId === normalizedServerId) ?? null;
    return binding ? inspect(binding) : null;
  }

  async function bind({ serverId, webDomainId, expectedRevision = 0 } = {}) {
    await ensureInitialized();
    const normalizedServerId = uuid(serverId, 'serverId');
    const normalizedWebDomainId = uuid(webDomainId, 'webDomainId');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new MailServiceIdentityRegistryError('invalid_expected_revision', 'expectedRevision is invalid');
    }
    const existingIndex = state.bindings.findIndex((candidate) => candidate.serverId === normalizedServerId);
    const existing = existingIndex >= 0 ? state.bindings[existingIndex] : null;
    if ((existing?.revision ?? 0) !== expectedRevision) {
      throw new MailServiceIdentityRegistryError(
        'mail_service_identity_revision_conflict',
        'Mail service identity changed; refresh and retry',
        409,
      );
    }
    const domain = await getWebDomain(normalizedWebDomainId);
    if (!domain) throw new MailServiceIdentityRegistryError('domain_not_found', 'Web Domain was not found', 404);
    const candidate = {
      serverId: normalizedServerId,
      webDomainId: normalizedWebDomainId,
      hostname: hostname(domain.primaryDomain),
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    };
    await requireDomain(candidate);
    const { certificate } = await resolveCertificate(candidate, domain, { requireReady: true });
    if (existing && existing.webDomainId === candidate.webDomainId && existing.hostname === candidate.hostname) {
      throw new MailServiceIdentityRegistryError('mail_service_identity_no_change', 'Mail service identity is already bound to this Web Domain', 409);
    }
    if (existingIndex >= 0) state.bindings[existingIndex] = candidate;
    else state.bindings.push(candidate);
    await persist();
    return publicBinding(candidate, domain, certificate, []);
  }

  async function materializeForServer(serverId) {
    await ensureInitialized();
    const normalizedServerId = uuid(serverId, 'serverId');
    const binding = state.bindings.find((candidate) => candidate.serverId === normalizedServerId);
    if (!binding) {
      throw new MailServiceIdentityRegistryError('mail_service_identity_required', 'Mail service TLS identity is not configured', 409);
    }
    const domain = await requireDomain(binding, { persisted: true });
    const { certificate } = await resolveCertificate(binding, domain, { requireReady: true });
    if (typeof certificate.fullchainPath !== 'string' || typeof certificate.privateKeyPath !== 'string'
      || !certificate.fullchainPath.startsWith('/') || !certificate.privateKeyPath.startsWith('/')) {
      throw new MailServiceIdentityRegistryError(
        'mail_service_certificate_material_unavailable',
        'Mail service certificate material paths are unavailable',
        409,
      );
    }
    return Object.freeze({
      serverId: binding.serverId,
      webDomainId: binding.webDomainId,
      hostname: binding.hostname,
      certificateId: certificate.id,
      certificateFingerprint256: certificate.fingerprint256 ?? null,
      fullchainPath: certificate.fullchainPath,
      privateKeyPath: certificate.privateKeyPath,
      revision: binding.revision,
    });
  }

  async function clear(serverId, { expectedRevision, confirmation } = {}) {
    await ensureInitialized();
    const normalizedServerId = uuid(serverId, 'serverId');
    const index = state.bindings.findIndex((candidate) => candidate.serverId === normalizedServerId);
    if (index < 0) throw new MailServiceIdentityRegistryError('mail_service_identity_not_found', 'Mail service identity was not found', 404);
    const binding = state.bindings[index];
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== binding.revision
      || confirmation !== `clear-mail-service-identity:${binding.serverId}:${binding.revision}`) {
      throw new MailServiceIdentityRegistryError(
        'mail_service_identity_confirmation_invalid',
        'Mail service identity clear confirmation is invalid or stale',
        409,
      );
    }
    state.bindings.splice(index, 1);
    await persist();
    return Object.freeze({ serverId: binding.serverId, cleared: true });
  }

  return Object.freeze({ init, getForServer, bind, materializeForServer, clear });
}

export const mailServiceIdentityRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  certificateCoversHostname,
  validatePersisted,
});