export const NOTIFICATION_EVENT_TYPES = Object.freeze({
  SSL_CERTIFICATE_EXPIRING: 'ssl_certificate_expiring',
  SSL_CERTIFICATE_CRITICAL: 'ssl_certificate_critical',
  SSL_CERTIFICATE_EXPIRED: 'ssl_certificate_expired',
  SSL_RENEWAL_FAILED: 'ssl_renewal_failed',
  SSL_RENEWAL_SUCCEEDED: 'ssl_renewal_succeeded',
  BACKUP_FAILED: 'backup_failed',
  RESTORE_FAILED: 'restore_failed',
  DISK_THRESHOLD_WARNING: 'disk_threshold_warning',
  DISK_THRESHOLD_CRITICAL: 'disk_threshold_critical',
  INODE_THRESHOLD_WARNING: 'inode_threshold_warning',
  INODE_THRESHOLD_CRITICAL: 'inode_threshold_critical',
  SERVICE_OUTAGE: 'service_outage',
  TEST_NOTIFICATION: 'test_notification',
});

export const NOTIFICATION_SEVERITY = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
});

export const SEVERITY_LEVELS = Object.freeze({
  info: 10,
  warning: 20,
  critical: 30,
});

export const NOTIFICATION_CATEGORIES = Object.freeze({
  SSL: 'ssl',
  BACKUP: 'backup',
  DISK: 'disk',
  SERVICE: 'service',
  SYSTEM: 'system',
});

export const NOTIFICATION_CHANNELS = Object.freeze({
  EMAIL: 'email',
  WEBHOOK: 'webhook',
  PANEL: 'panel',
});

export const DELIVERY_STATUS = Object.freeze({
  DELIVERED: 'delivered',
  FAILED: 'failed',
  SUPPRESSED: 'suppressed',
  SKIPPED_PREFERENCE: 'skipped_preference',
  SKIPPED_TENANT: 'skipped_tenant',
});

export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  enabled: true,
  minSeverity: NOTIFICATION_SEVERITY.INFO,
  categories: Object.freeze({
    ssl: true,
    backup: true,
    disk: true,
    service: true,
    system: true,
  }),
  channels: Object.freeze({
    email: Object.freeze({
      enabled: true,
      address: null,
    }),
    webhook: Object.freeze({
      enabled: false,
      url: null,
    }),
    panel: Object.freeze({
      enabled: true,
    }),
  }),
  throttling: Object.freeze({
    windowMinutes: 60,
  }),
});

export function mapEventToCategory(eventType) {
  if (typeof eventType !== 'string') return NOTIFICATION_CATEGORIES.SYSTEM;
  if (eventType.startsWith('ssl_')) return NOTIFICATION_CATEGORIES.SSL;
  if (eventType === 'backup_failed' || eventType === 'restore_failed') return NOTIFICATION_CATEGORIES.BACKUP;
  if (eventType.startsWith('disk_') || eventType.startsWith('inode_')) return NOTIFICATION_CATEGORIES.DISK;
  if (eventType.startsWith('service_')) return NOTIFICATION_CATEGORIES.SERVICE;
  return NOTIFICATION_CATEGORIES.SYSTEM;
}
