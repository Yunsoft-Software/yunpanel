import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import path from 'node:path';
import { createAuthStore } from '../apps/api/src/auth-store.js';

async function readPassword() {
  if (!process.stdin.isTTY) {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 2048) throw new Error('Password input is too long');
    }
    return input.replace(/\r?\n$/, '');
  }
  const hiddenOutput = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input: process.stdin, output: hiddenOutput, terminal: true });
  try {
    process.stderr.write('New password (at least 12 characters): ');
    const password = await reader.question('');
    process.stderr.write('\nConfirm password: ');
    const confirmation = await reader.question('');
    process.stderr.write('\n');
    if (password !== confirmation) throw new Error('Passwords do not match');
    return password;
  } finally { reader.close(); }
}

const [command, username, ...extra] = process.argv.slice(2);
let store;
try {
  if (extra.length || !['setup-token', 'reset-password'].includes(command) || (command === 'setup-token' && username) || (command === 'reset-password' && !username)) {
    throw new Error('Usage: node scripts/auth.mjs setup-token | reset-password <username> (password via hidden prompt or stdin, never argv)');
  }
  const serverStore = process.env.YUNPANEL_SERVER_STORE ?? path.resolve('.data/server-registry.json');
  const filePath = process.env.YUNPANEL_AUTH_DB ?? path.join(path.dirname(serverStore), 'auth', 'auth.sqlite');
  store = createAuthStore({ filePath });
  if (command === 'setup-token') {
    const setup = store.issueSetupToken();
    console.log(`One-time setup token (expires ${new Date(setup.expiresAt).toISOString()}):`);
    console.log(setup.token);
  } else {
    await store.resetPassword(username, await readPassword());
    console.log('Password updated; all sessions for this user have been revoked.');
  }
} catch (error) {
  console.error(error.code ? `${error.code}: ${error.message}` : error.message);
  process.exitCode = 1;
} finally { store?.close(); }
