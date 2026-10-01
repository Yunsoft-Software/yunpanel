import assert from 'node:assert/strict';
import test from 'node:test';
import { nftablesTemplatePolicy } from '@yunpanel/config-templates';
import {
  createNftablesManager,
  NftablesManagerError,
  inspectSshListeners,
  verifySshListenerContract,
  nftablesManagerInternals,
} from '../src/index.js';

test('PROD-01 (AC-1): resolves default SSH port from standardPorts.ssh when nftablesTemplatePolicy.defaultSshPort is undefined', () => {
  assert.equal(nftablesTemplatePolicy.defaultSshPort, undefined);
  assert.equal(nftablesTemplatePolicy.standardPorts.ssh, 22);

  const manager = createNftablesManager();
  assert.equal(manager.defaultSshPort, 22);
  assert.deepEqual(manager.defaultSshPorts, [22]);
  assert.equal(nftablesManagerInternals.RESOLVED_DEFAULT_SSH_PORT, 22);
});

test('PROD-01 (AC-1): createNftablesManager accepts defaultSshPort, defaultSshPorts, sshPort, sshPorts, and standardPorts aliases', () => {
  const m1 = createNftablesManager({ defaultSshPort: 2201 });
  assert.equal(m1.defaultSshPort, 2201);
  assert.deepEqual(m1.defaultSshPorts, [2201]);

  const m2 = createNftablesManager({ defaultSshPorts: [2202, 2203] });
  assert.equal(m2.defaultSshPort, 2202);
  assert.deepEqual(m2.defaultSshPorts, [2202, 2203]);

  const m3 = createNftablesManager({ sshPort: 2204 });
  assert.equal(m3.defaultSshPort, 2204);
  assert.deepEqual(m3.defaultSshPorts, [2204]);

  const m4 = createNftablesManager({ sshPorts: [2205, 2206] });
  assert.equal(m4.defaultSshPort, 2205);
  assert.deepEqual(m4.defaultSshPorts, [2205, 2206]);

  const m5 = createNftablesManager({ standardPorts: { ssh: 2207 } });
  assert.equal(m5.defaultSshPort, 2207);
  assert.deepEqual(m5.defaultSshPorts, [2207]);
});

test('PROD-01 (AC-1 & AC-2): applyRuleset with default parameters succeeds using standard port 22 without lockout', async () => {
  const appliedFiles = new Map();
  const manager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === 'is-active' || args[0] === 'is-enabled') {
        return { stdout: 'inactive\n' };
      }
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: '' };
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async (target, content) => {
      appliedFiles.set(target, content);
    },
    chmodFn: async () => {},
    renameFn: async (src, dst) => {
      appliedFiles.set(dst, appliedFiles.get(src));
      appliedFiles.delete(src);
    },
    rmFn: async () => {},
  });

  const result = await manager.applyRuleset();
  assert.equal(result.success, true);
  assert.equal(result.allowedSshPort, 22);
  assert.deepEqual(result.allowedSshPorts, [22]);
  assert.equal(result.sshPort, 22);
  assert.deepEqual(result.sshPorts, [22]);

  const persisted = appliedFiles.get('/etc/nftables.conf');
  assert.ok(persisted);
  assert.match(persisted, /table inet yunpanel/);
  assert.match(persisted, /tcp dport \{[^\}]*22[^\}]*\} accept/);
});

test('PROD-01 (AC-2): applyRuleset with custom SSH port correctly renders and allows the custom port', async () => {
  const appliedFiles = new Map();
  const manager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === 'is-active' || args[0] === 'is-enabled') {
        return { stdout: 'inactive\n' };
      }
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: '' };
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async (target, content) => {
      appliedFiles.set(target, content);
    },
    chmodFn: async () => {},
    renameFn: async (src, dst) => {
      appliedFiles.set(dst, appliedFiles.get(src));
      appliedFiles.delete(src);
    },
    rmFn: async () => {},
  });

  // Call with sshPort: 2222
  const result = await manager.applyRuleset({ sshPort: 2222 });
  assert.equal(result.success, true);
  assert.equal(result.allowedSshPort, 2222);
  assert.deepEqual(result.allowedSshPorts, [2222]);
  assert.equal(result.sshPort, 2222);
  assert.deepEqual(result.sshPorts, [2222]);

  const persisted = appliedFiles.get('/etc/nftables.conf');
  assert.match(persisted, /tcp dport \{[^\}]*2222[^\}]*\} accept/);
});

test('PROD-01 (AC-2): applyRuleset with multiple SSH ports (array and comma-separated) renders and verifies all ports', async () => {
  const appliedFiles = new Map();
  const manager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === 'is-active' || args[0] === 'is-enabled') {
        return { stdout: 'inactive\n' };
      }
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: '' };
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async (target, content) => {
      appliedFiles.set(target, content);
    },
    chmodFn: async () => {},
    renameFn: async (src, dst) => {
      appliedFiles.set(dst, appliedFiles.get(src));
      appliedFiles.delete(src);
    },
    rmFn: async () => {},
  });

  // 1. Array of ports: [22, 2222]
  const resultArr = await manager.applyRuleset({ sshPorts: [22, 2222] });
  assert.equal(resultArr.success, true);
  assert.deepEqual(resultArr.allowedSshPorts, [22, 2222]);
  assert.deepEqual(resultArr.sshPorts, [22, 2222]);
  const persistedArr = appliedFiles.get('/etc/nftables.conf');
  assert.match(persistedArr, /tcp dport \{[^\}]*22[^\}]*2222[^\}]*\} accept/);

  // 2. Comma-separated string: "22, 2222"
  const resultStr = await manager.applyRuleset({ allowedSshPorts: '22, 2222' });
  assert.equal(resultStr.success, true);
  assert.deepEqual(resultStr.allowedSshPorts, [22, 2222]);
});

test('PROD-01 (AC-2): lockout risk is triggered if candidate ruleset omits any of the required multiple ports', async () => {
  const manager = createNftablesManager();
  const candidateOnly22 = `
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport 22 accept
  }
}
`;

  // Candidate allows 22, but port 2222 is required
  await assert.rejects(
    () => manager.validateRulesetCandidate(candidateOnly22, { sshPorts: [22, 2222] }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'ssh_lockout_risk');
      assert.match(err.message, /2222/);
      return true;
    },
  );
});

test('PROD-01 (AC-3): fail-closed behavior on empty, null, or invalid port inputs', async () => {
  const manager = createNftablesManager();
  const validCandidate = `
table inet filter {
  chain input {
    tcp dport 22 accept
  }
}
`;

  // Null input
  await assert.rejects(
    () => manager.validateRulesetCandidate(validCandidate, { sshPort: null }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'invalid_ssh_port');
      return true;
    },
  );

  // Empty string input
  await assert.rejects(
    () => manager.validateRulesetCandidate(validCandidate, { sshPort: '' }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'invalid_ssh_port');
      return true;
    },
  );

  // Empty array input
  await assert.rejects(
    () => manager.validateRulesetCandidate(validCandidate, { sshPorts: [] }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'invalid_ssh_port');
      return true;
    },
  );

  // Out of range port (< 1)
  await assert.rejects(
    () => manager.validateRulesetCandidate(validCandidate, { sshPort: 0 }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'invalid_ssh_port');
      return true;
    },
  );

  // Out of range port (> 65535)
  await assert.rejects(
    () => manager.validateRulesetCandidate(validCandidate, { sshPort: 70000 }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'invalid_ssh_port');
      return true;
    },
  );

  // Non-numeric string
  await assert.rejects(
    () => manager.validateRulesetCandidate(validCandidate, { sshPort: 'not-a-port' }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'invalid_ssh_port');
      return true;
    },
  );

  // Empty candidate ruleset
  await assert.rejects(
    () => manager.validateRulesetCandidate('   '),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'invalid_candidate');
      return true;
    },
  );
});

test('PROD-01 (AC-4): inspectPortCoverageInRuleset recognizes dual-stack, IPv4-specific, and IPv6-specific rules', () => {
  // 1. Dual-stack inet table
  const inetRuleset = `
table inet yunpanel {
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport { 22, 80 } accept
  }
}
`;
  const covInet = nftablesManagerInternals.inspectPortCoverageInRuleset(inetRuleset, 22);
  assert.equal(covInet.allowed, true);
  assert.equal(covInet.dualStack, true);
  assert.equal(covInet.hasIpv4, true);
  assert.equal(covInet.hasIpv6, true);

  // 2. Separate IPv4 and IPv6 rules
  const separateRuleset = `
table inet filter {
  chain input {
    ip protocol tcp tcp dport 22 accept
    ip6 nexthdr tcp tcp dport 22 accept
  }
}
`;
  const covSep = nftablesManagerInternals.inspectPortCoverageInRuleset(separateRuleset, 22);
  assert.equal(covSep.allowed, true);
  assert.equal(covSep.dualStack, true);
  assert.equal(covSep.hasIpv4, true);
  assert.equal(covSep.hasIpv6, true);

  // 3. IPv4-only rule
  const ipv4OnlyRuleset = `
table inet filter {
  chain input {
    ip protocol tcp tcp dport 22 accept
  }
}
`;
  const covIpv4 = nftablesManagerInternals.inspectPortCoverageInRuleset(ipv4OnlyRuleset, 22);
  assert.equal(covIpv4.allowed, true);
  assert.equal(covIpv4.dualStack, false);
  assert.equal(covIpv4.hasIpv4, true);
  assert.equal(covIpv4.hasIpv6, false);

  // 4. Port range
  const rangeRuleset = `
table inet filter {
  chain input {
    tcp dport 20-25 accept
  }
}
`;
  const covRange = nftablesManagerInternals.inspectPortCoverageInRuleset(rangeRuleset, 22);
  assert.equal(covRange.allowed, true);
  assert.equal(covRange.dualStack, true);
});

test('PROD-01 (AC-4): inspectSshListeners correctly parses live ss output and sshd_config', async () => {
  const mockSsOutput = `LISTEN 0 128 0.0.0.0:22 0.0.0.0:*
LISTEN 0 128 [::]:22 [::]:*
LISTEN 0 128 0.0.0.0:2222 0.0.0.0:*
LISTEN 0 128 [::]:2222 [::]:*
`;

  const listenersInfo = await inspectSshListeners({
    execFn: async () => ({ stdout: mockSsOutput }),
    readFileFn: async () => 'Port 22\nPort 2222\n',
  });

  assert.equal(listenersInfo.satisfied, true);
  assert.deepEqual(listenersInfo.ports, [22, 2222]);
  assert.equal(listenersInfo.hasIpv4, true);
  assert.equal(listenersInfo.hasIpv6, true);
  assert.equal(listenersInfo.dualStack, true);
  assert.equal(listenersInfo.listeners.length, 4);
});

test('PROD-01 (AC-4): verifySshListenerContract enforces both IPv4 and IPv6 listener rules and detects lockouts', async () => {
  const activeListeners = {
    satisfied: true,
    listeners: [
      { address: '0.0.0.0', port: 22, family: 'IPv4' },
      { address: '::', port: 22, family: 'IPv6' },
    ],
    ports: [22],
    hasIpv4: true,
    hasIpv6: true,
    dualStack: true,
  };

  // Valid dual-stack candidate passes verification
  const validCandidate = `
table inet filter {
  chain input {
    tcp dport 22 accept
  }
}
`;
  const contract = await verifySshListenerContract(validCandidate, { listeners: activeListeners });
  assert.equal(contract.verified, true);
  assert.deepEqual(contract.targetPorts, [22]);

  // Candidate with IPv4-only rule fails because IPv6 listener is active (preventing IPv6 lockout)
  const ipv4OnlyCandidate = `
table inet filter {
  chain input {
    ip protocol tcp tcp dport 22 accept
  }
}
`;
  await assert.rejects(
    () => verifySshListenerContract(ipv4OnlyCandidate, { listeners: activeListeners }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'ssh_lockout_risk');
      assert.match(err.message, /IPv6/);
      return true;
    },
  );
});

test('PROD-01 (AC-4): manager.inspectNftables includes sshListeners and resolved default ports', async () => {
  const manager = createNftablesManager({
    execFn: async (file, args) => {
      if (args[0] === '--version') return { stdout: 'nftables v1.0.9\n' };
      if (args[0] === 'is-active' || args[0] === 'is-enabled') return { stdout: 'active\n' };
      if (args[0] === 'list' && args[1] === 'ruleset') return { stdout: 'table inet yunpanel {}\n' };
      if (args[0] === '-H' && args[1] === '-ltn') {
        return { stdout: 'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 128 [::]:22 [::]:*\n' };
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    readFileFn: async () => 'Port 22\n',
  });

  const inspected = await manager.inspectNftables();
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.defaultSshPort, 22);
  assert.deepEqual(inspected.defaultSshPorts, [22]);
  assert.ok(inspected.sshListeners);
  assert.equal(inspected.sshListeners.satisfied, true);
  assert.deepEqual(inspected.sshListeners.ports, [22]);
  assert.equal(inspected.sshListeners.hasIpv4, true);
  assert.equal(inspected.sshListeners.hasIpv6, true);
});
