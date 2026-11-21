import { AuthError } from './auth-error.js';

const quotaFields = Object.freeze(['maxWebsites', 'maxDiskMb', 'maxTrafficMb', 'maxDatabases']);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const invalid = () => new AuthError('invalid_customer_quotas', 'Customer quotas must specify maxWebsites, maxDiskMb, maxTrafficMb, and maxDatabases as non-negative integers or null.', 400);

export function initializeCustomerQuotaSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_customer_quotas (
      customer_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_hosting_accounts(user_id) ON DELETE CASCADE,
      max_websites INTEGER CHECK(max_websites IS NULL OR (typeof(max_websites) = 'integer' AND max_websites >= 0)),
      max_disk_mb INTEGER CHECK(max_disk_mb IS NULL OR (typeof(max_disk_mb) = 'integer' AND max_disk_mb >= 0)),
      max_traffic_mb INTEGER CHECK(max_traffic_mb IS NULL OR (typeof(max_traffic_mb) = 'integer' AND max_traffic_mb >= 0)),
      max_databases INTEGER CHECK(max_databases IS NULL OR (typeof(max_databases) = 'integer' AND max_databases >= 0)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

export function validateCustomerQuotas(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  for (const key of Object.keys(input)) {
    if (!quotaFields.includes(key)) throw invalid();
  }
  for (const key of quotaFields) {
    if (!Object.hasOwn(input, key)) throw invalid();
    if (input[key] !== null && !count(input[key])) throw invalid();
  }
  return {
    maxWebsites: input.maxWebsites,
    maxDiskMb: input.maxDiskMb,
    maxTrafficMb: input.maxTrafficMb,
    maxDatabases: input.maxDatabases,
  };
}

export function assertCustomerQuotaCapacity({ quotas, usage, resource = 'websites', amount = 1 } = {}) {
  const currentQuotas = validateCustomerQuotas(quotas);
  if (!usage || typeof usage !== 'object' || !count(usage[resource])) throw invalid();
  if (!Number.isSafeInteger(amount) || amount < 1) throw invalid();
  const next = usage[resource] + amount;
  const field = resource === 'websites' ? 'maxWebsites' : resource === 'diskMb' ? 'maxDiskMb' : resource === 'trafficMb' ? 'maxTrafficMb' : 'maxDatabases';
  const limit = currentQuotas[field];
  if (limit !== null && next > limit) {
    throw new AuthError('customer_quota_exceeded', 'The customer account quota does not allow this addition.', 409);
  }
}

export function assertCustomerQuotaWithinResellerCapacity({ customerQuotas, resellerLimits } = {}) {
  if (resellerLimits?.maxWebsites !== null && (customerQuotas?.maxWebsites === null || customerQuotas.maxWebsites > resellerLimits.maxWebsites)) {
    throw new AuthError('reseller_limit_reached', 'Customer website quota cannot exceed the reseller maximum websites limit.', 409);
  }
}

export const RESOURCE_METRICS = Object.freeze({
  diskSpaceMb: Object.freeze({ category: 'disk', key: 'diskSpaceMb', label: 'Disk Alanı', unit: 'MB' }),
  diskInodes: Object.freeze({ category: 'disk', key: 'diskInodes', label: 'Disk Inode', unit: 'count' }),
  mailStorageMb: Object.freeze({ category: 'mail', key: 'mailStorageMb', label: 'Posta Depolama', unit: 'MB' }),
  mailboxes: Object.freeze({ category: 'mail', key: 'mailboxes', label: 'Posta Kutusu Sayısı', unit: 'count' }),
  databaseStorageMb: Object.freeze({ category: 'database', key: 'databaseStorageMb', label: 'Veritabanı Depolama', unit: 'MB' }),
  databases: Object.freeze({ category: 'database', key: 'databases', label: 'Veritabanı Sayısı', unit: 'count' }),
  trafficMb: Object.freeze({ category: 'traffic', key: 'trafficMb', label: 'Aylık Trafik', unit: 'MB' }),
  cpuPercent: Object.freeze({ category: 'cpu', key: 'cpuPercent', label: 'CPU Kullanımı', unit: 'percent' }),
  memoryMb: Object.freeze({ category: 'memory', key: 'memoryMb', label: 'Bellek (RAM)', unit: 'MB' }),
  processCount: Object.freeze({ category: 'process', key: 'processCount', label: 'Süreç Sayısı', unit: 'count' }),
});

function normalizeMeasuredTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Date(parsed).toISOString();
}

function normalizeOptionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function evaluateResourceMetric({
  metric,
  measured = null,
  definedLimit = null,
  enforcedLimit = null,
  warnThreshold = 0.85,
  measuredAt = null,
  bytes = null,
  period = null,
  scope = null,
  reasonCode = null,
  reason = null,
  definedLimitScope = null,
} = {}) {
  const isMeasured = measured !== null && measured !== undefined && typeof measured === 'number' && Number.isFinite(measured);
  const measuredValue = isMeasured ? measured : null;
  const unknown = !isMeasured;

  const defined = (definedLimit !== null && definedLimit !== undefined && Number.isFinite(definedLimit)) ? definedLimit : null;
  const enforced = (enforcedLimit !== null && enforcedLimit !== undefined && Number.isFinite(enforcedLimit)) ? enforcedLimit : null;

  const effectiveLimit = enforced !== null ? enforced : defined;

  let status = 'unknown';
  let exceeded = false;
  let warning = false;

  if (isMeasured) {
    if (effectiveLimit !== null && effectiveLimit > 0) {
      if (measuredValue > effectiveLimit) {
        status = 'exceeded';
        exceeded = true;
      } else if (measuredValue >= effectiveLimit * warnThreshold) {
        status = 'warning';
        warning = true;
      } else {
        status = 'ok';
      }
    } else {
      status = 'ok';
    }
  }

  const def = typeof metric === 'string' && RESOURCE_METRICS[metric] ? RESOURCE_METRICS[metric] : null;
  const normalizedMeasuredAt = isMeasured ? normalizeMeasuredTimestamp(measuredAt) : null;
  const normalizedBytes = isMeasured && typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : null;

  return Object.freeze({
    metric: typeof metric === 'string' ? metric : (def?.key ?? 'unknown'),
    category: def?.category ?? null,
    unit: def?.unit ?? null,
    label: def?.label ?? null,
    measured: measuredValue,
    definedLimit: defined,
    enforcedLimit: enforced,
    enforced: enforced !== null,
    effectiveLimit,
    unknown,
    status,
    exceeded,
    warning,
    measuredAt: normalizedMeasuredAt,
    bytes: normalizedBytes,
    period: normalizeOptionalText(period),
    scope: normalizeOptionalText(scope),
    reasonCode: normalizeOptionalText(reasonCode),
    reason: normalizeOptionalText(reason),
    definedLimitScope: normalizeOptionalText(definedLimitScope),
  });
}

export function buildSiteConsumptionReport({
  websiteId,
  customerId = null,
  measurements = {},
  definedLimits = {},
  enforcedLimits = {},
  metricDetails = {},
  definedLimitScopes = {},
  inspectedAt = Date.now(),
} = {}) {
  if (!websiteId || typeof websiteId !== 'string') {
    throw new AuthError('invalid_site_consumption_input', 'websiteId is required', 400);
  }

  const metrics = {};
  let anyExceeded = false;
  const warnings = [];
  const exceededList = [];

  for (const [key] of Object.entries(RESOURCE_METRICS)) {
    const measured = measurements?.[key] ?? null;
    const defined = definedLimits?.[key] ?? null;
    const enforced = enforcedLimits?.[key] ?? null;
    const detail = metricDetails?.[key] && typeof metricDetails[key] === 'object' ? metricDetails[key] : null;

    const evaluated = evaluateResourceMetric({
      metric: key,
      measured,
      definedLimit: defined,
      enforcedLimit: enforced,
      measuredAt: detail?.measuredAt ?? null,
      bytes: detail?.bytes ?? null,
      period: detail?.period ?? null,
      scope: detail?.scope ?? null,
      reasonCode: detail?.reasonCode ?? null,
      reason: detail?.reason ?? null,
      definedLimitScope: definedLimitScopes?.[key] ?? detail?.definedLimitScope ?? null,
    });

    metrics[key] = evaluated;
    if (evaluated.exceeded) {
      anyExceeded = true;
      exceededList.push(key);
    } else if (evaluated.warning) {
      warnings.push(key);
    }
  }

  const measuredMetrics = Object.values(metrics).filter((item) => !item.unknown);
  let measuredAt = null;
  if (measuredMetrics.length > 0) {
    const explicitTimestamps = measuredMetrics
      .map((item) => (item.measuredAt ? Date.parse(item.measuredAt) : Number.NaN))
      .filter((ts) => Number.isFinite(ts) && ts > 0);
    if (explicitTimestamps.length > 0) {
      measuredAt = new Date(Math.max(...explicitTimestamps)).toISOString();
    } else {
      measuredAt = normalizeMeasuredTimestamp(inspectedAt);
    }
  }

  const categories = Object.freeze({
    disk: Object.freeze({
      spaceMb: metrics.diskSpaceMb,
      inodes: metrics.diskInodes,
    }),
    mail: Object.freeze({
      storageMb: metrics.mailStorageMb,
      mailboxes: metrics.mailboxes,
    }),
    database: Object.freeze({
      storageMb: metrics.databaseStorageMb,
      databases: metrics.databases,
    }),
    traffic: Object.freeze({
      usageMb: metrics.trafficMb,
    }),
    cpu: Object.freeze({
      usage: metrics.cpuPercent,
    }),
    memory: Object.freeze({
      usage: metrics.memoryMb,
    }),
    process: Object.freeze({
      count: metrics.processCount,
    }),
  });

  return Object.freeze({
    websiteId,
    customerId,
    inspectedAt,
    measuredAt,
    exceeded: anyExceeded,
    exceededMetrics: Object.freeze(exceededList),
    warningMetrics: Object.freeze(warnings),
    categories,
    metrics: Object.freeze(metrics),
  });
}

export function assertSiteResourceLimit({ report, metric = null } = {}) {
  if (!report || typeof report !== 'object') {
    throw new AuthError('invalid_site_consumption_report', 'Valid consumption report required', 400);
  }
  if (metric) {
    const item = report.metrics?.[metric];
    if (item?.exceeded) {
      throw new AuthError('site_quota_exceeded', `Resource limit exceeded for ${item.label || metric}: measured ${item.measured} exceeds limit ${item.effectiveLimit}`, 409);
    }
    return;
  }
  if (report.exceeded) {
    const firstExceeded = report.exceededMetrics?.[0];
    const item = report.metrics?.[firstExceeded];
    throw new AuthError('site_quota_exceeded', `Resource limit exceeded for ${item?.label || firstExceeded || 'site'}`, 409);
  }
}

export function assertSiteIsolation({ breachedSiteReport, isolatedSiteReport } = {}) {
  if (!breachedSiteReport || !isolatedSiteReport) {
    throw new AuthError('invalid_isolation_assertion', 'Both site reports are required', 400);
  }
  if (breachedSiteReport.websiteId === isolatedSiteReport.websiteId) {
    throw new AuthError('invalid_isolation_assertion', 'Sites must be distinct for isolation verification', 400);
  }
  if (isolatedSiteReport.exceeded) {
    throw new AuthError('site_isolation_violation', `Site ${isolatedSiteReport.websiteId} was unexpectedly impacted by breach on ${breachedSiteReport.websiteId}`, 409);
  }
  return true;
}

export function createSiteConsumptionInspector({
  websiteRegistry = null,
  domainRegistry = null,
  databaseBindingRegistry = null,
  mailboxRegistry = null,
  systemInspector = null,
} = {}) {
  return Object.freeze({
    async inspectWebsite(websiteId, { customerId = null, definedLimits = {}, enforcedLimits = {}, definedLimitScopes = {}, signal = null } = {}) {
      if (!websiteId || typeof websiteId !== 'string') {
        throw new AuthError('invalid_site_consumption_input', 'websiteId is required', 400);
      }

      let website = null;
      if (websiteRegistry?.getWebsite) {
        try {
          website = await websiteRegistry.getWebsite(websiteId);
        } catch {
          website = null;
        }
      }

      const resolvedCustomerId = customerId ?? website?.customerId ?? null;
      const measurements = {};
      const metricDetails = {};

      if (systemInspector) {
        try {
          if (typeof systemInspector.getDiskUsage === 'function') {
            const disk = await systemInspector.getDiskUsage(websiteId, website, { signal });
            if (disk) {
              if (disk.spaceMb !== undefined) measurements.diskSpaceMb = disk.spaceMb;
              if (disk.inodes !== undefined) measurements.diskInodes = disk.inodes;
              metricDetails.diskSpaceMb = {
                measuredAt: disk.measuredAt ?? null,
                bytes: disk.bytes ?? null,
                scope: disk.scope ?? null,
                reasonCode: disk.reasonCode ?? null,
                reason: disk.reason ?? null,
              };
              if (disk.inodes !== undefined) {
                metricDetails.diskInodes = {
                  measuredAt: disk.measuredAt ?? null,
                  scope: disk.scope ?? null,
                  reasonCode: disk.reasonCode ?? null,
                  reason: disk.reason ?? null,
                };
              }
            }
          }
        } catch {
          metricDetails.diskSpaceMb = {
            measuredAt: null,
            reasonCode: 'disk_measurement_failed',
            reason: 'Disk kullanımı ölçülürken beklenmeyen bir hata oluştu.',
          };
        }

        try {
          if (typeof systemInspector.getMailUsage === 'function') {
            const mail = await systemInspector.getMailUsage(websiteId, website);
            if (mail) {
              if (mail.storageMb !== undefined) measurements.mailStorageMb = mail.storageMb;
              if (mail.mailboxes !== undefined) measurements.mailboxes = mail.mailboxes;
              metricDetails.mailStorageMb = {
                measuredAt: mail.measuredAt ?? null,
                scope: mail.scope ?? null,
                reasonCode: mail.reasonCode ?? null,
                reason: mail.reason ?? null,
              };
              metricDetails.mailboxes = {
                measuredAt: mail.measuredAt ?? null,
                scope: mail.scope ?? null,
                reasonCode: mail.reasonCode ?? null,
                reason: mail.reason ?? null,
              };
            }
          }
        } catch {
          // Failure leaves metric as unmeasured (null)
        }

        try {
          if (typeof systemInspector.getDatabaseUsage === 'function') {
            const dbUsage = await systemInspector.getDatabaseUsage(websiteId, website);
            if (dbUsage) {
              if (dbUsage.storageMb !== undefined) measurements.databaseStorageMb = dbUsage.storageMb;
              if (dbUsage.databases !== undefined) measurements.databases = dbUsage.databases;
              metricDetails.databases = {
                measuredAt: dbUsage.measuredAt ?? null,
                scope: dbUsage.scope ?? null,
                reasonCode: dbUsage.reasonCode ?? null,
                reason: dbUsage.reason ?? null,
              };
              if (dbUsage.storageMb !== undefined && dbUsage.storageMb !== null) {
                metricDetails.databaseStorageMb = {
                  measuredAt: dbUsage.measuredAt ?? null,
                  scope: dbUsage.scope ?? null,
                };
              }
            }
          }
        } catch {
          measurements.databases = null;
          metricDetails.databases = {
            measuredAt: null,
            reasonCode: 'database_inventory_unavailable',
            reason: 'Veritabanı bağlantı envanteri okunamadığı için sayı doğrulanamadı.',
          };
        }

        try {
          if (typeof systemInspector.getTrafficUsage === 'function') {
            const traffic = await systemInspector.getTrafficUsage(websiteId, website);
            if (traffic) {
              if (traffic.trafficMb !== undefined) measurements.trafficMb = traffic.trafficMb;
              metricDetails.trafficMb = {
                measuredAt: traffic.measuredAt ?? null,
                period: traffic.period ?? null,
                scope: traffic.scope ?? null,
                reasonCode: traffic.reasonCode ?? null,
                reason: traffic.reason ?? null,
              };
            }
          }
        } catch {
          measurements.trafficMb = null;
          metricDetails.trafficMb = {
            measuredAt: null,
            reasonCode: 'traffic_source_unavailable',
            reason: 'Aylık trafik verisi okunamadı.',
          };
        }

        try {
          if (typeof systemInspector.getCpuUsage === 'function') {
            const cpu = await systemInspector.getCpuUsage(websiteId, website);
            if (cpu && cpu.percent !== undefined) {
              measurements.cpuPercent = cpu.percent;
              metricDetails.cpuPercent = {
                measuredAt: cpu.measuredAt ?? null,
                scope: cpu.scope ?? null,
                reasonCode: cpu.reasonCode ?? null,
                reason: cpu.reason ?? null,
              };
            }
          }
        } catch {
          // Failure leaves metric as unmeasured (null)
        }

        try {
          if (typeof systemInspector.getMemoryUsage === 'function') {
            const mem = await systemInspector.getMemoryUsage(websiteId, website);
            if (mem && mem.usageMb !== undefined) {
              measurements.memoryMb = mem.usageMb;
              metricDetails.memoryMb = {
                measuredAt: mem.measuredAt ?? null,
                scope: mem.scope ?? null,
                reasonCode: mem.reasonCode ?? null,
                reason: mem.reason ?? null,
              };
            }
          }
        } catch {
          // Failure leaves metric as unmeasured (null)
        }

        try {
          if (typeof systemInspector.getProcessUsage === 'function') {
            const proc = await systemInspector.getProcessUsage(websiteId, website);
            if (proc && proc.count !== undefined) {
              measurements.processCount = proc.count;
              metricDetails.processCount = {
                measuredAt: proc.measuredAt ?? null,
                scope: proc.scope ?? null,
                reasonCode: proc.reasonCode ?? null,
                reason: proc.reason ?? null,
              };
            }
          }
        } catch {
          // Failure leaves metric as unmeasured (null)
        }
      }

      if (measurements.databases === undefined && databaseBindingRegistry) {
        if (typeof databaseBindingRegistry.listBindings === 'function') {
          try {
            const bindings = await databaseBindingRegistry.listBindings({
              serverId: website?.serverId ?? null,
              websiteId,
            });
            if (Array.isArray(bindings)) {
              measurements.databases = bindings.filter((b) => (
                b
                && b.websiteId === websiteId
                && (!website?.serverId || b.serverId === website.serverId)
                && (!website?.applicationId || b.applicationId === website.applicationId)
              )).length;
              metricDetails.databases = {
                measuredAt: new Date().toISOString(),
                scope: 'canonical_active_bindings',
              };
            }
          } catch {
            measurements.databases = null;
            metricDetails.databases = {
              measuredAt: null,
              reasonCode: 'database_inventory_unavailable',
              reason: 'Veritabanı bağlantı envanteri okunamadığı için sayı doğrulanamadı.',
            };
          }
        } else if (typeof databaseBindingRegistry.listDatabaseBindings === 'function') {
          try {
            const bindings = await databaseBindingRegistry.listDatabaseBindings();
            if (Array.isArray(bindings)) {
              measurements.databases = bindings.filter((b) => b && b.websiteId === websiteId).length;
              metricDetails.databases = {
                measuredAt: new Date().toISOString(),
                scope: 'canonical_active_bindings',
              };
            }
          } catch {
            measurements.databases = null;
            metricDetails.databases = {
              measuredAt: null,
              reasonCode: 'database_inventory_unavailable',
              reason: 'Veritabanı bağlantı envanteri okunamadığı için sayı doğrulanamadı.',
            };
          }
        }
      }

      return buildSiteConsumptionReport({
        websiteId,
        customerId: resolvedCustomerId,
        measurements,
        definedLimits: definedLimits ?? website?.quotas ?? {},
        enforcedLimits: enforcedLimits ?? website?.enforcedLimits ?? {},
        metricDetails,
        definedLimitScopes,
      });
    },
  });
}
