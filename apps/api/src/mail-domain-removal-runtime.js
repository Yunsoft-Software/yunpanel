import {
  mailDomainRemovalOperationPublicView,
  MailDomainRemovalOperationRegistryError,
} from './mail-domain-removal-operation-registry.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXECUTABLE_STATUSES = new Set([
  'pending', 'disabling', 'cleaning', 'deleting_data', 'finalizing', 'blocked', 'failed',
]);
const INTERRUPTED_STATUSES = new Set(['disabling', 'cleaning', 'deleting_data', 'finalizing']);
const OUTCOME_BASE_FIELDS = Object.freeze([
  'version', 'operationId', 'expectedUpdatedAt', 'fromStatus', 'disposition', 'sideEffects',
]);

export class MailDomainRemovalRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDomainRemovalRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function mapped(error) {
  if (error instanceof MailDomainRemovalRuntimeError) return error;
  if (error instanceof MailDomainRemovalOperationRegistryError) {
    return new MailDomainRemovalRuntimeError(error.code, error.message, error.status);
  }
  return error;
}

function safeFailure(error, fallbackCode, fallbackMessage) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,120}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const message = typeof error?.message === 'string' && error.message.length > 0
    && error.message.length <= 500
    ? error.message
    : fallbackMessage;
  return Object.freeze({ code, message });
}

function exactPreview(input, preview) {
  return Boolean(preview
    && preview.version === 1
    && preview.operation === 'mail_domain_remove'
    && preview.readyToStart === true
    && Array.isArray(preview.blockers)
    && preview.blockers.length === 0
    && preview.sideEffects === false
    && preview.parentOperationId === input.parentOperationId
    && preview.mailDomain?.id === input.mailDomainId
    && typeof preview.previewDigest === 'string'
    && SHA256_PATTERN.test(preview.previewDigest)
    && preview.previewDigest === input.previewDigest
    && typeof preview.confirmation === 'string'
    && preview.confirmation === input.confirmation);
}

function retryConfirmation(operation) {
  return mailDomainRemovalOperationPublicView(operation)?.recovery?.retryConfirmation ?? null;
}

function validateOutcome(operation, outcome, { inspection }) {
  const extraFields = outcome?.disposition === 'advance'
    ? ['status', 'evidence']
    : outcome?.disposition === 'removed' ? ['deletedAt'] : ['error'];
  const allowedFields = new Set([...OUTCOME_BASE_FIELDS, ...extraFields]);
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
    || Object.keys(outcome).length !== allowedFields.size
    || Object.keys(outcome).some((field) => !allowedFields.has(field))
    || outcome.version !== 1
    || outcome.operationId !== operation.id
    || outcome.expectedUpdatedAt !== operation.updatedAt
    || outcome.fromStatus !== operation.status
    || outcome.sideEffects !== !inspection
    || !['advance', 'removed', 'blocked', 'failed'].includes(outcome.disposition)) {
    throw new MailDomainRemovalRuntimeError(
      'mail_domain_removal_outcome_invalid',
      'Mail Domain removal phase outcome does not match the durable operation',
      503,
    );
  }
  if (outcome.disposition === 'advance') {
    if (typeof outcome.status !== 'string' || !outcome.evidence
      || Object.hasOwn(outcome, 'deletedAt') || Object.hasOwn(outcome, 'error')) {
      throw new MailDomainRemovalRuntimeError(
        'mail_domain_removal_outcome_invalid',
        'Mail Domain removal advance outcome is invalid',
        503,
      );
    }
    return Object.freeze({
      disposition: 'advance',
      status: outcome.status,
      evidence: outcome.evidence,
    });
  }
  if (outcome.disposition === 'removed') {
    if (typeof outcome.deletedAt !== 'string'
      || Object.hasOwn(outcome, 'status') || Object.hasOwn(outcome, 'evidence')
      || Object.hasOwn(outcome, 'error')) {
      throw new MailDomainRemovalRuntimeError(
        'mail_domain_removal_outcome_invalid',
        'Mail Domain removal completion outcome is invalid',
        503,
      );
    }
    return Object.freeze({ disposition: 'removed', deletedAt: outcome.deletedAt });
  }
  if (!outcome.error || Object.hasOwn(outcome, 'status')
    || Object.hasOwn(outcome, 'evidence') || Object.hasOwn(outcome, 'deletedAt')) {
    throw new MailDomainRemovalRuntimeError(
      'mail_domain_removal_outcome_invalid',
      'Mail Domain removal failure outcome is invalid',
      503,
    );
  }
  return Object.freeze({ disposition: outcome.disposition, error: outcome.error });
}

export function createMailDomainRemovalRuntime({
  registry,
  previewProvider,
  stepExecutor,
  stepInspector,
} = {}) {
  if (!registry || typeof registry.init !== 'function' || typeof registry.create !== 'function'
    || typeof registry.get !== 'function' || typeof registry.listForMailDomain !== 'function'
    || typeof registry.listIncomplete !== 'function' || typeof registry.advance !== 'function'
    || typeof registry.block !== 'function' || typeof registry.fail !== 'function'
    || typeof registry.retry !== 'function' || typeof registry.succeed !== 'function'
    || typeof previewProvider !== 'function' || typeof stepExecutor !== 'function'
    || typeof stepInspector !== 'function') {
    throw new MailDomainRemovalRuntimeError(
      'mail_domain_removal_runtime_dependencies_invalid',
      'Mail Domain removal runtime dependencies are unavailable',
      503,
    );
  }

  async function load(operationId) {
    let operation;
    try { operation = await registry.get(operationId); }
    catch (error) { throw mapped(error); }
    if (!operation) {
      throw new MailDomainRemovalRuntimeError(
        'mail_domain_removal_operation_not_found',
        'Mail Domain removal operation was not found',
        404,
      );
    }
    return operation;
  }

  async function applyOutcome(operation, rawOutcome, { inspection }) {
    const outcome = validateOutcome(operation, rawOutcome, { inspection });
    try {
      if (outcome.disposition === 'advance') {
        return await registry.advance(operation.id, {
          expectedUpdatedAt: operation.updatedAt,
          status: outcome.status,
          evidence: outcome.evidence,
        });
      }
      if (outcome.disposition === 'removed') {
        return await registry.succeed(operation.id, {
          expectedUpdatedAt: operation.updatedAt,
          deletedAt: outcome.deletedAt,
        });
      }
      if (outcome.disposition === 'blocked') {
        return await registry.block(operation.id, {
          expectedUpdatedAt: operation.updatedAt,
          error: outcome.error,
        });
      }
      return await registry.fail(operation.id, {
        expectedUpdatedAt: operation.updatedAt,
        error: outcome.error,
      });
    } catch (error) { throw mapped(error); }
  }

  async function execute(operation) {
    let outcome;
    try { outcome = await stepExecutor(operation); }
    catch (error) {
      const failure = safeFailure(
        error,
        'mail_domain_removal_phase_failed',
        'Mail Domain removal phase failed',
      );
      try {
        return await registry.fail(operation.id, {
          expectedUpdatedAt: operation.updatedAt,
          error: failure,
        });
      } catch (registryError) { throw mapped(registryError); }
    }
    try { return await applyOutcome(operation, outcome, { inspection: false }); }
    catch (error) {
      const failure = safeFailure(
        error,
        'mail_domain_removal_outcome_invalid',
        'Mail Domain removal phase returned invalid evidence',
      );
      try {
        return await registry.fail(operation.id, {
          expectedUpdatedAt: operation.updatedAt,
          error: failure,
        });
      } catch (registryError) { throw mapped(registryError); }
    }
  }

  async function inspectInterrupted(operation) {
    let outcome;
    try { outcome = await stepInspector(operation); }
    catch (error) {
      const failure = safeFailure(
        error,
        'mail_domain_removal_inspection_failed',
        'Mail Domain removal phase could not be inspected',
      );
      try {
        return await registry.block(operation.id, {
          expectedUpdatedAt: operation.updatedAt,
          error: failure,
        });
      } catch (registryError) { throw mapped(registryError); }
    }
    try { return await applyOutcome(operation, outcome, { inspection: true }); }
    catch (error) {
      const failure = safeFailure(
        error,
        'mail_domain_removal_inspection_invalid',
        'Mail Domain removal inspection returned invalid evidence',
      );
      try {
        return await registry.block(operation.id, {
          expectedUpdatedAt: operation.updatedAt,
          error: failure,
        });
      } catch (registryError) { throw mapped(registryError); }
    }
  }

  async function preview(input) {
    try { return await previewProvider(input); }
    catch (error) { throw mapped(error); }
  }

  async function start({ mailDomainId, parentOperationId, previewDigest, confirmation } = {}) {
    if (typeof mailDomainId !== 'string' || !mailDomainId
      || typeof parentOperationId !== 'string' || !parentOperationId
      || typeof previewDigest !== 'string' || !SHA256_PATTERN.test(previewDigest)
      || typeof confirmation !== 'string' || !confirmation) {
      throw new MailDomainRemovalRuntimeError(
        'mail_domain_removal_confirmation_invalid',
        'A current Mail Domain removal preview and exact confirmation are required',
        409,
      );
    }
    const input = { mailDomainId, parentOperationId, previewDigest, confirmation };
    let current;
    try { current = await previewProvider({ mailDomainId, parentOperationId }); }
    catch (error) { throw mapped(error); }
    if (!exactPreview(input, current)) {
      throw new MailDomainRemovalRuntimeError(
        'mail_domain_removal_preview_stale',
        'Mail Domain removal preview is stale, blocked or confirmation is invalid',
        409,
      );
    }
    let operation;
    try { operation = await registry.create(current); }
    catch (error) { throw mapped(error); }
    if (operation.parentOperationId !== parentOperationId
      || operation.mailDomainId !== mailDomainId
      || operation.previewDigest !== previewDigest) {
      throw new MailDomainRemovalRuntimeError(
        'mail_domain_removal_operation_drift',
        'Mail Domain removal journal does not match the approved preview',
        409,
      );
    }
    if (operation.status === 'removed') return mailDomainRemovalOperationPublicView(operation);
    if (operation.status !== 'pending') {
      throw new MailDomainRemovalRuntimeError(
        'mail_domain_removal_operation_active',
        'Mail Domain removal operation already requires explicit continuation',
        409,
      );
    }
    return mailDomainRemovalOperationPublicView(await execute(operation));
  }

  async function retry({
    mailDomainId,
    operationId,
    parentOperationId,
    expectedUpdatedAt,
    confirmation,
  } = {}) {
    let operation = await load(operationId);
    if (operation.mailDomainId !== mailDomainId
      || operation.parentOperationId !== parentOperationId) {
      throw new MailDomainRemovalRuntimeError(
        'mail_domain_removal_operation_not_found',
        'Mail Domain removal operation was not found',
        404,
      );
    }
    if (!EXECUTABLE_STATUSES.has(operation.status)
      || expectedUpdatedAt !== operation.updatedAt
      || confirmation !== retryConfirmation(operation)) {
      throw new MailDomainRemovalRuntimeError(
        'mail_domain_removal_retry_stale',
        'Mail Domain removal retry is stale or confirmation is invalid',
        409,
      );
    }
    if (['blocked', 'failed'].includes(operation.status)) {
      try {
        operation = await registry.retry(operation.id, { expectedUpdatedAt: operation.updatedAt });
      } catch (error) { throw mapped(error); }
    }
    return mailDomainRemovalOperationPublicView(await execute(operation));
  }

  async function listForMailDomain(mailDomainId) {
    try {
      return Object.freeze((await registry.listForMailDomain(mailDomainId))
        .map(mailDomainRemovalOperationPublicView));
    } catch (error) { throw mapped(error); }
  }

  async function get(operationId) {
    return mailDomainRemovalOperationPublicView(await load(operationId));
  }

  async function init() {
    try { await registry.init(); }
    catch (error) { throw mapped(error); }
    let incomplete;
    try { incomplete = await registry.listIncomplete(); }
    catch (error) { throw mapped(error); }
    const recovery = [];
    for (const operation of incomplete) {
      if (!INTERRUPTED_STATUSES.has(operation.status)) {
        recovery.push(Object.freeze({
          operationId: operation.id,
          reconciled: false,
          operation: mailDomainRemovalOperationPublicView(operation),
        }));
        continue;
      }
      try {
        const reconciled = await inspectInterrupted(operation);
        recovery.push(Object.freeze({
          operationId: operation.id,
          reconciled: reconciled.status !== 'blocked' && reconciled.status !== 'failed',
          operation: mailDomainRemovalOperationPublicView(reconciled),
        }));
      } catch (error) {
        recovery.push(Object.freeze({
          operationId: operation.id,
          reconciled: false,
          error: safeFailure(
            error,
            'mail_domain_removal_recovery_pending',
            'Mail Domain removal recovery remains pending',
          ),
        }));
      }
    }
    return Object.freeze(recovery);
  }

  return Object.freeze({ init, preview, start, retry, get, listForMailDomain });
}

export const mailDomainRemovalRuntimeInternals = Object.freeze({
  exactPreview,
  retryConfirmation,
  validateOutcome,
  safeFailure,
});
