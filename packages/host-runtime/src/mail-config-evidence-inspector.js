import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  mailForwardingTemplatePolicy,
  mailSubmissionTemplatePolicy,
  previewManagedMailApplyPlan,
} from '@yunpanel/config-templates';
import { mailConfigBackupInternals } from './mail-config-backup.js';
import { createMailReadinessInspector } from './mail-readiness-inspector.js';
import { parseManagedSystemIdentity, parseManagedVmailIdentity } from './mail-vmail-identity.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 128 * 1024;
const ROOT_UID = 0;
const ROOT_GID = 0;
const SENSITIVE_MODE = 0o600;
const PUBLIC_MODE = 0o640;
const SIEVE_SHARED_MODE = 0o640;
const SUBMISSION_SOCKET_MODE = 0o660;
const GETENT = '/usr/bin/getent';
const POSTCONF = '/usr/sbin/postconf';

export class MailConfigEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailConfigEvidenceError';
    this.code = code;
  }
}

function boundedOutput(value) {
  const output = String(value ?? '').trim();
  if (Buffer.byteLength(output) > MAX_OUTPUT) {
    throw new MailConfigEvidenceError('mail_config_evidence_output_too_large', 'Managed mail evidence command output exceeded its bound');
  }
  return output;
}

export function createMailConfigEvidenceInspector({
  readinessInspector = createMailReadinessInspector(),
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
  if (!readinessInspector || typeof readinessInspector.inspect !== 'function') {
    throw new MailConfigEvidenceError('mail_config_evidence_readiness_invalid', 'Managed mail readiness inspector is unavailable');
  }

  async function resolveSystemIdentity(name) {
    try {
      const result = await run(GETENT, ['passwd', name], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      boundedOutput(result?.stderr ?? '');
      const output = boundedOutput(result?.stdout ?? result);
      return name === 'vmail'
        ? parseManagedVmailIdentity(output)
        : parseManagedSystemIdentity(output, name);
    } catch {
      return null;
    }
  }

  async function inspectArtifact(artifact, vmailGid) {
    try {
      const metadata = await lstatFn(artifact.path);
      const expectedMode = artifact.sensitive ? SENSITIVE_MODE : PUBLIC_MODE;
      const expectedGid = artifact.path === mailForwardingTemplatePolicy.sievePath ? vmailGid : ROOT_GID;
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || (metadata.mode & 0o777) !== expectedMode
        || metadata.uid !== ROOT_UID || metadata.gid !== expectedGid) return false;
      const content = await readFileFn(artifact.path);
      return createHash('sha256').update(content).digest('hex') === artifact.sha256;
    } catch {
      return false;
    }
  }

  async function inspectCompiledMap(filePath) {
    try {
      const metadata = await lstatFn(filePath);
      return metadata.isFile() && !metadata.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async function inspectCompiledSieve(vmailGid) {
    try {
      const metadata = await lstatFn(mailConfigBackupInternals.sieveCompiledPath);
      return metadata.isFile() && !metadata.isSymbolicLink()
        && metadata.uid === ROOT_UID && metadata.gid === vmailGid
        && (metadata.mode & 0o777) === SIEVE_SHARED_MODE;
    } catch {
      return false;
    }
  }

  async function inspectSubmissionSocket(postfixIdentity) {
    try {
      const metadata = await lstatFn(mailSubmissionTemplatePolicy.dovecotAuthSocket);
      return metadata.isSocket() && !metadata.isSymbolicLink()
        && metadata.uid === postfixIdentity.uid && metadata.gid === postfixIdentity.gid
        && (metadata.mode & 0o7777) === SUBMISSION_SOCKET_MODE;
    } catch {
      return false;
    }
  }

  async function commandSatisfied(command) {
    try {
      const result = await run(command.file, command.args, { timeout: 30_000, maxBuffer: MAX_OUTPUT });
      boundedOutput(result?.stdout ?? result);
      boundedOutput(result?.stderr ?? '');
      return true;
    } catch {
      return false;
    }
  }

  async function postfixParameterSatisfied(parameter) {
    try {
      const result = await run(POSTCONF, ['-h', parameter.name], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      return boundedOutput(result?.stdout ?? result) === parameter.value;
    } catch {
      return false;
    }
  }

  async function removedPostfixParametersSatisfied(plan) {
    const names = plan.srs?.removePostfixParameters ?? [];
    if (names.length === 0) return true;
    let content;
    try { content = await readFileFn(mailConfigBackupInternals.postfixMainCfPath, 'utf8'); }
    catch { return false; }
    const activeLines = String(content).split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    return names.every((name) => !new RegExp(`^\\s*${name}\\s*=`, 'mi').test(activeLines));
  }

  async function postfixMasterServiceSatisfied(service) {
    const identity = `${service.service}/${service.type}`;
    try {
      const serviceResult = await run(POSTCONF, ['-M', identity], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
      if (boundedOutput(serviceResult?.stdout ?? serviceResult).replace(/\s+/g, ' ')
        !== service.definition.replace(/\s+/g, ' ')) return false;
      for (const parameter of service.parameters) {
        const key = `${identity}/${parameter.name}`;
        const result = await run(POSTCONF, ['-P', key], { timeout: 10_000, maxBuffer: MAX_OUTPUT });
        if (boundedOutput(result?.stdout ?? result) !== `${key}=${parameter.value}`) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async function inspect(preview) {
    const plan = previewManagedMailApplyPlan(preview);
    const [vmailIdentity, postfixIdentity] = await Promise.all([
      resolveSystemIdentity('vmail'),
      resolveSystemIdentity('postfix'),
    ]);
    if (!vmailIdentity || !postfixIdentity) return { satisfied: false, result: null };
    for (const artifact of plan.artifacts) {
      if (!(await inspectArtifact(artifact, vmailIdentity.gid))) return { satisfied: false, result: null };
    }
    for (const compiledPath of mailConfigBackupInternals.postfixCompiledPaths) {
      if (!(await inspectCompiledMap(compiledPath))) return { satisfied: false, result: null };
    }
    if (!(await inspectCompiledSieve(vmailIdentity.gid))) return { satisfied: false, result: null };
    for (const parameter of plan.postfixParameters) {
      if (!(await postfixParameterSatisfied(parameter))) return { satisfied: false, result: null };
    }
    if (!(await removedPostfixParametersSatisfied(plan))) return { satisfied: false, result: null };
    for (const service of plan.postfixMasterServices) {
      if (!(await postfixMasterServiceSatisfied(service))) return { satisfied: false, result: null };
    }
    for (const command of plan.stages.validate) {
      if (!(await commandSatisfied(command))) return { satisfied: false, result: null };
    }
    for (const command of plan.stages.health) {
      if (!(await commandSatisfied(command))) return { satisfied: false, result: null };
    }
    if (!(await inspectSubmissionSocket(postfixIdentity))) return { satisfied: false, result: null };

    let readiness;
    try { readiness = await readinessInspector.inspect(preview, { phase: 'post' }); }
    catch { return { satisfied: false, result: null }; }
    if (!readiness || readiness.ready !== true || readiness.previewSha256 !== preview.sha256
      || readiness.phase !== 'post'
      || typeof readiness.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(readiness.sha256)) {
      return { satisfied: false, result: null };
    }
    return Object.freeze({
      satisfied: true,
      result: Object.freeze({
        version: 1,
        previewSha256: preview.sha256,
        planSha256: plan.sha256,
        readinessSha256: readiness.sha256,
        applied: true,
        sideEffects: true,
      }),
    });
  }

  return Object.freeze({ inspect });
}

export const mailConfigEvidenceInternals = Object.freeze({
  maxOutput: MAX_OUTPUT,
  rootUid: ROOT_UID,
  rootGid: ROOT_GID,
  sensitiveMode: SENSITIVE_MODE,
  publicMode: PUBLIC_MODE,
  sieveSharedMode: SIEVE_SHARED_MODE,
  submissionSocketMode: SUBMISSION_SOCKET_MODE,
  boundedOutput,
});
