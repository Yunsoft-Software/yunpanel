import {
  createMailDataBackupManager,
  createMailDataInspector,
} from '@yunpanel/host-runtime';

import { createMailDeleteFinalizeService } from './mail-delete-finalize.js';
import { createMailDeleteImpactService } from './mail-delete-impact.js';
import { createMailDomainRemovalCleanupPhase } from './mail-domain-removal-cleanup-phase.js';
import { createMailDomainRemovalConfigPhase } from './mail-domain-removal-config-phase.js';
import { createMailDomainRemovalDataPhase } from './mail-domain-removal-data-phase.js';
import { createMailDomainRemovalFinalizePhase } from './mail-domain-removal-finalize-phase.js';
import { createMailDomainRemovalOperationRegistry } from './mail-domain-removal-operation-registry.js';
import { createMailDomainRemovalPhaseRouter } from './mail-domain-removal-phase-router.js';
import { createMailDomainRemovalPlanService } from './mail-domain-removal-plan.js';
import { createMailDomainRemovalRuntime } from './mail-domain-removal-runtime.js';

export class MailDomainRemovalProductionRuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailDomainRemovalProductionRuntimeError';
    this.code = code;
    this.status = status;
  }
}

export function createMailDomainRemovalProductionRuntime({
  filePath,
  mailDomainRegistry,
  domainRegistry,
  mailboxRegistry,
  mailAliasRegistry,
  mailboxQuotaRegistry,
  mailboxForwardingRegistry,
  mailDkimRegistry,
  mailConfigurationService,
  jobRegistry,
  localServerId,
  mailDataInspector = createMailDataInspector(),
  mailDataBackupManager = null,
  mailDeleteImpactService = null,
  mailDeleteFinalizeService = null,
  roundcubeDomainMappingRegistry = null,
  roundcubeDomainMappingService = null,
} = {}) {
  if (typeof filePath !== 'string' || !filePath
    || typeof localServerId !== 'string' || !localServerId
    || !jobRegistry || typeof jobRegistry.findIdempotentJob !== 'function') {
    throw new MailDomainRemovalProductionRuntimeError(
      'mail_domain_removal_production_dependencies_invalid',
      'Mail Domain removal production runtime dependencies are unavailable',
      503,
    );
  }

  const backupManager = mailDataBackupManager ?? createMailDataBackupManager({
    mailDataInspector,
  });
  const deleteImpact = mailDeleteImpactService ?? createMailDeleteImpactService({
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDkimRegistry,
    jobRegistry,
    mailDataInspector,
    roundcubeDomainMappingRegistry,
    localServerId,
  });
  const deleteFinalize = mailDeleteFinalizeService ?? createMailDeleteFinalizeService({
    mailboxRegistry,
    mailDomainRegistry,
    mailDeleteImpactService: deleteImpact,
    jobRegistry,
  });
  const planService = createMailDomainRemovalPlanService({
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDkimRegistry,
    mailConfigurationService,
    jobRegistry,
    mailDataInspector,
    roundcubeDomainMappingRegistry,
    localServerId,
  });
  const operationRegistry = createMailDomainRemovalOperationRegistry({ filePath });
  const configPhase = createMailDomainRemovalConfigPhase({
    mailDomainRegistry,
    domainRegistry,
    mailConfigurationService,
    jobRegistry,
    jobIdempotencyLookup: Object.freeze({
      find: (request) => jobRegistry.findIdempotentJob(request),
    }),
    localServerId,
  });
  const cleanupPhase = createMailDomainRemovalCleanupPhase({
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailAliasRegistry,
    mailboxQuotaRegistry,
    mailboxForwardingRegistry,
    mailDkimRegistry,
    localServerId,
  });
  const dataPhase = createMailDomainRemovalDataPhase({
    mailDomainRegistry,
    domainRegistry,
    mailboxRegistry,
    mailDataInspector,
    mailDataBackupManager: backupManager,
    jobRegistry,
    localServerId,
  });
  const finalizePhase = createMailDomainRemovalFinalizePhase({
    mailDomainRegistry,
    domainRegistry,
    mailDeleteFinalizeService: deleteFinalize,
    localServerId,
  });
  const phaseRouter = createMailDomainRemovalPhaseRouter({
    configPhase,
    cleanupPhase,
    dataPhase,
    finalizePhase,
  });
  const runtime = createMailDomainRemovalRuntime({
    registry: operationRegistry,
    previewProvider: (input) => planService.preview(input),
    stepExecutor: (operation) => phaseRouter.execute(operation),
    stepInspector: (operation) => phaseRouter.inspect(operation),
  });

  return Object.freeze({
    runtime,
    registry: operationRegistry,
    planService,
    phaseRouter,
    mailDataInspector,
    mailDataBackupManager: backupManager,
    mailDeleteImpactService: deleteImpact,
    mailDeleteFinalizeService: deleteFinalize,
  });
}
