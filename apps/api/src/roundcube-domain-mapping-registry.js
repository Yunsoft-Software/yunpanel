import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertUuid, normalizeDomainSet } from '@yunpanel/shared';

const STORE_VERSION = 2;
const LEGACY_STORE_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i;
const SAFE_OPERATION_ID = /^[A-Za-z0-9._:@-]{8,160}$/;
const STATES = new Set(['pending', 'active', 'removing']);

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

function optionalDigest(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new RoundcubeDomainMappingRegistryError(
      'roundcube_mapping_state_invalid',
      'Roundcube Domain mapping ' + field + ' is invalid',
      409,
    );
  }
  return value;
}

function optionalReference(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || !SAFE_OPERATION_ID.test(value)) {
    throw new RoundcubeDomainMappingRegistryError(
      'roundcube_mapping_state_invalid',
      'Roundcube Domain mapping ' + field + ' is invalid',
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

function hydrateLegacy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    ...value,
    state: 'active',
    operationId: null,
    applyJobId: null,
    expectedRoundcubePreviewSha256: null,
    expectedRoundcubeNginxSha256: null,
  };
}

function normalizePersisted(value) {
  const fields = new Set([
    'id', 'mailDomainId', 'webDomainId', 'serverId', 'domainName', 'hostname',
    'certificateId', 'certificateFingerprint256', 'revision', 'state',
    'operationId', 'applyJobId', 'expectedRoundcubePreviewSha256',
    'expectedRoundcubeNginxSha256', 'createdAt', 'updatedAt',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.size
    || Object.keys(value).some((field) => !fields.has(field))
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !STATES.has(value.state)
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
  const operationId = optionalReference(value.operationId, 'operationId');
  const applyJobId = optionalReference(value.applyJobId, 'applyJobId');
  const expectedRoundcubePreviewSha256 = optionalDigest(
    value.expectedRoundcubePreviewSha256,
    'expectedRoundcubePreviewSha256',
  );
  const expectedRoundcubeNginxSha256 = optionalDigest(
    value.expectedRoundcubeNginxSha256,
    'expectedRoundcubeNginxSha256',
  );
  const inFlight = value.state !== 'active';
  if (inFlight !== (operationId !== null)
    || (applyJobId === null) !== (expectedRoundcubePreviewSha256 === null)
    || (applyJobId === null) !== (expectedRoundcubeNginxSha256 === null)
    || (value.state === 'active' && (applyJobId !== null
      || expectedRoundcubePreviewSha256 !== null || expectedRoundcubeNginxSha256 !== null))) {
    throw new RoundcubeDomainMappingRegistryError(
      'roundcube_mapping_state_invalid',
      'Roundcube Domain mapping operation evidence is inconsistent',
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
    state: value.state,
    operationId,
    applyJobId,
    expectedRoundcubePreviewSha256,
    expectedRoundcubeNginxSha256,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
}

function exactSuccessfulJob(mapping, job) {
  return Boolean(mapping
    && mapping.state !== 'active'
    && mapping.applyJobId !== null
    && job
    && job.id === mapping.applyJobId
    && job.serverId === mapping.serverId
    && job.operation === 'roundcube.config.apply'
    && job.resourceType === 'server'
    && job.resourceId === mapping.serverId
    && job.status === 'succeeded'
    && job.result?.previewSha256 === mapping.expectedRoundcubePreviewSha256
    && job.result?.nginxSha256 === mapping.expectedRoundcubeNginxSha256
    && job.result?.httpHealthy === true
    && job.result?.applied === true);
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

  function validateRelationships(mappings) {
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
        if (!parsed || ![LEGACY_STORE_VERSION, STORE_VERSION].includes(parsed.version)
          || !Array.isArray(parsed.mappings)
          || Object.keys(parsed).length !== 2
          || Object.keys(parsed).some((field) => !['version', 'mappings'].includes(field))) {
          throw new RoundcubeDomainMappingRegistryError(
            'roundcube_mapping_store_invalid',
            'Roundcube Domain mapping store is invalid',
            409,
          );
        }
        const mappings = parsed.mappings.map((mapping) => normalizePersisted(
          parsed.version === LEGACY_STORE_VERSION ? hydrateLegacy(mapping) : mapping,
        ));
        validateRelationships(mappings);
        state = { version: STORE_VERSION, mappings };
        if (parsed.version !== STORE_VERSION) await persist(state);
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
      validateRelationships(normalized);
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
      throw new RoundcubeDomainMappingRegistryError('mail_domain_not_found', 'Mail Domain was not found', 404);
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
    try { inspected = await inspectCertificate({ certificate, domains: [hostname] }); }
    catch {
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
    if (current) {
      if (current.state !== 'active') {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_operation_in_progress',
          'Roundcube Domain mapping already has an operation in progress',
          409,
        );
      }
      if (current.webDomainId === candidate.webDomainId
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
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_rebind_requires_delete',
        'Delete the current Roundcube Domain mapping before binding another certificate',
        409,
      );
    }
    const identity = Object.freeze({
      version: 1,
      operation: 'roundcube_domain_mapping_bind',
      currentRevision: 0,
      currentUpdatedAt: null,
      ...candidate,
    });
    const previewDigest = digest(identity);
    return Object.freeze({
      ...identity,
      previewDigest,
      confirmation: 'bind-roundcube-domain:' + candidate.mailDomainId + ':0:' + previewDigest,
      sideEffects: false,
    });
  }

  async function beginBind({ mailDomainId, certificateId, previewDigest, confirmation } = {}) {
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
      if (next.mappings.some((mapping) => mapping.mailDomainId === preview.mailDomainId)) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_revision_conflict',
          'Roundcube Domain mapping changed after preview',
          409,
        );
      }
      const currentTime = new Date(now()).toISOString();
      const record = normalizePersisted({
        id: randomUUID(),
        mailDomainId: preview.mailDomainId,
        webDomainId: preview.webDomainId,
        serverId: preview.serverId,
        domainName: preview.domainName,
        hostname: preview.hostname,
        certificateId: preview.certificateId,
        certificateFingerprint256: preview.certificateFingerprint256,
        revision: 1,
        state: 'pending',
        operationId: randomUUID(),
        applyJobId: null,
        expectedRoundcubePreviewSha256: null,
        expectedRoundcubeNginxSha256: null,
        createdAt: currentTime,
        updatedAt: currentTime,
      });
      next.mappings.push(record);
      return publicMapping(record);
    });
  }

  async function getForMailDomain(mailDomainIdValue) {
    await ensureInitialized();
    const mailDomainId = uuid(mailDomainIdValue, 'mailDomainId');
    const mapping = state.mappings.find((candidate) => (
      candidate.mailDomainId === mailDomainId && candidate.state === 'active'
    )) ?? null;
    return mapping ? publicMapping(mapping) : null;
  }

  async function getRecordForMailDomain(mailDomainIdValue) {
    await ensureInitialized();
    const mailDomainId = uuid(mailDomainIdValue, 'mailDomainId');
    const mapping = state.mappings.find((candidate) => candidate.mailDomainId === mailDomainId) ?? null;
    return mapping ? publicMapping(mapping) : null;
  }

  async function listMappings({ serverId = null } = {}) {
    await ensureInitialized();
    const scopedServerId = serverId === null ? null : uuid(serverId, 'serverId');
    return state.mappings
      .filter((mapping) => mapping.state !== 'removing'
        && (scopedServerId === null || mapping.serverId === scopedServerId))
      .sort((left, right) => left.hostname.localeCompare(right.hostname))
      .map(publicMapping);
  }

  async function listActiveMappings({ serverId = null } = {}) {
    await ensureInitialized();
    const scopedServerId = serverId === null ? null : uuid(serverId, 'serverId');
    return state.mappings
      .filter((mapping) => mapping.state === 'active'
        && (scopedServerId === null || mapping.serverId === scopedServerId))
      .sort((left, right) => left.hostname.localeCompare(right.hostname))
      .map(publicMapping);
  }

  async function listInFlight({ serverId = null } = {}) {
    await ensureInitialized();
    const scopedServerId = serverId === null ? null : uuid(serverId, 'serverId');
    return state.mappings
      .filter((mapping) => mapping.state !== 'active'
        && (scopedServerId === null || mapping.serverId === scopedServerId))
      .sort((left, right) => left.hostname.localeCompare(right.hostname))
      .map(publicMapping);
  }

  async function previewDelete(mailDomainIdValue) {
    const mapping = await getForMailDomain(mailDomainIdValue);
    if (!mapping) {
      const current = await getRecordForMailDomain(mailDomainIdValue);
      if (current) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_operation_in_progress',
          'Roundcube Domain mapping already has an operation in progress',
          409,
        );
      }
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

  async function beginDelete(mailDomainIdValue, { expectedRevision, previewDigest, confirmation } = {}) {
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
      if (current.state !== 'active'
        || current.revision !== preview.revision || current.updatedAt !== preview.updatedAt) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_revision_conflict',
          'Roundcube Domain mapping changed after preview',
          409,
        );
      }
      const updatedAt = new Date(now()).toISOString();
      const removing = normalizePersisted({
        ...current,
        revision: current.revision + 1,
        state: 'removing',
        operationId: randomUUID(),
        applyJobId: null,
        expectedRoundcubePreviewSha256: null,
        expectedRoundcubeNginxSha256: null,
        updatedAt,
      });
      next.mappings[index] = removing;
      return publicMapping(removing);
    });
  }

  async function attachApplyJob(mailDomainIdValue, {
    operationId,
    jobId,
    previewSha256,
    nginxSha256,
  } = {}) {
    const mailDomainId = uuid(mailDomainIdValue, 'mailDomainId');
    const safeOperationId = optionalReference(operationId, 'operationId');
    const safeJobId = optionalReference(jobId, 'applyJobId');
    const safePreviewSha256 = optionalDigest(previewSha256, 'expectedRoundcubePreviewSha256');
    const safeNginxSha256 = optionalDigest(nginxSha256, 'expectedRoundcubeNginxSha256');
    if (!safeOperationId || !safeJobId || !safePreviewSha256 || !safeNginxSha256) {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_apply_identity_invalid',
        'Roundcube mapping apply job identity is incomplete',
        409,
      );
    }
    return mutate(async (next) => {
      const index = next.mappings.findIndex((mapping) => mapping.mailDomainId === mailDomainId);
      if (index < 0) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_not_found',
          'Roundcube Domain mapping was not found',
          404,
        );
      }
      const current = next.mappings[index];
      if (current.state === 'active' || current.operationId !== safeOperationId) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_operation_stale',
          'Roundcube Domain mapping operation is stale',
          409,
        );
      }
      if (current.applyJobId !== null
        && (current.applyJobId !== safeJobId
          || current.expectedRoundcubePreviewSha256 !== safePreviewSha256
          || current.expectedRoundcubeNginxSha256 !== safeNginxSha256)) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_apply_job_conflict',
          'Roundcube Domain mapping already references another apply job',
          409,
        );
      }
      const updated = normalizePersisted({
        ...current,
        applyJobId: safeJobId,
        expectedRoundcubePreviewSha256: safePreviewSha256,
        expectedRoundcubeNginxSha256: safeNginxSha256,
        updatedAt: new Date(now()).toISOString(),
      });
      next.mappings[index] = updated;
      return publicMapping(updated);
    });
  }

  async function replaceFailedApplyJob(mailDomainIdValue, {
    operationId,
    previousJobId,
    jobId,
    previewSha256,
    nginxSha256,
  } = {}) {
    const mailDomainId = uuid(mailDomainIdValue, 'mailDomainId');
    const safeOperationId = optionalReference(operationId, 'operationId');
    const safePreviousJobId = optionalReference(previousJobId, 'previousJobId');
    const safeJobId = optionalReference(jobId, 'applyJobId');
    const safePreviewSha256 = optionalDigest(previewSha256, 'expectedRoundcubePreviewSha256');
    const safeNginxSha256 = optionalDigest(nginxSha256, 'expectedRoundcubeNginxSha256');
    if (!safeOperationId || !safePreviousJobId || !safeJobId || !safePreviewSha256 || !safeNginxSha256) {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_apply_identity_invalid',
        'Roundcube mapping retry job identity is incomplete',
        409,
      );
    }
    return mutate(async (next) => {
      const index = next.mappings.findIndex((mapping) => mapping.mailDomainId === mailDomainId);
      if (index < 0) throw new RoundcubeDomainMappingRegistryError('roundcube_mapping_not_found', 'Roundcube Domain mapping was not found', 404);
      const current = next.mappings[index];
      if (current.state === 'active' || current.operationId !== safeOperationId
        || current.applyJobId !== safePreviousJobId) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_operation_stale',
          'Roundcube Domain mapping retry operation is stale',
          409,
        );
      }
      const updated = normalizePersisted({
        ...current,
        applyJobId: safeJobId,
        expectedRoundcubePreviewSha256: safePreviewSha256,
        expectedRoundcubeNginxSha256: safeNginxSha256,
        updatedAt: new Date(now()).toISOString(),
      });
      next.mappings[index] = updated;
      return publicMapping(updated);
    });
  }

  async function completeApply(mailDomainIdValue, { operationId, job } = {}) {
    const mailDomainId = uuid(mailDomainIdValue, 'mailDomainId');
    const safeOperationId = optionalReference(operationId, 'operationId');
    if (!safeOperationId) {
      throw new RoundcubeDomainMappingRegistryError(
        'roundcube_mapping_apply_identity_invalid',
        'Roundcube mapping operation ID is required',
        409,
      );
    }
    return mutate(async (next) => {
      const index = next.mappings.findIndex((mapping) => mapping.mailDomainId === mailDomainId);
      if (index < 0) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_not_found',
          'Roundcube Domain mapping was not found',
          404,
        );
      }
      const current = next.mappings[index];
      if (current.state === 'active' || current.operationId !== safeOperationId) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_operation_stale',
          'Roundcube Domain mapping completion is stale',
          409,
        );
      }
      if (!exactSuccessfulJob(current, job)) {
        throw new RoundcubeDomainMappingRegistryError(
          'roundcube_mapping_apply_evidence_invalid',
          'Roundcube apply job does not prove the exact mapping desired state',
          409,
        );
      }
      if (current.state === 'removing') {
        next.mappings.splice(index, 1);
        return Object.freeze({
          id: current.id,
          mailDomainId: current.mailDomainId,
          operationId: current.operationId,
          deleted: true,
          applyJobId: current.applyJobId,
        });
      }
      const active = normalizePersisted({
        ...current,
        state: 'active',
        operationId: null,
        applyJobId: null,
        expectedRoundcubePreviewSha256: null,
        expectedRoundcubeNginxSha256: null,
        updatedAt: new Date(now()).toISOString(),
      });
      next.mappings[index] = active;
      return publicMapping(active);
    });
  }

  return Object.freeze({
    init,
    previewBind,
    beginBind,
    getForMailDomain,
    getRecordForMailDomain,
    listMappings,
    listActiveMappings,
    listInFlight,
    previewDelete,
    beginDelete,
    attachApplyJob,
    replaceFailedApplyJob,
    completeApply,
  });
}

export const roundcubeDomainMappingRegistryInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  legacyStoreVersion: LEGACY_STORE_VERSION,
  states: Object.freeze([...STATES]),
  hostnameFor,
  digest,
  normalizePersisted,
  exactSuccessfulJob,
});
