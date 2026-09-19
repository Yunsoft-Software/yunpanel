import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STORE_PATH = '/var/lib/yunpanel/control-plane/panel-settings.json';
const STORE_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  websiteDefaults: Object.freeze({
    defaultRuntime: 'node',
    defaultNodeMajor: 24,
    defaultPhpVersion: '8.3',
    defaultDocumentRootPattern: '/var/lib/yunpanel/data/:websiteId/current',
    defaultUmask: '0027',
    isolationUserPrefix: 'yunapp-',
  }),
  dnsSsl: Object.freeze({
    acmeEmail: null,
    autoRenewDaysBeforeExpiry: 30,
  }),
  backupDefaults: Object.freeze({
    retentionDaily: 7,
    retentionWeekly: 4,
    retentionMonthly: 12,
  }),
});

export class PanelSettingsRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'PanelSettingsRegistryError';
    this.code = code;
    this.status = status;
  }
}

function validateEmail(email) {
  if (email === null || email === undefined || email === '') return null;
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new PanelSettingsRegistryError('invalid_acme_email', 'ACME email must be a valid email address');
  }
  return email.trim().toLowerCase();
}

function validateRuntime(runtime) {
  if (runtime === undefined) return undefined;
  if (!['node', 'php', 'static'].includes(runtime)) {
    throw new PanelSettingsRegistryError('invalid_default_runtime', 'Default runtime must be node, php, or static');
  }
  return runtime;
}

function validateNodeMajor(version) {
  if (version === undefined) return undefined;
  const num = Number(version);
  if (!Number.isSafeInteger(num) || num < 18 || num > 30) {
    throw new PanelSettingsRegistryError('invalid_default_node_major', 'Default Node major version must be between 18 and 30');
  }
  return num;
}

function validatePhpVersion(version) {
  if (version === undefined) return undefined;
  if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version.trim())) {
    throw new PanelSettingsRegistryError('invalid_default_php_version', 'Default PHP version must be format X.Y (e.g. 8.3)');
  }
  return version.trim();
}

function validatePositiveInt(value, field, min = 1, max = 365) {
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    throw new PanelSettingsRegistryError(`invalid_${field}`, `${field} must be between ${min} and ${max}`);
  }
  return num;
}

export function createPanelSettingsRegistry({ filePath = DEFAULT_STORE_PATH } = {}) {
  let cache = null;

  async function loadStore() {
    if (cache) return cache;
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.version === STORE_VERSION && parsed?.settings) {
        cache = {
          version: STORE_VERSION,
          settings: {
            websiteDefaults: { ...DEFAULT_SETTINGS.websiteDefaults, ...parsed.settings.websiteDefaults },
            dnsSsl: { ...DEFAULT_SETTINGS.dnsSsl, ...parsed.settings.dnsSsl },
            backupDefaults: { ...DEFAULT_SETTINGS.backupDefaults, ...parsed.settings.backupDefaults },
          },
          updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        };
        return cache;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new PanelSettingsRegistryError('store_read_failed', `Failed to read panel settings: ${error.message}`, 500);
      }
    }

    cache = {
      version: STORE_VERSION,
      settings: {
        websiteDefaults: { ...DEFAULT_SETTINGS.websiteDefaults },
        dnsSsl: { ...DEFAULT_SETTINGS.dnsSsl },
        backupDefaults: { ...DEFAULT_SETTINGS.backupDefaults },
      },
      updatedAt: new Date().toISOString(),
    };
    return cache;
  }

  async function persistStore(state) {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tempFile = `${filePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const payload = JSON.stringify(state, null, 2);
    await writeFile(tempFile, payload, { mode: 0o600 });
    await rename(tempFile, filePath);
    cache = state;
  }

  return {
    async getSettings() {
      const store = await loadStore();
      return JSON.parse(JSON.stringify(store.settings));
    },

    async updateSettings(patch = {}) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new PanelSettingsRegistryError('invalid_patch', 'Patch must be an object');
      }

      const store = await loadStore();
      const current = store.settings;

      const newWebsiteDefaults = { ...current.websiteDefaults };
      if (patch.websiteDefaults && typeof patch.websiteDefaults === 'object') {
        const { defaultRuntime, defaultNodeMajor, defaultPhpVersion } = patch.websiteDefaults;
        if (defaultRuntime !== undefined) newWebsiteDefaults.defaultRuntime = validateRuntime(defaultRuntime);
        if (defaultNodeMajor !== undefined) newWebsiteDefaults.defaultNodeMajor = validateNodeMajor(defaultNodeMajor);
        if (defaultPhpVersion !== undefined) newWebsiteDefaults.defaultPhpVersion = validatePhpVersion(defaultPhpVersion);
      }

      const newDnsSsl = { ...current.dnsSsl };
      if (patch.dnsSsl && typeof patch.dnsSsl === 'object') {
        const { acmeEmail, autoRenewDaysBeforeExpiry } = patch.dnsSsl;
        if (acmeEmail !== undefined) newDnsSsl.acmeEmail = validateEmail(acmeEmail);
        if (autoRenewDaysBeforeExpiry !== undefined) {
          newDnsSsl.autoRenewDaysBeforeExpiry = validatePositiveInt(autoRenewDaysBeforeExpiry, 'auto_renew_days', 1, 90);
        }
      }

      const newBackupDefaults = { ...current.backupDefaults };
      if (patch.backupDefaults && typeof patch.backupDefaults === 'object') {
        const { retentionDaily, retentionWeekly, retentionMonthly } = patch.backupDefaults;
        if (retentionDaily !== undefined) newBackupDefaults.retentionDaily = validatePositiveInt(retentionDaily, 'retention_daily', 1, 365);
        if (retentionWeekly !== undefined) newBackupDefaults.retentionWeekly = validatePositiveInt(retentionWeekly, 'retention_weekly', 1, 104);
        if (retentionMonthly !== undefined) newBackupDefaults.retentionMonthly = validatePositiveInt(retentionMonthly, 'retention_monthly', 1, 120);
      }

      const updated = {
        version: STORE_VERSION,
        settings: {
          websiteDefaults: newWebsiteDefaults,
          dnsSsl: newDnsSsl,
          backupDefaults: newBackupDefaults,
        },
        updatedAt: new Date().toISOString(),
      };

      await persistStore(updated);
      return JSON.parse(JSON.stringify(updated.settings));
    },

    clearCache() {
      cache = null;
    },
  };
}
