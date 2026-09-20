import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPanelSettingsRegistry } from '../src/panel-settings-registry.js';
import { createPanelSettingsService } from '../src/panel-settings-service.js';

test('PanelSettingsService - getSystemSettings and updateSystemSettings', async (t) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'yunpanel-settings-test-'));
  const filePath = path.join(tempDir, 'panel-settings.json');

  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const registry = createPanelSettingsRegistry({ filePath });

  const mockServerRegistry = {
    async getServer(id) {
      if (id === 'srv-local') {
        return { id: 'srv-local', hostname: 'panel.yunsoft.local', displayName: 'Yunsoft Test Sunucusu' };
      }
      return null;
    },
  };

  const mockDnsRegistry = {
    async getSettings(id) {
      if (id === 'srv-local') {
        return {
          publicIpv4: '198.51.100.1',
          publicIpv6: null,
          ns1: { hostname: 'ns1.yunsoft.local', ipv4: '198.51.100.1', local: true },
          ns2: { hostname: 'ns2.yunsoft.local', ipv4: '198.51.100.2', local: true },
          soa: { refresh: 3600, retry: 900, expire: 1209600, minimum: 300, ttl: 300 },
          dnssecDefault: true,
          secondaryDns: [],
        };
      }
      return null;
    },
  };

  const mockJobRegistry = {
    async listJobs() {
      return [];
    },
  };

  const service = createPanelSettingsService({
    panelSettingsRegistry: registry,
    serverRegistry: mockServerRegistry,
    serverDnsIdentityRegistry: mockDnsRegistry,
    jobRegistry: mockJobRegistry,
    localServerId: 'srv-local',
  });

  await t.test('returns full system settings with all sections populated', async () => {
    const settings = await service.getSystemSettings();

    // Panel
    assert.equal(settings.panel.version, '0.3.0');
    assert.equal(settings.panel.localServerId, 'srv-local');
    assert.equal(settings.panel.hostname, 'panel.yunsoft.local');
    assert.equal(settings.panel.displayName, 'Yunsoft Test Sunucusu');
    assert.equal(settings.panel.executionMode, 'local');

    // Network & DNS
    assert.equal(settings.networkDns.publicIpv4, '198.51.100.1');
    assert.equal(settings.networkDns.dnssecDefault, true);

    // Website Defaults
    assert.equal(settings.websiteDefaults.defaultRuntime, 'node');
    assert.equal(settings.websiteDefaults.defaultNodeMajor, 24);
    assert.equal(settings.websiteDefaults.defaultPhpVersion, '8.3');
    assert.equal(settings.websiteDefaults.defaultUmask, '0027');

    // DNS & SSL
    assert.equal(settings.dnsSsl.authoritativeProvider, 'powerdns');
    assert.equal(settings.dnsSsl.acmeProvider, 'letsencrypt');
    assert.equal(settings.dnsSsl.autoRenewDaysBeforeExpiry, 30);

    // Mail & Webmail
    assert.equal(settings.mail.engine, 'postfix + dovecot + rspamd');
    assert.equal(settings.mail.authStorage, 'sqlite');
    assert.equal(settings.mail.webmail.engine, 'roundcube');
    assert.equal(settings.mail.security.spam.engine, 'rspamd');
    assert.equal(settings.mail.security.antivirus.profile, 'disabled');
    assert.equal(settings.mail.security.antivirus.enabled, false);
    assert.equal(settings.mail.security.antivirus.active, false);

    // Database & Cache
    assert.equal(settings.database.engine, 'mariadb');
    assert.equal(settings.database.client.engine, 'phpmyadmin');
    assert.equal(settings.cache.redis.isolation, 'site-scoped ACL');
    assert.equal(settings.cache.memcached.isolation, 'per-site key prefix');

    // Backup
    assert.equal(settings.backup.engine, 'restic');
    assert.equal(settings.backup.retentionDefaults.retentionDaily, 7);

    // Security
    assert.equal(settings.security.authHash, 'argon2id');
    assert.equal(settings.security.mfa, 'totp');
    assert.equal(settings.security.sftp.engine, 'OpenSSH internal-sftp');
    assert.equal(settings.security.firewall.engine, 'nftables');

    // Observability
    assert.equal(settings.observability.metrics.engine, 'netdata');
    assert.equal(settings.observability.logs.engine, 'goaccess');
  });

  await t.test('updates website defaults, dnsSsl, and mailSecurity', async () => {
    const updated = await service.updateSystemSettings({
      websiteDefaults: {
        defaultRuntime: 'php',
        defaultPhpVersion: '8.4',
      },
      dnsSsl: {
        acmeEmail: 'admin@yunsoft.local',
        autoRenewDaysBeforeExpiry: 20,
      },
      backupDefaults: {
        retentionDaily: 14,
      },
      mailSecurity: {
        antivirusProfile: 'clamav',
      },
    });

    assert.equal(updated.websiteDefaults.defaultRuntime, 'php');
    assert.equal(updated.websiteDefaults.defaultPhpVersion, '8.4');
    assert.equal(updated.dnsSsl.acmeEmail, 'admin@yunsoft.local');
    assert.equal(updated.dnsSsl.autoRenewDaysBeforeExpiry, 20);
    assert.equal(updated.backup.retentionDefaults.retentionDaily, 14);
    assert.equal(updated.mail.security.antivirus.profile, 'clamav');
    assert.equal(updated.mail.security.antivirus.enabled, true);

    const reloaded = await service.getSystemSettings();
    assert.equal(reloaded.websiteDefaults.defaultRuntime, 'php');
    assert.equal(reloaded.dnsSsl.acmeEmail, 'admin@yunsoft.local');
    assert.equal(reloaded.backup.retentionDefaults.retentionDaily, 14);
    assert.equal(reloaded.mail.security.antivirus.profile, 'clamav');
    assert.equal(reloaded.mail.security.antivirus.enabled, true);
    assert.equal(reloaded.mail.security.antivirus.active, false); // No inspector provided -> health yoksa aktif gösterme!
  });

  await t.test('health yoksa aktif gösterme: clamav active only when healthy', async () => {
    // 1. Unhealthy inspector -> active must be false
    const unhealthyInspector = {
      inspect: async () => ({
        profile: 'clamav',
        enabled: true,
        active: false,
        healthy: false,
        status: 'unhealthy',
        blockers: ['clamav_service_inactive'],
      }),
    };
    const unhealthyService = createPanelSettingsService({
      panelSettingsRegistry: registry,
      serverRegistry: mockServerRegistry,
      serverDnsIdentityRegistry: mockDnsRegistry,
      jobRegistry: mockJobRegistry,
      localServerId: 'srv-local',
      mailAntivirusHealthInspector: unhealthyInspector,
    });
    const unhealthySettings = await unhealthyService.getSystemSettings();
    assert.equal(unhealthySettings.mail.security.antivirus.enabled, true);
    assert.equal(unhealthySettings.mail.security.antivirus.healthy, false);
    assert.equal(unhealthySettings.mail.security.antivirus.active, false); // health yoksa aktif gösterme!
    assert.equal(unhealthySettings.mail.security.antivirus.status, 'unhealthy');

    // 2. Healthy inspector -> active is true
    const healthyInspector = {
      inspect: async () => ({
        profile: 'clamav',
        enabled: true,
        active: true,
        healthy: true,
        status: 'ready',
        blockers: [],
      }),
    };
    const healthyService = createPanelSettingsService({
      panelSettingsRegistry: registry,
      serverRegistry: mockServerRegistry,
      serverDnsIdentityRegistry: mockDnsRegistry,
      jobRegistry: mockJobRegistry,
      localServerId: 'srv-local',
      mailAntivirusHealthInspector: healthyInspector,
    });
    const healthySettings = await healthyService.getSystemSettings();
    assert.equal(healthySettings.mail.security.antivirus.enabled, true);
    assert.equal(healthySettings.mail.security.antivirus.healthy, true);
    assert.equal(healthySettings.mail.security.antivirus.active, true);
    assert.equal(healthySettings.mail.security.antivirus.status, 'ready');
  });

  await t.test('rejects invalid patch values', async () => {
    await assert.rejects(
      () => service.updateSystemSettings({ websiteDefaults: { defaultRuntime: 'ruby' } }),
      /Default runtime must be node, php, or static/,
    );
    await assert.rejects(
      () => service.updateSystemSettings({ dnsSsl: { acmeEmail: 'invalid-email' } }),
      /ACME email must be a valid email address/,
    );
    await assert.rejects(
      () => service.updateSystemSettings({ mailSecurity: { antivirusProfile: 'unknown' } }),
      /Antivirus profile must be disabled or clamav/,
    );
  });
});
