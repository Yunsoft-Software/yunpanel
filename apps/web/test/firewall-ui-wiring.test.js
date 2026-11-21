import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { TOOLS_SETTINGS_GROUPS } from '../src/workspace/ui/ux-model.js';

const source = (path) => readFile(new URL(`../src/workspace/${path}`, import.meta.url), 'utf8');

test('firewall ui wiring: WorkspaceApp routes /firewall with owner guard', async () => {
  const appSrc = await source('WorkspaceApp.jsx');
  assert.match(appSrc, /import FirewallPage from '\.\/FirewallPage\.jsx';/);
  assert.match(appSrc, /path: 'firewall', element: owner\(<FirewallPage \/>\)/);
  assert.match(appSrc, /path: 'servers\/firewall', element: <RedirectWithSearch to="\/firewall" \/>/);
});

test('firewall ui wiring: ux-model exposes /firewall in TOOLS_SETTINGS_GROUPS under server group', () => {
  const serverGroup = TOOLS_SETTINGS_GROUPS.find((g) => g.id === 'server');
  assert.ok(serverGroup, 'server group must exist in TOOLS_SETTINGS_GROUPS');

  const firewallItem = serverGroup.items.find(([to]) => to === '/firewall');
  assert.ok(firewallItem, '/firewall must be an item in server group');
  assert.equal(firewallItem[1], 'Güvenlik duvarı ve port yönetimi');
  assert.equal(firewallItem[2], 'shield');
});

test('firewall ui wiring: FirewallPage uses clean Turkish copy, independent fail-closed states, and panel gateway', async () => {
  const pageSrc = await source('FirewallPage.jsx');
  const clientSrc = await source('firewall-client.js');
  const modelSrc = await source('firewall-model.js');

  // Verify panelRequest gateway usage (never direct /api/firewall)
  assert.match(clientSrc, /panelRequest/);
  assert.equal(clientSrc.includes("'/api/firewall'"), false);

  // Verify real firewall status
  assert.match(pageSrc, /Güvenlik Duvarı ve Port Yönetimi/);
  assert.match(pageSrc, /nftables/);

  // Verify unknown cloud / provider firewall advisory note without English buzzwords
  assert.match(pageSrc, /Cloud \/ Sağlayıcı Güvenlik Duvarı Durumu: Bilinmiyor/);
  assert.match(pageSrc, /providerNotice/);
  assert.match(modelSrc, /AWS Güvenlik Grubu, Hetzner Cloud Firewall, GCP Firewall/);

  // Verify service profiles (localMail & authoritativeDns)
  assert.match(pageSrc, /Sunucu Servis Profilleri/);
  assert.match(pageSrc, /localMail/);
  assert.match(pageSrc, /authoritativeDns/);
  assert.match(pageSrc, /Yerel e-posta ve yetkili DNS servis profilleri etkin olmadığında ilgili portların açılması engellenir/);

  // Verify port inventory and reachability distinction
  assert.match(pageSrc, /Dinleyen Port/);
  assert.match(pageSrc, /Firewall İzinli/);
  assert.match(pageSrc, /Dış Erişilebilir/);

  // Verify CrowdSec integration
  assert.match(pageSrc, /CrowdSec/);
  assert.match(pageSrc, /Bouncer/);

  // Verify clean end-user target restriction copy and zero hardcoded test IPs / English buzzwords / swallowed catches
  assert.match(pageSrc, /isFirewallStatusVerified/);
  assert.match(pageSrc, /Güvenlik duvarı durumu doğrulanamadı/);
  assert.match(pageSrc, /Port erişilebilirlik testi yalnızca izinli sunucu hedeflerinde çalıştırılabilir\./);
  for (const forbidden of [
    '157.180.11.28',
    'server.cryptoraichu.website',
    '.44',
    '(Unknown)',
    '(Boot)',
    '(Local Mail)',
    '(Authoritative DNS)',
    'E-Posta (Mail)',
    'Local-mail',
    'Authoritative-DNS',
    '.catch(() => null)',
    '.catch(() => [])',
  ]) {
    assert.equal(pageSrc.includes(forbidden), false, `FirewallPage.jsx must not contain "${forbidden}"`);
    assert.equal(modelSrc.includes(forbidden), false, `firewall-model.js must not contain "${forbidden}"`);
  }
});
