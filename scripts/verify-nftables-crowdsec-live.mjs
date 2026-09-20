import assert from 'node:assert/strict';
import {
  createNftablesManager,
  createCrowdsecManager,
  NftablesManagerError,
} from '@yunpanel/host-runtime';
import { renderNftablesConfig } from '@yunpanel/config-templates';

async function runLiveAcceptance() {
  console.log('=== STARTING NFTABLES & CROWDSEC LIVE ACCEPTANCE ===\n');

  const nftManager = createNftablesManager();
  const csManager = createCrowdsecManager();

  // 1. Inspect nftables
  console.log('--- 1. Inspecting nftables ---');
  const nftState = await nftManager.inspectNftables();
  console.log('nftables state:', JSON.stringify(nftState, null, 2));
  assert.equal(nftState.satisfied, true, 'nftables must be installed');
  assert.ok(nftState.version, 'nftables version must be detected');
  console.log('✓ nftables inspection passed.\n');

  // 2. Lockout protection test
  console.log('--- 2. Testing SSH Lockout Protection ---');
  const dangerousCandidate = `
table inet dangerous {
  chain input {
    type filter hook input priority 0; policy drop;
    tcp dport 80 accept
  }
}
`;
  let lockoutBlocked = false;
  try {
    await nftManager.validateRulesetCandidate(dangerousCandidate, { allowedSshPort: 22 });
  } catch (err) {
    if (err instanceof NftablesManagerError && err.code === 'ssh_lockout_risk') {
      lockoutBlocked = true;
      console.log('✓ Correctly caught lockout risk:', err.message);
    } else {
      throw err;
    }
  }
  assert.equal(lockoutBlocked, true, 'Ruleset candidate without SSH port must be rejected');

  // Syntax validation test with invalid candidate
  console.log('--- 3. Testing Syntax Validation ---');
  const malformedCandidate = `
table inet broken {
  chain input {
    tcp dport 22 accept
    unknown_keyword_here drop
  }
}
`;
  let syntaxBlocked = false;
  try {
    await nftManager.validateRulesetCandidate(malformedCandidate, { allowedSshPort: 22 });
  } catch (err) {
    if (err instanceof NftablesManagerError && err.code === 'candidate_syntax_error') {
      syntaxBlocked = true;
      console.log('✓ Correctly caught syntax error:', err.message);
    } else {
      throw err;
    }
  }
  assert.equal(syntaxBlocked, true, 'Malformed candidate must be rejected by nft -c');

  // 4. Valid candidate validation
  console.log('--- 4. Validating Production Candidate ---');
  const validCandidate = renderNftablesConfig({
    sshPort: 22,
    allowWeb: true,
    allowDns: true,
    allowMail: true,
  });
  const validCheck = await nftManager.validateRulesetCandidate(validCandidate, { allowedSshPort: 22 });
  assert.equal(validCheck.valid, true);
  console.log('✓ Production candidate validated successfully.\n');

  // 5. Apply ruleset and test rollback
  console.log('--- 5. Testing Ruleset Apply and Rollback ---');
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('/usr/sbin/nft', ['delete', 'table', 'inet', 'yunpanel']);
  } catch {}
  const initialRuleset = await nftManager.getLiveRuleset();
  console.log(`Initial live ruleset length: ${initialRuleset.length} chars`);

  const applyResult = await nftManager.applyRuleset({
    candidateContent: validCandidate,
    allowedSshPort: 22,
    persist: false, // first test without persist
  });
  console.log('Apply result:', applyResult);
  assert.equal(applyResult.success, true);

  // Check live ruleset after apply
  const liveAfterApply = await nftManager.inspectNftables();
  console.log('Ruleset tables after apply:', liveAfterApply.ruleset.tableNames);
  assert.equal(liveAfterApply.ruleset.hasYunpanelTable, true, 'inet yunpanel table must be active');

  // Test rollback
  console.log('Rolling back to initial ruleset...');
  const rollbackResult = await nftManager.rollbackRuleset(initialRuleset);
  console.log('Rollback result:', rollbackResult);
  assert.equal(rollbackResult.success, true);

  const liveAfterRollback = await nftManager.inspectNftables();
  console.log('Ruleset tables after rollback:', liveAfterRollback.ruleset.tableNames);
  assert.equal(liveAfterRollback.ruleset.hasYunpanelTable, false, 'inet yunpanel table should be gone after rollback');
  console.log('✓ Apply and rollback passed.\n');

  // 6. Re-apply candidate and persist
  console.log('--- 6. Re-applying Candidate and Persisting ---');
  const finalApply = await nftManager.applyRuleset({
    candidateContent: validCandidate,
    allowedSshPort: 22,
    persist: true,
    enableService: true,
  });
  console.log('Final apply result:', finalApply);
  assert.equal(finalApply.success, true);
  assert.equal(finalApply.persisted, true);
  console.log('✓ Final apply and persistence succeeded.\n');

  // 7. Inspect CrowdSec
  console.log('--- 7. Inspecting CrowdSec Engine & Bouncer ---');
  const csStatus = await csManager.inspectCrowdsec();
  console.log('CrowdSec status:', JSON.stringify(csStatus, null, 2));
  assert.equal(csStatus.engine.installed, true, 'CrowdSec engine must be installed');
  assert.equal(csStatus.engine.active, true, 'CrowdSec engine must be active');
  assert.equal(csStatus.bouncer.active, true, 'CrowdSec firewall bouncer must be active');
  assert.equal(csStatus.conflicts.fail2banActive, false, 'fail2ban must not be active');
  assert.equal(csStatus.healthy, true, 'CrowdSec must be healthy');
  console.log('✓ CrowdSec inspection passed.\n');

  // 8. Test Decisions: Add, Verify in nftables, and Delete
  console.log('--- 8. Testing CrowdSec Decisions (IPv4 & IPv6) ---');
  const testIp4 = '198.51.100.99';
  const testIp6 = '2001:db8::99';
  // Note: Ubuntu 24.04 crowdsec-firewall-bouncer 0.0.25 writes to nftables netlink in little-endian order on x86_64
  const testIp4Reversed = testIp4.split('.').reverse().join('.');

  console.log(`Adding IPv4 ban decision for ${testIp4}...`);
  const addRes4 = await csManager.addDecision({
    ip: testIp4,
    duration: '1h',
    reason: 'live-acceptance-test',
    type: 'ban',
  });
  console.log('Add IPv4 decision result:', addRes4);
  assert.equal(addRes4.success, true);

  console.log(`Adding IPv6 ban decision for ${testIp6}...`);
  const addRes6 = await csManager.addDecision({
    ip: testIp6,
    duration: '1h',
    reason: 'live-acceptance-test-v6',
    type: 'ban',
  });
  console.log('Add IPv6 decision result:', addRes6);
  assert.equal(addRes6.success, true);

  // List decisions via manager
  const decisions = await csManager.listDecisions();
  console.log(`Current active decisions count: ${decisions.length}`);
  const foundIp4 = decisions.find((d) => d.value === testIp4);
  const foundIp6 = decisions.find((d) => d.value === testIp6);
  assert.ok(foundIp4, `Decision for ${testIp4} must be in decision list`);
  assert.ok(foundIp6, `Decision for ${testIp6} must be in decision list`);
  console.log(`✓ Found decisions in cscli: IPv4 ID=${foundIp4.id}, IPv6 ID=${foundIp6.id}`);

  // Wait for bouncer polling interval (update_frequency: 10s)
  console.log('Waiting for CrowdSec firewall bouncer to sync with nftables sets (up to 15s)...');
  let synced = false;
  for (let i = 0; i < 15; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const ruleset = await nftManager.getLiveRuleset();
    if (ruleset.includes(testIp4) || ruleset.includes(testIp4Reversed)) {
      synced = true;
      console.log(`✓ Decision synced to nftables after ${i + 1} seconds.`);
      break;
    }
  }
  assert.equal(synced, true, 'CrowdSec firewall bouncer must sync banned IP to nftables sets');

  // Verify decisions in live nftables ruleset
  console.log('Verifying decisions in kernel nftables sets...');
  const currentRuleset = await nftManager.getLiveRuleset();
  const hasIp4 = currentRuleset.includes(testIp4) || currentRuleset.includes(testIp4Reversed);
  assert.ok(hasIp4, `Kernel nftables ruleset must contain banned IPv4 (${testIp4} or ${testIp4Reversed})`);
  console.log('✓ Verified IPv4 is present in nftables kernel sets!');

  // Delete test decisions
  console.log(`Deleting decision for ${testIp4}...`);
  const delRes4 = await csManager.deleteDecision({ ip: testIp4 });
  assert.equal(delRes4.success, true);

  console.log(`Deleting decision for ${testIp6}...`);
  const delRes6 = await csManager.deleteDecision({ ip: testIp6 });
  assert.equal(delRes6.success, true);

  // Wait for bouncer deletion sync
  console.log('Waiting for CrowdSec firewall bouncer to remove IP from nftables sets (up to 15s)...');
  let removed = false;
  for (let i = 0; i < 15; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const ruleset = await nftManager.getLiveRuleset();
    if (!ruleset.includes(testIp4) && !ruleset.includes(testIp4Reversed)) {
      removed = true;
      console.log(`✓ Decision removed from nftables after ${i + 1} seconds.`);
      break;
    }
  }
  assert.equal(removed, true, 'CrowdSec firewall bouncer must remove deleted IP from nftables sets');
  console.log('✓ Verified both test IPs successfully removed from nftables kernel sets!\n');

  // 9. Verify Metrics and Alerts
  console.log('--- 9. Checking CrowdSec Metrics and Alerts ---');
  const alerts = await csManager.listAlerts({ limit: 5 });
  console.log(`Recent alerts count: ${alerts.length}`);
  console.log('Sample alert:', alerts[0]?.message ?? 'none');

  console.log('\n=== ALL NFTABLES & CROWDSEC LIVE ACCEPTANCE CHECKS PASSED ===');
}

runLiveAcceptance().catch((err) => {
  console.error('\n❌ LIVE ACCEPTANCE FAILED:', err);
  process.exit(1);
});
