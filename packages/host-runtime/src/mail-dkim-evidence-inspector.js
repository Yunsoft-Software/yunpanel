import {
  createHash,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { mailDkimTemplatePolicy } from '@yunpanel/config-templates';
import { mailDkimActivatorInternals } from './mail-dkim-activator.js';
import { parseManagedRspamdIdentity } from './mail-rspamd-identity.js';

const execFileAsync = promisify(execFile);
const GETENT = '/usr/bin/getent';
const RSPAMADM = '/usr/bin/rspamadm';
const SYSTEMCTL = '/usr/bin/systemctl';
const ROOT_UID = 0;
const ROOT_GID = 0;
const MAX_OUTPUT = 128 * 1024;

export class MailDkimEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDkimEvidenceError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function publicKeyFromPrivate(privateKeyPem) {
  try {
    return createPublicKey(createPrivateKey(privateKeyPem))
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
  } catch {
    return null;
  }
}

function bounded(value) {
  const output = String(value ?? '');
  if (Buffer.byteLength(output) > MAX_OUTPUT) {
    throw new MailDkimEvidenceError('mail_dkim_evidence_output_too_large', 'DKIM evidence command output exceeded its bound');
  }
  return output;
}

export function createMailDkimEvidenceInspector({
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
    ...options,
  }),
  lstatFn = lstat,
  readFileFn = readFile,
} = {}) {
  if (typeof run !== 'function' || typeof lstatFn !== 'function' || typeof readFileFn !== 'function') {
    throw new MailDkimEvidenceError('mail_dkim_evidence_dependencies_invalid', 'DKIM evidence dependencies are invalid');
  }

  async function commandSatisfied(file, args) {
    try {
      const result = await run(file, args, { timeout: 30_000, maxBuffer: MAX_OUTPUT });
      bounded(result?.stdout ?? result);
      bounded(result?.stderr ?? '');
      return true;
    } catch (error) {
      if (error instanceof MailDkimEvidenceError) throw error;
      return false;
    }
  }

  async function rspamdIdentity() {
    try {
      const result = await run(GETENT, ['passwd', '_rspamd'], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      const output = bounded(result?.stdout ?? result);
      bounded(result?.stderr ?? '');
      return parseManagedRspamdIdentity(output);
    } catch (error) {
      if (error instanceof MailDkimEvidenceError) throw error;
      return null;
    }
  }

  async function safeDirectory(directoryPath) {
    try {
      const metadata = await lstatFn(directoryPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
      return Object.freeze({
        present: true,
        mode: metadata.mode & 0o7777,
        uid: metadata.uid,
        gid: metadata.gid,
      });
    } catch {
      return null;
    }
  }

  async function inspect(input) {
    let bundle;
    try { bundle = mailDkimActivatorInternals.normalizeBundle(input); }
    catch { return Object.freeze({ satisfied: false, result: null }); }

    const identity = await rspamdIdentity();
    if (!identity) return Object.freeze({ satisfied: false, result: null });

    const parent = await safeDirectory(mailDkimActivatorInternals.liveKeyParent);
    const keyRoot = await safeDirectory(mailDkimTemplatePolicy.keyRoot);
    if (!parent || !keyRoot
      || !mailDkimActivatorInternals.directoryTraversableBy(parent, identity)
      || keyRoot.uid !== ROOT_UID || keyRoot.gid !== identity.gid
      || keyRoot.mode !== mailDkimActivatorInternals.liveKeyDirectoryMode) {
      return Object.freeze({ satisfied: false, result: null });
    }

    try {
      const configMetadata = await lstatFn(mailDkimTemplatePolicy.configPath);
      if (!configMetadata.isFile() || configMetadata.isSymbolicLink()
        || configMetadata.uid !== ROOT_UID || configMetadata.gid !== ROOT_GID
        || (configMetadata.mode & 0o7777) !== mailDkimActivatorInternals.publicConfigMode) {
        return Object.freeze({ satisfied: false, result: null });
      }
      const config = await readFileFn(mailDkimTemplatePolicy.configPath);
      if (sha256(config) !== bundle.preview.artifact.sha256) {
        return Object.freeze({ satisfied: false, result: null });
      }

      for (const key of bundle.keys) {
        const metadata = await lstatFn(key.targetPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()
          || metadata.uid !== ROOT_UID || metadata.gid !== identity.gid
          || (metadata.mode & 0o7777) !== mailDkimActivatorInternals.liveKeyMode) {
          return Object.freeze({ satisfied: false, result: null });
        }
        const privateKey = await readFileFn(key.targetPath, 'utf8');
        if (publicKeyFromPrivate(privateKey) !== key.publicKey) {
          return Object.freeze({ satisfied: false, result: null });
        }
      }
    } catch {
      return Object.freeze({ satisfied: false, result: null });
    }

    if (!(await commandSatisfied(RSPAMADM, ['configtest']))
      || !(await commandSatisfied(SYSTEMCTL, ['is-active', '--quiet', 'rspamd']))) {
      return Object.freeze({ satisfied: false, result: null });
    }

    return Object.freeze({
      satisfied: true,
      result: Object.freeze({
        version: 1,
        previewSha256: bundle.preview.sha256,
        applied: true,
        sideEffects: true,
      }),
    });
  }

  return Object.freeze({ inspect });
}

export const mailDkimEvidenceInternals = Object.freeze({
  maxOutput: MAX_OUTPUT,
  rootUid: ROOT_UID,
  rootGid: ROOT_GID,
  publicKeyFromPrivate,
  bounded,
});
