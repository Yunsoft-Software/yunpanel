import { createHash } from 'node:crypto';
import { normalizeMailboxAddress } from './mail.js';
import {
  previewManagedMailQuotaConfiguration,
  renderDovecotQuotaMailConfig,
} from './mail-quota.js';

const FORWARDING_SIEVE_PATH = '/etc/dovecot/yunpanel-forwarding.sieve';
const FORWARDING_SVBIN_PATH = '/etc/dovecot/yunpanel-forwarding.svbin';
const MAX_FORWARDINGS = 10_000;
const MAX_DESTINATIONS = 4;
const MODES = new Set(['copy', 'redirect']);

export class MailForwardingTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailForwardingTemplateError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function canonicalAddress(value, code) {
  try { return normalizeMailboxAddress(value).address; }
  catch {
    throw new MailForwardingTemplateError(code, 'Mailbox forwarding address is invalid');
  }
}

function normalizeForwardings(values) {
  if (!Array.isArray(values) || values.length > MAX_FORWARDINGS) {
    throw new MailForwardingTemplateError(
      'invalid_mailbox_forwardings',
      `Mailbox forwarding policies must contain at most ${MAX_FORWARDINGS} entries`,
    );
  }
  const sources = new Set();
  const normalized = values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 3
      || !Object.hasOwn(value, 'source') || !Object.hasOwn(value, 'mode') || !Object.hasOwn(value, 'destinations')) {
      throw new MailForwardingTemplateError(
        'invalid_mailbox_forwarding',
        'Mailbox forwarding must contain only source, mode and destinations',
      );
    }
    const source = canonicalAddress(value.source, 'invalid_mailbox_forwarding_source');
    if (sources.has(source)) {
      throw new MailForwardingTemplateError('duplicate_mailbox_forwarding', 'Mailbox forwarding sources must be unique');
    }
    sources.add(source);
    if (!MODES.has(value.mode)) {
      throw new MailForwardingTemplateError('invalid_mailbox_forwarding_mode', 'Mailbox forwarding mode must be copy or redirect');
    }
    if (!Array.isArray(value.destinations) || value.destinations.length < 1 || value.destinations.length > MAX_DESTINATIONS) {
      throw new MailForwardingTemplateError(
        'invalid_mailbox_forwarding_destinations',
        `Mailbox forwarding must contain 1 to ${MAX_DESTINATIONS} destinations`,
      );
    }
    const destinations = [...new Set(value.destinations.map((destination) => canonicalAddress(
      destination,
      'invalid_mailbox_forwarding_destination',
    )))].sort();
    if (destinations.length < 1 || destinations.length > MAX_DESTINATIONS || destinations.includes(source)) {
      throw new MailForwardingTemplateError(
        destinations.includes(source) ? 'mailbox_forwarding_self_destination' : 'invalid_mailbox_forwarding_destinations',
        destinations.includes(source)
          ? 'Mailbox cannot forward to its own address'
          : `Mailbox forwarding must contain 1 to ${MAX_DESTINATIONS} unique destinations`,
      );
    }
    return Object.freeze({ source, mode: value.mode, destinations: Object.freeze(destinations) });
  }).sort((left, right) => left.source.localeCompare(right.source));

  const bySource = new Map(normalized.map((policy) => [policy.source, policy]));
  const visiting = new Set();
  const visited = new Set();
  function visit(source) {
    if (visiting.has(source)) {
      throw new MailForwardingTemplateError('mailbox_forwarding_cycle', 'Mailbox forwarding policies must not contain cycles');
    }
    if (visited.has(source)) return;
    visiting.add(source);
    for (const destination of bySource.get(source)?.destinations ?? []) {
      if (bySource.has(destination)) visit(destination);
    }
    visiting.delete(source);
    visited.add(source);
  }
  for (const source of bySource.keys()) visit(source);
  return Object.freeze(normalized);
}

function forwardingRequirements(baseRequirements) {
  if (!Array.isArray(baseRequirements)) {
    throw new MailForwardingTemplateError('mail_forwarding_requirements_invalid', 'Managed mail requirements are invalid');
  }
  const result = [];
  for (const requirement of baseRequirements) {
    result.push(requirement);
    if (requirement === 'dovecot_2_3') result.push('dovecot_sieve');
  }
  if (!result.includes('dovecot_sieve')) {
    throw new MailForwardingTemplateError('mail_forwarding_requirements_invalid', 'Dovecot readiness requirement is unavailable');
  }
  return Object.freeze(result);
}

export function renderManagedMailboxForwardingSieve(forwardings = []) {
  const normalized = normalizeForwardings(forwardings);
  const lines = ['require ["envelope", "copy"];', ''];
  for (const policy of normalized) {
    lines.push(`if envelope :is "to" "${policy.source}" {`);
    for (const destination of policy.destinations) {
      lines.push(`  redirect${policy.mode === 'copy' ? ' :copy' : ''} "${destination}";`);
    }
    if (policy.mode === 'copy') lines.push('  keep;');
    lines.push('  stop;', '}', '');
  }
  return `${lines.join('\n')}\n`;
}

export function previewManagedMailboxForwardingSieve(forwardings = []) {
  const normalized = normalizeForwardings(forwardings);
  const content = renderManagedMailboxForwardingSieve(normalized);
  return Object.freeze({
    version: 1,
    path: FORWARDING_SIEVE_PATH,
    compiledPath: FORWARDING_SVBIN_PATH,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    policies: normalized.length,
    content,
    compile: Object.freeze({ file: '/usr/bin/sievec', args: Object.freeze([FORWARDING_SIEVE_PATH]) }),
    sideEffects: false,
  });
}

export function renderDovecotQuotaForwardingMailConfig({ domains, postmasterAddress } = {}) {
  const quotaConfig = renderDovecotQuotaMailConfig({ domains, postmasterAddress });
  const withLmtpSieve = quotaConfig.replace(
    'protocol lmtp {\n',
    'protocol lmtp {\n  mail_plugins = $mail_plugins sieve\n',
  );
  if (withLmtpSieve === quotaConfig) {
    throw new MailForwardingTemplateError('dovecot_lmtp_config_invalid', 'Managed Dovecot LMTP config could not be extended safely');
  }
  const pluginNeedle = 'plugin {\n  quota = maildir:User quota\n}\n';
  const pluginReplacement = `plugin {\n  quota = maildir:User quota\n  sieve_before = file:${FORWARDING_SIEVE_PATH}\n}\n`;
  const rendered = withLmtpSieve.replace(pluginNeedle, pluginReplacement);
  if (rendered === withLmtpSieve) {
    throw new MailForwardingTemplateError('dovecot_plugin_config_invalid', 'Managed Dovecot plugin config could not be extended safely');
  }
  return rendered;
}

function publicArtifact(path, content) {
  return Object.freeze({
    version: 1,
    path,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    content,
    sensitive: false,
    sideEffects: false,
  });
}

export function previewManagedMailForwardingConfiguration({
  domains,
  mailboxes = [],
  aliases = [],
  accounts = [],
  postmasterAddress,
  forwardings = [],
} = {}) {
  const base = previewManagedMailQuotaConfiguration({
    domains,
    mailboxes,
    aliases,
    accounts,
    postmasterAddress,
  });
  const forwarding = previewManagedMailboxForwardingSieve(forwardings);
  const dovecotMail = publicArtifact(
    '/etc/dovecot/conf.d/99-yunpanel-mail.conf',
    renderDovecotQuotaForwardingMailConfig({ domains, postmasterAddress }),
  );
  const artifacts = [];
  for (const artifact of base.artifacts) {
    if (artifact.path === dovecotMail.path) artifacts.push(dovecotMail);
    else if (artifact.path === '/etc/rspamd/local.d/worker-proxy.inc') {
      artifacts.push(forwarding, artifact);
    } else artifacts.push(artifact);
  }
  const requirements = forwardingRequirements(base.requirements);
  const identity = {
    version: 1,
    baseSha256: base.sha256,
    forwardingSha256: forwarding.sha256,
    artifactDigests: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
    requirements,
  };
  return Object.freeze({
    version: 1,
    sha256: sha256(JSON.stringify(identity)),
    counts: Object.freeze({ ...base.counts, forwardings: forwarding.policies }),
    artifacts: Object.freeze(artifacts),
    postfixParameters: base.postfixParameters,
    validate: base.validate,
    requirements,
    readyToApply: false,
    sideEffects: false,
  });
}

export const mailForwardingTemplatePolicy = Object.freeze({
  sievePath: FORWARDING_SIEVE_PATH,
  compiledPath: FORWARDING_SVBIN_PATH,
  maxForwardings: MAX_FORWARDINGS,
  maxDestinations: MAX_DESTINATIONS,
  modes: Object.freeze([...MODES]),
});

export const mailForwardingTemplateInternals = Object.freeze({
  forwardingRequirements,
});
