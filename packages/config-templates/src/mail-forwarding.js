import { createHash } from 'node:crypto';
import { normalizeMailboxAddress } from './mail.js';

const FORWARDING_SIEVE_PATH = '/etc/yunpanel/mail/dovecot/yunpanel-forwarding.sieve';
const FORWARDING_SVBIN_PATH = '/etc/yunpanel/mail/dovecot/yunpanel-forwarding.svbin';
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
  const content = renderManagedMailboxForwardingSieve(forwardings);
  return Object.freeze({
    version: 1,
    path: FORWARDING_SIEVE_PATH,
    compiledPath: FORWARDING_SVBIN_PATH,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    policies: normalizeForwardings(forwardings).length,
    content,
    compile: Object.freeze({ file: '/usr/bin/sievec', args: Object.freeze([FORWARDING_SIEVE_PATH]) }),
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
