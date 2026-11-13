import { nginxConfigFileName } from '@yunpanel/config-templates';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export class WebsiteProvisioningRetirementError extends Error {
  constructor(code = 'website_provisioning_retirement_unverified', status = 409) {
    super('Removed Website compensation ownership could not be verified');
    this.name = 'WebsiteProvisioningRetirementError';
    this.code = code;
    this.status = status;
  }
}

function requireProof(condition, code) {
  if (!condition) throw new WebsiteProvisioningRetirementError(code);
}
const unique = values => [...new Set(values)].sort();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const terminal = value => value?.status === 'removed' && value.error === null
  && Array.isArray(value.steps) && value.steps.length > 0
  && value.steps.every(step => step.status === 'succeeded' && step.error === null);

function originalRouting(operation, { operationId, websiteId }, localServerId) {
  const resources = operation?.resources;
  const website = resources?.website;
  const application = resources?.application;
  const domains = [resources?.primaryDomain, resources?.wwwDomain].filter(Boolean);
  const nginx = operation?.steps?.find(step => step.id === 'nginx');
  const activation = operation?.steps?.find(step => step.id === 'domain_activation');
  requireProof(operation?.operationId === operationId && operation?.websiteId === websiteId
    && operation.terminalState !== 'abandoned' && timestamp(operation.createdAt)
    && UUID.test(operationId) && UUID.test(websiteId)
    && website?.id === websiteId && website.serverId === localServerId
    && typeof website.name === 'string' && website.name.length > 0
    && resources.primaryDomain && UUID.test(application?.id) && website.applicationId === application.id
    && application.serverId === localServerId && domains.length >= 1 && domains.length <= 2
    && domains.every(domain => UUID.test(domain.id) && domain.websiteId === websiteId
      && domain.serverId === localServerId && typeof domain.primaryDomain === 'string')
    && new Set(domains.map(domain => domain.id)).size === domains.length,
  'website_provisioning_retirement_source_invalid');
  const primaryDomain = resources.primaryDomain.primaryDomain;
  const aliases = unique([...(resources.primaryDomain.aliases ?? []), ...(resources.wwwDomain ? [resources.wwwDomain.primaryDomain] : [])]);
  requireProof(nginx?.intent?.websiteId === websiteId && nginx.intent.primaryDomain === primaryDomain
    && Array.isArray(nginx.intent.aliases) && same(unique(nginx.intent.aliases), aliases)
    && nginx.evidence?.satisfied === true && nginx.evidence.active === true
    && SHA256.test(nginx.evidence.checksum)
    && nginx.evidence.configName === `yunpanel-${nginxConfigFileName(primaryDomain)}`
    && activation?.intent?.adapter === 'domain-activation' && activation.intent.websiteId === websiteId
    && Array.isArray(activation.intent.domains)
    && activation.intent.domains.every(entry => Number.isSafeInteger(entry.expectedRevision) && entry.expectedRevision > 0)
    && same(activation.intent.domains.map(entry => entry.domainId).sort(), domains.map(domain => domain.id).sort())
    && activation.evidence?.satisfied === true
    && activation.evidence.adapter === 'domain-activation' && activation.evidence.websiteId === websiteId
    && Array.isArray(activation.evidence.domains)
    && same([...activation.evidence.domains].sort((a, b) => a.domainId.localeCompare(b.domainId)),
      [...activation.intent.domains].sort((a, b) => a.domainId.localeCompare(b.domainId)))
    && activation.evidence.nginxChecksum === nginx.evidence.checksum
    && activation.evidence.nginxConfigName === nginx.evidence.configName,
  'website_provisioning_retirement_routing_invalid');
  return Object.freeze({
    operationId, websiteId, applicationId: application.id, serverId: localServerId,
    name: website.name, createdAt: operation.createdAt, primaryDomain,
    domains: Object.freeze(domains.map(domain => Object.freeze({ id: domain.id, primaryDomain: domain.primaryDomain }))),
    names: Object.freeze(unique([primaryDomain, ...aliases, ...(nginx.intent.acmeOnlyHostnames ?? [])])),
    checksum: nginx.evidence.checksum, configName: nginx.evidence.configName,
  });
}

function verifyRetirement({ source, namespace, website, application, websiteRemovals, domainRemovals, nginx }) {
  requireProof(Array.isArray(websiteRemovals) && Array.isArray(domainRemovals),
    'website_provisioning_retirement_inventory_unavailable');
  requireProof(website === null && application === null && Array.isArray(namespace)
    && !namespace.some(domain => source.domains.some(old => old.id === domain.id)),
  'website_provisioning_retirement_metadata_present');
  requireProof(!namespace.some(domain => [domain.primaryDomain, domain.appliedPrimaryDomain, ...(domain.aliases ?? [])]
    .some(name => source.names.includes(name))), 'website_provisioning_retirement_name_reassigned');
  const matching = websiteRemovals.filter(removal => terminal(removal)
    && removal.websiteId === source.websiteId && removal.applicationId === source.applicationId
    && removal.serverId === source.serverId && removal.label === source.name
    && timestamp(removal.createdAt) && timestamp(removal.updatedAt)
    && Date.parse(removal.createdAt) >= Date.parse(source.createdAt)
    && removal.plan?.applicationId === source.applicationId
    && source.domains.every(domain => removal.plan.domains?.some(item => item.id === domain.id && item.primaryDomain === domain.primaryDomain)
      && removal.steps.some(step => step.kind === 'domain_removal' && step.resourceId === domain.id
        && step.result?.domainRemoved === true && step.result.domainId === domain.id))
    && removal.steps.some(step => step.kind === 'metadata_finalization' && step.resourceId === source.websiteId && step.result?.finalized === true)
    && removal.steps.some(step => step.kind === 'application_cleanup' && step.resourceId === source.applicationId && step.result?.applicationCleaned === true));
  requireProof(matching.length === 1, 'website_provisioning_retirement_removal_unverified');
  const removal = matching[0];
  const domainRemovalIds = source.domains.map(domain => {
    const candidates = domainRemovals.filter(item => terminal(item)
      && item.domainId === domain.id && item.serverId === source.serverId
      && item.primaryDomain === domain.primaryDomain && item.plan?.websiteId === source.websiteId
      && timestamp(item.createdAt) && timestamp(item.updatedAt)
      && Date.parse(item.createdAt) >= Date.parse(source.createdAt)
      && Date.parse(item.updatedAt) <= Date.parse(removal.updatedAt)
      && item.steps.some(step => step.kind === 'metadata_finalization' && step.resourceId === domain.id
        && step.result?.referenceId === domain.id && SHA256.test(step.result.evidenceDigest)));
    requireProof(candidates.length === 1, 'website_provisioning_retirement_domain_unverified');
    return candidates[0].id;
  });
  requireProof(nginx?.configName === source.configName && nginx.checksum === source.checksum
    && nginx.receiptVersion === 1 && nginx.hadPreviousActive === false && nginx.previousPrimaryDomain === null
    && (nginx.satisfied === true || nginx.satisfied === false && nginx.reason === 'nginx_compensation_pending'),
  'website_provisioning_retirement_receipt_unverified');
  return Object.freeze({
    satisfied: true, retired: true, reset: false, websiteId: source.websiteId,
    provisioningOperationId: source.operationId, removalOperationId: removal.id,
    domainRemovalIds: Object.freeze(domainRemovalIds),
    nginxChecksum: source.checksum, nginxConfigName: source.configName,
  });
}

export function createWebsiteProvisioningRetirementProvider({
  provisioningRegistry, websiteRegistry, applicationRegistry, domainRegistry,
  websiteRemovalRegistry, domainRemovalRegistry, nginxManager, localServerId,
} = {}) {
  requireProof(typeof localServerId === 'string' && localServerId.length > 0
    && typeof provisioningRegistry?.get === 'function'
    && typeof websiteRegistry?.getWebsite === 'function'
    && typeof applicationRegistry?.getApplication === 'function'
    && typeof domainRegistry?.withRoutingNamespaceReservation === 'function'
    && typeof websiteRemovalRegistry?.listForWebsite === 'function'
    && typeof domainRemovalRegistry?.listForDomain === 'function'
    && typeof nginxManager?.inspectDomainCompensation === 'function',
  'website_provisioning_retirement_dependencies_invalid');

  async function withRetiredRouting(context, action) {
    requireProof(typeof action === 'function', 'website_provisioning_retirement_action_invalid');
    return domainRegistry.withRoutingNamespaceReservation(async namespace => {
      const operation = await provisioningRegistry.get(context?.operationId);
      const source = originalRouting(operation, context ?? {}, localServerId);
      const requested = operation.steps.find(step => step.id === context.stepId);
      requireProof(['domain_activation', 'nginx'].includes(context.stepId)
        && requested && same(context.intent, requested.intent) && same(context.evidence, requested.evidence),
      'website_provisioning_retirement_context_drift');
      const [website, application, websiteRemovals, nested] = await Promise.all([
        websiteRegistry.getWebsite(source.websiteId), applicationRegistry.getApplication(source.applicationId),
        websiteRemovalRegistry.listForWebsite(source.websiteId),
        Promise.all(source.domains.map(domain => domainRemovalRegistry.listForDomain(domain.id))),
      ]);
      const nginx = await nginxManager.inspectDomainCompensation({ primaryDomain: source.primaryDomain, checksum: source.checksum });
      const proof = verifyRetirement({ source, namespace, website, application, websiteRemovals, domainRemovals: nested.flat(), nginx });
      // The namespace lease stays held through configtest/reload/rollback and
      // the manager's post-check. Never call Domain get/list from this callback.
      return action(proof);
    });
  }

  async function withCompensationRouting(context, action) {
    const operation = await provisioningRegistry.get(context?.operationId);
    const live = await websiteRegistry.getWebsite(context?.websiteId);
    if (live) {
      const removals = await websiteRemovalRegistry.listForWebsite(context.websiteId);
      requireProof(Array.isArray(removals), 'website_provisioning_retirement_inventory_unavailable');
      const retired = operation?.steps?.find(step => step.id === 'domain_activation')?.compensation?.evidence?.retired === true;
      if (retired || removals.some(terminal)) return withRetiredRouting(context, action);
      const planned = operation?.resources?.website;
      requireProof(operation?.operationId === context?.operationId && operation.websiteId === context.websiteId
        && live.id === context.websiteId && planned?.id === live.id
        && live.serverId === localServerId && planned.serverId === localServerId
        && live.applicationId === planned.applicationId && live.name === planned.name,
      'website_provisioning_retirement_live_identity_drift');
      return action();
    }
    return withRetiredRouting(context, action);
  }
  return Object.freeze({ withRetiredRouting, withCompensationRouting });
}

export const websiteProvisioningRetirementInternals = Object.freeze({ originalRouting, verifyRetirement });
