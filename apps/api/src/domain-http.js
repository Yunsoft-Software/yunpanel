import { DomainRegistryError } from './domain-registry.js';

const REPARENT_PREVIEW_FIELDS = new Set(['parentDomainId']);
const REPARENT_APPLY_FIELDS = new Set(['parentDomainId', 'previewDigest', 'confirmation']);
const UPDATE_PREVIEW_FIELDS = new Set(['changes']);
const UPDATE_APPLY_FIELDS = new Set(['changes', 'previewDigest', 'confirmation']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CERTIFICATE_OPERATION_STATES = new Set(['pending', 'validating', 'issuing', 'renewing']);

function exactBody(body, fields, code, message) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.size || Object.keys(body).some((key) => !fields.has(key))) {
    throw new DomainRegistryError(code, message);
  }
  return body;
}

function parentDomainId(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new DomainRegistryError('invalid_parent_domain_id', 'parentDomainId must be a safe non-empty string or null');
  }
  return value;
}

function assertReparentPreviewBody(body) {
  const input = exactBody(body, REPARENT_PREVIEW_FIELDS, 'invalid_domain_reparent_preview', 'Send only parentDomainId');
  return Object.freeze({ parentDomainId: parentDomainId(input.parentDomainId) });
}

function assertReparentApplyBody(body) {
  const input = exactBody(body, REPARENT_APPLY_FIELDS, 'invalid_domain_reparent', 'Send parentDomainId, previewDigest and confirmation');
  const normalizedParentId = parentDomainId(input.parentDomainId);
  if (typeof input.previewDigest !== 'string' || !SHA256_PATTERN.test(input.previewDigest)) {
    throw new DomainRegistryError('invalid_domain_reparent_digest', 'A current Domain reparent preview digest is required');
  }
  if (typeof input.confirmation !== 'string') {
    throw new DomainRegistryError('domain_reparent_confirmation_required', 'Exact Domain reparent confirmation is required');
  }
  return Object.freeze({
    parentDomainId: normalizedParentId,
    previewDigest: input.previewDigest,
    confirmation: input.confirmation,
  });
}

function assertUpdateChanges(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length < 1) {
    throw new DomainRegistryError('invalid_domain_update', 'Domain update changes are required');
  }
  return value;
}

function assertUpdatePreviewBody(body) {
  const input = exactBody(body, UPDATE_PREVIEW_FIELDS, 'invalid_domain_update_preview', 'Send only Domain changes');
  return Object.freeze({ changes: assertUpdateChanges(input.changes) });
}

function assertUpdateApplyBody(body) {
  const input = exactBody(body, UPDATE_APPLY_FIELDS, 'invalid_domain_update', 'Send changes, previewDigest and confirmation');
  if (typeof input.previewDigest !== 'string' || !SHA256_PATTERN.test(input.previewDigest)) {
    throw new DomainRegistryError('invalid_domain_update_digest', 'A current Domain update preview digest is required');
  }
  if (typeof input.confirmation !== 'string') {
    throw new DomainRegistryError('domain_update_confirmation_required', 'Exact Domain update confirmation is required');
  }
  return Object.freeze({ changes: assertUpdateChanges(input.changes), previewDigest: input.previewDigest, confirmation: input.confirmation });
}

async function assertDomainUpdateIdle(domainId, { jobRegistry = null, certificateRegistry = null } = {}) {
  const [jobs, certificates] = await Promise.all([
    jobRegistry?.listJobs ? jobRegistry.listJobs({ resourceType: 'domain', resourceId: domainId }) : [],
    certificateRegistry?.listCertificates ? certificateRegistry.listCertificates() : [],
  ]);
  const domainBusy = jobs.some((job) => job.status === 'queued' || job.status === 'running');
  const certificateBusy = certificates.some((certificate) => (
    certificate.domainId === domainId && CERTIFICATE_OPERATION_STATES.has(certificate.state)
  ));
  if (domainBusy || certificateBusy) {
    throw new DomainRegistryError('domain_update_operation_conflict', 'Wait for the active Domain or certificate operation to finish before updating routing', 409);
  }
}

// Transport mapping is separate from validation and persistence so parent/Website
// references and error propagation can be tested without a network listener.
export function createDomainHandler(domainRegistry) {
  return async (request, response, next) => {
    try {
      const domain = await domainRegistry.createDomain({
        serverId: request.body?.serverId,
        websiteId: request.body?.websiteId ?? null,
        primaryDomain: request.body?.primaryDomain,
        parentDomainId: request.body?.parentDomainId ?? null,
        aliases: request.body?.aliases ?? [],
        targetType: request.body?.targetType,
        target: request.body?.target,
        httpsMode: request.body?.httpsMode ?? 'off',
        httpsRedirect: request.body?.httpsRedirect,
        canonicalRedirect: request.body?.canonicalRedirect ?? false,
      });
      return response.status(201).json({ data: domain });
    } catch (error) {
      return next(error);
    }
  };
}

export function createDomainReparentPreviewHandler(domainRegistry) {
  return async (request, response, next) => {
    try {
      if (!domainRegistry || typeof domainRegistry.previewDomainReparent !== 'function') {
        throw new DomainRegistryError('domain_reparent_unavailable', 'Domain reparent preview is unavailable', 503);
      }
      const input = assertReparentPreviewBody(request.body);
      const preview = await domainRegistry.previewDomainReparent({ domainId: request.params.domainId, ...input });
      return response.json({ data: preview });
    } catch (error) {
      return next(error);
    }
  };
}

export function createDomainUpdatePreviewHandler(domainRegistry) {
  return async (request, response, next) => {
    try {
      if (!domainRegistry || typeof domainRegistry.previewDomainUpdate !== 'function') {
        throw new DomainRegistryError('domain_update_unavailable', 'Domain update preview is unavailable', 503);
      }
      const preview = await domainRegistry.previewDomainUpdate({ domainId: request.params.domainId, ...assertUpdatePreviewBody(request.body) });
      return response.json({ data: preview });
    } catch (error) {
      return next(error);
    }
  };
}

export function createDomainUpdateHandler(domainRegistry, dependencies = {}) {
  return async (request, response, next) => {
    try {
      if (!domainRegistry || typeof domainRegistry.previewDomainUpdate !== 'function' || typeof domainRegistry.updateDomain !== 'function') {
        throw new DomainRegistryError('domain_update_unavailable', 'Domain update is unavailable', 503);
      }
      const input = assertUpdateApplyBody(request.body);
      await assertDomainUpdateIdle(request.params.domainId, dependencies);
      const preview = await domainRegistry.previewDomainUpdate({ domainId: request.params.domainId, changes: input.changes });
      if (input.previewDigest !== preview.previewDigest) {
        throw new DomainRegistryError('domain_update_preview_stale', 'Domain routing state changed after preview; request a new preview', 409);
      }
      if (input.confirmation !== preview.confirmation) {
        throw new DomainRegistryError('domain_update_confirmation_required', `Confirm Domain update with ${preview.confirmation}`);
      }
      const result = await domainRegistry.updateDomain({
        domainId: request.params.domainId,
        changes: input.changes,
        previewDigest: input.previewDigest,
      });
      return response.json({ data: result });
    } catch (error) {
      return next(error);
    }
  };
}

export function createDomainReparentHandler(domainRegistry) {
  return async (request, response, next) => {
    try {
      if (!domainRegistry || typeof domainRegistry.previewDomainReparent !== 'function' || typeof domainRegistry.reparentDomain !== 'function') {
        throw new DomainRegistryError('domain_reparent_unavailable', 'Domain reparent is unavailable', 503);
      }
      const input = assertReparentApplyBody(request.body);
      const preview = await domainRegistry.previewDomainReparent({
        domainId: request.params.domainId,
        parentDomainId: input.parentDomainId,
      });
      if (input.previewDigest !== preview.previewDigest) {
        throw new DomainRegistryError('domain_reparent_preview_stale', 'Domain hierarchy changed after preview; request a new preview', 409);
      }
      if (input.confirmation !== preview.confirmation) {
        throw new DomainRegistryError('domain_reparent_confirmation_required', `Confirm Domain reparent with ${preview.confirmation}`);
      }
      const result = await domainRegistry.reparentDomain({
        domainId: request.params.domainId,
        parentDomainId: input.parentDomainId,
        previewDigest: input.previewDigest,
      });
      return response.json({ data: result });
    } catch (error) {
      return next(error);
    }
  };
}

export const domainHttpInternals = Object.freeze({
  assertReparentPreviewBody,
  assertReparentApplyBody,
  assertUpdatePreviewBody,
  assertUpdateApplyBody,
  assertDomainUpdateIdle,
});
