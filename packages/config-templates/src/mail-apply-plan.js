import { createHash } from 'node:crypto';

const POSTFIX_SERVICE = 'postfix';
const DOVECOT_SERVICE = 'dovecot';
const RSPAMD_SERVICE = 'rspamd';
const MANAGED_SERVICES = Object.freeze([RSPAMD_SERVICE, DOVECOT_SERVICE, POSTFIX_SERVICE]);

export class MailApplyPlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailApplyPlanError';
    this.code = code;
  }
}

function assertPreview(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    throw new MailApplyPlanError('invalid_mail_preview', 'Managed mail preview is required');
  }
  if (typeof preview.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(preview.sha256)) {
    throw new MailApplyPlanError('invalid_mail_preview_digest', 'Managed mail preview must contain a sha256 digest');
  }
  if (!Array.isArray(preview.artifacts) || !Array.isArray(preview.postfixParameters)
    || !Array.isArray(preview.validate) || !Array.isArray(preview.requirements)) {
    throw new MailApplyPlanError('invalid_mail_preview_shape', 'Managed mail preview is missing apply metadata');
  }
}

function snapshotArtifact(artifact) {
  if (!artifact || typeof artifact.path !== 'string' || !artifact.path.startsWith('/')
    || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new MailApplyPlanError('invalid_mail_artifact', 'Managed mail artifact metadata is invalid');
  }
  return Object.freeze({
    path: artifact.path,
    sha256: artifact.sha256,
    sensitive: artifact.sensitive === true,
    contentIncluded: artifact.sensitive === true ? false : artifact.contentIncluded !== false,
  });
}

function command(file, args) {
  return Object.freeze({ file, args: Object.freeze([...args]) });
}

export function previewManagedMailApplyPlan(preview) {
  assertPreview(preview);

  const artifacts = Object.freeze(preview.artifacts.map(snapshotArtifact));
  const postfixParameters = Object.freeze(preview.postfixParameters.map((parameter) => {
    if (!parameter || typeof parameter.name !== 'string' || typeof parameter.value !== 'string'
      || !/^[a-z0-9_]+$/.test(parameter.name) || parameter.value.length > 1_024) {
      throw new MailApplyPlanError('invalid_postfix_parameter', 'Managed Postfix parameter metadata is invalid');
    }
    return Object.freeze({ name: parameter.name, value: parameter.value });
  }));
  const validators = Object.freeze(preview.validate.map((entry) => {
    if (!entry || typeof entry.file !== 'string' || !entry.file.startsWith('/') || !Array.isArray(entry.args)
      || entry.args.some((value) => typeof value !== 'string')) {
      throw new MailApplyPlanError('invalid_mail_validator', 'Managed mail validator metadata is invalid');
    }
    return command(entry.file, entry.args);
  }));

  const compile = Object.freeze(preview.artifacts
    .filter((artifact) => artifact.compile)
    .map((artifact) => command(artifact.compile.file, artifact.compile.args)));
  const configurePostfix = Object.freeze(postfixParameters.map((parameter) => command(
    '/usr/sbin/postconf',
    ['-e', `${parameter.name} = ${parameter.value}`],
  )));
  const reload = Object.freeze(MANAGED_SERVICES.map((service) => command(
    '/usr/bin/systemctl',
    ['reload', service],
  )));
  const health = Object.freeze(MANAGED_SERVICES.map((service) => command(
    '/usr/bin/systemctl',
    ['is-active', '--quiet', service],
  )));
  const rollbackReload = Object.freeze([...MANAGED_SERVICES].reverse().map((service) => command(
    '/usr/bin/systemctl',
    ['reload', service],
  )));

  const identity = {
    version: 1,
    previewSha256: preview.sha256,
    artifacts,
    postfixParameters,
    validators,
    compile,
    reload,
    health,
    rollbackReload,
  };

  return Object.freeze({
    version: 1,
    sha256: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    previewSha256: preview.sha256,
    requirements: Object.freeze([...preview.requirements]),
    artifacts,
    stages: Object.freeze({
      backup: Object.freeze(artifacts.map((artifact) => Object.freeze({ path: artifact.path }))),
      write: artifacts,
      compile,
      configurePostfix,
      validate: validators,
      reload,
      health,
    }),
    rollback: Object.freeze({
      restore: Object.freeze([...artifacts].reverse().map((artifact) => Object.freeze({ path: artifact.path }))),
      reload: rollbackReload,
      validate: validators,
      health,
    }),
    sensitiveMaterialRequired: artifacts.some((artifact) => artifact.sensitive),
    readyToExecute: false,
    sideEffects: false,
  });
}
