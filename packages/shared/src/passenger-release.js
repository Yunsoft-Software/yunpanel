import { ApplicationValidationError, assertUuid, normalizeGitBranch, normalizeGithubRepositoryUrl, normalizeGitDeploymentTarget } from './application.js';
import { normalizeNodeRuntimeConfig } from './node-application.js';

const fail = () => { throw new ApplicationValidationError('invalid_passenger_release', 'Passenger release snapshot is invalid'); };
const commonFields = ['applicationId', 'websiteId', 'unixUser', 'websiteRevision', 'configurationRevision', 'environmentRevision', 'bindingRevision', 'domains', 'runtime'];
function integer(value, minimum) { if (!Number.isSafeInteger(value) || value < minimum) fail(); return value; }
function routing(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail();
  const seen = new Set();
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 3
      || !Object.keys(entry).every(key => ['domainId', 'desiredRevision', 'nginxChecksum'].includes(key))
      || !/^[a-f0-9]{64}$/.test(entry.nginxChecksum ?? '')) fail();
    const domainId = assertUuid(entry.domainId, 'domainId');
    if (seen.has(domainId)) fail(); seen.add(domainId);
    return { domainId, desiredRevision: integer(entry.desiredRevision, 1), nginxChecksum: entry.nginxChecksum };
  }).sort((a, b) => a.domainId.localeCompare(b.domainId));
}
function common(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key)) || !/^yunapp-[a-f0-9]{12}$/.test(value.unixUser ?? '')) fail();
  const runtime = normalizeNodeRuntimeConfig(value.runtime, { requirePort: false });
  if (runtime.start.mode !== 'node' || !runtime.start.entryFile) fail();
  return { applicationId: assertUuid(value.applicationId, 'applicationId'), websiteId: assertUuid(value.websiteId, 'websiteId'),
    unixUser: value.unixUser, websiteRevision: integer(value.websiteRevision, 1), configurationRevision: integer(value.configurationRevision, 1),
    environmentRevision: integer(value.environmentRevision, 0), bindingRevision: integer(value.bindingRevision, 1), domains: routing(value.domains), runtime };
}
export function normalizePassengerNodeDeploySpec(value) {
  const result = common(value, [...commonFields, 'deploymentId', 'previousReleaseId', 'repositoryUrl', 'branch', 'gitTarget', 'retention']);
  const branch = normalizeGitBranch(value.branch);
  return { ...result, deploymentId: assertUuid(value.deploymentId, 'deploymentId'), previousReleaseId: assertUuid(value.previousReleaseId, 'previousReleaseId'),
    repositoryUrl: normalizeGithubRepositoryUrl(value.repositoryUrl), branch, gitTarget: normalizeGitDeploymentTarget(value.gitTarget, { defaultBranch: branch }),
    retention: integer(value.retention, 2) <= 20 ? value.retention : fail() };
}
export function normalizePassengerNodeRollbackSpec(value) {
  const result = common(value, [...commonFields, 'releaseId', 'currentReleaseId', 'commitSha', 'releaseConfigurationRevision']);
  if (!/^[a-f0-9]{40}$/.test(value.commitSha ?? '')) fail();
  const releaseId = assertUuid(value.releaseId, 'releaseId'), currentReleaseId = assertUuid(value.currentReleaseId, 'currentReleaseId');
  if (releaseId === currentReleaseId) fail();
  return { ...result, releaseId, currentReleaseId, commitSha: value.commitSha, releaseConfigurationRevision: integer(value.releaseConfigurationRevision, 1) };
}
