import { randomBytes } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { rollbackSecretMasterKey, rotateSecretMasterKey } from '../apps/api/src/secret-master-key-rotation.js';

function usage() {
  return 'Usage: node scripts/rotate-secret-master-key.mjs rotate --confirm-offline --backup-dir <dir> --new-key-file <file> [--current-key-file <file> | --current-env-file <file>] | rollback --confirm-offline --backup-dir <dir>';
}

function parseOptions(values) {
  const options = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === '--confirm-offline') {
      if (options.has(name)) throw new Error(`Duplicate option ${name}`);
      options.set(name, true);
      continue;
    }
    if (!['--backup-dir', '--new-key-file', '--current-key-file', '--current-env-file'].includes(name)) throw new Error(`Unknown option ${name}`);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    if (options.has(name)) throw new Error(`Duplicate option ${name}`);
    options.set(name, value);
    index += 1;
  }
  return options;
}

async function readPrivateTextFile(filePath, label) {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error(`${label} must be a private regular file with no group/other permissions`);
  if (metadata.size > 64 * 1024) throw new Error(`${label} is unexpectedly large`);
  return { path: resolved, text: await readFile(resolved, 'utf8') };
}

async function readPrivateKeyFile(filePath) {
  const { text } = await readPrivateTextFile(filePath, 'Key file');
  return text.trim();
}

function unquoteEnvironmentValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function readKeyFromEnvironmentFile(filePath) {
  const { text } = await readPrivateTextFile(filePath, 'Environment file');
  const values = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^YUNPANEL_SECRET_MASTER_KEY\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = unquoteEnvironmentValue(match[1]);
    if (!value || /\s/.test(value)) throw new Error('YUNPANEL_SECRET_MASTER_KEY in the environment file has unsupported whitespace or quoting');
    values.push(value);
  }
  if (values.length !== 1) throw new Error('Environment file must contain exactly one YUNPANEL_SECRET_MASTER_KEY assignment');
  return values[0];
}

async function readOrCreateNextKey(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return { path: resolved, key: await readPrivateKeyFile(resolved), created: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const parent = await lstat(path.dirname(resolved));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
    throw new Error('New key file parent directory must already exist and have no group/other permissions');
  }
  const key = randomBytes(32).toString('hex');
  const handle = await open(resolved, 'wx', 0o600);
  try {
    await handle.writeFile(`${key}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  return { path: resolved, key, created: true };
}

function storePaths() {
  const serverStore = process.env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json');
  return {
    authDbPath: path.resolve(process.env.YUNPANEL_AUTH_DB ?? path.join(path.dirname(serverStore), 'auth', 'auth.sqlite')),
    applicationEnvironmentStorePath: path.resolve(process.env.YUNPANEL_APPLICATION_ENVIRONMENT_STORE ?? '.data/application-environment-registry.json'),
    dnsProviderCredentialStorePath: path.resolve(process.env.YUNPANEL_DNS_CREDENTIAL_STORE ?? '.data/dns-provider-credential-registry.json'),
  };
}

const [command, ...args] = process.argv.slice(2);
try {
  if (!['rotate', 'rollback'].includes(command)) throw new Error(usage());
  const options = parseOptions(args);
  if (options.get('--confirm-offline') !== true) {
    throw new Error('Refusing to continue without --confirm-offline. Stop yunpanel-api.service before rotating or rolling back.');
  }
  const backupDirectory = options.get('--backup-dir');
  if (!backupDirectory) throw new Error(usage());
  const paths = storePaths();

  if (command === 'rollback') {
    if (options.has('--new-key-file') || options.has('--current-key-file') || options.has('--current-env-file')) throw new Error(usage());
    const result = await rollbackSecretMasterKey({ ...paths, backupDirectory });
    console.log(`Master-key data rollback complete. Backup: ${path.resolve(backupDirectory)}`);
    console.log(`Restored ${result.counts?.mfa ?? 0} active MFA, ${result.counts?.mfaPending ?? 0} pending MFA, ${result.counts?.applicationSecrets ?? 0} application secret and ${result.counts?.dnsProviderSecrets ?? 0} DNS provider secret record(s).`);
    console.log('Restore the PREVIOUS YUNPANEL_SECRET_MASTER_KEY in the API environment before starting yunpanel-api.service.');
  } else {
    const newKeyFile = options.get('--new-key-file');
    if (!newKeyFile) throw new Error(usage());
    if (options.has('--current-key-file') && options.has('--current-env-file')) throw new Error('Choose only one of --current-key-file or --current-env-file');
    const currentMasterKey = options.get('--current-key-file')
      ? await readPrivateKeyFile(options.get('--current-key-file'))
      : options.get('--current-env-file')
        ? await readKeyFromEnvironmentFile(options.get('--current-env-file'))
        : process.env.YUNPANEL_SECRET_MASTER_KEY;
    if (!currentMasterKey) throw new Error('Current master key is required via YUNPANEL_SECRET_MASTER_KEY, --current-key-file or --current-env-file');
    const next = await readOrCreateNextKey(newKeyFile);
    const result = await rotateSecretMasterKey({
      ...paths,
      currentMasterKey,
      nextMasterKey: next.key,
      backupDirectory,
    });
    console.log(`Master-key data rotation complete. Backup: ${path.resolve(backupDirectory)}`);
    console.log(`Rotated ${result.counts.mfa} active MFA, ${result.counts.mfaPending} pending MFA, ${result.counts.applicationSecrets} application secret and ${result.counts.dnsProviderSecrets} DNS provider secret record(s).`);
    console.log(`Next key ${next.created ? 'created' : 'read'} at ${next.path}; its contents were not printed.`);
    console.log('Replace YUNPANEL_SECRET_MASTER_KEY in /etc/yunpanel/control-plane/api.env with that key, then start yunpanel-api.service and validate MFA + application secrets.');
    console.log(`If validation fails: stop the API, restore the previous key configuration, then run rollback with --backup-dir ${path.resolve(backupDirectory)}.`);
  }
} catch (error) {
  console.error(error.code ? `${error.code}: ${error.message}` : error.message);
  process.exitCode = 1;
}
