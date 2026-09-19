import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid, normalizeDomainSet } from '@yunpanel/shared';

const STORE_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;

export class RoundcubeDomainMappingRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'RoundcubeDomainMappingRegistryError';
    this.code = code;
    this.status = status;
  }
}

function uuid(value, field) {
  try { return assertUuid(value, field); }
  catch {
    throw new RoundcubeDomainMappingRegistryError(
      'roundcube_mapping_identity_invalid',
      field + ' is invalid',
    );
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new RoundcubeDomainMappingRegistryError(
      'roundcube_mapping_state_invalid',
      'Roundcube Domain mapping timestamp is invalid',
      409,
    );
  }
  return value;
}

function hostnameFor(domainName) {
  let domain;
  try { domain = normalizeDomainSet(domainName, []).primary; }
  catch {
    throw new RoundcubeDomainMappingRegistryError(
      'roundcube_mapping_domain_invalid',
      'Roundcube Domain mapping domain is invalid',
      409,
    );
  }
  return 'webmail.' + domain;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicMapping(mapping) {
  return Object.freeze({ ...mapping });
}

function normalizePersisted(value) {
  const fields = new Set([
    'id', 'mailDomainId', 'webDomainId', 'serverId', 'domainName', 'hostname',
    'certificateId', 'certificateFingerprint256', 'revision', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.certificateFingerprint256 !== 'string'
    || !FINGERPRINT_PATTERN.test(value.certificateFingerprint256)) {
    throw new RoundcubeDomainMappingRegistryError(
      'roundcube_mapping_state_invalid',
      'Roundcube Domain mapping state is invalid',
      409,
    );
  }
  const domainName = hostnameFor(value.domainName).slice('webmail.'.length);
  if (value.hostname !== 'webmail.' + domainName) {
    throw new RoundcubeDomainMappingRegistryError(
      'roundcube_mapping_state_invalid',
      'Roundcube Domain mapping hostname is invalid',
      409,
    );
  }
  return Object.freeze({
    id: uuid(value.id, 'roundcubeMappingId'),
    mailDomainId: uuid(value.mailDomainId, 'mailDomainId'),
    webDomainId: uuid(value.webDomainId, 'webDomainId'),
    serverId: uuid(value.serverId, 'serverId'),
    domainName,
    hostname: value.hostname,
    certificateId: uuid(value.certificateId, 'certificateId'),
    certificateFingerprint256: value.certificateFingerprint256.toUpperCase(),
    revision: value.revision,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
}

export function createRoundcubeDomainMappingRegistry({
  filePath = null,
  now = () => Date.now(),
  getMailDomain,
  getDomain,
  getCertificate,
  inspectCertificate,
} = {}) {
  if ((filePath !== null && (typeof filePath !== 'string' || !path.isAbsolute(filePath)))
    || typeof now !== 'function'
    || typeof getMailDomain !== 'function'
    || typeof getDomain !== 'function'
    || typeof getCertificate !== 'function'
    || typeof inspectCertificate !== 'function') {
    throw new RoundcubeDomainMappingRegistryError(
      'roundcube_mapping_dependencies_invalid',
      'Roundcube Domain mapping dependencies are unavailable',
      503,
    );
  }

  let state = { version: STORE_VERSION, mappings: [] };
  let initialized = false;
  let mutationChain = Promise.resolve();

  async function persist(nextState) {
    if (!filePath) {
      state = nextState;
      return;
    }
    const directory = path.dirname(filePath);
    const temporary = filePath + '.' + process.pid + '.tmp';
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporary, JSON.stringify(nextState, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
    state = nextState;
  }

  async function validateRelationships(mappings) {
    if (new Set(mappings.map((mapping) => mapping.id)).size !== mappings.length
      || new Set(mappings.map((mapping) => mapping.mailDomainId)).size !== mappings.length
      || new Set(mappings.map((mapping) => mapping.webDomainId)).size !== mappings.length
      || new Set(mappings.map((mapping) => mapping.hostname)).size !== mappings.length) {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_state_invalid',
        'Roundcube Domain mapping identities are duplicated',
        409,
      );
    }
  }

  async function init() {
    if (initialized) return;
    if (filePath) {
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!parsed || parsed.version !== STORE_VERSION || !Array.isArray(parsed.mappings)
          || Object.keys(parsed).length !== 2
          || Object.keys(parsed).some((field) => !['version', 'mappings'].includes(field))) {
          throw new RoundcubeDomainMappingRegistryError(
            'roundcube_mapping_store_invalid',
            'Roundcube Domain mapping store is invalid',
            409,
          );
        }
        const mappings = parsed.mappings.map(normalizePersisted);
        await validateRelationships(mappings);
        state = { version: STORE_VERSION, mappings };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await persist(state);
      }
    }
    initialized = true;
  }

  async function ensureInitialized() {
    if (!initialized) await init();
  }

  function mutate(operation) {
    const pending = mutationChain.catch(() => {}).then(async () => {
      await ensureInitialized();
      const next = {
        version: STORE_VERSION,
        mappings: state.mappings.map((mapping) => ({ ...mapping })),
      };
      const result = await operation(next);
      const normalized = next.mappings.map(normalizePersisted);
      await validateRelationships(normalized);
      await persist({ version: STORE_VERSION, mappings: normalized });
      return result;
    });
    mutationChain = pending;
    return pending;
  }

  async function resolveCandidate(mailDomainIdValue, certificateIdValue) {
    const mailDomainId = uuid(mailDomainIdValue, 'mailDomainId');
    const certificateId = uuid(certificateIdValue, 'certificateId');
    let mailDomain;
    try { mailDomain = await getMailDomain(mailDomainId); }
    catch {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_mail_domain_unavailable',
        'Roundcube mapping Mail Domain could not be verified',
        503,
      );
    }
    if (!mailDomain || mailDomain.id !== mailDomainId) {
      throw new RoundcubeDomainMappingRegistryError(
        'mail_domain_not_found',
        'Mail Domain was not found',
        404,
      );
    }
    if (mailDomain.managementMode !== 'local' || mailDomain.status !== 'enabled'
      || typeof mailDomain.webDomainId !== 'string') {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_mail_domain_not_ready',
        'Roundcube mapping requires an enabled local Mail Domain',
        409,
      );
    }

    let domain;
    try { domain = await getDomain(mailDomain.webDomainId); }
    catch {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_domain_unavailable',
        'Roundcube mapping web Domain could not be verified',
        503,
      );
    }
    if (!domain || domain.id !== mailDomain.webDomainId
      || domain.primaryDomain !== mailDomain.domainName
      || typeof domain.serverId !== 'string' || !domain.serverId) {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_domain_drift',
        'Roundcube mapping Domain ownership is stale',
        409,
      );
    }

    let certificate;
    try { certificate = await getCertificate(certificateId); }
    catch {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_certificate_unavailable',
        'Roundcube mapping certificate could not be verified',
        503,
      );
    }
    if (!certificate || certificate.id !== certificateId
      || certificate.domainId !== domain.id || certificate.serverId !== domain.serverId
      || certificate.staging === true || certificate.state !== 'active') {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_certificate_not_ready',
        'Roundcube mapping requires an active certificate owned by the Domain',
        409,
      );
    }

    const hostname = hostnameFor(domain.primaryDomain);
    let inspected;
    try {
      inspected = await inspectCertificate({ certificate, domains: [hostname] });
    } catch {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_certificate_hostname_mismatch',
        'Roundcube mapping certificate does not cover the webmail hostname',
        409,
      );
    }
    if (!inspected || typeof inspected.fingerprint256 !== 'string'
      || !FINGERPRINT_PATTERN.test(inspected.fingerprint256)
      || inspected.fingerprint256.toUpperCase() !== String(certificate.fingerprint256 ?? '').toUpperCase()) {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_certificate_drift',
        'Roundcube mapping certificate material does not match registry evidence',
        409,
      );
    }

    return Object.freeze({
      mailDomainId,
      webDomainId: domain.id,
      serverId: domain.serverId,
      domainName: domain.primaryDomain,
      hostname,
      certificateId,
      certificateFingerprint256: inspected.fingerprint256.toUpperCase(),
      certificateUpdatedAt: certificate.updatedAt,
      mailDomainRevision: mailDomain.revision,
      domainRevision: domain.desiredRevision,
    });
  }

  async function previewBind({ mailDomainId, certificateId } = {}) {
    await ensureInitialized();
    const candidate = await resolveCandidate(mailDomainId, certificateId);
    const current = state.mappings.find((mapping) => mapping.mailDomainId === candidate.mailDomainId) ?? null;
    if (current && current.webDomainId === candidate.webDomainId
      && current.serverId === candidate.serverId
      && current.hostname === candidate.hostname
      && current.certificateId === candidate.certificateId
      && current.certificateFingerprint256 === candidate.certificateFingerprint256) {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_no_change',
        'Roundcube Domain mapping is unchanged',
        409,
      );
    }
    const identity = Object.freeze({
      version: 1,
      operation: 'roundcube_domain_mapping_bind',
      currentRevision: current?.revision ?? 0,
      currentUpdatedAt: current?.updatedAt ?? null,
      ...candidate,
    });
    const previewDigest = digest(identity);
    return Object.freeze({
      ...identity,
      previewDigest,
      confirmation: 'bind-roundcube-domain:' + candidate.mailDomainId + ':' + identity.currentRevision + ':' + previewDigest,
      sideEffects: false,
    });
  }

  async function bind({ mailDomainId, certificateId, previewDigest, confirmation } = {}) {
    const preview = await previewBind({ mailDomainId, certificateId });
    if (preview.previewDigest !== previewDigest || preview.confirmation !== confirmation
      || !SHA256_PATTERN.test(String(previewDigest ?? ''))) {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_confirmation_invalid',
        'Roundcube Domain mapping preview is stale or confirmation is invalid',
        409,
      );
    }
    return mutate(async (next) => {
      const currentIndex = next.mappings.findIndex((mapping) => mapping.mailDomainId === preview.mailDomainId);
      const current = currentIndex < 0 ? null : next.mappings[currentIndex];
      if ((current?.revision ?? 0) !== preview.currentRevision
        || (current?.updatedAt ?? null) !== preview.currentUpdatedAt) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_revision_conflict',
          'Roundcube Domain mapping changed after preview',
          409,
        );
      }
      const currentTime = new Date(now()).toISOString();
      const record = normalizePersisted({
        id: current?.id ?? randomUUID(),
        mailDomainId: preview.mailDomainId,
        webDomainId: preview.webDomainId,
        serverId: preview.serverId,
        domainName: preview.domainName,
        hostname: preview.hostname,
        certificateId: preview.certificateId,
        certificateFingerprint256: preview.certificateFingerprint256,
        revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? currentTime,
        updatedAt: currentTime,
      });
      if (currentIndex < 0) next.mappings.push(record);
      else next.mappings[currentIndex] = record;
      return publicMapping(record);
    });
  }

  async function getForMailDomain(mailDomainIdValue) {
    await ensureInitialized();
    const mailDomainId = uuid(mailDomainIdValue, 'mailDomainId');
    const mapping = state.mappings.find((candidate) => candidate.mailDomainId === mailDomainId) ?? null;
    return mapping ? publicMapping(mapping) : null;
  }

  async function listMappings({ serverId = null } = {}) {
    await ensureInitialized();
    const scopedServerId = serverId === null ? null : uuid(serverId, 'serverId');
    return state.mappings
      .filter((mapping) => scopedServerId === null || mapping.serverId === scopedServerId)
      .sort((left, right) => left.hostname.localeCompare(right.hostname))
      .map(publicMapping);
  }

  async function previewDelete(mailDomainIdValue) {
    const mapping = await getForMailDomain(mailDomainIdValue);
    if (!mapping) {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_not_found',
        'Roundcube Domain mapping was not found',
        404,
      );
    }
    const identity = Object.freeze({
      version: 1,
      operation: 'roundcube_domain_mapping_delete',
      id: mapping.id,
      mailDomainId: mapping.mailDomainId,
      webDomainId: mapping.webDomainId,
      serverId: mapping.serverId,
      hostname: mapping.hostname,
      certificateId: mapping.certificateId,
      certificateFingerprint256: mapping.certificateFingerprint256,
      revision: mapping.revision,
      updatedAt: mapping.updatedAt,
    });
    const previewDigest = digest(identity);
    return Object.freeze({
      ...identity,
      previewDigest,
      confirmation: 'delete-roundcube-domain:' + mapping.id + ':' + mapping.revision + ':' + previewDigest,
      sideEffects: false,
    });
  }

  async function deleteMapping(mailDomainIdValue, { expectedRevision, previewDigest, confirmation } = {}) {
    const preview = await previewDelete(mailDomainIdValue);
    if (expectedRevision !== preview.revision || previewDigest !== preview.previewDigest
      || confirmation !== preview.confirmation) {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_confirmation_invalid',
        'Roundcube Domain mapping deletion preview is stale or confirmation is invalid',
        409,
      );
    }
    return mutate(async (next) => {
      const index = next.mappings.findIndex((mapping) => mapping.id === preview.id);
      if (index < 0) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_not_found',
          'Roundcube Domain mapping was not found',
          404,
        );
      }
      const current = next.mappings[index];
      if (current.revision !== preview.revision || current.updatedAt !== preview.updatedAt) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_revision_conflict',
          'Roundcube Domain mapping changed after preview',
          409,
        );
      }
      next.mappings.splice(index, 1);
      return Object.freeze({
        id: current.id,
        mailDomainId: current.mailDomainId,
        deleted: true,
      });
    });
  }

  return Object.freeze({
    init,
    previewBind,
    bind,
    getForMailDomain,
    listMappings,
    previewDelete,
    deleteMapping,
  });
}

export const roundcubeDomainMappingRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  hostnameFor,
  digest,
  normalizePersisted,
});
