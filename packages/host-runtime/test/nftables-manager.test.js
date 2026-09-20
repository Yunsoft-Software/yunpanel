import assert from 'node:assert/strict';
import test from 'node:test';
import { createNftablesManager, NftablesManagerError } from '../src/index.js';

test('inspectNftables returns version, service status and conflict metadata', async () => {
  const manager = createNftablesManager({
    execFn: async (file, args) => {
      if (args[0] === '--version') {
        return { stdout: 'nftables v1.0.9 (Old Doc Halsey)\n' };
      }
      if (args[0] === 'is-active' && args[1] === 'nftables') {
        return { stdout: 'active\n' };
      }
      if (args[0] === 'is-enabled' && args[1] === 'nftables') {
        return { stdout: 'enabled\n' };
      }
      if (args[0] === 'is-active' && args[1] === 'ufw') {
        return { stdout: 'inactive\n' };
      }
      if (args[0] === 'is-enabled' && args[1] === 'ufw') {
        return { stdout: 'disabled\n' };
      }
      if (args[0] === 'is-active' && args[1] === 'firewalld') {
        throw new Error('inactive');
      }
      if (args[0] === 'is-enabled' && args[1] === 'firewalld') {
        throw new Error('disabled');
      }
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return {
          stdout: `table inet yunpanel {
  chain input {
    type filter hook input priority 0;
  }
}
`,
        };
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });

  const inspected = await manager.inspectNftables();
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.version, '1.0.9');
  assert.equal(inspected.serviceStatus.active, true);
  assert.equal(inspected.serviceStatus.enabled, true);
  assert.equal(inspected.conflictingFirewalls.conflictDetected, false);
  assert.equal(inspected.ruleset.loaded, true);
  assert.equal(inspected.ruleset.hasYunpanelTable, true);
});

test('inspectNftables detects active UFW conflict', async () => {
  const manager = createNftablesManager({
    execFn: async (file, args) => {
      if (args[0] === '--version') {
        return { stdout: 'nftables v1.0.9\n' };
      }
      if (args[0] === 'is-active' || args[0] === 'is-enabled') {
        return { stdout: 'active\n' };
      }
      if (file === '/usr/sbin/ufw' && args[0] === 'status') {
        return { stdout: 'Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing)\n' };
      }
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: '' };
      }
      return { stdout: '' };
    },
    statFn: async () => ({ isFile: () => true }),
  });

  const inspected = await manager.inspectNftables();
  assert.equal(inspected.conflictingFirewalls.ufw.statusActive, true);
  assert.equal(inspected.conflictingFirewalls.conflictDetected, true);
});

test('validateRulesetCandidate rejects candidates that do not allow SSH port (lockout prevention)', async () => {
  const manager = createNftablesManager();

  const unsafeRuleset = `
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport 80 accept
    tcp dport 443 accept
  }
}
`;

  await assert.rejects(
    () => manager.validateRulesetCandidate(unsafeRuleset, { allowedSshPort: 22 }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'ssh_lockout_risk');
      return true;
    },
  );
});

test('validateRulesetCandidate rejects candidates with invalid syntax via nft -c', async () => {
  const manager = createNftablesManager({
    execFn: async (file, args) => {
      if (args[0] === '-c' && args[1] === '-f') {
        const err = new Error('Syntax error');
        err.stderr = 'Error: syntax error, unexpected newline\n';
        throw err;
      }
      return { stdout: '' };
    },
    writeFileFn: async () => {},
    rmFn: async () => {},
  });

  const candidate = `
table inet filter {
  chain input {
    tcp dport 22 accept
    invalid syntax here
  }
}
`;

  await assert.rejects(
    () => manager.validateRulesetCandidate(candidate, { allowedSshPort: 22 }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'candidate_syntax_error');
      assert.match(err.message, /syntax error/);
      return true;
    },
  );
});

test('applyRuleset blocks when conflicting firewall is active unless forceConflictOverride is true', async () => {
  const manager = createNftablesManager({
    execFn: async (file, args) => {
      if (file === '/usr/sbin/ufw' && args[0] === 'status') {
        return { stdout: 'Status: active\n' };
      }
      if (args[0] === 'is-active' || args[0] === 'is-enabled') {
        return { stdout: 'active\n' };
      }
      return { stdout: '' };
    },
    statFn: async () => ({ isFile: () => true }),
  });

  await assert.rejects(
    () => manager.applyRuleset({ allowedSshPort: 22 }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'conflicting_firewall_detected');
      return true;
    },
  );
});

test('applyRuleset successfully applies ruleset, snapshots backup, and persists config', async () => {
  const calls = [];
  const files = new Map();

  const manager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      calls.push(['exec', file, ...args]);
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: 'table inet old { chain input { type filter hook input priority 0; } }\n' };
      }
      if (args[0] === 'is-active' || args[0] === 'is-enabled') {
        return { stdout: 'inactive\n' };
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async (target, content) => {
      files.set(target, content);
      calls.push(['writeFile', target]);
    },
    chmodFn: async (target, mode) => {
      calls.push(['chmod', target, mode]);
    },
    renameFn: async (src, dst) => {
      files.set(dst, files.get(src));
      files.delete(src);
      calls.push(['rename', src, dst]);
    },
    rmFn: async (target) => {
      files.delete(target);
      calls.push(['rm', target]);
    },
  });

  const result = await manager.applyRuleset({
    allowedSshPort: 22,
    renderOptions: {
      allowWeb: true,
      allowDns: true,
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.persisted, true);
  assert.equal(result.serviceEnabled, true);
  assert.equal(result.allowedSshPort, 22);
  assert.ok(result.appliedRulesetSha256);
  assert.ok(result.backupRulesetSha256);

  // Verified persisted file
  assert.equal(files.has('/etc/nftables.conf'), true);
  assert.match(files.get('/etc/nftables.conf'), /table inet yunpanel/);
  assert.match(files.get('/etc/nftables.conf'), /tcp dport \{ 22, 25, 53, 80, 143, 443, 465, 587, 993 \} accept/);
});

test('rollbackRuleset restores previous ruleset from text', async () => {
  const calls = [];
  const files = new Map();

  const manager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      calls.push(['exec', file, ...args]);
      return { stdout: '' };
    },
    writeFileFn: async (target, content) => {
      files.set(target, content);
    },
    chmodFn: async () => {},
    renameFn: async (src, dst) => {
      files.set(dst, files.get(src));
    },
    rmFn: async () => {},
  });

  const previousRuleset = `table inet backup {
  chain input {
    type filter hook input priority 0;
    tcp dport 22 accept
  }
}
`;

  const result = await manager.rollbackRuleset(previousRuleset);
  assert.equal(result.success, true);
  assert.equal(result.rolledBack, true);
  assert.ok(result.rulesetSha256);
  assert.equal(calls.some(([op, , ...args]) => op === 'exec' && args[0] === '-f'), true);
});
