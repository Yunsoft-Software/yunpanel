import os from 'node:os';
import { API_VERSION } from './core-app.js';
import { managedServiceHttpInternals } from './managed-service-http.js';

export function createPanelSettingsService({
  panelSettingsRegistry,
  serverRegistry,
  serverDnsIdentityRegistry,
  jobRegistry,
  localServerId,
  mailAntivirusHealthInspector,
}) {
  if (!panelSettingsRegistry || typeof panelSettingsRegistry.getSettings !== 'function') {
    throw new Error('Panel settings registry is required');
  }

  return {
    async getSystemSettings() {
      const persistedSettings = await panelSettingsRegistry.getSettings();

      // 1. Panel & Host information
      let serverInfo = null;
      if (serverRegistry && localServerId) {
        try {
          serverInfo = await serverRegistry.getServer(localServerId);
        } catch {
          // ignore if server not found or uninitialized
        }
      }

      const panel = {
        version: API_VERSION,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        localServerId: localServerId ?? null,
        hostname: serverInfo?.hostname ?? os.hostname(),
        displayName: serverInfo?.displayName ?? null,
        uptimeSeconds: Math.floor(process.uptime()),
        executionMode: 'local',
      };

      // 2. Network & DNS identity
      let networkDns = null;
      if (serverDnsIdentityRegistry && localServerId) {
        try {
          networkDns = await serverDnsIdentityRegistry.getSettings(localServerId);
        } catch {
          networkDns = null;
        }
      }

      // 3. Website Defaults
      const websiteDefaults = {
        ...persistedSettings.websiteDefaults,
      };

      // 4. DNS & SSL Defaults
      const dnsSsl = {
        acmeEmail: persistedSettings.dnsSsl?.acmeEmail ?? process.env.YUNPANEL_ACME_EMAIL ?? null,
        acmeProvider: 'letsencrypt',
        authoritativeProvider: 'powerdns',
        autoRenewDaysBeforeExpiry: persistedSettings.dnsSsl?.autoRenewDaysBeforeExpiry ?? 30,
        customCertificatesRoot: '/var/lib/yunpanel/control-plane/custom-certificates',
      };

      // 5. Mail & Webmail
      const antivirusProfile = persistedSettings.mailSecurity?.antivirusProfile ?? 'disabled';
      let antivirusHealth = null;
      if (mailAntivirusHealthInspector) {
        antivirusHealth = await mailAntivirusHealthInspector.inspect({ profile: antivirusProfile });
      } else {
        antivirusHealth = {
          profile: antivirusProfile,
          enabled: antivirusProfile === 'clamav',
          active: false,
          healthy: false,
          status: antivirusProfile === 'clamav' ? 'unhealthy' : 'disabled',
          blockers: antivirusProfile === 'clamav' ? ['mail_antivirus_inspector_unavailable'] : [],
        };
      }

      const mail = {
        engine: 'postfix + dovecot + rspamd',
        authStorage: 'sqlite',
        authDatabasePath: '/var/lib/yunpanel/mail-auth/virtual-mail.sqlite3',
        maildirRoot: '/var/lib/yunpanel/mail',
        webmail: {
          engine: 'roundcube',
          deployment: 'shared-instance',
          subdomainPattern: 'webmail.<domain>',
        },
        security: {
          spam: { engine: 'rspamd', enabled: true },
          antivirus: antivirusHealth,
        },
      };

      // 6. Databases & Cache
      const database = {
        engine: 'mariadb',
        client: {
          engine: 'phpmyadmin',
          deployment: 'integrated-gateway',
          access: 'session-handoff',
        },
      };

      const cache = {
        redis: {
          isolation: 'site-scoped ACL',
          userPattern: 'yunapp-<websiteId>',
          keyPrefix: '~<websiteId>:*',
          dangerousCommandsRestricted: true,
        },
        memcached: {
          isolation: 'per-site key prefix',
          keyPrefix: 'yunapp_<websiteId>:',
        },
      };

      // 7. Backup & Storage
      const backup = {
        engine: 'restic',
        remoteEngine: 'rclone',
        localBackupRoot: '/var/lib/yunpanel/backups',
        retentionDefaults: {
          ...persistedSettings.backupDefaults,
        },
      };

      // 8. Security
      const security = {
        authHash: 'argon2id',
        mfa: 'totp',
        sftp: {
          engine: 'OpenSSH internal-sftp',
          chrootPattern: '/var/lib/yunpanel/data/<websiteId>',
          authorizedKeysRoot: '/etc/ssh/yunpanel-authorized-keys',
        },
        firewall: {
          engine: 'nftables',
          bouncer: 'crowdsec',
        },
      };

      // 9. Observability
      const observability = {
        metrics: {
          engine: 'netdata',
          mode: 'loopback gateway',
        },
        logs: {
          engine: 'goaccess',
          mode: 'per-site log analyzer',
        },
      };

      // 10. Managed Services Snapshot
      let managedServices = null;
      if (jobRegistry && localServerId) {
        try {
          const snapshot = await managedServiceHttpInternals.latestServiceSnapshot(jobRegistry, localServerId);
          managedServices = {
            services: snapshot?.services ?? null,
            snapshot: snapshot?.snapshot ?? null,
          };
        } catch {
          managedServices = { services: null, snapshot: null };
        }
      }

      return {
        panel,
        networkDns,
        websiteDefaults,
        dnsSsl,
        mail,
        database,
        cache,
        backup,
        security,
        observability,
        managedServices,
      };
    },

    async updateSystemSettings(patch) {
      await panelSettingsRegistry.updateSettings(patch);
      return this.getSystemSettings();
    },
  };
}
