import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_WP_CLI_PATHS = Object.freeze(['/usr/local/bin/wp', '/usr/bin/wp']);
const DEFAULT_COMPOSER_PATHS = Object.freeze(['/usr/local/bin/composer', '/usr/bin/composer']);
const RUNUSER_PATH = '/usr/sbin/runuser';
const PASSWD_PATH = '/etc/passwd';
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const APPLICATION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RELEASE_ID = APPLICATION_ID;
const SITE_CURRENT_PATTERN = new RegExp(`^(/(?:var/www|var/lib)/yunpanel/apps/(${APPLICATION_ID}))/current(?:/public)?$`, 'i');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MB

export class PhpCliToolError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PhpCliToolError';
    this.code = code;
    this.status = status;
  }
}

function defaultError(code, message, status = 400) {
  return new PhpCliToolError(code, message, status);
}

function parsePasswd(passwdText, user, errorFactory = defaultError) {
  if (typeof passwdText !== 'string' || !APP_USER_PATTERN.test(user)) {
    throw errorFactory('php_cli_account_invalid', 'Website user account is invalid', 400);
  }
  const matching = passwdText.split('\n').filter((line) => line.startsWith(`${user}:`));
  if (matching.length !== 1) {
    throw errorFactory('php_cli_account_missing', 'Website user account is unavailable', 409);
  }
  const fields = matching[0].split(':');
  const numericId = /^[1-9][0-9]{0,9}$/;
  const uid = numericId.test(fields[2] ?? '') ? Number(fields[2]) : null;
  const gid = numericId.test(fields[3] ?? '') ? Number(fields[3]) : null;
  const home = fields[5];
  if (fields.length !== 7 || !Number.isSafeInteger(uid) || uid < 1 || uid > 2_147_483_647
    || !Number.isSafeInteger(gid) || gid < 1 || gid > 2_147_483_647
    || typeof home !== 'string' || !home.startsWith('/') || /[\u0000-\u001f\u007f]/.test(home)) {
    throw errorFactory('php_cli_account_invalid', 'Website user account is invalid', 400);
  }
  return Object.freeze({ user, home, uid, gid });
}

function toolEnvironment({ user, home }) {
  return Object.freeze({
    HOME: home,
    LANG: 'C.UTF-8',
    LOGNAME: user,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    USER: user,
    COMPOSER_HOME: path.posix.join(home, '.composer'),
    WP_CLI_CACHE_DIR: path.posix.join(home, '.wp-cli', 'cache'),
  });
}

// Allowlisted WP-CLI top-level commands
const WP_CLI_ALLOWED_COMMANDS = new Set([
  'core',
  'plugin',
  'theme',
  'cache',
  'transient',
  'db',
  'option',
  'cron',
  'user',
  'post',
  'eval',
  'config',
]);

// Allowlisted Composer top-level commands
const COMPOSER_ALLOWED_COMMANDS = new Set([
  'validate',
  'install',
  'update',
  'dump-autoload',
  'dumpautoload',
  'show',
  'audit',
  'outdated',
  'licenses',
  'diagnose',
  'clear-cache',
  'clearcache',
  'require',
  'remove',
]);

function validateCommandArgs(command, rawArgs, allowedCommands, toolName) {
  if (typeof command !== 'string' || !allowedCommands.has(command)) {
    throw new PhpCliToolError(
      `${toolName}_command_unsupported`,
      `The ${toolName} command "${command}" is not supported or allowlisted`,
      400,
    );
  }

  const args = Array.isArray(rawArgs) ? rawArgs : [];
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new PhpCliToolError(
        `${toolName}_argument_invalid`,
        `Invalid argument type for ${toolName}`,
        400,
      );
    }
    if (/[\u0000\r\n]/.test(arg)) {
      throw new PhpCliToolError(
        `${toolName}_argument_invalid`,
        `Argument contains forbidden control characters`,
        400,
      );
    }
    // Explicitly forbid --allow-root
    if (arg === '--allow-root' || arg.startsWith('--allow-root=')) {
      throw new PhpCliToolError(
        `${toolName}_root_forbidden`,
        `--allow-root is strictly forbidden in YunPanel`,
        403,
      );
    }
  }

  return Object.freeze([command, ...args]);
}

export function createPhpCliToolManager({
  wpCliPaths = DEFAULT_WP_CLI_PATHS,
  composerPaths = DEFAULT_COMPOSER_PATHS,
  run = (file, args, options = {}) => execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    cwd: options.cwd,
    env: options.env,
  }),
  lstatFn = lstat,
  realpathFn = realpath,
  readFileFn = readFile,
  passwdPath = PASSWD_PATH,
} = {}) {
  async function findBinary(candidates, toolName) {
    for (const candidate of candidates) {
      try {
        const stat = await lstatFn(candidate);
        if (stat.isFile() || stat.isSymbolicLink()) {
          return candidate;
        }
      } catch {
        // continue
      }
    }
    return null;
  }

  async function inspectWpCli() {
    const binary = await findBinary(wpCliPaths, 'wp-cli');
    if (!binary) {
      return Object.freeze({ available: false, path: null, version: null });
    }
    try {
      const { stdout } = await run(binary, ['--version', '--allow-root'], { timeout: 10_000 });
      const versionMatch = stdout.match(/WP-CLI\s+([0-9]+\.[0-9]+\.[0-9]+[a-z0-9.-]*)/i);
      return Object.freeze({
        available: true,
        path: binary,
        version: versionMatch ? versionMatch[1] : stdout.trim(),
      });
    } catch {
      return Object.freeze({ available: true, path: binary, version: null });
    }
  }

  async function inspectComposer() {
    const binary = await findBinary(composerPaths, 'composer');
    if (!binary) {
      return Object.freeze({ available: false, path: null, version: null });
    }
    try {
      const { stdout } = await run(binary, ['--version'], { timeout: 10_000 });
      const versionMatch = stdout.match(/Composer\s+(?:version\s+)?([0-9]+\.[0-9]+\.[0-9]+[a-z0-9.-]*)/i);
      return Object.freeze({
        available: true,
        path: binary,
        version: versionMatch ? versionMatch[1] : stdout.trim(),
      });
    } catch {
      return Object.freeze({ available: true, path: binary, version: null });
    }
  }

  async function resolveTargetContext({ unixUser, cwd }) {
    if (!APP_USER_PATTERN.test(unixUser ?? '')) {
      throw new PhpCliToolError('php_cli_account_invalid', 'Website Unix user is invalid', 400);
    }
    if (typeof cwd !== 'string' || !SITE_CURRENT_PATTERN.test(cwd)) {
      throw new PhpCliToolError('php_cli_cwd_invalid', 'Website working directory is invalid', 400);
    }

    let stat;
    try {
      stat = await lstatFn(cwd);
    } catch {
      throw new PhpCliToolError('php_cli_cwd_unavailable', 'Website working directory is unavailable', 409);
    }
    if (!stat.isDirectory()) {
      throw new PhpCliToolError('php_cli_cwd_invalid', 'Website working directory is not a directory', 400);
    }

    let resolvedCwd;
    try {
      resolvedCwd = await realpathFn(cwd);
    } catch {
      throw new PhpCliToolError('php_cli_cwd_unavailable', 'Website working directory could not be resolved', 409);
    }

    const match = SITE_CURRENT_PATTERN.exec(cwd);
    const releasePrefix = match[1];
    const releasePattern = new RegExp(`^${releasePrefix}/releases/${RELEASE_ID}(?:/public)?$`, 'i');
    if (!releasePattern.test(resolvedCwd)) {
      throw new PhpCliToolError('php_cli_cwd_escape', 'Website working directory escaped managed storage', 409);
    }

    const passwdText = await readFileFn(passwdPath, 'utf8');
    const account = parsePasswd(passwdText, unixUser);

    if (account.uid === 0 || account.user === 'root') {
      throw new PhpCliToolError('php_cli_root_forbidden', 'Running PHP tools as root is strictly forbidden', 403);
    }

    return Object.freeze({
      account,
      cwd: resolvedCwd,
      env: toolEnvironment(account),
    });
  }

  async function runWpCli({ unixUser, cwd, command, args = [], timeout = 60_000 } = {}) {
    const wpInfo = await inspectWpCli();
    if (!wpInfo.available) {
      throw new PhpCliToolError('wp_cli_not_installed', 'WP-CLI is not installed on the system', 503);
    }

    const target = await resolveTargetContext({ unixUser, cwd });
    const validatedArgs = validateCommandArgs(command, args, WP_CLI_ALLOWED_COMMANDS, 'wp_cli');

    // Run via runuser -u <user> -- <binary> <args>
    const runArgs = ['-u', target.account.user, '--', wpInfo.path, ...validatedArgs];

    try {
      const result = await run(RUNUSER_PATH, runArgs, {
        cwd: target.cwd,
        env: target.env,
        timeout: Math.min(timeout, 300_000),
      });

      return Object.freeze({
        success: true,
        exitCode: 0,
        stdout: String(result?.stdout ?? ''),
        stderr: String(result?.stderr ?? ''),
      });
    } catch (error) {
      return Object.freeze({
        success: false,
        exitCode: Number.isInteger(error?.code) ? error.code : 1,
        stdout: String(error?.stdout ?? ''),
        stderr: String(error?.stderr ?? error?.message ?? ''),
      });
    }
  }

  async function runComposer({ unixUser, cwd, command, args = [], timeout = 120_000 } = {}) {
    const composerInfo = await inspectComposer();
    if (!composerInfo.available) {
      throw new PhpCliToolError('composer_not_installed', 'Composer is not installed on the system', 503);
    }

    const target = await resolveTargetContext({ unixUser, cwd });
    const validatedArgs = validateCommandArgs(command, args, COMPOSER_ALLOWED_COMMANDS, 'composer');

    // Run via runuser -u <user> -- <binary> <args>
    const runArgs = ['-u', target.account.user, '--', composerInfo.path, ...validatedArgs];

    try {
      const result = await run(RUNUSER_PATH, runArgs, {
        cwd: target.cwd,
        env: target.env,
        timeout: Math.min(timeout, 600_000),
      });

      return Object.freeze({
        success: true,
        exitCode: 0,
        stdout: String(result?.stdout ?? ''),
        stderr: String(result?.stderr ?? ''),
      });
    } catch (error) {
      return Object.freeze({
        success: false,
        exitCode: Number.isInteger(error?.code) ? error.code : 1,
        stdout: String(error?.stdout ?? ''),
        stderr: String(error?.stderr ?? error?.message ?? ''),
      });
    }
  }

  return Object.freeze({
    inspectWpCli,
    inspectComposer,
    resolveTargetContext,
    runWpCli,
    runComposer,
  });
}

export const phpCliToolInternals = Object.freeze({
  DEFAULT_WP_CLI_PATHS,
  DEFAULT_COMPOSER_PATHS,
  RUNUSER_PATH,
  PASSWD_PATH,
  APP_USER_PATTERN,
  SITE_CURRENT_PATTERN,
  WP_CLI_ALLOWED_COMMANDS,
  COMPOSER_ALLOWED_COMMANDS,
  parsePasswd,
  toolEnvironment,
  validateCommandArgs,
});
