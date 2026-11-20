import { createHash } from 'node:crypto';
import { mailTemplatePolicy, normalizeMailboxAddress } from './mail.js';

const MULTIMAP_PATH = '/etc/rspamd/local.d/multimap.conf';
const MAX_SENDERS_PER_LIST = 64;
const MAX_PAIRS = 1_000;
const AUTH_SYMBOL = 'YUNPANEL_MAIL_POLICY_AUTHENTICATED';
// The lookup key uses the entire SMTP recipient list. A multi-recipient scan
// cannot inherit the spam score chosen by any single recipient.
const PAIR_SELECTOR = "id('mailbox');rcpts('smtp'):addr.lower.join(',');from('mime'):addr.lower";

export class MailSpamPolicyTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailSpamPolicyTemplateError';
    this.code = code;
  }
}

function normalizeSenders(value) {
  if (!Array.isArray(value) || value.length > MAX_SENDERS_PER_LIST) {
    throw new MailSpamPolicyTemplateError('mail_spam_senders_invalid', 'Mail sender list must be a bounded array of addresses');
  }
  return new Set(value.map((sender) => normalizeMailboxAddress(sender).address));
}

function normalizePairs(mailboxes, policies) {
  if (!Array.isArray(mailboxes) || mailboxes.length > mailTemplatePolicy.maxMailboxes
    || !Array.isArray(policies) || policies.length > mailboxes.length) {
    throw new MailSpamPolicyTemplateError('mail_spam_input_invalid', 'Mail spam policies require a bounded list of managed mailboxes');
  }
  const managed = new Set(mailboxes.map((value) => normalizeMailboxAddress(value).address));
  const seen = new Set();
  const pairs = { allow: [], deny: [] };
  for (const policy of policies) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).length !== 3
      || !['mailbox', 'allow', 'deny'].every((key) => Object.hasOwn(policy, key))) {
      throw new MailSpamPolicyTemplateError('mail_spam_policy_invalid', 'Mail spam policy requires only mailbox, allow and deny');
    }
    const mailbox = normalizeMailboxAddress(policy.mailbox).address;
    if (!managed.has(mailbox) || seen.has(mailbox)) {
      throw new MailSpamPolicyTemplateError('mail_spam_mailbox_invalid', 'Mail spam policy requires a unique, managed mailbox');
    }
    seen.add(mailbox);
    const allow = normalizeSenders(policy.allow);
    const deny = normalizeSenders(policy.deny);
    for (const sender of allow) {
      if (deny.has(sender)) throw new MailSpamPolicyTemplateError('mail_spam_sender_conflict', 'The same sender cannot be allowed and denied for one mailbox');
      pairs.allow.push(`mailbox|${mailbox}|${sender}`);
    }
    for (const sender of deny) pairs.deny.push(`mailbox|${mailbox}|${sender}`);
    if (pairs.allow.length + pairs.deny.length > MAX_PAIRS) {
      throw new MailSpamPolicyTemplateError('mail_spam_policy_too_large', 'Mail spam policy exceeds the supported number of mailbox and sender pairs');
    }
  }
  return { allow: pairs.allow.sort(), deny: pairs.deny.sort() };
}

function renderRule(symbol, selector, values, { score, condition, delimiter } = {}) {
  const lines = [
    `${symbol} {`,
    '  type = "selector";',
    `  selector = ${JSON.stringify(selector)};`,
    // Rspamd Multimap expects the asynchronous callback of a native map.
    `  map = { url = "static"; data = ${JSON.stringify(values)}; };`,
    `  score = ${score};`,
  ];
  if (delimiter) lines.push(`  delimiter = "${delimiter}";`);
  if (condition) lines.push(`  require_symbols = "${condition}";`);
  lines.push('}', '');
  return lines.join('\n');
}

export function previewManagedMailboxSpamPolicy({ mailboxes = [], policies = [] } = {}) {
  const { allow, deny } = normalizePairs(mailboxes, policies);
  const rules = [];
  if (allow.length || deny.length) {
    rules.push(renderRule(AUTH_SYMBOL, "user.id('present')", ['present'], { score: 0 }));
  }
  if (allow.length) {
    rules.push(renderRule('YUNPANEL_MAIL_POLICY_ALLOW', PAIR_SELECTOR, allow, {
      score: -1,
      condition: `!${AUTH_SYMBOL} & DMARC_POLICY_ALLOW`,
      delimiter: '|',
    }));
  }
  if (deny.length) {
    rules.push(renderRule('YUNPANEL_MAIL_POLICY_DENY', PAIR_SELECTOR, deny, {
      score: 5,
      condition: `!${AUTH_SYMBOL}`,
      delimiter: '|',
    }));
  }
  const content = rules.join('\n');
  return Object.freeze({
    version: 1,
    path: MULTIMAP_PATH,
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    counts: Object.freeze({ allow: allow.length, deny: deny.length }),
    content,
    sensitive: true,
    sideEffects: false,
  });
}
