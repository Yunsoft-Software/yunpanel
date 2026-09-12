import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { mailDkimTemplatePolicy } from '@yunpanel/config-templates';
import { normalizeDomainSet } from '@yunpanel/shared';

const execFileAsync = promisify(execFile);
const RSPAMADM = '/usr/bin/rspamadm';
const SYSTEMCTL = '/usr/bin/systemctl';
const ROOT_UID = 0;
const ROOT_GID = 0;
const CONFIG_MODE = 0o640;
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_OUTPUT = 128 * 1024;

export class MailDkimRetirementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailDkimRetirementError';
    this.code = code;
  }
}

function target(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 2
    || typeof input.domain !== 'string' || typeof input.selector !== 'string') {
    throw new MailDkimRetirementError('mail_dkim_retirement_input_invalid', 'DKIM retirement target is invalid');
  }
  let domain;
  try { domain = normalizeDomainSet(input.domain, []).primary; }
  catch { throw new MailDkimRetirementError('mail_dkim_retirement_domain_invalid', 'DKIM retirement domain is invalid'); }
  if (domain !== input.domain || !mailDkimTemplatePolicy.selectorPattern.test(input.selector)) {
    throw new MailDkimRetirementError('mail_dkim_retirement_target_invalid', 'DKIM retirement target is not canonical');
  }
  return Object.freeze({
    domain,
    selector: input.selector,
    keyPath: mailDkimTemplatePolicy.keyPath(domain, input.selector),
  });
}

function bounded(value) {
  const output = String(value ?? '');
  if (Buffer.byteLength(output) > MAX_OUTPUT) {
    throw new MailDkimRetirementError('mail_dkim_retirement_output_too_large', 'DKIM retirement command output exceeded its bound');
  }
  return output;
}

export function createMailDkimRetirementInspector({
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
    throw new MailDkimRetirementError('mail_dkim_retirement_dependencies_invalid', 'DKIM retirement dependencies are invalid');
  }

  async function commandSatisfied(file, args) {
    try {
      const result = await run(file, args, { timeout: 30_000, maxBuffer: MAX_OUTPUT });
      bounded(result?.stdout ?? result);
      bounded(result?.stderr ?? '');
      return true;
    } catch (error) {
      if (error instanceof MailDkimRetirementError) throw error;
      return false;
    }
  }

  async function keyAbsent(keyPath) {
    try {
      await lstatFn(keyPath);
      return false;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  }

  async function configRetired({ domain, keyPath }) {
    try {
      const metadata = await lstatFn(mailDkimTemplatePolicy.configPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.uid !== ROOT_UID || metadata.gid !== ROOT_GID
        || (metadata.mode & 0o7777) !== CONFIG_MODE
        || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_CONFIG_BYTES) {
        return false;
      }
      const content = await readFileFn(mailDkimTemplatePolicy.configPath, 'utf8');
      if (Buffer.byteLength(content) !== metadata.size || Buffer.byteLength(content) > MAX_CONFIG_BYTES) return false;
      return !content.includes(`path = "${keyPath}";`)
        && !content.split('\n').some((line) => line === `  ${domain} {`);
    } catch {
      return false;
    }
  }

  async function inspect(input) {
    const candidate = target(input);
    if (!(await keyAbsent(candidate.keyPath)) || !(await configRetired(candidate))) {
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
        domain: candidate.domain,
        selector: candidate.selector,
        retired: true,
        sideEffects: false,
      }),
    });
  }

  return Object.freeze({ inspect });
}

export const mailDkimRetirementInternals = Object.freeze({
  rootUid: ROOT_UID,
  rootGid: ROOT_GID,
  configMode: CONFIG_MODE,
  maxConfigBytes: MAX_CONFIG_BYTES,
  maxOutput: MAX_OUTPUT,
  target,
  bounded,
});
