import { createHash } from 'node:crypto';
import { mailTemplatePolicy, normalizeMailboxAddress } from './mail.js';

const SIEVE_PATH = '/etc/dovecot/yunpanel-vacation.sieve';
const COMPILED_PATH = '/etc/dovecot/yunpanel-vacation.svbin';
const MAX_SUBJECT_BYTES = 200;
const MAX_BODY_BYTES = 4_000;
const MAX_SCRIPT_BYTES = 512 * 1024;
const REPLY_INTERVAL_DAYS = 7;
const SIEVE_HEADER = 'require ["envelope", "vacation"];\n\n';

export class MailVacationTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailVacationTemplateError';
    this.code = code;
  }
}

function validateText(value, maxBytes, disallowed, code) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim()
    || disallowed.test(value) || Buffer.byteLength(value) > maxBytes) {
    throw new MailVacationTemplateError(code, 'Vacation text is empty, invalid or too long');
  }
  return value;
}

export function normalizeManagedMailboxVacationPolicies(mailboxes, policies) {
  if (!Array.isArray(mailboxes) || mailboxes.length > mailTemplatePolicy.maxMailboxes
    || !Array.isArray(policies) || policies.length > mailboxes.length) {
    throw new MailVacationTemplateError('mail_vacation_input_invalid', 'Vacation requires a bounded list of managed mailboxes and policies');
  }

  const managed = new Set(mailboxes.map((value) => normalizeMailboxAddress(value).address));
  const seen = new Set();
  const normalized = [];
  for (const policy of policies) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).length !== 3
      || !['mailbox', 'subject', 'body'].every((key) => Object.hasOwn(policy, key))) {
      throw new MailVacationTemplateError('mail_vacation_policy_invalid', 'Vacation policy requires only mailbox, subject and body');
    }
    const mailbox = normalizeMailboxAddress(policy.mailbox).address;
    if (!managed.has(mailbox) || seen.has(mailbox)) {
      throw new MailVacationTemplateError('mail_vacation_mailbox_invalid', 'Vacation requires a unique, managed mailbox');
    }
    seen.add(mailbox);
    const subject = validateText(policy.subject, MAX_SUBJECT_BYTES, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u, 'mail_vacation_subject_invalid');
    const body = typeof policy.body === 'string' ? policy.body.replaceAll('\r\n', '\n') : policy.body;
    validateText(body, MAX_BODY_BYTES, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u, 'mail_vacation_body_invalid');
    normalized.push({ mailbox, subject, body });
  }
  return normalized.sort((left, right) => left.mailbox.localeCompare(right.mailbox));
}

export function renderManagedMailboxVacationRules({ mailboxes = [], policies = [] } = {}) {
  const normalized = normalizeManagedMailboxVacationPolicies(mailboxes, policies);
  const lines = [];
  for (const { mailbox, subject, body } of normalized) {
    const escapedSubject = subject.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    // Every body line beginning with a dot must be escaped, including a lone dot.
    const dotStuffedBody = body.replace(/^\./gm, '..');
    lines.push(
      `if allof (envelope :is "to" "${mailbox}", not envelope :is "from" ["", "${mailbox}"]) {`,
      `  vacation :days ${REPLY_INTERVAL_DAYS} :subject "${escapedSubject}" :addresses ["${mailbox}"] text:`,
      dotStuffedBody,
      '.',
      '  ;',
      '}',
      '',
    );
  }
  const content = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  if (Buffer.byteLength(SIEVE_HEADER + content) > MAX_SCRIPT_BYTES) {
    throw new MailVacationTemplateError('mail_vacation_script_too_large', 'Vacation script exceeds the supported size');
  }
  return { content, policies: normalized.length };
}

export function previewManagedMailboxVacationSieve({ mailboxes = [], policies = [] } = {}) {
  const rules = renderManagedMailboxVacationRules({ mailboxes, policies });
  const content = SIEVE_HEADER + rules.content;
  return Object.freeze({
    version: 1,
    path: SIEVE_PATH,
    compiledPath: COMPILED_PATH,
    compile: Object.freeze({ file: '/usr/bin/sievec', args: Object.freeze([SIEVE_PATH]) }),
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    policies: rules.policies,
    content,
    sensitive: true,
    sideEffects: false,
  });
}
