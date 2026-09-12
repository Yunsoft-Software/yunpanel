import { createHash } from 'node:crypto';
import { mailSubmissionTemplatePolicy } from './mail-submission.js';

const POSTFIX_SERVICE = 'postfix';
const DOVECOT_SERVICE = 'dovecot';
const RSPAMD_SERVICE = 'rspamd';
const MANAGED_SERVICES = Object.freeze([RSPAMD_SERVICE, DOVECOT_SERVICE, POSTFIX_SERVICE]);
const POSTFIX_MAP_PATHS = Object.freeze(new Set([
  '/etc/yunpanel/mail/postfix/virtual-domains',
  '/etc/yunpanel/mail/postfix/virtual-mailboxes',
  '/etc/yunpanel/mail/postfix/virtual-aliases',
  mailSubmissionTemplatePolicy.senderLoginPath,
]));
const FORWARDING_SIEVE_PATH = '/etc/dovecot/yunpanel-forwarding.sieve';
const VALIDATORS = Object.freeze(new Map([
  ['/usr/sbin/postfix', Object.freeze(['check'])],
  ['/usr/bin/doveconf', Object.freeze(['-n'])],
  ['/usr/bin/rspamadm', Object.freeze(['configtest'])],
]));

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
    || !Array.isArray(preview.postfixMasterServices)
    || !Array.isArray(preview.validate) || !Array.isArray(preview.requirements)) {
    throw new MailApplyPlanError('invalid_mail_preview_shape', 'Managed mail preview is missing apply metadata');
  }
  if (preview.requirements.some((value) => typeof value !== 'string' || !/^[a-z0-9_]+$/.test(value))) {
    throw new MailApplyPlanError('invalid_mail_requirement', 'Managed mail requirement metadata is invalid');
  }
}

function snapshotArtifact(artifact) {
  if (!artifact || typeof artifact.path !== 'string' || !artifact.path.startsWith('/')
    || artifact.path.includes('\0') || artifact.path.includes('\n') || artifact.path.includes('\r')
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

function validatorCommand(entry) {
  if (!entry || typeof entry.file !== 'string' || !Array.isArray(entry.args)
    || entry.args.some((value) => typeof value !== 'string')) {
    throw new MailApplyPlanError('invalid_mail_validator', 'Managed mail validator metadata is invalid');
  }
  const expectedArgs = VALIDATORS.get(entry.file);
  if (!expectedArgs || entry.args.length !== expectedArgs.length
    || entry.args.some((value, index) => value !== expectedArgs[index])) {
    throw new MailApplyPlanError('invalid_mail_validator', 'Managed mail validator is not allowlisted');
  }
  return command(entry.file, entry.args);
}

function compileCommand(artifact) {
  const entry = artifact.compile;
  if (!entry || !Array.isArray(entry.args) || entry.args.length !== 1) {
    throw new MailApplyPlanError('invalid_mail_compile_command', 'Managed mail compile command is not allowlisted');
  }
  if (POSTFIX_MAP_PATHS.has(artifact.path)
    && entry.file === '/usr/sbin/postmap'
    && entry.args[0] === `hash:${artifact.path}`) {
    return command(entry.file, entry.args);
  }
  if (artifact.path === FORWARDING_SIEVE_PATH
    && entry.file === '/usr/bin/sievec'
    && entry.args[0] === FORWARDING_SIEVE_PATH) {
    return command(entry.file, entry.args);
  }
  throw new MailApplyPlanError('invalid_mail_compile_command', 'Managed mail compile command is not allowlisted');
}

function canonicalMasterServices(value) {
  const expected = mailSubmissionTemplatePolicy.service;
  if (!Array.isArray(value) || value.length !== 1) {
    throw new MailApplyPlanError('invalid_postfix_master_service', 'Managed Postfix master service metadata is incomplete');
  }
  const service = value[0];
  if (!service || service.service !== expected.service || service.type !== expected.type
    || service.definition !== expected.definition || !Array.isArray(service.parameters)
    || service.parameters.length !== expected.parameters.length) {
    throw new MailApplyPlanError('invalid_postfix_master_service', 'Managed Postfix master service metadata is invalid');
  }
  for (let index = 0; index < expected.parameters.length; index += 1) {
    const actual = service.parameters[index];
    const wanted = expected.parameters[index];
    if (!actual || actual.name !== wanted.name || actual.value !== wanted.value) {
      throw new MailApplyPlanError('invalid_postfix_master_service', 'Managed Postfix master service override is not allowlisted');
    }
  }
  return Object.freeze([Object.freeze({
    service: expected.service,
    type: expected.type,
    definition: expected.definition,
    parameters: Object.freeze(expected.parameters.map((parameter) => Object.freeze({ ...parameter }))),
  })]);
}

function masterServiceCommands(services) {
  const commands = [];
  for (const service of services) {
    const identity = `${service.service}/${service.type}`;
    commands.push(command('/usr/sbin/postconf', ['-M', `${identity}=${service.definition}`]));
    for (const parameter of service.parameters) {
      commands.push(command('/usr/sbin/postconf', ['-P', `${identity}/${parameter.name}=${parameter.value}`]));
    }
  }
  return Object.freeze(commands);
}

export function previewManagedMailApplyPlan(preview) {
  assertPreview(preview);

  const artifacts = Object.freeze(preview.artifacts.map(snapshotArtifact));
  const postfixParameters = Object.freeze(preview.postfixParameters.map((parameter) => {
    if (!parameter || typeof parameter.name !== 'string' || typeof parameter.value !== 'string'
      || !/^[a-z0-9_]+$/.test(parameter.name) || parameter.value.length > 1_024
      || /[\0\r\n]/.test(parameter.value)) {
      throw new MailApplyPlanError('invalid_postfix_parameter', 'Managed Postfix parameter metadata is invalid');
    }
    return Object.freeze({ name: parameter.name, value: parameter.value });
  }));
  const postfixMasterServices = canonicalMasterServices(preview.postfixMasterServices);
  const validators = Object.freeze(preview.validate.map(validatorCommand));

  const compile = Object.freeze(preview.artifacts
    .filter((artifact) => artifact.compile)
    .map(compileCommand));
  const configurePostfix = Object.freeze(postfixParameters.map((parameter) => command(
    '/usr/sbin/postconf',
    ['-e', `${parameter.name} = ${parameter.value}`],
  )));
  const configurePostfixMaster = masterServiceCommands(postfixMasterServices);
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
    postfixMasterServices,
    validators,
    compile,
    configurePostfixMaster,
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
    postfixParameters,
    postfixMasterServices,
    stages: Object.freeze({
      backup: Object.freeze(artifacts.map((artifact) => Object.freeze({ path: artifact.path }))),
      write: artifacts,
      compile,
      configurePostfix,
      configurePostfixMaster,
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
