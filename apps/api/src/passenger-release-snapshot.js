import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';
import { resolveWebsiteDomainTarget } from './website-domain-target.js';

export const passengerReleaseError = code => Object.assign(new Error('Passenger yayın işleminin site ve sürüm kanıtı doğrulanamadı'), { code, status: 409 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export async function capturePassengerReleaseSnapshot({ application, websiteRegistry, domainRegistry, runtimeBindingRegistry,
  applicationRegistry, applicationEnvironmentRegistry, localServerId }) {
  if (!localServerId || application?.serverId !== localServerId || application.type !== 'node' || application.runtimeAdapter !== 'passenger'
    || !application.currentReleaseId) throw passengerReleaseError('passenger_release_scope_invalid');
  const websites = await websiteRegistry.listWebsites();
  const matching = websites.filter(w => w.applicationId === application.id);
  const identity = createApplicationIdentity(application.id);
  const website = matching[0];
  if (matching.length !== 1 || website.serverId !== localServerId || website.runtimeType !== 'node'
    || website.unixUser !== identity.unixUser || websites.some(w => w.id !== website.id && w.unixUser === website.unixUser)) throw passengerReleaseError('passenger_release_scope_invalid');
  const binding = await runtimeBindingRegistry.getBinding(application.id);
  if (!binding || binding.adapter !== 'passenger' || binding.state !== 'active' || binding.releaseId !== application.currentReleaseId
    || binding.websiteId !== website.id || binding.serverId !== localServerId || binding.websiteRevision !== website.revision) throw passengerReleaseError('passenger_release_binding_drift');
  const domains = (await domainRegistry.listDomains()).filter(d => d.websiteId === website.id).sort((a,b) => a.id.localeCompare(b.id));
  if (domains.length === 0 || !same(domains.map(d => d.id), binding.domains.map(d => d.domainId).sort())) throw passengerReleaseError('passenger_release_domain_scope_invalid');
  for (const domain of domains) {
    if (domain.serverId !== localServerId || domain.state !== 'active' || domain.appliedRevision !== domain.desiredRevision
      || domain.stagedRevision !== domain.desiredRevision || !/^[a-f0-9]{64}$/.test(domain.stagedChecksum ?? '') || domain.lastError) throw passengerReleaseError('passenger_release_domain_drift');
    await resolveWebsiteDomainTarget({ domain, websiteRegistry, applicationRegistry, runtimeBindingRegistry });
  }
  const environment = await applicationEnvironmentRegistry.environmentStatus(application.id);
  const payload = { applicationId: application.id, websiteId: website.id, unixUser: website.unixUser,
    websiteRevision: website.revision, configurationRevision: application.desiredRevision, environmentRevision: environment.savedRevision,
    bindingRevision: binding.revision, domains: domains.map(d => ({ domainId: d.id, desiredRevision: d.desiredRevision, nginxChecksum: d.stagedChecksum })) };
  return { application, website, binding, domains, environment, payload };
}

export async function verifyPassengerReleaseBaselineTarget({application,binding,release},{realpathFn=realpath}={}) {
  const identity=createApplicationIdentity(application.id),runtime=application.activeRuntime,target=binding.passengerTarget;
  const currentRoot=path.posix.join(identity.paths.runtime.currentRelease,runtime.documentRoot);
  const releaseRoot=path.posix.join(identity.paths.runtime.releasesDirectory,application.currentReleaseId,runtime.documentRoot);
  if(release.applicationId!==application.id || release.currentReleaseId!==application.currentReleaseId || release.releaseId!==application.currentReleaseId
    || release.unixUser!==identity.unixUser || target.user!==identity.unixUser || target.group!==identity.unixUser
    || target.appEnv!==runtime.mode || target.environmentInclude!==`/etc/yunpanel/passenger-env/${application.id}.conf`
    || release.appRoot!==releaseRoot || release.documentRoot!==releaseRoot || target.startupFile!==release.startupFile
    || target.startupFile!==runtime.start.entryFile || target.nodeBinary!==release.nodeBinary) throw passengerReleaseError('passenger_release_baseline_target_unverified');
  for(const field of ['appRoot','documentRoot']) {
    if(target[field]===releaseRoot) continue;
    if(target[field]!==currentRoot || await realpathFn(currentRoot)!==releaseRoot) throw passengerReleaseError('passenger_release_baseline_target_unverified');
  }
  return {verified:true,currentRoot,releaseRoot};
}
