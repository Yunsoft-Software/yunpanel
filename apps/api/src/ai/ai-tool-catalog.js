export const AI_TOOL_RISKS = Object.freeze({
  READ: 'read',
  REVERSIBLE_WRITE: 'reversible_write',
  DESTRUCTIVE: 'destructive',
});

export const AI_TOOL_CONFIRMATION = Object.freeze({
  NEVER: 'never',
  CONFIGURABLE: 'configurable',
  ALWAYS: 'always',
});

function objectSchema(properties = {}, required = []) {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze(properties),
    required: Object.freeze(required),
  });
}

const ID = Object.freeze({ type: 'string', minLength: 1, maxLength: 128 });
const QUERY = Object.freeze({ type: 'string', minLength: 1, maxLength: 512 });

export const DEFAULT_AI_TOOL_DEFINITIONS = Object.freeze([
  { name: 'server.health', description: 'Inspect the local YunPanel server health.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({}) },
  { name: 'website.list', description: 'List Websites managed by this YunPanel host.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({}) },
  { name: 'website.inspect', description: 'Inspect one Website and its current control-plane state.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({ websiteId: ID }, ['websiteId']) },
  { name: 'website.restart', description: 'Restart the runtime bound to one Website.', risk: AI_TOOL_RISKS.REVERSIBLE_WRITE, confirmation: AI_TOOL_CONFIRMATION.CONFIGURABLE, defaultPolicy: 'allow', inputSchema: objectSchema({ websiteId: ID }, ['websiteId']) },
  { name: 'application.inspect', description: 'Inspect one Application and its current runtime/deploy state.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({ applicationId: ID }, ['applicationId']) },
  { name: 'application.deploy', description: 'Queue a deployment through the existing YunPanel durable deployment flow.', risk: AI_TOOL_RISKS.REVERSIBLE_WRITE, confirmation: AI_TOOL_CONFIRMATION.CONFIGURABLE, defaultPolicy: 'confirm', inputSchema: objectSchema({ applicationId: ID, gitTarget: Object.freeze({ type: 'string', minLength: 1, maxLength: 512 }) }, ['applicationId']) },
  { name: 'application.rollback', description: 'Roll an Application back through the existing durable rollback flow.', risk: AI_TOOL_RISKS.REVERSIBLE_WRITE, confirmation: AI_TOOL_CONFIRMATION.CONFIGURABLE, defaultPolicy: 'confirm', inputSchema: objectSchema({ applicationId: ID, releaseId: ID }, ['applicationId', 'releaseId']) },
  { name: 'logs.query', description: 'Query bounded YunPanel-managed logs without exposing unrestricted filesystem access.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({ websiteId: ID, applicationId: ID, query: QUERY, limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 200 }) }) },
  { name: 'dns.inspect', description: 'Inspect DNS state known to YunPanel for a Website or zone.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({ websiteId: ID, dnsZoneId: ID }) },
  { name: 'dns.update', description: 'Apply an explicitly scoped DNS change through YunPanel DNS lifecycle APIs.', risk: AI_TOOL_RISKS.REVERSIBLE_WRITE, confirmation: AI_TOOL_CONFIRMATION.CONFIGURABLE, defaultPolicy: 'confirm', inputSchema: objectSchema({ dnsZoneId: ID, change: Object.freeze({ type: 'object' }) }, ['dnsZoneId', 'change']) },
  { name: 'certificate.inspect', description: 'Inspect certificate state for a Domain or Website.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({ domainId: ID, websiteId: ID }) },
  { name: 'certificate.issue', description: 'Queue certificate issuance through the existing certificate job flow.', risk: AI_TOOL_RISKS.REVERSIBLE_WRITE, confirmation: AI_TOOL_CONFIRMATION.CONFIGURABLE, defaultPolicy: 'confirm', inputSchema: objectSchema({ domainId: ID }, ['domainId']) },
  { name: 'certificate.renew', description: 'Queue renewal for an existing managed certificate.', risk: AI_TOOL_RISKS.REVERSIBLE_WRITE, confirmation: AI_TOOL_CONFIRMATION.CONFIGURABLE, defaultPolicy: 'confirm', inputSchema: objectSchema({ certificateId: ID }, ['certificateId']) },
  { name: 'mail.inspect', description: 'Inspect bounded mail health and configuration state.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({ websiteId: ID, mailDomainId: ID }) },
  { name: 'database.inspect', description: 'Inspect database inventory and Website bindings.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({ websiteId: ID, databaseName: Object.freeze({ type: 'string', minLength: 1, maxLength: 128 }) }) },
  { name: 'backup.inspect', description: 'Inspect backup repository and Website backup state.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({ websiteId: ID }) },
  { name: 'backup.create', description: 'Create a Website backup through the existing restic-backed lifecycle.', risk: AI_TOOL_RISKS.REVERSIBLE_WRITE, confirmation: AI_TOOL_CONFIRMATION.CONFIGURABLE, defaultPolicy: 'allow', inputSchema: objectSchema({ websiteId: ID }, ['websiteId']) },
  { name: 'backup.restore', description: 'Restore Website data through the existing preview and restore lifecycle.', risk: AI_TOOL_RISKS.DESTRUCTIVE, confirmation: AI_TOOL_CONFIRMATION.ALWAYS, inputSchema: objectSchema({ websiteId: ID, snapshotId: ID }, ['websiteId', 'snapshotId']) },
  { name: 'job.inspect', description: 'Inspect one durable YunPanel job and its safe public result.', risk: AI_TOOL_RISKS.READ, confirmation: AI_TOOL_CONFIRMATION.NEVER, inputSchema: objectSchema({ jobId: ID }, ['jobId']) },
  { name: 'service.restart', description: 'Restart one allowlisted managed system service.', risk: AI_TOOL_RISKS.REVERSIBLE_WRITE, confirmation: AI_TOOL_CONFIRMATION.CONFIGURABLE, defaultPolicy: 'allow', inputSchema: objectSchema({ serviceId: ID }, ['serviceId']) },
].map((definition) => Object.freeze({
  defaultPolicy: definition.defaultPolicy ?? (definition.confirmation === AI_TOOL_CONFIRMATION.NEVER ? 'allow' : 'confirm'),
  ...definition,
})));
