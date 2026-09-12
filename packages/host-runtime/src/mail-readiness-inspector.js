import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { mailTemplatePolicy } from '@yunpanel/config-templates';
import { createManagedServiceManager } from './managed-service-manager.js';
import { parseManagedVmailIdentity } from './mail-vmail-identity.js';

const execFileAsync = promisify(execFile);
const GETENT = '/usr/bin/getent';
const DOVECOT = '/usr/sbin/dovecot';
const DOVECONF = '/usr/bin/doveconf';
const POSTCONF = '/usr/sbin/postconf';
const SS = '/usr/bin/ss';
const SIEVEC = '/usr/bin/sievec';
const MAX_OUTPUT = 128 * 1024;
const BASE_REQUIREMENTS = Object.freeze([
  'postfix',
  'dovecot_2_3',
  'rspamd',
  'vmail_identity',
  'postfix_identity',
  'mail_tls_material',
  'loopback_11332_available',
  'managed_domains_excluded_from_mydestination',
  'postfix_relay_policy_verified',
]);
const SIEVE_REQUIREMENTS = Object.freeze([
  'postfix',
  'dovecot_2_3',
  'dovecot_sieve',
  'rspamd',
  'vmail_identity',
  'postfix_identity',
  'mail_tls_material',
  'loopback_11332_available',
  'managed_domains_excluded_from_mydestination',
  'postfix_relay_policy_verified',
]);

export class MailReadinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailReadinessError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalRequirementIds(value) {
  if (!Array.isArray(value)) {
    throw new MailReadinessError('mail_readiness_requirements_invalid', 'Managed mail preview readiness requirements are not canonical');
  }
  for (const allowed of [BASE_REQUIREMENTS, SIEVE_REQUIREMENTS]) {
    if (value.length === allowed.length && value.every((requirement, index) => requirement === allowed[index])) {
      return allowed;
    }
  }
  throw new MailReadinessError('mail_readiness_requirements_invalid', 'Managed mail preview readiness requirements are not canonical');
}

function canonicalDomainsFromPreview(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || typeof preview.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(preview.sha256)
    || !Array.isArray(preview.artifacts) || !Array.isArray(preview.requirements)) {
    throw new MailReadinessError('mail_readiness_preview_invalid', 'Managed mail preview is invalid');
  }
  canonicalRequirementIds(preview.requirements);
  const domainArtifact = preview.artifacts.find((artifact) => artifact?.path === mailTemplatePolicy.postfixVirtualDomainMapPath);
  if (!domainArtifact || typeof domainArtifact.content !== 'string') {
    throw new MailReadinessError('mail_readiness_domains_unavailable', 'Managed mail domain map is unavailable');
  }
  const domains = domainArtifact.content === '' ? [] : domainArtifact.content.trimEnd().split('\n').map((line) => {
    const match = line.match(/^([^\s]+) OK$/);
    if (!match) throw new MailReadinessError('mail_readiness_domains_invalid', 'Managed mail domain map is invalid');
    return match[1];
  });
  if (new Set(domains).size !== domains.length || domains.some((domain) => domain !== domain.toLowerCase())) {
    throw new MailReadinessError('mail_readiness_domains_invalid', 'Managed mail domains are not canonical');
  }
  return Object.freeze(domains);
}

function serviceSatisfied(service) {
  return service?.installed === true && service?.active === true && service?.health?.status === 'ready';
}

function commandKey(file, args) {
  return `${file}\u0000${args.join('\u0000')}`;
}

function cleanOutput(value) {
  const output = String(value ?? '').trim();
  if (Buffer.byteLength(output) > MAX_OUTPUT) {
    throw new MailReadinessError('mail_readiness_output_too_large', 'Managed mail readiness command output exceeded its bound');
  }
  return output;
}

function configuredPath(value) {
  let result = cleanOutput(value);
  if (result.startsWith('<')) result = result.slice(1).trim();
  if (!result || result.includes('\u0000') || result.includes('\n') || !result.startsWith('/')) return null;
  return result;
}

function restrictionTokens(value) {
  return cleanOutput(value).toLowerCase().split(/[\s,]+/).filter(Boolean);
}

function destinationTokens(value, variables) {
  const tokens = cleanOutput(value).split(/[\s,]+/).filter(Boolean);
  const expanded = [];
  for (const token of tokens) {
    if (token.includes(':') || token.startsWith('/')) return null;
    const resolved = token
      .replaceAll('${myhostname}', variables.myhostname)
      .replaceAll('$myhostname', variables.myhostname)
      .replaceAll('${mydomain}', variables.mydomain)
      .replaceAll('$mydomain', variables.mydomain)
      .toLowerCase();
    if (!resolved || resolved.includes('$') || !/^[a-z0-9.-]+$/.test(resolved)) return null;
    expanded.push(resolved);
  }
  return expanded;
}

function loopbackPortSafe(value) {
  const output = cleanOutput(value);
  if (!output) return true;
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    const local = columns[3] ?? '';
    if (local !== '127.0.0.1:11332' && local !== '[::1]:11332') return false;
  }
  return true;
}

function identityPresent(value, expectedName) {
  const output = cleanOutput(value);
  return output.startsWith(`${expectedName}:`) && output.split(':').length >= 7;
}

export function createMailReadinessInspector({
  managedServiceManager = createManagedServiceManager(),
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
  statFn = stat,
} = {}) {
  if (!managedServiceManager || typeof managedServiceManager.inspect !== 'function') {
    throw new MailReadinessError('mail_readiness_service_manager_invalid', 'Managed service inspector is unavailable');
  }

  async function runText(file, args) {
    try {
      const result = await run(file, args, { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      return { ok: true, output: cleanOutput(result?.stdout ?? result) };
    } catch {
      return { ok: false, output: '' };
    }
  }

  async function regularFileExists(filePath) {
    if (!filePath) return false;
    try { return (await statFn(filePath)).isFile(); }
    catch { return false; }
  }

  async function executableFileExists(filePath) {
    try {
      const metadata = await statFn(filePath);
      return metadata.isFile() && Number.isSafeInteger(metadata.mode) && (metadata.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  async function inspect(preview) {
    const domains = canonicalDomainsFromPreview(preview);
    const requirementIds = canonicalRequirementIds(preview.requirements);
    const requiresSieve = requirementIds.includes('dovecot_sieve');
    const [postfix, dovecot, rspamd] = await Promise.all([
      managedServiceManager.inspect('postfix'),
      managedServiceManager.inspect('dovecot'),
      managedServiceManager.inspect('rspamd'),
    ]);

    const checks = await Promise.all([
      runText(DOVECOT, ['--version']),
      runText(GETENT, ['passwd', 'vmail']),
      runText(GETENT, ['passwd', 'postfix']),
      runText(DOVECONF, ['-h', 'ssl']),
      runText(DOVECONF, ['-h', 'ssl_cert']),
      runText(DOVECONF, ['-h', 'ssl_key']),
      runText(POSTCONF, ['-h', 'smtpd_tls_cert_file']),
      runText(POSTCONF, ['-h', 'smtpd_tls_key_file']),
      runText(POSTCONF, ['-h', 'myhostname']),
      runText(POSTCONF, ['-h', 'mydomain']),
      runText(POSTCONF, ['-h', 'mydestination']),
      runText(POSTCONF, ['-h', 'smtpd_relay_restrictions']),
      runText(POSTCONF, ['-h', 'smtpd_recipient_restrictions']),
      runText(SS, ['-H', '-ltn', 'sport = :11332']),
    ]);
    const [
      dovecotVersion,
      vmailIdentity,
      postfixIdentity,
      dovecotSsl,
      dovecotCert,
      dovecotKey,
      postfixCert,
      postfixKey,
      myhostname,
      mydomain,
      mydestination,
      relayRestrictions,
      recipientRestrictions,
      socketState,
    ] = checks;

    const dovecotCertPath = configuredPath(dovecotCert.output);
    const dovecotKeyPath = configuredPath(dovecotKey.output);
    const postfixCertPath = configuredPath(postfixCert.output);
    const postfixKeyPath = configuredPath(postfixKey.output);
    const [dovecotCertExists, dovecotKeyExists, postfixCertExists, postfixKeyExists, sieveExecutable] = await Promise.all([
      regularFileExists(dovecotCertPath),
      regularFileExists(dovecotKeyPath),
      regularFileExists(postfixCertPath),
      regularFileExists(postfixKeyPath),
      requiresSieve ? executableFileExists(SIEVEC) : Promise.resolve(true),
    ]);
    const tlsFiles = [dovecotCertExists, dovecotKeyExists, postfixCertExists, postfixKeyExists];

    const variablesValid = myhostname.ok && mydomain.ok
      && /^[a-z0-9.-]+$/i.test(myhostname.output) && /^[a-z0-9.-]+$/i.test(mydomain.output);
    const destinations = variablesValid && mydestination.ok
      ? destinationTokens(mydestination.output, {
        myhostname: myhostname.output.toLowerCase(),
        mydomain: mydomain.output.toLowerCase(),
      })
      : null;
    const managedDomainsExcluded = Array.isArray(destinations)
      && domains.every((domain) => !destinations.includes(domain));

    const relayTokens = [
      ...(relayRestrictions.ok ? restrictionTokens(relayRestrictions.output) : []),
      ...(recipientRestrictions.ok ? restrictionTokens(recipientRestrictions.output) : []),
    ];
    const relayPolicyVerified = relayTokens.includes('reject_unauth_destination')
      || relayTokens.includes('defer_unauth_destination');
    const managedVmailIdentity = vmailIdentity.ok ? parseManagedVmailIdentity(vmailIdentity.output) : null;

    const status = new Map([
      ['postfix', serviceSatisfied(postfix)],
      ['dovecot_2_3', serviceSatisfied(dovecot) && dovecotVersion.ok && /^2\.3(?:\.|$)/.test(dovecotVersion.output)],
      ['dovecot_sieve', serviceSatisfied(dovecot) && sieveExecutable],
      ['rspamd', serviceSatisfied(rspamd)],
      ['vmail_identity', managedVmailIdentity !== null],
      ['postfix_identity', postfixIdentity.ok && identityPresent(postfixIdentity.output, 'postfix')],
      ['mail_tls_material', dovecotSsl.ok && dovecotSsl.output.toLowerCase() !== 'no'
        && dovecotCert.ok && dovecotKey.ok && postfixCert.ok && postfixKey.ok && tlsFiles.every(Boolean)],
      ['loopback_11332_available', socketState.ok && loopbackPortSafe(socketState.output)],
      ['managed_domains_excluded_from_mydestination', managedDomainsExcluded],
      ['postfix_relay_policy_verified', relayPolicyVerified],
    ]);
    const requirements = Object.freeze(requirementIds.map((id) => Object.freeze({ id, satisfied: status.get(id) === true })));
    const blockers = Object.freeze(requirements.filter((entry) => !entry.satisfied).map((entry) => entry.id));
    const identity = {
      version: 1,
      previewSha256: preview.sha256,
      requirements,
    };
    return Object.freeze({
      version: 1,
      sha256: sha256(identity),
      previewSha256: preview.sha256,
      ready: blockers.length === 0,
      requirements,
      blockers,
      sideEffects: false,
    });
  }

  return Object.freeze({ inspect });
}

export const mailReadinessInternals = Object.freeze({
  requirements: BASE_REQUIREMENTS,
  sieveRequirements: SIEVE_REQUIREMENTS,
  sievecPath: SIEVEC,
  commandKey,
  canonicalRequirementIds,
  canonicalDomainsFromPreview,
  configuredPath,
  destinationTokens,
  restrictionTokens,
  loopbackPortSafe,
  identityPresent,
});
