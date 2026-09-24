import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DOVEADM = '/usr/bin/doveadm';
const POSTCONF = '/usr/sbin/postconf';
const POSTMAP = '/usr/sbin/postmap';
const MAX_OUTPUT = 16 * 1024;
// The SQL lookup paths are the existing managed mail-sql.js policy, not input.
const LOOKUPS = Object.freeze([
  ['virtual_mailbox_maps', 'proxy:sqlite:/etc/postfix/yunpanel-sql/virtual-mailboxes.cf'],
  ['smtpd_sender_login_maps', 'proxy:sqlite:/etc/postfix/yunpanel-sql/sender-login.cf'],
].map((item) => Object.freeze(item)));

export class MailboxAccessError extends Error {
  constructor(code) {
    super('Selected mailbox access could not be safely disabled and verified');
    this.name = 'MailboxAccessError';
    this.code = code;
  }
}

function addressArgument(value) {
  // doveadm treats * and ? as user masks, even without a shell. Reject masks,
  // whitespace, options, control characters, and noncanonical identities.
  if (typeof value !== 'string' || value.length > 254
    || !/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)
    || value.split('@')[1].split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    throw new MailboxAccessError('mailbox_access_identity_invalid');
  }
  return value;
}

function commandOutput(result) {
  if (!result || typeof result !== 'object' || typeof result.stdout !== 'string'
    || (result.stderr !== undefined && typeof result.stderr !== 'string')
    || Buffer.byteLength(result.stdout) > MAX_OUTPUT || Buffer.byteLength(result.stderr ?? '') > MAX_OUTPUT
    || /[\u0000\u001b]/.test(result.stdout + (result.stderr ?? ''))) {
    throw new MailboxAccessError('mailbox_access_output_invalid');
  }
  return { stdout: result.stdout.trim(), stderr: (result.stderr ?? '').trim() };
}

export function createMailboxAccessGuard({
  run = (file, args, options) => execFileAsync(file, args, {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C' }, ...options,
  }),
} = {}) {
  if (typeof run !== 'function') throw new TypeError('Mailbox access command runner is required');

  async function command(file, args, expectedMissing = null) {
    let result;
    try {
      result = await run(file, args, { timeout: 10_000, maxBuffer: MAX_OUTPUT, shell: false });
    } catch (error) {
      // Only documented absence, not timeout/EACCES/config errors, is evidence.
      if (!expectedMissing || error?.code !== expectedMissing.code || error?.killed || error?.signal) {
        throw new MailboxAccessError('mailbox_access_check_failed');
      }
      const output = commandOutput(error);
      if (output.stdout !== expectedMissing.stdout || output.stderr !== expectedMissing.stderr) {
        throw new MailboxAccessError('mailbox_access_absence_unverified');
      }
      return true;
    }
    const output = commandOutput(result);
    if (expectedMissing) throw new MailboxAccessError('mailbox_access_still_enabled');
    if (output.stderr) throw new MailboxAccessError('mailbox_access_check_failed');
    return output.stdout;
  }

  async function noDelivery(address) {
    for (const [parameter, lookup] of LOOKUPS) {
      const configured = await command(POSTCONF, ['-h', parameter]);
      if (configured !== lookup) throw new MailboxAccessError('mailbox_access_configuration_unverified');
      await command(POSTMAP, ['-q', address, lookup], { code: 1, stdout: '', stderr: '' });
    }
  }

  async function noAuthentication(address) {
    // -f user avoids returning password/hash fields even if lookup succeeds.
    for (const service of ['imap', 'pop3', 'smtp', 'sieve']) {
      await command(DOVEADM, ['auth', 'lookup', '-x', `service=${service}`, '-f', 'user', address], {
        code: 67, stdout: '', stderr: `passdb lookup: user ${address} doesn't exist`,
      });
    }
    for (const service of ['imap', 'pop3', 'lmtp', 'sieve']) {
      // Use a field-only lookup; -u and -f are mutually exclusive in the manual.
      await command(DOVEADM, ['user', '-x', `service=${service}`, '-f', 'uid', address], {
        code: 67, stdout: '', stderr: `userdb lookup: user ${address} doesn't exist`,
      });
    }
  }

  async function noSessions(address) {
    const output = await command(DOVEADM, ['-f', 'tab', 'who', '-1', address]);
    // Some versions suppress an empty table entirely. Any row or unrecognized
    // output is not proof of no sessions. Never publish the session list.
    if (output !== '' && !['username\tproto\tpid\tip', 'username\tservice\tpid\tip'].includes(output)) {
      throw new MailboxAccessError('mailbox_access_sessions_remaining');
    }
  }

  async function quiesce(value) {
    const address = addressArgument(value);
    await noDelivery(address);
    const flushed = await command(DOVEADM, ['auth', 'cache', 'flush', address]);
    if (!/^\d+ cache entries flushed$/.test(flushed)) throw new MailboxAccessError('mailbox_access_cache_unverified');
    await noAuthentication(address);
    await command(DOVEADM, ['kick', address]);
    await noSessions(address);
    // Re-enable/config drift after the first check must not authorize deletion.
    await noDelivery(address);
    await noAuthentication(address);
    return Object.freeze({ identity: address, accessDisabled: true, sessionsCleared: true });
  }

  async function verify(value) {
    const address = addressArgument(value);
    await noDelivery(address);
    await noAuthentication(address);
    await noSessions(address);
    return Object.freeze({ identity: address, accessDisabled: true, sessionsCleared: true });
  }

  return Object.freeze({ quiesce, verify });
}

export const mailboxAccessInternals = Object.freeze({ addressArgument, commandOutput, lookups: LOOKUPS });
