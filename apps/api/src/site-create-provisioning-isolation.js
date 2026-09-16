import path from 'node:path';
import { createWebsitePathContract } from '@yunpanel/host-runtime';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';
import { siteCreateProvisioningPlan as createBaseSiteCreateProvisioningPlan } from './site-create-provisioning.js';
import { createWebsiteProvisioningPlan } from './website-provisioning-plan.js';

const HOSTED_RUNTIME_TYPES = new Set(['static', 'node', 'php']);
const SFTP_ADAPTER = 'openssh-internal-sftp';

function exactIntent(candidate, expected) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const expectedEntries = Object.entries(expected);
  return Object.keys(candidate).length === expectedEntries.length
    && expectedEntries.every(([key, value]) => candidate[key] === value);
}

function containsIntent(candidate, expected) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  return Object.entries(expected).every(([key, value]) => candidate[key] === value);
}

function isolationContract(plan) {
  const website = plan.resources?.website;
  if (!website || !HOSTED_RUNTIME_TYPES.has(website.runtimeType)) return null;
  if (website.id !== plan.websiteId) {
    throw new Error('Hosted Website isolation requires the canonical Website identity');
  }
  if (typeof website.applicationId !== 'string' || typeof website.unixUser !== 'string') {
    throw new Error('Hosted Website SFTP isolation requires Application and Unix identities');
  }

  const application = plan.resources?.application;
  if (!application || typeof application !== 'object' || application.id !== website.applicationId) {
    throw new Error('Hosted Website isolation Application identity does not match Website ownership');
  }
  if (application.type !== website.runtimeType) {
    throw new Error('Hosted Website runtime type does not match its Application');
  }

  const identity = createApplicationIdentity(application.id);
  if (website.unixUser !== identity.unixUser) {
    throw new Error('Hosted Website Unix user does not match the canonical Application identity');
  }
  const paths = createWebsitePathContract({
    websiteId: plan.websiteId,
    applicationId: application.id,
  });
  const documentRoot = website.runtimeType === 'static'
    ? path.posix.join(paths.static.publishRoot, 'current')
    : website.runtimeType === 'php'
      ? path.posix.join(paths.runtime.currentRelease, 'public')
      : paths.runtime.currentRelease;
  if (website.documentRoot !== documentRoot) {
    throw new Error('Hosted Website document root does not match the managed path contract');
  }

  const runtimeDocumentRoot = website.runtimeType === 'node'
    ? path.posix.resolve(paths.runtime.currentRelease, application.runtime?.documentRoot ?? '.')
    : documentRoot;

  return Object.freeze({
    websiteId: plan.websiteId,
    applicationId: application.id,
    unixUser: identity.unixUser,
    runtimeType: website.runtimeType,
    documentRoot,
    runtimeDocumentRoot,
    paths,
  });
}

function assertUnixIdentityStep(plan, contract) {
  const matches = plan.steps.filter((step) => step.id === 'unix_identity' || step.kind === 'unix_identity');
  if (matches.length !== 1) {
    throw new Error('Hosted Website isolation requires exactly one canonical Unix identity step');
  }
  const [step] = matches;
  const expected = {
    websiteId: contract.websiteId,
    applicationId: contract.applicationId,
    unixUser: contract.unixUser,
    homeDirectory: contract.paths.workspace.homeDirectory,
    documentRoot: contract.documentRoot,
  };
  if (step.id !== 'unix_identity' || step.kind !== 'unix_identity' || step.required !== true
    || !exactIntent(step.intent, expected)) {
    throw new Error('Hosted Website Unix identity step does not match canonical Website ownership and paths');
  }
}

function singleStep(plan, id, kind, message) {
  const matches = plan.steps.filter((step) => step.id === id || step.kind === kind);
  if (matches.length !== 1) throw new Error(message);
  const [step] = matches;
  if (step.id !== id || step.kind !== kind || step.required !== true) throw new Error(message);
  return step;
}

function assertRuntimePathSteps(plan, contract) {
  if (contract.runtimeType === 'static') {
    const step = singleStep(
      plan,
      'runtime',
      'static_runtime',
      'Static Website isolation requires exactly one canonical runtime step',
    );
    if (!containsIntent(step.intent, {
      adapter: 'static',
      websiteId: contract.websiteId,
      applicationId: contract.applicationId,
      homeDirectory: contract.paths.workspace.homeDirectory,
      buildRoot: contract.paths.static.buildRoot,
      publishRoot: contract.paths.static.publishRoot,
    })) {
      throw new Error('Static Website runtime paths do not match the managed path contract');
    }
    return;
  }

  if (contract.runtimeType === 'node') {
    const step = singleStep(
      plan,
      'runtime',
      'runtime',
      'Node Website isolation requires exactly one canonical runtime step',
    );
    if (!containsIntent(step.intent, {
      adapter: 'passenger',
      websiteId: contract.websiteId,
      applicationId: contract.applicationId,
      unixUser: contract.unixUser,
      appRoot: contract.runtimeDocumentRoot,
      documentRoot: contract.runtimeDocumentRoot,
    })) {
      throw new Error('Node Website runtime paths do not match the managed path contract');
    }

    const releaseSteps = plan.steps.filter((candidate) => candidate.id === 'node_release' || candidate.kind === 'node_release');
    if (releaseSteps.length > 1) throw new Error('Node Website provisioning contains duplicate release steps');
    if (releaseSteps.length === 1) {
      const [release] = releaseSteps;
      if (release.id !== 'node_release' || release.kind !== 'node_release' || release.required !== true
        || !containsIntent(release.intent, {
          websiteId: contract.websiteId,
          applicationId: contract.applicationId,
          currentRelease: contract.paths.runtime.currentRelease,
          releasesDirectory: contract.paths.runtime.releasesDirectory,
        })) {
        throw new Error('Node Website release paths do not match the managed path contract');
      }
    }
    return;
  }

  const bootstrap = singleStep(
    plan,
    'php_bootstrap',
    'php_bootstrap',
    'PHP Website isolation requires exactly one canonical bootstrap step',
  );
  if (!containsIntent(bootstrap.intent, {
    adapter: 'php-bootstrap',
    websiteId: contract.websiteId,
    applicationId: contract.applicationId,
    unixUser: contract.unixUser,
    documentRoot: contract.documentRoot,
  })) {
    throw new Error('PHP Website bootstrap path does not match the managed path contract');
  }
  const runtime = singleStep(
    plan,
    'php_runtime',
    'php_runtime',
    'PHP Website isolation requires exactly one canonical runtime step',
  );
  if (!containsIntent(runtime.intent, {
    adapter: 'php-fpm',
    websiteId: contract.websiteId,
    applicationId: contract.applicationId,
    unixUser: contract.unixUser,
    documentRoot: contract.documentRoot,
  })) {
    throw new Error('PHP Website runtime path does not match the managed path contract');
  }
}

function isolationStep(contract) {
  return Object.freeze({
    id: 'sftp',
    kind: 'sftp',
    required: true,
    state: 'pending',
    intent: Object.freeze({
      adapter: SFTP_ADAPTER,
      websiteId: contract.websiteId,
      applicationId: contract.applicationId,
      unixUser: contract.unixUser,
    }),
    compensation: Object.freeze({ state: 'pending' }),
  });
}

function existingSftpStep(plan) {
  const matches = plan.steps.filter((step) => step.id === 'sftp' || step.kind === 'sftp');
  if (matches.length > 1) {
    throw new Error('Website provisioning contains duplicate SFTP isolation steps');
  }
  return matches[0] ?? null;
}

function assertSftpStep(step, contract) {
  const expectedIntent = {
    adapter: SFTP_ADAPTER,
    websiteId: contract.websiteId,
    applicationId: contract.applicationId,
    unixUser: contract.unixUser,
  };
  if (step.id !== 'sftp' || step.kind !== 'sftp' || step.required !== true || !exactIntent(step.intent, expectedIntent)) {
    throw new Error('Existing Website SFTP step does not match canonical Website isolation intent');
  }
}

export function withWebsiteIsolationSteps(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) {
    throw new Error('A Website provisioning plan is required');
  }

  const contract = isolationContract(plan);
  const existingSftp = existingSftpStep(plan);
  if (!contract) {
    if (existingSftp) throw new Error('Non-hosted Website provisioning must not contain an SFTP isolation step');
    return plan;
  }

  assertUnixIdentityStep(plan, contract);
  assertRuntimePathSteps(plan, contract);
  if (existingSftp) {
    assertSftpStep(existingSftp, contract);
    return plan;
  }

  const sftp = isolationStep(contract);
  const steps = plan.steps.map((step) => ({
    ...step,
    intent: { ...step.intent },
    compensation: { ...step.compensation },
  }));
  const nginxIndex = steps.findIndex((step) => step.id === 'nginx');
  const insertAt = nginxIndex >= 0 ? nginxIndex : steps.length;
  steps.splice(insertAt, 0, sftp);

  return createWebsiteProvisioningPlan({
    operationId: plan.operationId,
    websiteId: plan.websiteId,
    resources: plan.resources,
    steps,
  });
}

export function siteCreateProvisioningPlan(preview) {
  return withWebsiteIsolationSteps(createBaseSiteCreateProvisioningPlan(preview));
}

export const siteCreateProvisioningIsolationInternals = Object.freeze({
  hostedRuntimeTypes: Object.freeze([...HOSTED_RUNTIME_TYPES]),
  isolationContract,
  assertUnixIdentityStep,
  assertRuntimePathSteps,
  isolationStep,
  existingSftpStep,
  assertSftpStep,
});
