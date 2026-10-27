import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// Applies the outbound relay rendered by @yunpanel/config-templates renderSmarthost.
// It touches only its own postconf parameters and its own sasl_passwd map, keeps the
// operator's original values in a receipt and restores them on failure or disable.
const execFileAsync = promisify(execFile);
const MANAGED = Object.freeze([
  'relayhost', 'smtp_sasl_auth_enable', 'smtp_sasl_password_maps', 'smtp_sasl_security_options',
  'smtp_sasl_tls_security_options', 'smtp_tls_security_level', 'smtp_tls_wrappermode',
]);

export class MailSmarthostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailSmarthostError';
    this.code = code;
  }
}

export function createMailSmarthostManager({
  directory = '/etc/postfix/yunpanel-smarthost',
  configDirectory = null,
  postconf = '/usr/sbin/postconf',
  postmap = '/usr/sbin/postmap',
  postfix = '/usr/sbin/postfix',
  reload = true,
  execFileFn = execFileAsync,
} = {}) {
  const saslPath = path.join(directory, 'sasl_passwd');
  const receiptPath = path.join(directory, 'baseline.json');
  const configArgs = configDirectory ? ['-c', configDirectory] : [];

  async function run(file, args, code, message) {
    try { return (await execFileFn(file, args, { timeout: 30_000, maxBuffer: 256 * 1024 })).stdout ?? ''; }
    catch { throw new MailSmarthostError(code, message); }
  }

  async function currentValues() {
    const values = {};
    for (const name of MANAGED) {
      values[name] = (await run(postconf, [...configArgs, '-h', name], 'smarthost_postconf_read_failed', 'Postfix settings could not be read')).trim();
    }
    return values;
  }

  async function setValues(values) {
    const args = Object.entries(values).map(([name, value]) => `${name}=${value}`);
    await run(postconf, [...configArgs, '-e', ...args], 'smarthost_postconf_write_failed', 'Postfix settings could not be written');
  }

  async function writeSecret(content) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${saslPath}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, saslPath);
    await run(postmap, [...configArgs, `hash:${saslPath}`], 'smarthost_postmap_failed', 'Relay credential map could not be compiled');
    await chmod(`${saslPath}.db`, 0o600);
  }

  async function optionalRead(target) {
    try { return await readFile(target, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }

  async function check() {
    await run(postfix, [...configArgs, 'check'], 'smarthost_postfix_check_failed', 'Postfix rejected the relay configuration');
  }

  async function reloadPostfix() {
    if (reload) await run(postfix, [...configArgs, 'reload'], 'smarthost_postfix_reload_failed', 'Postfix could not reload the relay configuration');
  }

  async function apply({ postfixParameters, saslPasswd } = {}) {
    if (!Array.isArray(postfixParameters) || typeof saslPasswd !== 'string'
      || postfixParameters.some(({ name }) => !MANAGED.includes(name))
      || postfixParameters.some(({ value }) => typeof value !== 'string' || /[\s]/.test(value))) {
      throw new MailSmarthostError('invalid_smarthost_plan', 'Relay plan must come from renderSmarthost');
    }
    const before = await currentValues();
    const previousSecret = await optionalRead(saslPath);
    // The first enable records the operator's own values; later edits keep that baseline.
    if ((await optionalRead(receiptPath)) === null) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(receiptPath, JSON.stringify({ version: 1, values: before }), { encoding: 'utf8', mode: 0o600 });
    }
    try {
      await writeSecret(saslPasswd);
      await setValues(Object.fromEntries(postfixParameters.map(({ name, value }) => [name, value])));
      await check();
    } catch (error) {
      await setValues(before).catch(() => {});
      if (previousSecret === null) await rm(saslPath, { force: true }).catch(() => {});
      else await writeSecret(previousSecret).catch(() => {});
      throw error;
    }
    await reloadPostfix();
    return { enabled: true };
  }

  async function disable() {
    const receipt = await optionalRead(receiptPath);
    if (receipt === null) return { enabled: false, changed: false };
    const { values } = JSON.parse(receipt);
    await setValues(values);
    await check();
    await rm(saslPath, { force: true });
    await rm(`${saslPath}.db`, { force: true });
    await rm(receiptPath, { force: true });
    await reloadPostfix();
    return { enabled: false, changed: true };
  }

  async function status() {
    const values = await currentValues();
    return { relayhost: values.relayhost || null, authenticated: values.smtp_sasl_auth_enable === 'yes',
      tlsRequired: values.smtp_tls_security_level === 'encrypt' };
  }

  return Object.freeze({ apply, disable, status });
}

export const mailSmarthostManagerInternals = Object.freeze({ MANAGED });
