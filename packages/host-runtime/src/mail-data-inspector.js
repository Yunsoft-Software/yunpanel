import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  mailDataTemplatePolicy,
  mailDomainDataPath,
  mailboxDataPath,
  normalizeMailboxAddress,
} from '@yunpanel/config-templates';

const execFileAsync = promisify(execFile);
const DU = '/usr/bin/du';
const MAX_OUTPUT = 16 * 1024;

export class MailDataInspectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDataInspectorError';
    this.code = code;
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function missing(error) {
  return error?.code === 'ENOENT';
}

function parseDuBytes(value, expectedPath) {
  const output = String(value ?? '').trim();
  if (!output || Buffer.byteLength(output) > MAX_OUTPUT || output.includes('\n')) {
    throw new MailDataInspectorError('mail_data_usage_invalid', 'Mail data usage output is invalid');
  }
  const separator = output.indexOf('\t');
  if (separator < 1 || output.slice(separator + 1) !== expectedPath) {
    throw new MailDataInspectorError('mail_data_usage_invalid', 'Mail data usage output is invalid');
  }
  const rawBytes = output.slice(0, separator);
  if (!/^\d+$/.test(rawBytes)) {
    throw new MailDataInspectorError('mail_data_usage_invalid', 'Mail data usage output is invalid');
  }
  const bytes = Number.parseInt(rawBytes, 10);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new MailDataInspectorError('mail_data_usage_invalid', 'Mail data usage exceeds the supported range');
  }
  return bytes;
}

export function createMailDataInspector({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
  lstatFn = lstat,
} = {}) {
  async function safeDirectory(directoryPath, { optional = false } = {}) {
    try {
      const metadata = await lstatFn(directoryPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new MailDataInspectorError('mail_data_path_unsafe', 'Managed mail data path is not a real directory');
      }
      return metadata;
    } catch (error) {
      if (optional && missing(error)) return null;
      if (error instanceof MailDataInspectorError) throw error;
      if (missing(error)) throw new MailDataInspectorError('mail_data_root_missing', 'Managed mail data root is unavailable');
      throw new MailDataInspectorError('mail_data_path_unavailable', 'Managed mail data path could not be inspected');
    }
  }

  async function usageBytes(targetPath) {
    try {
      const result = await run(DU, ['--bytes', '--summarize', '--one-file-system', '--', targetPath], {
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT,
      });
      return parseDuBytes(result?.stdout ?? result, targetPath);
    } catch (error) {
      if (error instanceof MailDataInspectorError) throw error;
      throw new MailDataInspectorError('mail_data_usage_failed', 'Managed mail data usage could not be inspected');
    }
  }

  async function inspectPath({ scope, identity, targetPath, domainPath }) {
    const root = await safeDirectory(mailDataTemplatePolicy.root, { optional: true });
    if (!root) {
      const snapshot = { version: 1, scope, identity, dataPath: targetPath, present: false, bytes: 0 };
      return Object.freeze({ ...snapshot, snapshotSha256: digest(snapshot), sideEffects: false });
    }
    const domain = await safeDirectory(domainPath, { optional: true });
    if (!domain) {
      const snapshot = { version: 1, scope, identity, dataPath: targetPath, present: false, bytes: 0 };
      return Object.freeze({ ...snapshot, snapshotSha256: digest(snapshot), sideEffects: false });
    }
    let target = domain;
    if (targetPath !== domainPath) {
      target = await safeDirectory(targetPath, { optional: true });
      if (!target) {
        const snapshot = { version: 1, scope, identity, dataPath: targetPath, present: false, bytes: 0 };
        return Object.freeze({ ...snapshot, snapshotSha256: digest(snapshot), sideEffects: false });
      }
    }
    const bytes = await usageBytes(targetPath);
    const snapshot = {
      version: 1,
      scope,
      identity,
      dataPath: targetPath,
      present: true,
      bytes,
      mode: target.mode & 0o7777,
      uid: target.uid,
      gid: target.gid,
    };
    return Object.freeze({ ...snapshot, snapshotSha256: digest(snapshot), sideEffects: false });
  }

  async function inspectMailbox(address) {
    const mailbox = normalizeMailboxAddress(address);
    return inspectPath({
      scope: 'mailbox',
      identity: mailbox.address,
      targetPath: mailboxDataPath(mailbox.address),
      domainPath: mailDomainDataPath(mailbox.domain),
    });
  }

  async function inspectDomain(domainName) {
    const targetPath = mailDomainDataPath(domainName);
    return inspectPath({
      scope: 'domain',
      identity: path.posix.basename(targetPath),
      targetPath,
      domainPath: targetPath,
    });
  }

  return Object.freeze({ inspectMailbox, inspectDomain });
}

export const mailDataInspectorInternals = Object.freeze({
  duPath: DU,
  maxOutput: MAX_OUTPUT,
  parseDuBytes,
});
