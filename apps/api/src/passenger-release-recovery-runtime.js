import os from 'node:os';import path from 'node:path';
import {createApplicationRegistry} from './application-registry.js';
import {createApplicationEnvironmentRegistry} from './application-environment-registry.js';
import {createApplicationRuntimeBindingRegistry} from './application-runtime-binding-registry.js';
import {createWebsiteRegistry} from './website-registry.js';
import {createWebsiteProvisioningRegistry} from './website-provisioning-registry.js';
import {createDomainRegistry} from './domain-registry.js';
import {createCertificateRegistry} from './certificate-registry.js';
import {createServerRegistry} from './server-registry.js';
import {createJobRegistry} from './job-registry.js';
import {createDurableJobRegistry} from './durable-job-registry.js';
import {createJobRecoveryStore} from './job-recovery-store.js';
import {createJobRecoveryContextReader} from './job-recovery-context.js';
import {jobRecoveryRuntimeInternals as internals,resolveJobRecoveryPaths} from './job-recovery-runtime.js';
import {createMigrationServiceStatus} from './local-migration-cli.js';
import {createSiteMutationLock} from './site-mutation-lock.js';
import {createLocalPassengerReleaseOperation} from './local-passenger-release-operation.js';
import {createPassengerReleasePhaseStore} from './passenger-release-phase-store.js';
import {createWebsiteResourceBackupCodec} from './website-resource-backup-codec.js';
import {recoverPassengerRelease} from './passenger-release-recovery.js';

export async function runPassengerReleaseRecoveryFromStores({serverId,jobId,hostname=os.hostname(),env=process.env,packaged=false,cwd=process.cwd(),
  compensationOnly=false,serviceStatus=createMigrationServiceStatus()}={}) {
  const status=await serviceStatus();
  if(!status || status.apiActive!==false || status.agentActive!==false)throw Object.assign(new Error('Stop YunPanel consumers before inspecting Passenger release stores'),{code:'passenger_release_recovery_consumers_must_be_stopped'});
  const paths=resolveJobRecoveryPaths({env,packaged,cwd}),root=path.dirname(paths.serverStore);
  const {serverRegistry,jobRegistry,contextReader}=await internals.initHostScopedRecovery({paths,serverId,hostname,
    serverRegistryFactory:createServerRegistry,jobRegistryFactory:createJobRegistry,durableRegistryFactory:createDurableJobRegistry,
    recoveryStoreFactory:createJobRecoveryStore,contextReaderFactory:createJobRecoveryContextReader});
  const resolve=(value,name)=>internals.resolveRecoveryStorePath(value,path.join(root,name),{packaged,cwd,label:'Passenger release'});
  const serverExists=async id=>Boolean(await serverRegistry.getServer(id));
  const applicationRegistry=await internals.initRegistry(createApplicationRegistry({filePath:paths.applicationStore,serverExists}),'Application');
  const websiteRegistry=await internals.initRegistry(createWebsiteRegistry({filePath:resolve(env.YUNPANEL_WEBSITE_STORE,'website-registry.json'),
    serverExists,getApplication:id=>applicationRegistry.getApplication(id)}),'Website');
  const domainRegistry=await internals.initRegistry(createDomainRegistry({filePath:paths.domainStore,serverExists,getWebsite:id=>websiteRegistry.getWebsite(id)}),'Domain');
  const certificateRegistry=await internals.initRegistry(createCertificateRegistry({filePath:paths.certificateStore}),'Certificate');
  const runtimeBindingRegistry=await internals.initRegistry(createApplicationRuntimeBindingRegistry({filePath:resolve(env.YUNPANEL_APPLICATION_RUNTIME_BINDING_STORE,'application-runtime-binding-registry.json')}),'Runtime binding');
  const applicationEnvironmentRegistry=await internals.initRegistry(createApplicationEnvironmentRegistry({filePath:resolve(env.YUNPANEL_APPLICATION_ENVIRONMENT_STORE,'application-environment-registry.json'),
    masterKey:env.YUNPANEL_SECRET_MASTER_KEY,applicationExists:async id=>Boolean(await applicationRegistry.getApplication(id))}),'Application environment');
  const provisioningRegistry=await internals.initRegistry(createWebsiteProvisioningRegistry({filePath:resolve(env.YUNPANEL_WEBSITE_PROVISIONING_STORE,'website-provisioning-registry.json')}),'Website provisioning');
  const dependencies={applicationRegistry,websiteRegistry,domainRegistry,certificateRegistry,runtimeBindingRegistry,applicationEnvironmentRegistry,
    provisioningRegistry,localServerId:serverId,siteMutationLock:createSiteMutationLock({root:path.join(root,'locks','site-mutations')})};
  const phaseStore=createPassengerReleasePhaseStore({codec:createWebsiteResourceBackupCodec({masterKey:env.YUNPANEL_SECRET_MASTER_KEY})});
  const operation=createLocalPassengerReleaseOperation({...dependencies,phaseStore});
  const result=await recoverPassengerRelease({serverId,jobId,jobRegistry,operation,dependencies,serviceStatus,
    loadJobContext:id=>contextReader.read(id),compensationOnly});
  return {...result,statePaths:paths};
}
