export class DomainRemovalBackupImpactError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'DomainRemovalBackupImpactError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 409) {
  throw new DomainRemovalBackupImpactError(code, message, status);
}

function safeContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || typeof context.serverId !== 'string' || !context.serverId
    || !Array.isArray(context.domainIds)
    || context.domainIds.some((id) => typeof id !== 'string' || !id)
    || (context.websiteId !== null && context.websiteId !== undefined
      && (typeof context.websiteId !== 'string' || !context.websiteId))) {
    fail('domain_removal_backup_context_invalid', 'Backup impact context is invalid');
  }
  return context;
}

function successfulStepReferences(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)
    || !operation.plan || typeof operation.plan !== 'object' || Array.isArray(operation.plan)
    || !Array.isArray(operation.plan.steps) || !Array.isArray(operation.steps)) {
    fail('domain_removal_backup_operation_invalid', 'Backup operation inventory is invalid');
  }
  const planById = new Map(operation.plan.steps.map((step) => [step?.stepId, step]));
  if (planById.size !== operation.plan.steps.length) {
    fail('domain_removal_backup_operation_invalid', 'Backup operation plan contains duplicate steps');
  }
  return operation.steps
    .filter((step) => step?.status === 'succeeded' && step.evidence !== null)
    .map((step) => {
      const planStep = planById.get(step.stepId);
      if (!planStep || !step.evidence
        || typeof step.evidence.artifactId !== 'string' || !step.evidence.artifactId) {
        fail('domain_removal_backup_operation_invalid', 'Backup operation evidence is invalid');
      }
      return Object.freeze({ state: step, plan: planStep });
    });
}

function stepTouchesAffectedResource(planStep, scope) {
  const input = planStep?.input;
  if (!planStep || typeof planStep !== 'object' || Array.isArray(planStep)
    || !input || typeof input !== 'object' || Array.isArray(input)) {
    fail('domain_removal_backup_plan_invalid', 'Backup execution step is invalid');
  }
  if (planStep.resourceType === 'application') {
    return scope.applicationIds.has(input.applicationId);
  }
  if (planStep.resourceType === 'database') {
    return typeof input.databaseName === 'string'
      && scope.databaseNames.has(input.databaseName.toLowerCase());
  }
  if (planStep.resourceType === 'docker_storage') {
    return scope.dockerProjectIds.has(input.projectId);
  }
  if (planStep.resourceType === 'mail_data') {
    return scope.mailDomainIds.has(input.mailDomainId);
  }
  fail('domain_removal_backup_plan_invalid', 'Backup execution step has an unsupported resource type');
}

function backupReference(operation, executionStep) {
  const id = operation.id + ':' + executionStep.plan.stepId;
  if (id.length > 160) {
    fail('domain_removal_backup_reference_invalid', 'Backup impact reference is too long');
  }
  return Object.freeze({
    id,
    state: 'retained_' + executionStep.plan.resourceType,
  });
}

export function createDomainRemovalBackupImpactProvider({
  backupOperationRegistry,
  domainRegistry,
  websiteRegistry,
  databaseBindingRegistry,
  mailDomainRegistry,
  localServerId = null,
} = {}) {
  if (!backupOperationRegistry || typeof backupOperationRegistry.listOperations !== 'function'
    || !domainRegistry || typeof domainRegistry.getDomain !== 'function'
    || !websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !databaseBindingRegistry || typeof databaseBindingRegistry.listBindings !== 'function'
    || !mailDomainRegistry || typeof mailDomainRegistry.listMailDomains !== 'function') {
    throw new DomainRemovalBackupImpactError(
      'domain_removal_backup_dependencies_invalid',
      'Backup impact dependencies are unavailable',
      503,
    );
  }

  return async function domainRemovalBackupImpact(contextValue) {
    const context = safeContext(contextValue);
    if (localServerId !== null && context.serverId !== localServerId) {
      fail('domain_removal_backup_server_mismatch', 'Backup impact request targets another server');
    }

    const domainIds = new Set(context.domainIds);
    const websiteIds = new Set();
    if (context.websiteId) websiteIds.add(context.websiteId);

    for (const domainId of domainIds) {
      let domain;
      try { domain = await domainRegistry.getDomain(domainId); }
      catch {
        fail('domain_removal_backup_domain_unavailable', 'Backup impact Domain state is unavailable', 503);
      }
      if (!domain || domain.id !== domainId || domain.serverId !== context.serverId) {
        fail('domain_removal_backup_domain_drift', 'Backup impact Domain ownership is stale');
      }
      if (domain.websiteId !== null && domain.websiteId !== undefined) websiteIds.add(domain.websiteId);
    }

    const websites = [];
    for (const websiteId of [...websiteIds].sort()) {
      let website;
      try { website = await websiteRegistry.getWebsite(websiteId); }
      catch {
        fail('domain_removal_backup_website_unavailable', 'Backup impact Website state is unavailable', 503);
      }
      if (!website || website.id !== websiteId || website.serverId !== context.serverId) {
        fail('domain_removal_backup_website_drift', 'Backup impact Website ownership is stale');
      }
      websites.push(website);
    }

    let bindings;
    let mailDomains;
    let operations;
    try {
      [bindings, mailDomains, operations] = await Promise.all([
        databaseBindingRegistry.listBindings({ serverId: context.serverId }),
        mailDomainRegistry.listMailDomains(),
        backupOperationRegistry.listOperations({ serverId: context.serverId }),
      ]);
    } catch {
      fail('domain_removal_backup_inventory_unavailable', 'Backup impact inventory is unavailable', 503);
    }
    if (!Array.isArray(bindings) || !Array.isArray(mailDomains) || !Array.isArray(operations)) {
      fail('domain_removal_backup_inventory_invalid', 'Backup impact inventory is invalid', 503);
    }

    const scope = Object.freeze({
      applicationIds: new Set(websites
        .map((website) => website.applicationId)
        .filter((id) => typeof id === 'string' && id)),
      dockerProjectIds: new Set(websites
        .map((website) => website.managedComposeBinding?.projectId ?? null)
        .filter((id) => typeof id === 'string' && id)),
      databaseNames: new Set(bindings
        .filter((binding) => websiteIds.has(binding?.websiteId))
        .map((binding) => String(binding.databaseName).toLowerCase())),
      mailDomainIds: new Set(mailDomains
        .filter((mailDomain) => mailDomain?.webDomainId !== null && domainIds.has(mailDomain.webDomainId))
        .map((mailDomain) => mailDomain.id)),
    });

    const references = [];
    for (const operation of operations) {
      for (const executionStep of successfulStepReferences(operation)) {
        if (!stepTouchesAffectedResource(executionStep.plan, scope)) continue;
        references.push(backupReference(operation, executionStep));
      }
    }
    references.sort((left, right) => left.id.localeCompare(right.id));
    if (references.length > 500 || new Set(references.map((reference) => reference.id)).size !== references.length) {
      fail('domain_removal_backup_inventory_invalid', 'Backup impact inventory is duplicated or too large', 503);
    }
    return Object.freeze(references);
  };
}

export const domainRemovalBackupImpactInternals = Object.freeze({
  safeContext,
  successfulStepReferences,
  stepTouchesAffectedResource,
  backupReference,
});
