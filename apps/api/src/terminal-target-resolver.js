const SHELL_PATH = '/bin/bash';
const RUNUSER_PATH = '/usr/sbin/runuser';
const APP_USER_PATTERN = /^yunapp-[a-f0-9]{12}$/;
const APPLICATION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RELEASE_ID = APPLICATION_ID;
const SITE_CURRENT_PATTERN = new RegExp(`^(/(?:var/www|var/lib)/yunpanel/apps/(${APPLICATION_ID}))/current$`, 'i');

function defaultError(code, message, status = 400) {
  const error = new Error(message);
  error.name = 'TerminalTargetError';
  error.code = code;
  error.status = status;
  return error;
}

function terminalEnvironment({ user, home }) {
  return Object.freeze({
    COLORTERM: 'truecolor',
    HOME: home,
    LANG: 'C.UTF-8',
    LOGNAME: user,
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SHELL: SHELL_PATH,
    TERM: 'xterm-256color',
    USER: user,
  });
}

function parseManagedAccount(passwdText, user, errorFactory = defaultError) {
  if (typeof passwdText !== 'string' || !APP_USER_PATTERN.test(user)) {
    throw errorFactory('site_terminal_account_invalid', 'Website terminal account is invalid', 409);
  }
  const matching = passwdText.split('\n').filter((line) => line.startsWith(`${user}:`));
  if (matching.length !== 1) {
    throw errorFactory('site_terminal_account_missing', 'Website terminal account is unavailable', 409);
  }
  const fields = matching[0].split(':');
  const numericId = /^[1-9][0-9]{0,9}$/;
  const uid = numericId.test(fields[2] ?? '') ? Number(fields[2]) : null;
  const gid = numericId.test(fields[3] ?? '') ? Number(fields[3]) : null;
  const home = fields[5];
  if (fields.length !== 7 || !Number.isSafeInteger(uid) || uid < 1 || uid > 2_147_483_647
    || !Number.isSafeInteger(gid) || gid < 1 || gid > 2_147_483_647
    || typeof home !== 'string' || !home.startsWith('/') || /[\u0000-\u001f\u007f]/.test(home)) {
    throw errorFactory('site_terminal_account_invalid', 'Website terminal account is invalid', 409);
  }
  return Object.freeze({ user, home, uid, gid });
}

function validateTerminalTargetShape(target, errorFactory = defaultError) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw errorFactory('terminal_target_invalid', 'Terminal target is invalid');
  }
  if (target.scope === 'server' && target.user === 'root' && target.cwd === '/root') return;
  if (target.scope === 'site' && APP_USER_PATTERN.test(target.user ?? '') && SITE_CURRENT_PATTERN.test(target.cwd ?? '')) return;
  throw errorFactory('terminal_target_invalid', 'Terminal target is invalid');
}

export async function resolveTerminalTarget(target, {
  statFn,
  realpathFn,
  readPasswd,
  errorFactory = defaultError,
} = {}) {
  if (typeof statFn !== 'function' || typeof realpathFn !== 'function' || typeof readPasswd !== 'function'
    || typeof errorFactory !== 'function') {
    throw new TypeError('Terminal target resolver dependencies are invalid');
  }
  validateTerminalTargetShape(target, errorFactory);

  let info;
  try { info = await statFn(target.cwd); }
  catch { throw errorFactory('terminal_directory_unavailable', 'Terminal directory is unavailable', 409); }
  if (!info?.isDirectory?.()) {
    throw errorFactory('terminal_directory_unavailable', 'Terminal directory is unavailable', 409);
  }

  let resolved;
  try { resolved = await realpathFn(target.cwd); }
  catch { throw errorFactory('terminal_directory_unavailable', 'Terminal directory is unavailable', 409); }

  if (target.scope === 'server') {
    if (resolved !== '/root') {
      throw errorFactory('terminal_directory_invalid', 'Server terminal directory is invalid', 409);
    }
    return Object.freeze({
      file: SHELL_PATH,
      args: ['--login'],
      user: 'root',
      uid: 0,
      gid: 0,
      home: '/root',
      cwd: '/root',
      env: terminalEnvironment({ user: 'root', home: '/root' }),
    });
  }

  const match = SITE_CURRENT_PATTERN.exec(target.cwd);
  const releasePattern = new RegExp(`^${match[1]}/releases/${RELEASE_ID}$`, 'i');
  if (!releasePattern.test(resolved)) {
    throw errorFactory('site_terminal_directory_escape', 'Website terminal directory escaped managed storage', 409);
  }
  const account = parseManagedAccount(await readPasswd(), target.user, errorFactory);
  return Object.freeze({
    file: RUNUSER_PATH,
    args: ['-u', account.user, '--', SHELL_PATH, '--noprofile', '--norc', '-i'],
    user: account.user,
    uid: account.uid,
    gid: account.gid,
    home: account.home,
    cwd: target.cwd,
    env: terminalEnvironment(account),
  });
}

export const terminalTargetInternals = Object.freeze({
  shellPath: SHELL_PATH,
  runuserPath: RUNUSER_PATH,
  appUserPattern: APP_USER_PATTERN,
  siteCurrentPattern: SITE_CURRENT_PATTERN,
  terminalEnvironment,
  parseManagedAccount,
  validateTerminalTargetShape,
  defaultError,
});
