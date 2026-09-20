import { createHash } from 'node:crypto';
import { mailSqlTemplatePolicy } from './mail-sql.js';
import { mailSrsTemplatePolicy } from './mail-srs.js';
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
const SRS_PARAMETER_NAMES = Object.freeze(mailSrsTemplatePolicy.postfixParameters.map((parameter) => parameter.name));

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
  if (!entry || !Array.isArray(entry.args)) {
    throw new MailApplyPlanError('invalid_mail_compile_command', 'Managed mail compile command is not allowlisted');
  }
  if (POSTFIX_MAP_PATHS.has(artifact.path)
    && entry.file === '/usr/sbin/postmap'
    && entry.args.length === 1
    && entry.args[0] === `hash:${artifact.path}`) {
    return command(entry.file, entry.args);
  }
  if (artifact.path === FORWARDING_SIEVE_PATH
    && entry.file === '/usr/bin/sievec'
    && entry.args.length === 1
    && entry.args[0] === FORWARDING_SIEVE_PATH) {
    return command(entry.file, entry.args);
  }
  if (artifact.path === mailSqlTemplatePolicy.seedPath
    && entry.file === '/usr/bin/sqlite3'
    && entry.args.length === 2
    && entry.args[0] === mailSqlTemplatePolicy.databasePath
    && entry.args[1] === '.read ' + mailSqlTemplatePolicy.seedPath) {
    return command(entry.file, entry.args);
  }
  throw new MailApplyPlanError('invalid_mail_compile_command', 'Managed mail compile command is not allowlisted');
}

function canonicalMasterServices(value, { sqlEnabled = false } = {}) {
  const expectedServices = mailSubmissionTemplatePolicy.services;
  if (!Array.isArray(value) || value.length !== expectedServices.length) {
    throw new MailApplyPlanError('invalid_postfix_master_service', 'Managed Postfix master service metadata is incomplete');
  }
  const result = [];
  for (let sIndex = 0; sIndex < expectedServices.length; sIndex += 1) {
    const expected = expectedServices[sIndex];
    const service = value[sIndex];
    if (!service || service.service !== expected.service || service.type !== expected.type
      || service.definition !== expected.definition || !Array.isArray(service.parameters)
      || service.parameters.length !== expected.parameters.length) {
      throw new MailApplyPlanError('invalid_postfix_master_service', 'Managed Postfix master service metadata is invalid');
    }
    for (let index = 0; index < expected.parameters.length; index += 1) {
      const actual = service.parameters[index];
      const baseWanted = expected.parameters[index];
      const wanted = baseWanted.name === 'smtpd_sender_login_maps' && sqlEnabled
        ? Object.freeze({
          name: baseWanted.name,
          value: 'proxy:sqlite:' + mailSqlTemplatePolicy.postfixSenderLoginPath,
        })
        : baseWanted;
      if (!actual || actual.name !== wanted.name || actual.value !== wanted.value) {
        throw new MailApplyPlanError('invalid_postfix_master_service', 'Managed Postfix master service override is not allowlisted');
      }
    }
    result.push(Object.freeze({
      service: expected.service,
      type: expected.type,
      definition: expected.definition,
      parameters: Object.freeze(expected.parameters.map((parameter) => Object.freeze({
        ...parameter,
        value: parameter.name === 'smtpd_sender_login_maps' && sqlEnabled
          ? 'proxy:sqlite:' + mailSqlTemplatePolicy.postfixSenderLoginPath
          : parameter.value,
      }))),
    }));
  }
  return Object.freeze(result);
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

function canonicalSqlState(preview, artifacts, postfixParameters) {
  const required = preview.requirements.includes('mail_sqlite');
  if (!required) {
    if (preview.sql !== undefined) {
      throw new MailApplyPlanError('invalid_mail_sql_state', 'Inactive managed mail SQL state contains active metadata');
    }
    return Object.freeze({ required: false });
  }
  const sql = preview.sql;
  const sqlFields = new Set(['enabled', 'databasePath', 'domains', 'seedSha256', 'stateSha256', 'lookups']);
  const lookupFields = new Set(['domains', 'mailboxes', 'aliases', 'senderLogin']);
  if (!sql || typeof sql !== 'object' || Array.isArray(sql)
    || Object.keys(sql).length !== sqlFields.size
    || Object.keys(sql).some((field) => !sqlFields.has(field))
    || sql.enabled !== true
    || sql.databasePath !== mailSqlTemplatePolicy.databasePath
    || !Array.isArray(sql.domains) || sql.domains.length > 500
    || sql.domains.some((domain) => typeof domain !== 'string'
      || domain !== domain.toLowerCase() || domain.length < 1 || domain.length > 253)
    || new Set(sql.domains).size !== sql.domains.length
    || typeof sql.seedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sql.seedSha256)
    || typeof sql.stateSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sql.stateSha256)
    || !sql.lookups || typeof sql.lookups !== 'object' || Array.isArray(sql.lookups)
    || Object.keys(sql.lookups).length !== lookupFields.size
    || Object.keys(sql.lookups).some((field) => !lookupFields.has(field))) {
    throw new MailApplyPlanError('invalid_mail_sql_state', 'Managed mail SQL state is incomplete');
  }
  const expectedLookups = Object.freeze({
    domains: 'proxy:sqlite:' + mailSqlTemplatePolicy.postfixDomainPath,
    mailboxes: 'proxy:sqlite:' + mailSqlTemplatePolicy.postfixMailboxPath,
    aliases: 'proxy:sqlite:' + mailSqlTemplatePolicy.postfixAliasPath,
    senderLogin: 'proxy:sqlite:' + mailSqlTemplatePolicy.postfixSenderLoginPath,
  });
  if (Object.entries(expectedLookups).some(([key, value]) => sql.lookups[key] !== value)) {
    throw new MailApplyPlanError('invalid_mail_sql_state', 'Managed mail SQL lookup identity is invalid');
  }
  const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const requiredPaths = [
    mailSqlTemplatePolicy.seedPath,
    mailSqlTemplatePolicy.postfixDomainPath,
    mailSqlTemplatePolicy.postfixMailboxPath,
    mailSqlTemplatePolicy.postfixAliasPath,
    mailSqlTemplatePolicy.postfixSenderLoginPath,
    mailSqlTemplatePolicy.dovecotSqlPath,
  ];
  if (requiredPaths.some((artifactPath) => !byPath.has(artifactPath))
    || byPath.get(mailSqlTemplatePolicy.seedPath)?.sensitive !== true
    || byPath.get(mailSqlTemplatePolicy.seedPath)?.sha256 !== sql.seedSha256
    || byPath.has('/etc/yunpanel/mail/postfix/virtual-domains')
    || byPath.has('/etc/yunpanel/mail/postfix/virtual-mailboxes')
    || byPath.has('/etc/yunpanel/mail/postfix/virtual-aliases')
    || byPath.has(mailSubmissionTemplatePolicy.senderLoginPath)
    || byPath.has('/etc/yunpanel/mail/dovecot/users')) {
    throw new MailApplyPlanError('invalid_mail_sql_state', 'Managed mail SQL artifact set is inconsistent');
  }
  const byParameter = new Map(postfixParameters.map((parameter) => [parameter.name, parameter.value]));
  if (byParameter.get('virtual_alias_maps') !== expectedLookups.aliases
    || byParameter.get('virtual_mailbox_domains') !== expectedLookups.domains
    || byParameter.get('virtual_mailbox_maps') !== expectedLookups.mailboxes) {
    throw new MailApplyPlanError('invalid_mail_sql_state', 'Managed mail SQL Postfix parameters are inconsistent');
  }
  return Object.freeze({
    required: true,
    databasePath: sql.databasePath,
    domains: Object.freeze([...sql.domains]),
    seedSha256: sql.seedSha256,
    stateSha256: sql.stateSha256,
    lookups: expectedLookups,
  });
}

function canonicalSrsState(preview, artifacts, postfixParameters) {
  const required = preview.requirements.includes(mailSrsTemplatePolicy.requirement);
  const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
  const byParameter = new Map(postfixParameters.map((parameter) => [parameter.name, parameter.value]));
  const hasArtifacts = byPath.has(mailSrsTemplatePolicy.defaultsPath) || byPath.has(mailSrsTemplatePolicy.secretPath);
  const presentSrsParameters = SRS_PARAMETER_NAMES.filter((name) => byParameter.has(name));
  if (!required) {
    if (hasArtifacts || presentSrsParameters.length > 0 || preview.srs !== undefined) {
      throw new MailApplyPlanError('invalid_mail_srs_state', 'Inactive managed SRS state contains active configuration');
    }
    return Object.freeze({
      required: false,
      serviceUnit: mailSrsTemplatePolicy.serviceUnit,
      removePostfixParameters: SRS_PARAMETER_NAMES,
    });
  }
  if (!preview.srs || preview.srs.required !== true
    || preview.srs.serviceUnit !== mailSrsTemplatePolicy.serviceUnit
    || preview.srs.packageName !== mailSrsTemplatePolicy.packageName
    || preview.srs.forwardEndpoint !== `tcp:${mailSrsTemplatePolicy.listenAddress}:${mailSrsTemplatePolicy.forwardPort}`
    || preview.srs.reverseEndpoint !== `tcp:${mailSrsTemplatePolicy.listenAddress}:${mailSrsTemplatePolicy.reversePort}`
    || typeof preview.srs.rewriteDomain !== 'string' || preview.srs.rewriteDomain.length < 1
    || !Number.isSafeInteger(preview.srs.externalDestinationCount) || preview.srs.externalDestinationCount < 1
    || !Number.isSafeInteger(preview.srs.secretRevision) || preview.srs.secretRevision < 1
    || !Number.isSafeInteger(preview.srs.secretBytes) || preview.srs.secretBytes < 1
    || !byPath.has(mailSrsTemplatePolicy.defaultsPath)
    || !byPath.has(mailSrsTemplatePolicy.secretPath)
    || preview.srs.defaultsSha256 !== byPath.get(mailSrsTemplatePolicy.defaultsPath).sha256
    || preview.srs.secretSha256 !== byPath.get(mailSrsTemplatePolicy.secretPath).sha256
    || byPath.get(mailSrsTemplatePolicy.secretPath).sensitive !== true) {
    throw new MailApplyPlanError('invalid_mail_srs_state', 'Active managed SRS state is incomplete');
  }
  for (const expected of mailSrsTemplatePolicy.postfixParameters) {
    if (byParameter.get(expected.name) !== expected.value) {
      throw new MailApplyPlanError('invalid_mail_srs_state', 'Managed SRS Postfix parameters are inconsistent');
    }
  }
  return Object.freeze({
    required: true,
    serviceUnit: mailSrsTemplatePolicy.serviceUnit,
    removePostfixParameters: Object.freeze([]),
  });
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
  const sql = canonicalSqlState(preview, artifacts, postfixParameters);
  const srs = canonicalSrsState(preview, artifacts, postfixParameters);
  const postfixMasterServices = canonicalMasterServices(preview.postfixMasterServices, {
    sqlEnabled: sql.required,
  });
  const validators = Object.freeze(preview.validate.map(validatorCommand));

  const compile = Object.freeze(preview.artifacts
    .filter((artifact) => artifact.compile)
    .map(compileCommand));
  const configurePostfix = Object.freeze([
    ...postfixParameters.map((parameter) => command(
      '/usr/sbin/postconf',
      ['-e', `${parameter.name} = ${parameter.value}`],
    )),
    ...srs.removePostfixParameters.map((name) => command('/usr/sbin/postconf', ['-X', name])),
  ]);
  const configurePostfixMaster = masterServiceCommands(postfixMasterServices);
  const configureSrs = Object.freeze(srs.required
    ? [command('/usr/bin/systemctl', ['restart', srs.serviceUnit])]
    : []);
  const reload = Object.freeze(MANAGED_SERVICES.map((service) => command(
    '/usr/bin/systemctl',
    ['reload', service],
  )));
  const health = Object.freeze([
    ...(srs.required ? [command('/usr/bin/systemctl', ['is-active', '--quiet', srs.serviceUnit])] : []),
    ...MANAGED_SERVICES.map((service) => command('/usr/bin/systemctl', ['is-active', '--quiet', service])),
  ]);
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
    sql,
    srs,
    validators,
    compile,
    configurePostfix,
    configurePostfixMaster,
    configureSrs,
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
    sql,
    srs,
    stages: Object.freeze({
      backup: Object.freeze(artifacts.map((artifact) => Object.freeze({ path: artifact.path }))),
      write: artifacts,
      compile,
      configurePostfix,
      configurePostfixMaster,
      configureSrs,
      validate: validators,
      reload,
      health,
    }),
    rollback: Object.freeze({
      restore: Object.freeze([...artifacts].reverse().map((artifact) => Object.freeze({ path: artifact.path }))),
      reload: rollbackReload,
      validate: validators,
      health: Object.freeze(MANAGED_SERVICES.map((service) => command(
        '/usr/bin/systemctl',
        ['is-active', '--quiet', service],
      ))),
    }),
    sensitiveMaterialRequired: artifacts.some((artifact) => artifact.sensitive),
    readyToExecute: false,
    sideEffects: false,
  });
}
