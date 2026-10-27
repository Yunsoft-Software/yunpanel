// Plesk "Track Email Delivery": groups Postfix journal lines by queue id into
// messages with a status per recipient. A message belongs to a mail domain only
// when its sender or a recipient is exactly in that domain, so one tenant never
// sees another tenant's mail (no substring matching).
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const QUEUE_LINE = /^([0-9A-F]{6,12}|[0-9A-Za-z]{12,20}): (.*)$/;
const NOQUEUE = /^NOQUEUE: reject: \S+ from [^:]+: (.*?); from=<([^>]*)> to=<([^>]*)>/;
const SEVERITY = Object.freeze({ sent: 0, deferred: 1, expired: 2, bounced: 2, rejected: 2 });

export class MailDeliveryTrackerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDeliveryTrackerError';
    this.code = code;
    this.status = 400;
  }
}

const domainOf = (address) => (address?.includes('@') ? address.slice(address.lastIndexOf('@') + 1).toLowerCase() : null);
const field = (text, name) => new RegExp(`(?:^|, )${name}=([^,]+)`).exec(text)?.[1] ?? null;

function worst(recipients) {
  return recipients.reduce((current, recipient) =>
    current === null || SEVERITY[recipient.status] > SEVERITY[current] ? recipient.status : current, null);
}

function parse(entries) {
  const messages = new Map();
  const rejected = [];
  const message = (queueId, timestamp) => {
    if (!messages.has(queueId)) {
      messages.set(queueId, { queueId, firstSeen: timestamp, lastSeen: timestamp, from: undefined, size: null,
        messageId: null, client: null, recipients: [], removed: false });
    }
    const current = messages.get(queueId);
    current.lastSeen = timestamp;
    return current;
  };
  for (const { timestamp, message: text } of entries) {
    if (typeof text !== 'string' || typeof timestamp !== 'string') continue;
    const refused = NOQUEUE.exec(text);
    if (refused) {
      rejected.push({ queueId: null, firstSeen: timestamp, lastSeen: timestamp, from: refused[2] || null, size: null, messageId: null,
        client: null, removed: false, status: 'rejected', reason: refused[1],
        recipients: [{ address: refused[3], status: 'rejected', dsn: null, relay: null, reason: refused[1] }] });
      continue;
    }
    const line = QUEUE_LINE.exec(text);
    if (!line) continue;
    const [, queueId, rest] = line;
    const current = message(queueId, timestamp);
    if (rest === 'removed') { current.removed = true; continue; }
    if (rest.startsWith('client=')) { current.client = rest.slice('client='.length); continue; }
    const messageId = /^message-id=<([^>]*)>/.exec(rest);
    if (messageId) { current.messageId = messageId[1]; continue; }
    const from = /^from=<([^>]*)>/.exec(rest);
    if (from) { current.from = from[1] || null; current.size = Number(field(rest, 'size')) || null; continue; }
    const to = /^to=<([^>]*)>/.exec(rest);
    const status = /status=([a-z]+)(?: \((.*)\))?/.exec(rest);
    if (to && status && Object.hasOwn(SEVERITY, status[1])) {
      const recipient = { address: to[1], status: status[1], dsn: field(rest, 'dsn'), relay: field(rest, 'relay'), reason: status[2] ?? null };
      // A later attempt for the same recipient replaces the earlier one (deferred, then sent).
      const index = current.recipients.findIndex(item => item.address === recipient.address);
      if (index >= 0) current.recipients[index] = recipient; else current.recipients.push(recipient);
    }
  }
  const tracked = [...messages.values()].filter(item => item.recipients.length > 0 || item.from !== undefined)
    .map(item => ({ ...item, from: item.from ?? null, status: worst(item.recipients) ?? 'queued',
      reason: item.recipients.find(r => r.status !== 'sent')?.reason ?? null }));
  return [...tracked, ...rejected];
}

export function trackDeliveries(entries, { domain, search = null, limit = 100 } = {}) {
  const scope = typeof domain === 'string' ? domain.toLowerCase() : '';
  if (!HOSTNAME.test(scope)) throw new MailDeliveryTrackerError('invalid_mail_domain', 'Mail domain is invalid');
  const needle = typeof search === 'string' && search.trim() ? search.trim().toLowerCase() : null;
  return parse(Array.isArray(entries) ? entries : [])
    .filter(item => domainOf(item.from) === scope || item.recipients.some(r => domainOf(r.address) === scope))
    .filter(item => !needle || [item.queueId, item.from, item.messageId, item.reason, ...item.recipients.flatMap(r => [r.address, r.reason])]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(needle)))
    .sort((left, right) => (left.lastSeen < right.lastSeen ? 1 : left.lastSeen > right.lastSeen ? -1 : 0))
    .slice(0, Math.max(1, Math.min(200, limit)));
}
