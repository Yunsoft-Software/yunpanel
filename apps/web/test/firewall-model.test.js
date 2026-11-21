import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatFirewallError,
  formatFirewallErrorMessage,
  formatPortReachability,
  formatServiceProfileLabel,
  formatProviderFirewallNotice,
  isFirewallStatusVerified,
  isSpecialPortLocked,
  checkPortProfileAllowed,
  MAIL_PORTS,
  DNS_PORTS,
} from '../src/workspace/firewall-model.js';

test('formatPortReachability correctly categorizes all states', () => {
  // 1. Listening, allowed, non-loopback -> Dışarıdan Erişilebilir
  const reachable = formatPortReachability({
    isListening: true,
    isFirewallAllowed: true,
    isLoopback: false,
  });
  assert.equal(reachable.label, 'Dışarıdan Erişilebilir');
  assert.equal(reachable.badgeState, 'ready');

  // 2. Listening, loopback -> Yalnız Yerel
  const loopback = formatPortReachability({
    isListening: true,
    isFirewallAllowed: false,
    isLoopback: true,
  });
  assert.equal(loopback.label, 'Yalnız Yerel');
  assert.equal(loopback.badgeState, 'stale');

  // 3. Listening, not allowed, non-loopback -> Firewall Engelli
  const blocked = formatPortReachability({
    isListening: true,
    isFirewallAllowed: false,
    isLoopback: false,
  });
  assert.equal(blocked.label, 'Firewall Engelli');
  assert.equal(blocked.badgeState, 'error');

  // 4. Not listening, allowed -> Firewall İzinli
  const allowedOnly = formatPortReachability({
    isListening: false,
    isFirewallAllowed: true,
  });
  assert.equal(allowedOnly.label, 'Firewall İzinli');
  assert.equal(allowedOnly.badgeState, 'stale');

  // 5. Inactive
  const inactive = formatPortReachability({
    isListening: false,
    isFirewallAllowed: false,
  });
  assert.equal(inactive.label, 'Pasif');
});

test('formatServiceProfileLabel maps profiles accurately without English parenthetical jargon', () => {
  assert.equal(formatServiceProfileLabel('system'), 'Sistem / SSH');
  assert.equal(formatServiceProfileLabel('web'), 'Web (HTTP/HTTPS)');
  assert.equal(formatServiceProfileLabel('mail'), 'E-Posta');
  assert.equal(formatServiceProfileLabel('dns'), 'DNS (53)');
  assert.equal(formatServiceProfileLabel('custom'), 'Özel Kural');
});

test('isFirewallStatusVerified only accepts verified active/degraded/inactive states', () => {
  assert.equal(isFirewallStatusVerified({ status: 'active' }), true);
  assert.equal(isFirewallStatusVerified({ status: 'degraded' }), true);
  assert.equal(isFirewallStatusVerified({ status: 'inactive' }), true);

  assert.equal(isFirewallStatusVerified({ status: 'error' }), false);
  assert.equal(isFirewallStatusVerified({ status: 'unknown' }), false);
  assert.equal(isFirewallStatusVerified({ status: 'unavailable' }), false);
  assert.equal(isFirewallStatusVerified({}), false);
  assert.equal(isFirewallStatusVerified(null), false);
  assert.equal(isFirewallStatusVerified(undefined), false);
  assert.equal(isFirewallStatusVerified([]), false);
});

test('formatFirewallError redacts host paths and stderr while mapping operational codes', () => {
  assert.equal(formatFirewallErrorMessage, formatFirewallError);
  assert.equal(
    formatFirewallError({ code: 'decisions_list_failed', message: 'Failed to list decisions: spawn /usr/bin/cscli ENOENT' }),
    'CrowdSec engelleme listesi alınamadı.',
  );
  assert.equal(
    formatFirewallError({ code: 'ruleset_snapshot_failed', message: 'Failed to snapshot: spawn /tmp/secret/nft ENOENT' }),
    'Güvenlik duvarı anlık görüntüsü alınamadı.',
  );
  assert.equal(
    formatFirewallError({ code: 'candidate_syntax_error', message: 'nft syntax validation failed: /etc/nftables.conf:1:1' }),
    'Güvenlik duvarı kural doğrulaması başarısız oldu.',
  );
  assert.equal(
    formatFirewallError({ status: 502, message: 'Request failed with HTTP 502' }),
    'Güvenlik duvarı servisine şu anda ulaşılamıyor.',
  );
  const redacted = formatFirewallError(
    { message: 'Command failed: /var/folders/xx/private-missing-nft ENOENT' },
    'Güvenlik duvarı işlemi başarısız oldu.',
  );
  assert.equal(redacted, 'Güvenlik duvarı işlemi başarısız oldu.');
  assert.equal(redacted.includes('/var/'), false);
  assert.equal(redacted.includes('ENOENT'), false);
});

test('formatProviderFirewallNotice handles unknown status and custom notes', () => {
  const notice = formatProviderFirewallNotice({
    status: 'unknown',
    advisory: 'Cloud/sağlayıcı güvenlik duvarı durumu bilinmiyor',
  });
  assert.equal(notice.status, 'unknown');
  assert.equal(notice.isUnknown, true);
  assert.ok(notice.advisory.includes('Cloud/sağlayıcı güvenlik duvarı durumu bilinmiyor'));
});

test('isSpecialPortLocked protects SSH port 22', () => {
  assert.equal(isSpecialPortLocked(22, 'system'), true);
  assert.equal(isSpecialPortLocked(22, 'custom'), true);
  assert.equal(isSpecialPortLocked(8080, 'custom'), false);
  assert.equal(isSpecialPortLocked(3306, 'custom'), false);
});

test('checkPortProfileAllowed validates localMail and authoritativeDns restrictions', () => {
  // Mail ports restricted when localMail is false
  for (const port of MAIL_PORTS) {
    const res = checkPortProfileAllowed(port, { localMail: false });
    assert.equal(res.allowed, false);
    assert.ok(res.reason.includes('Yerel E-Posta'));
    assert.equal(res.reason.includes('Local-mail'), false);
  }

  // Mail ports allowed when localMail is true
  const resMailAllowed = checkPortProfileAllowed(25, { localMail: true });
  assert.equal(resMailAllowed.allowed, true);

  // DNS port 53 restricted when authoritativeDns is false
  const resDnsBlocked = checkPortProfileAllowed(53, { authoritativeDns: false });
  assert.equal(resDnsBlocked.allowed, false);
  assert.ok(resDnsBlocked.reason.includes('Yetkili DNS'));
  assert.equal(resDnsBlocked.reason.includes('Authoritative-DNS'), false);

  // DNS port 53 allowed when authoritativeDns is true
  const resDnsAllowed = checkPortProfileAllowed(53, { authoritativeDns: true });
  assert.equal(resDnsAllowed.allowed, true);

  // Custom port allowed regardless
  const resCustom = checkPortProfileAllowed(8080, { localMail: false, authoritativeDns: false });
  assert.equal(resCustom.allowed, true);
});
