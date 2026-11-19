import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { envFile } from '../live-audit/runtime.js';

const TARGET_HOST = '157.180.11.28';
const PINNED_HELPER_REL = '.local/reinstall-20261011/host.py';
const SAFE_SSH_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function checkPrivateFile(filePath, ownerOnly = false) {
  const info = fs.lstatSync(filePath);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Private host-transport file must be a regular non-symlink file');
  if (typeof process.getuid === 'function') assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & (ownerOnly ? 0o077 : 0o022), 0, 'Private host-transport file has unsafe permissions');
  return info;
}

function resolveVerifiedHelper() {
  const configured = (process.env.YUNPANEL_AUDIT_HOST_HELPER ?? '').trim();
  assert.ok(configured, 'Configure YUNPANEL_TEST_SERVER_SSH_ALIAS or pinned YUNPANEL_AUDIT_HOST_HELPER');
  const configuredPath = path.resolve(configured);
  const pinnedPath = path.resolve(PINNED_HELPER_REL);
  checkPrivateFile(configuredPath, false);
  checkPrivateFile(pinnedPath, false);
  const actualPath = fs.realpathSync(configuredPath);
  const expectedPath = fs.realpathSync(pinnedPath);
  assert.equal(actualPath, expectedPath, 'Only the actual pinned .28 host helper is permitted');
  const knownHosts = path.join(path.dirname(expectedPath), 'verified-known-hosts');
  assert.ok(checkPrivateFile(knownHosts, true).size > 0, 'Pinned verified-known-hosts file is missing or empty');
  const sha256 = createHash('sha256').update(fs.readFileSync(expectedPath)).digest('hex');
  const expectedSha = (process.env.YUNPANEL_AUDIT_HOST_HELPER_SHA256 ?? '').trim();
  if (expectedSha) {
    assert.ok(SHA256_HEX.test(expectedSha) && sha256 === expectedSha, 'Pinned host helper SHA-256 mismatch');
  }
  return { path: expectedPath, sha256 };
}

// Narrow fail-closed .28 read-only transport shared by api-01 and eml-09.
export function createTestHostProbe() {
  const config = envFile('.local/test-server.env');
  const host = (config.YUNPANEL_TEST_SERVER_HOST ?? '').trim();
  assert.ok(host === TARGET_HOST && !host.endsWith('.44'), 'Only the authorized .28 test host is permitted');

  const alias = (config.YUNPANEL_TEST_SERVER_SSH_ALIAS ?? '').trim();
  let mode;
  let runCommand;

  if (alias) {
    assert.match(alias, SAFE_SSH_ALIAS, 'Invalid test-host SSH alias');
    const resolved = execFileSync('ssh', ['-G', alias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    const resolvedHost = resolved.match(/^hostname (.+)$/m)?.[1]?.trim() ?? '';
    const strict = resolved.match(/^stricthostkeychecking (.+)$/m)?.[1]?.trim().toLowerCase() ?? '';
    assert.ok(resolvedHost === TARGET_HOST && !resolvedHost.endsWith('.44'), 'SSH alias must resolve strictly to .28');
    assert.ok(strict !== 'no' && strict !== 'off', 'SSH alias disables StrictHostKeyChecking');
    mode = 'ssh-alias';
    runCommand = (remoteCommand, timeoutMs = 30_000) => {
      try {
        return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', alias, remoteCommand], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs,
        });
      } catch { throw new Error('Read-only test-host inspection failed'); }
    };
  } else {
    const helper = resolveVerifiedHelper();
    mode = 'pinned-host-helper';
    runCommand = (remoteCommand, timeoutMs = 30_000) => {
      const current = resolveVerifiedHelper();
      assert.equal(current.sha256, helper.sha256, 'Pinned host helper changed during test run');
      try {
        return execFileSync('python3', [current.path, remoteCommand], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs,
        });
      } catch { throw new Error('Read-only test-host inspection failed'); }
    };
  }

  let targetVerified = false;
  const execPythonJson = (code, args = [], { timeoutMs = 30_000 } = {}) => {
    const command = `python3 -c ${quote(code)}${args.length ? ' ' + args.map(quote).join(' ') : ''}`;
    return JSON.parse(runCommand(command, timeoutMs));
  };

  const verifyTarget = () => {
    const identity = execPythonJson(`import json,subprocess
addrs=[a.get('local','') for i in json.loads(subprocess.check_output(['ip','-j','-4','addr'],text=True)) for a in i.get('addr_info',[])]
print(json.dumps({'allowedPresent':'${TARGET_HOST}' in addrs,'forbiddenPresent':any(a.endswith('.44') for a in addrs)}))`, [], { timeoutMs: 20_000 });
    assert.ok(identity?.allowedPresent === true && identity?.forbiddenPresent === false, 'Connected host failed real .28 identity verification');
    targetVerified = true;
    return Object.freeze({ mode, targetHost: TARGET_HOST, verified: true });
  };

  const runPythonJson = (code, args = [], options = {}) => {
    assert.equal(targetVerified, true, 'verifyTarget() must confirm real .28 identity before host probes');
    return execPythonJson(code, args, options);
  };

  const runArgvStdout = (argv, { timeoutMs = 25_000 } = {}) => {
    assert.ok(Array.isArray(argv) && argv.length > 0 && argv.every((part) => typeof part === 'string'), 'Host argv must be a non-empty string array');
    const result = runPythonJson(`import json,subprocess,sys
r=subprocess.run(json.loads(sys.argv[1]),capture_output=True,text=True,timeout=20)
print(json.dumps({'rc':r.returncode,'stdout':(r.stdout or '').strip()}))`, [JSON.stringify(argv)], { timeoutMs });
    if (result?.rc !== 0) {
      throw new Error(`Read-only host probe command failed (exit ${result?.rc ?? 'unknown'})`);
    }
    return String(result.stdout ?? '');
  };

  return Object.freeze({ mode, targetHost: TARGET_HOST, verifyTarget, runPythonJson, runArgvStdout });
}
