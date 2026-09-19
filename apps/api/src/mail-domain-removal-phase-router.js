export class MailDomainRemovalPhaseRouterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDomainRemovalPhaseRouterError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new MailDomainRemovalPhaseRouterError(code, message, status);
}

function operationIdentity(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)
    || !['local', 'external'].includes(operation.managementMode)
    || typeof operation.status !== 'string') {
    fail(
      'mail_domain_removal_phase_invalid',
      'Mail Domain removal phase cannot be routed',
    );
  }
  return operation;
}

export function createMailDomainRemovalPhaseRouter({
  configPhase,
  cleanupPhase,
  dataPhase,
  finalizePhase,
} = {}) {
  if (!configPhase || typeof configPhase.execute !== 'function' || typeof configPhase.inspect !== 'function'
    || !cleanupPhase || typeof cleanupPhase.execute !== 'function' || typeof cleanupPhase.inspect !== 'function'
    || !dataPhase || typeof dataPhase.execute !== 'function' || typeof dataPhase.inspect !== 'function'
    || !finalizePhase || typeof finalizePhase.execute !== 'function' || typeof finalizePhase.inspect !== 'function') {
    throw new MailDomainRemovalPhaseRouterError(
      'mail_domain_removal_phase_dependencies_invalid',
      'Mail Domain removal phase dependencies are unavailable',
      503,
    );
  }

  function localPhase(operation) {
    if (operation.status === 'pending' || operation.status === 'disabling') return configPhase;
    if (operation.status === 'cleaning') return cleanupPhase;
    if (operation.status === 'backing_up' || operation.status === 'deleting_data') return dataPhase;
    if (operation.status === 'finalizing') return finalizePhase;
    return null;
  }

  function externalPhase(operation) {
    if (operation.status === 'pending' || operation.status === 'finalizing') return finalizePhase;
    return null;
  }

  function phaseFor(operation) {
    return operation.managementMode === 'local'
      ? localPhase(operation)
      : externalPhase(operation);
  }

  async function execute(operationValue) {
    const operation = operationIdentity(operationValue);
    const phase = phaseFor(operation);
    if (!phase) {
      fail(
        'mail_domain_removal_phase_not_executable',
        'Mail Domain removal phase has no executable adapter',
      );
    }
    return phase.execute(operation);
  }

  async function inspect(operationValue) {
    const operation = operationIdentity(operationValue);
    if (operation.status === 'pending') {
      fail(
        'mail_domain_removal_phase_not_inspectable',
        'Pending Mail Domain removal does not have an interrupted mutation to inspect',
      );
    }
    const phase = phaseFor(operation);
    if (!phase) {
      fail(
        'mail_domain_removal_phase_not_inspectable',
        'Mail Domain removal phase has no inspection adapter',
      );
    }
    return phase.inspect(operation);
  }

  return Object.freeze({ execute, inspect });
}

export const mailDomainRemovalPhaseRouterInternals = Object.freeze({
  operationIdentity,
});
