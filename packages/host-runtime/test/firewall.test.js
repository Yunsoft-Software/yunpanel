import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNftablesManager,
  NftablesManagerError,
  MANAGED_FIREWALL_TABLE,
  MANAGED_FIREWALL_FAMILY,
  DOCKER_BRIDGE_INTERFACES,
  CROWDSEC_SET_NAMES,
  detectTableNames,
  extractSetElements,
  preserveCrowdsecSetElements,
  sanitizeManagedRuleset,
  verifyDockerCoexistence,
  verifyCrowdsecCoexistence,
  inspectDockerFirewall,
  inspectCrowdsecFirewall,
  migrateRulesetToManagedScope,
  nftablesManagerInternals,
} from '../src/index.js';

const MOCK_LIVE_DOCKER_RULESET = `
table ip filter {
  chain INPUT {
    type filter hook input priority filter; policy accept;
  }
  chain FORWARD {
    type filter hook forward priority filter; policy drop;
    counter jump DOCKER-USER
    counter jump DOCKER-ISOLATION-STAGE-1
    oifname "docker0" ct state related,established counter accept
    oifname "docker0" counter jump DOCKER
    iifname "docker0" oifname != "docker0" counter accept
    iifname "docker0" oifname "docker0" counter accept
  }
  chain DOCKER {
  }
  chain DOCKER-USER {
    counter return
  }
}
table ip nat {
  chain PREROUTING {
    type nat hook prerouting priority dstnat; policy accept;
    fib daddr type local counter jump DOCKER
  }
  chain POSTROUTING {
    type nat hook postrouting priority srcnat; policy accept;
    oifname != "docker0" ip saddr 172.17.0.0/16 counter masquerade
  }
}
table inet yunpanel {
  set crowdsec-blacklists {
    type ipv4_addr
    flags interval
    elements = { 198.51.100.10, 203.0.113.50 }
  }
  set crowdsec6-blacklists {
    type ipv6_addr
    flags interval
    elements = { 2001:db8::1 }
  }
  chain input {
    type filter hook input priority 0; policy drop;
    ip saddr @crowdsec-blacklists drop
    ip6 saddr @crowdsec6-blacklists drop
    ct state established,related accept
    iif "lo" accept
    tcp dport { 22, 80, 443 } accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
    iifname "docker0" accept
    oifname "docker0" accept
    iifname "br-*" accept
    oifname "br-*" accept
  }
}
`;

test('AC-1: sanitizeManagedRuleset removes global flush ruleset and injects scoped table reset', () => {
  const legacyRuleset = `#!/usr/sbin/nft -f

flush ruleset

table inet yunpanel {
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport 22 accept
  }
}
`;

  const sanitized = sanitizeManagedRuleset(legacyRuleset);
  assert.equal(sanitized.includes('flush ruleset'), false);
  assert.match(sanitized, /table inet yunpanel\ndelete table inet yunpanel\ntable inet yunpanel \{/);
});

test('AC-1: validateRulesetCandidate strictly prohibits global flush ruleset', async () => {
  const manager = createNftablesManager();
  const rulesetWithFlush = `flush ruleset
table inet yunpanel {
  set crowdsec-blacklists { type ipv4_addr; flags interval; }
  set crowdsec6-blacklists { type ipv6_addr; flags interval; }
  chain input {
    type filter hook input priority 0; policy drop;
    ip saddr @crowdsec-blacklists drop
    ip6 saddr @crowdsec6-blacklists drop
    tcp dport 22 accept
  }
}
`;

  await assert.rejects(
    () => manager.validateRulesetCandidate(rulesetWithFlush, { allowedSshPort: 22 }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'global_flush_prohibited');
      return true;
    },
  );
});

test('AC-1: applyRuleset strips flush ruleset from template output and targets only table inet yunpanel', async () => {
  const writtenFiles = new Map();
  const execCommands = [];

  const manager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      execCommands.push([file, ...args]);
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: '' };
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
      writtenFiles.set(target, content);
    },
    chmodFn: async () => {},
    renameFn: async (src, dst) => {
      writtenFiles.set(dst, writtenFiles.get(src));
      writtenFiles.delete(src);
    },
    rmFn: async () => {},
  });

  const result = await manager.applyRuleset({
    allowedSshPort: 22,
    renderOptions: { allowWeb: true },
  });

  assert.equal(result.success, true);
  assert.equal(result.managedBoundary.table, MANAGED_FIREWALL_TABLE);
  assert.equal(result.managedBoundary.family, MANAGED_FIREWALL_FAMILY);

  const persisted = writtenFiles.get('/etc/nftables.conf');
  assert.ok(persisted);
  assert.equal(persisted.includes('flush ruleset'), false);
  assert.match(persisted, /table inet yunpanel\ndelete table inet yunpanel/);
  assert.match(persisted, /table inet yunpanel \{/);

  // Assert no execCommand called flush ruleset
  const hadFlushExec = execCommands.some(([, ...args]) => args.join(' ').includes('flush ruleset'));
  assert.equal(hadFlushExec, false);
});

test('AC-2: inspectDockerFirewall detects Docker iptables, NAT chains, and bridge interfaces', async () => {
  const inspected = await inspectDockerFirewall({
    execFn: async () => ({ stdout: MOCK_LIVE_DOCKER_RULESET }),
  });

  assert.equal(inspected.dockerDetected, true);
  assert.equal(inspected.hasDockerIptables, true);
  assert.equal(inspected.hasDockerNat, true);
  assert.equal(inspected.hasDockerBridgeForwarding, true);
  assert.equal(inspected.tablesProtected, true);
  assert.deepEqual(inspected.bridgeInterfaces, DOCKER_BRIDGE_INTERFACES);
});

test('AC-2: verifyDockerCoexistence prevents deletion of Docker tables and requires bridge forwarding', () => {
  // 1. Prohibits global flush
  assert.throws(
    () => verifyDockerCoexistence('flush ruleset\ntable inet yunpanel {}'),
    (err) => err instanceof NftablesManagerError && err.code === 'global_flush_prohibited',
  );

  // 2. Prohibits deleting Docker tables
  assert.throws(
    () => verifyDockerCoexistence('table inet yunpanel {}\ndelete table ip filter\n'),
    (err) => err instanceof NftablesManagerError && err.code === 'docker_table_interference',
  );
  assert.throws(
    () => verifyDockerCoexistence('table inet yunpanel {}\ndelete table ip nat\n'),
    (err) => err instanceof NftablesManagerError && err.code === 'docker_table_interference',
  );

  // 3. Rejects forward chain that omits docker0 / br-* forwarding
  const brokenForward = `
table inet yunpanel {
  chain forward {
    type filter hook forward priority 0; policy drop;
    ct state established,related accept
  }
}
`;
  assert.throws(
    () => verifyDockerCoexistence(brokenForward),
    (err) => err instanceof NftablesManagerError && err.code === 'docker_interface_isolation_risk',
  );

  // 4. Passes when Docker bridge interfaces are allowed
  const validForward = `
table inet yunpanel {
  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "docker0" accept
    oifname "docker0" accept
    iifname "br-*" accept
    oifname "br-*" accept
  }
}
`;
  const verified = verifyDockerCoexistence(validForward);
  assert.equal(verified.dockerProtected, true);
  assert.equal(verified.bridgeInterfacesAllowed, true);
});

test('AC-3: inspectCrowdsecFirewall detects bouncer status and extracts banned IPs', async () => {
  const inspected = await inspectCrowdsecFirewall({
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_DOCKER_RULESET };
      }
      if (args[0] === 'is-active' && args[1] === 'crowdsec-firewall-bouncer') {
        return { stdout: 'active\n' };
      }
      return { stdout: '' };
    },
  });

  assert.equal(inspected.bouncerActive, true);
  assert.equal(inspected.hasCrowdsecSets, true);
  assert.equal(inspected.earlyDropActive, true);
  assert.equal(inspected.bannedIpsCount, 3);
  assert.deepEqual(inspected.ipv4Bans, ['198.51.100.10', '203.0.113.50']);
  assert.deepEqual(inspected.ipv6Bans, ['2001:db8::1']);
});

test('AC-3: extractSetElements and preserveCrowdsecSetElements preserve active blacklist bans during rule reload', () => {
  const liveRuleset = `
table inet yunpanel {
  set crowdsec-blacklists {
    type ipv4_addr
    flags interval
    elements = { 10.0.0.1, 10.0.0.2 }
  }
  set crowdsec6-blacklists {
    type ipv6_addr
    flags interval
    elements = { 2001:db8::99 }
  }
}
`;

  const newCandidate = `
table inet yunpanel {
  set crowdsec-blacklists {
    type ipv4_addr
    flags interval
  }
  set crowdsec6-blacklists {
    type ipv6_addr
    flags interval
  }
  chain input {
    type filter hook input priority 0; policy drop;
    ip saddr @crowdsec-blacklists drop
    ip6 saddr @crowdsec6-blacklists drop
    tcp dport 22 accept
  }
}
`;

  const preserved = preserveCrowdsecSetElements(newCandidate, liveRuleset);
  assert.match(preserved, /elements\s*=\s*\{\s*10\.0\.0\.1,\s*10\.0\.0\.2\s*\}/);
  assert.match(preserved, /elements\s*=\s*\{\s*2001:db8::99\s*\}/);
});

test('AC-3: verifyCrowdsecCoexistence rejects candidates deleting CrowdSec tables or omitting blacklist drop rules', () => {
  // Prohibit deleting crowdsec table
  assert.throws(
    () => verifyCrowdsecCoexistence('table inet yunpanel {}\ndelete table inet crowdsec\n'),
    (err) => err instanceof NftablesManagerError && err.code === 'crowdsec_table_interference',
  );

  // Missing sets or drop rules
  const candidateWithoutDrop = `
table inet yunpanel {
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport 22 accept
  }
}
`;
  assert.throws(
    () => verifyCrowdsecCoexistence(candidateWithoutDrop),
    (err) => err instanceof NftablesManagerError && err.code === 'crowdsec_integration_missing',
  );
});

test('AC-3: applyRuleset automatically retains active CrowdSec ban elements from live ruleset', async () => {
  const writtenFiles = new Map();

  const manager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_DOCKER_RULESET };
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
      writtenFiles.set(target, content);
    },
    chmodFn: async () => {},
    renameFn: async (src, dst) => {
      writtenFiles.set(dst, writtenFiles.get(src));
      writtenFiles.delete(src);
    },
    rmFn: async () => {},
  });

  await manager.applyRuleset({ allowedSshPort: 22 });

  const persisted = writtenFiles.get('/etc/nftables.conf');
  assert.ok(persisted);
  // Live bans should be retained in the persisted file
  assert.match(persisted, /198\.51\.100\.10/);
  assert.match(persisted, /203\.0\.113\.50/);
  assert.match(persisted, /2001:db8::1/);
});

test('AC-4: rollbackRuleset scopes table restoration without flush ruleset', async () => {
  const execCalls = [];
  const writtenFiles = new Map();

  const manager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    execFn: async (file, args) => {
      execCalls.push([file, ...args]);
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_DOCKER_RULESET };
      }
      return { stdout: '' };
    },
    writeFileFn: async (target, content) => {
      writtenFiles.set(target, content);
    },
    chmodFn: async () => {},
    renameFn: async (src, dst) => {
      writtenFiles.set(dst, writtenFiles.get(src));
      writtenFiles.delete(src);
    },
    rmFn: async () => {},
  });

  const previousRuleset = `flush ruleset
table inet yunpanel {
  set crowdsec-blacklists { type ipv4_addr; flags interval; }
  set crowdsec6-blacklists { type ipv6_addr; flags interval; }
  chain input {
    type filter hook input priority 0; policy drop;
    ip saddr @crowdsec-blacklists drop
    ip6 saddr @crowdsec6-blacklists drop
    tcp dport 22 accept
  }
}
`;

  const result = await manager.rollbackRuleset(previousRuleset);
  assert.equal(result.success, true);
  assert.equal(result.rolledBack, true);
  assert.equal(result.managedBoundary.table, MANAGED_FIREWALL_TABLE);

  // Persisted rollback config must NOT contain flush ruleset
  const persisted = writtenFiles.get('/etc/nftables.conf');
  assert.ok(persisted);
  assert.equal(persisted.includes('flush ruleset'), false);
  assert.match(persisted, /table inet yunpanel\ndelete table inet yunpanel/);

  // Elements from live ruleset preserved in rollback too
  assert.match(persisted, /198\.51\.100\.10/);

  // No command with flush ruleset executed
  const hadFlushExec = execCalls.some(([, ...args]) => args.join(' ').includes('flush ruleset'));
  assert.equal(hadFlushExec, false);
});

test('AC-4: empty rollbackRuleset only deletes table inet yunpanel and never executes global flush', async () => {
  const execCalls = [];
  const writtenFiles = new Map();

  const manager = createNftablesManager({
    execFn: async (file, args) => {
      execCalls.push([file, ...args]);
      return { stdout: '' };
    },
    writeFileFn: async (target, content) => {
      writtenFiles.set(target, content);
    },
    rmFn: async () => {},
  });

  const result = await manager.rollbackRuleset('');
  assert.equal(result.success, true);
  assert.equal(result.rolledBack, true);
  assert.equal(result.flushed, false);
  assert.equal(result.tableDeleted, true);

  // Check script executed
  const tempFiles = Array.from(writtenFiles.values());
  assert.equal(tempFiles.length > 0, true);
  assert.match(tempFiles[0], /table inet yunpanel\ndelete table inet yunpanel/);

  // Assert no flush ruleset was run
  const hadFlushExec = execCalls.some(([, ...args]) => args.join(' ').includes('flush ruleset'));
  assert.equal(hadFlushExec, false);
});

test('AC-4: applyRuleset rolls back within managed scope on error without deleting external rules', async () => {
  const rollbackFiles = [];
  let failFirstApply = true;

  const manager = createNftablesManager({
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_DOCKER_RULESET };
      }
      if (args[0] === 'is-active' || args[0] === 'is-enabled') {
        return { stdout: 'inactive\n' };
      }
      if (args[0] === '-f' && failFirstApply) {
        failFirstApply = false;
        const err = new Error('NFT failed');
        err.stderr = 'Error: could not process rule';
        throw err;
      }
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileFn: async (target, content) => {
      rollbackFiles.push({ target, content });
    },
    chmodFn: async () => {},
    renameFn: async () => {},
    rmFn: async () => {},
  });

  await assert.rejects(
    () => manager.applyRuleset({ allowedSshPort: 22 }),
    (err) => {
      assert.equal(err instanceof NftablesManagerError, true);
      assert.equal(err.code, 'apply_failed');
      return true;
    },
  );

  // Verified that the rollback content written during failure does NOT have flush ruleset
  const rollbackAction = rollbackFiles.find((f) => f.target.includes('rollback'));
  assert.ok(rollbackAction);
  assert.equal(rollbackAction.content.includes('flush ruleset'), false);
  assert.match(rollbackAction.content, /table inet yunpanel/);
});

test('AC-5: inspectNftables enforces single authority and returns managed boundary status', async () => {
  const manager = createNftablesManager({
    execFn: async (file, args) => {
      if (args[0] === '--version') return { stdout: 'nftables v1.0.9\n' };
      if (args[0] === 'is-active' && args[1] === 'nftables') return { stdout: 'active\n' };
      if (args[0] === 'is-enabled' && args[1] === 'nftables') return { stdout: 'enabled\n' };
      if (args[0] === 'is-active' || args[0] === 'is-enabled') return { stdout: 'inactive\n' };
      if (args[0] === 'list' && args[1] === 'ruleset') return { stdout: MOCK_LIVE_DOCKER_RULESET };
      return { stdout: '' };
    },
    statFn: async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });

  const inspected = await manager.inspectNftables();
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.managedBoundary.table, 'yunpanel');
  assert.equal(inspected.managedBoundary.family, 'inet');
  assert.equal(inspected.managedBoundary.prohibitsGlobalFlush, true);
  assert.equal(inspected.managedBoundary.dockerProtected, true);
  assert.equal(inspected.managedBoundary.crowdsecProtected, true);
  assert.equal(inspected.dockerFirewall.dockerDetected, true);
  assert.equal(inspected.crowdsecFirewall.hasCrowdsecSets, true);
  assert.equal(inspected.conflictingFirewalls.conflictDetected, false);
});

test('AC-6: migrateRulesetToManagedScope eliminates global flush, preserves sets, and validates coexistence', () => {
  const legacyConfig = `#!/usr/sbin/nft -f

flush ruleset

table inet yunpanel {
  set crowdsec-blacklists {
    type ipv4_addr
    flags interval
  }
  set crowdsec6-blacklists {
    type ipv6_addr
    flags interval
  }
  chain input {
    type filter hook input priority 0; policy drop;
    ip saddr @crowdsec-blacklists drop
    ip6 saddr @crowdsec6-blacklists drop
    tcp dport 22 accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "docker0" accept
    oifname "docker0" accept
    iifname "br-*" accept
    oifname "br-*" accept
  }
}
`;

  const result = migrateRulesetToManagedScope(legacyConfig, {
    liveRuleset: MOCK_LIVE_DOCKER_RULESET,
  });

  assert.equal(result.hadGlobalFlush, true);
  assert.equal(result.globalFlushEliminated, true);
  assert.equal(result.migratedContent.includes('flush ruleset'), false);
  assert.match(result.migratedContent, /table inet yunpanel\ndelete table inet yunpanel/);
  // Preserved live CrowdSec elements
  assert.match(result.migratedContent, /198\.51\.100\.10/);
  assert.ok(result.sha256);
});

test('AC-6: manager.migrateFirewallConfiguration migrates existing file to managed scope and persists', async () => {
  const writtenFiles = new Map();
  const legacyContent = `flush ruleset
table inet yunpanel {
  set crowdsec-blacklists { type ipv4_addr; flags interval; }
  set crowdsec6-blacklists { type ipv6_addr; flags interval; }
  chain input {
    type filter hook input priority 0; policy drop;
    ip saddr @crowdsec-blacklists drop
    ip6 saddr @crowdsec6-blacklists drop
    tcp dport 22 accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "docker0" accept
    oifname "docker0" accept
    iifname "br-*" accept
    oifname "br-*" accept
  }
}
`;

  const manager = createNftablesManager({
    configPath: '/etc/nftables.conf',
    readFileFn: async () => legacyContent,
    writeFileFn: async (target, content) => {
      writtenFiles.set(target, content);
    },
    chmodFn: async () => {},
    renameFn: async (src, dst) => {
      writtenFiles.set(dst, writtenFiles.get(src));
      writtenFiles.delete(src);
    },
    rmFn: async () => {},
    execFn: async (file, args) => {
      if (args[0] === 'list' && args[1] === 'ruleset') {
        return { stdout: MOCK_LIVE_DOCKER_RULESET };
      }
      return { stdout: '' };
    },
  });

  const migration = await manager.migrateFirewallConfiguration();
  assert.equal(migration.migrated, true);
  assert.equal(migration.globalFlushEliminated, true);
  assert.equal(migration.persisted, true);

  const persisted = writtenFiles.get('/etc/nftables.conf');
  assert.ok(persisted);
  assert.equal(persisted.includes('flush ruleset'), false);
  assert.match(persisted, /table inet yunpanel\ndelete table inet yunpanel/);
  assert.match(persisted, /198\.51\.100\.10/);
});
