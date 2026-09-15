import { createHash } from 'node:crypto';
import path from 'node:path';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';

const HOSTED_RUNTIME_TYPES = new Set(['static', 'node', 'php']);
const ISOLATION_STEPS = Object.freeze({
  static: Object.freeze(['unix_identity', 'runtime', 'sftp']),
  node: Object.freeze(['unix_identity', 'runtime', 'sftp']),
  php: Object.freeze(['unix_identity', 'php_runtime', 'sftp']),
});

export class WebsiteIsolationAuditError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteIsolationAuditError';
    this.code = code;
    this.status = status;
  }
}

function expectedDocumentRoot(runtimeType, identity) {
  if (runtimeType === 'static') return path.posix.join(identity.paths.static.publishRoot, 'current');
  if (runtimeType === 'node') return identity.paths.runtime.currentRelease;
  if (runtimeType === 'php') return path.posix.join(identity.paths.runtime.currentRelease, 'public');
  return null;
}

function finding(code, severity, message, action) {
  return Object.freeze({ code, severity, message, action });
}

function migrationDigest(core) {
  return createHash('sha256').update(JSON.stringify(core)).digest('hex');
}

function handlerContext(operation, step) {
  return Object.freeze({
    operation,
    operationId: operation.operationId,
    websiteId: operation.websiteId,
    stepId: step.id,
    intent: step.intent,
    evidence: step.evidence,
    compensation: step.compensation,
  });
}

export function createWebsiteIsolationAuditService({
  websiteRegistry,
  applicationRegistry,
  provisioningRegistry = null,
  provisioningHandlers = null,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || (provisioningRegistry !== null && typeof provisioningRegistry.getLatestForWebsite !== 'function')) {
    throw new WebsiteIsolationAuditError(
      'website_isolation_audit_dependencies_invalid',
      'Website isolation audit dependencies are unavailable',
      503,
    );
  }

  async function audit(websiteId) {
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website) throw new WebsiteIsolationAuditError('website_not_found', 'Website not found', 404);
    if (!HOSTED_RUNTIME_TYPES.has(website.runtimeType)) {
      return Object.freeze({
        version: 1,
        websiteId: website.id,
        runtimeType: website.runtimeType,
        applicable: false,
        status: 'not_applicable',
        migrationRequired: false,
        findings: Object.freeze([]),
        migration: null,
      });
    }
    if (!website.applicationId) {
      throw new WebsiteIsolationAuditError('website_isolation_application_missing', 'Hosted Website has no Application identity', 409);
    }

    const application = await applicationRegistry.getApplication(website.applicationId);
    if (!application) {
      throw new WebsiteIsolationAuditError('website_isolation_application_missing', 'Hosted Website Application does not exist', 409);
    }
    if (application.serverId !== website.serverId || application.type !== website.runtimeType) {
      throw new WebsiteIsolationAuditError('website_isolation_binding_drift', 'Website and Application runtime binding has drifted', 409);
    }

    const identity = createApplicationIdentity(application.id);
    const expectedRoot = expectedDocumentRoot(website.runtimeType, identity);
    const findings = [];
    if (website.unixUser !== identity.unixUser) {
      findings.push(finding(
        'website_isolation_unix_user_drift',
        'critical',
        'Website Unix user does not match the canonical Application identity.',
        'Review the existing account and create an explicit migration plan; do not rename or chown recursively automatically.',
      ));
    }
    if (website.documentRoot !== expectedRoot) {
      findings.push(finding(
        'website_isolation_document_root_drift',
        'critical',
        'Website document root does not match the canonical runtime path contract.',
        'Inspect the existing release tree and plan an explicit cutover; do not move files automatically.',
      ));
    }

    const operation = provisioningRegistry
      ? await provisioningRegistry.getLatestForWebsite(website.id)
      : null;
    const inspectedSteps = [];
    if (!operation) {
      findings.push(finding(
        'website_isolation_operation_missing',
        'action_required',
        'Website has no durable provisioning operation that proves isolation state.',
        'Create an explicit adoption/migration operation after reviewing current UID/GID, paths and runtime state.',
      ));
    } else {
      for (const stepId of ISOLATION_STEPS[website.runtimeType]) {
        const step = operation.steps.find((candidate) => candidate.id === stepId) ?? null;
        if (!step) {
          findings.push(finding(
            `website_isolation_${stepId}_missing`,
            'action_required',
            `Durable Website provisioning is missing the ${stepId} isolation step.`,
            'Preview and apply an explicit Website isolation migration; do not mutate unrelated files.',
          ));
          continue;
        }
        const handler = provisioningHandlers?.[step.kind] ?? null;
        if (!handler || typeof handler.inspect !== 'function') {
          inspectedSteps.push(Object.freeze({ stepId, kind: step.kind, satisfied: null, reason: 'inspect_unavailable' }));
          findings.push(finding(
            `website_isolation_${stepId}_inspect_unavailable`,
            'action_required',
            `Current host state for ${stepId} cannot be inspected through the configured runtime.`,
            'Restore the isolation inspector before migration or readiness decisions.',
          ));
          continue;
        }
        try {
          const result = await handler.inspect(handlerContext(operation, step));
          const satisfied = result?.satisfied === true;
          inspectedSteps.push(Object.freeze({
            stepId,
            kind: step.kind,
            satisfied,
            reason: satisfied ? null : result?.reason ?? 'isolation_not_satisfied',
          }));
          if (!satisfied) {
            findings.push(finding(
              `website_isolation_${stepId}_not_satisfied`,
              'action_required',
              `${stepId} host isolation is not currently satisfied.`,
              'Inspect the reported drift and use an explicit migration/retry path instead of recursive ownership repair.',
            ));
          }
        } catch (error) {
          inspectedSteps.push(Object.freeze({
            stepId,
            kind: step.kind,
            satisfied: false,
            reason: typeof error?.code === 'string' ? error.code : 'isolation_inspection_failed',
          }));
          findings.push(finding(
            `website_isolation_${stepId}_drift`,
            'critical',
            `${stepId} inspection detected managed host drift.`,
            'Stop automatic migration and review the host evidence before changing ownership or routing.',
          ));
        }
      }
    }

    const migrationRequired = findings.length > 0;
    const migrationCore = Object.freeze({
      version: 1,
      websiteId: website.id,
      websiteRevision: website.revision,
      applicationId: application.id,
      runtimeType: website.runtimeType,
      expected: Object.freeze({
        unixUser: identity.unixUser,
        homeDirectory: identity.paths.workspace.homeDirectory,
        documentRoot: expectedRoot,
        temporaryDirectory: identity.paths.workspace.temporaryDirectory,
        logDirectory: identity.paths.workspace.logDirectory,
      }),
      actions: Object.freeze(findings.map((entry) => Object.freeze({ code: entry.code, action: entry.action }))),
    });
    const previewDigest = migrationDigest(migrationCore);

    return Object.freeze({
      ...migrationCore,
      applicable: true,
      status: migrationRequired ? 'migration_required' : 'isolated',
      migrationRequired,
      findings: Object.freeze(findings),
      inspectedSteps: Object.freeze(inspectedSteps),
      migration: migrationRequired ? Object.freeze({
        destructive: false,
        autoApply: false,
        previewDigest,
        confirmation: `migrate-isolation:${website.id}:${website.revision}:${previewDigest}`,
        warning: 'Preview only. No ownership, filesystem or runtime mutation is performed by this audit.',
      }) : null,
    });
  }

  return Object.freeze({ audit });
}

export const websiteIsolationAuditInternals = Object.freeze({
  hostedRuntimeTypes: Object.freeze([...HOSTED_RUNTIME_TYPES]),
  isolationSteps: ISOLATION_STEPS,
  expectedDocumentRoot,
  migrationDigest,
});
