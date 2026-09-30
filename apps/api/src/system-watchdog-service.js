import { randomUUID } from 'node:crypto';
import {
  MANAGED_SERVICE_CONTROL_IDS,
  MANAGED_SERVICE_IDS,
} from '@yunpanel/protocol';
import { managedServiceManager } from '@yunpanel/host-runtime';

export class SystemWatchdogError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SystemWatchdogError';
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_STALLED_JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_BACKLOG_WARNING_THRESHOLD = 20;
const DEFAULT_OLDEST_QUEUED_WARNING_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_RECOVERIES_PER_WINDOW = 3;
const DEFAULT_RECOVERY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RECOVERY_HISTORY = 100;

const DEFAULT_CRITICAL_SERVICES = Object.freeze([
  'nginx', 'mariadb', 'mysql', 'docker', 'cron', 'postfix', 'dovecot',
]);

const VALID_TARGET_TYPES = new Set(['service', 'job', 'executor', 'daemon']);

export function createSystemWatchdogService({
  serverRegistry = null,
  jobRegistry = null,
  localJobExecutor = null,
  localRuntime = null,
  inspectServices = null,
  serviceControl = null,
  daemons = {},
  stalledJobTimeoutMs = DEFAULT_STALLED_JOB_TIMEOUT_MS,
  backlogWarningThreshold = DEFAULT_BACKLOG_WARNING_THRESHOLD,
  oldestQueuedWarningMs = DEFAULT_OLDEST_QUEUED_WARNING_MS,
  maxRecoveriesPerWindow = DEFAULT_MAX_RECOVERIES_PER_WINDOW,
  recoveryWindowMs = DEFAULT_RECOVERY_WINDOW_MS,
  autoRecoveryEnabled = true,
  criticalServiceIds = DEFAULT_CRITICAL_SERVICES,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const criticalSet = new Set(criticalServiceIds);
  const recoveryLog = [];
  const recoveryAttemptsByTarget = new Map();
  let checkCount = 0;
  let lastCheckAt = null;
  let lastReport = null;
  let sweepTimer = null;
  let autoRecoveryActive = autoRecoveryEnabled;

  const defaultInspectServices = async () => {
    try {
      return await managedServiceManager.inspect();
    } catch {
      return [];
    }
  };

  const defaultServiceControl = async (serviceId, action) => {
    return managedServiceManager.control(serviceId, action);
  };

  const effectiveInspectServices = inspectServices ?? defaultInspectServices;
  const effectiveServiceControl = serviceControl ?? defaultServiceControl;

  function pruneOldRecoveryAttempts(targetKey, currentTime) {
    const attempts = recoveryAttemptsByTarget.get(targetKey) ?? [];
    const validAttempts = attempts.filter((ts) => currentTime - ts < recoveryWindowMs);
    if (validAttempts.length > 0) {
      recoveryAttemptsByTarget.set(targetKey, validAttempts);
    } else {
      recoveryAttemptsByTarget.delete(targetKey);
    }
    return validAttempts;
  }

  function isFlapping(targetKey, currentTime) {
    const attempts = pruneOldRecoveryAttempts(targetKey, currentTime);
    return attempts.length >= maxRecoveriesPerWindow;
  }

  function recordRecoveryAttempt(targetKey, currentTime) {
    const attempts = pruneOldRecoveryAttempts(targetKey, currentTime);
    attempts.push(currentTime);
    recoveryAttemptsByTarget.set(targetKey, attempts);
  }

  function logRecoveryEvent({ targetType, targetId, action, status, reason = null, error = null }) {
    const currentTime = now();
    const event = Object.freeze({
      id: `rec-${randomUUID()}`,
      timestamp: new Date(currentTime).toISOString(),
      timeMs: currentTime,
      targetType,
      targetId,
      action,
      status, // 'succeeded' | 'failed' | 'suppressed_flapping'
      reason,
      error: error ? { code: error.code ?? 'recovery_error', message: error.message ?? String(error) } : null,
    });
    recoveryLog.push(event);
    if (recoveryLog.length > MAX_RECOVERY_HISTORY) {
      recoveryLog.shift();
    }
    return event;
  }

  async function inspectManagedServices(currentTime) {
    let serviceList = [];
    try {
      const inspected = await effectiveInspectServices();
      serviceList = Array.isArray(inspected) ? inspected : [];
    } catch (err) {
      logger.error?.('[system-watchdog] Service inspection failed:', err);
    }

    const items = [];
    const incidents = [];

    for (const s of serviceList) {
      const id = s.id;
      const isCritical = criticalSet.has(id);
      const isInstalled = Boolean(s.installed);
      const units = Array.isArray(s.units) ? s.units : [];
      const hasUnits = units.length > 0;
      const isActive = hasUnits ? Boolean(s.active) : true;
      const isControllable = MANAGED_SERVICE_CONTROL_IDS.includes(id);
      const targetKey = `service:${id}`;
      const flapping = isFlapping(targetKey, currentTime);
      const recoveryAttempts = (recoveryAttemptsByTarget.get(targetKey) ?? []).length;

      let serviceStatus = 'ok';
      if (isInstalled && hasUnits && !isActive) {
        serviceStatus = 'inactive';
        incidents.push({
          type: 'service',
          targetId: id,
          code: 'service_inactive',
          critical: isCritical,
          controllable: isControllable,
          flapping,
          message: `Service ${s.label || id} is installed but not active`,
        });
      } else if (s.health?.status === 'configuration_invalid') {
        serviceStatus = 'configuration_invalid';
        incidents.push({
          type: 'service',
          targetId: id,
          code: 'service_configuration_invalid',
          critical: isCritical,
          controllable: false,
          flapping: false,
          message: `Service ${s.label || id} has invalid configuration`,
        });
      }

      items.push({
        id,
        label: s.label || id,
        category: s.category || 'system',
        installed: isInstalled,
        active: isActive,
        status: serviceStatus,
        critical: isCritical,
        controllable: isControllable,
        flapping,
        recoveryAttempts,
        units: units.map((u) => ({
          unit: u.unit,
          activeState: u.activeState,
          subState: u.subState,
          unitFileState: u.unitFileState,
        })),
      });
    }

    return { services: items, incidents };
  }

  async function inspectJobQueue(serverId, currentTime) {
    const queueReport = {
      queuedCount: 0,
      runningCount: 0,
      stalledCount: 0,
      oldestQueuedAgeMs: 0,
      backlogWarning: false,
      stalledJobs: [],
      worker: {
        running: true,
        fault: null,
      },
    };
    const incidents = [];

    if (!jobRegistry || typeof jobRegistry.listJobs !== 'function') {
      return { queueReport, incidents };
    }

    try {
      const [queuedJobs, runningJobs] = await Promise.all([
        jobRegistry.listJobs(serverId ? { serverId, status: 'queued' } : { status: 'queued' }),
        jobRegistry.listJobs(serverId ? { serverId, status: 'running' } : { status: 'running' }),
      ]);

      queueReport.queuedCount = queuedJobs.length;
      queueReport.runningCount = runningJobs.length;

      if (queuedJobs.length > 0) {
        let oldestCreatedAt = Infinity;
        for (const job of queuedJobs) {
          const ts = Date.parse(job.createdAt);
          if (Number.isFinite(ts) && ts < oldestCreatedAt) {
            oldestCreatedAt = ts;
          }
        }
        if (Number.isFinite(oldestCreatedAt)) {
          queueReport.oldestQueuedAgeMs = Math.max(0, currentTime - oldestCreatedAt);
        }
      }

      if (
        queueReport.queuedCount >= backlogWarningThreshold ||
        queueReport.oldestQueuedAgeMs >= oldestQueuedWarningMs
      ) {
        queueReport.backlogWarning = true;
        incidents.push({
          type: 'queue',
          targetId: 'job_queue',
          code: 'queue_backlog_elevated',
          critical: false,
          message: `Job queue backlog is elevated: ${queueReport.queuedCount} queued, oldest age ${Math.round(queueReport.oldestQueuedAgeMs / 1000)}s`,
        });
      }

      for (const job of runningJobs) {
        const started = Date.parse(job.startedAt || job.updatedAt || job.createdAt);
        const durationMs = Number.isFinite(started) ? Math.max(0, currentTime - started) : 0;
        if (durationMs > stalledJobTimeoutMs) {
          const stalledInfo = {
            id: job.id,
            operation: job.operation,
            serverId: job.serverId,
            runningDurationMs: durationMs,
          };
          queueReport.stalledJobs.push(stalledInfo);
          incidents.push({
            type: 'job',
            targetId: job.id,
            code: 'job_stalled',
            critical: true,
            job: stalledInfo,
            message: `Job ${job.id} (${job.operation}) is stalled in running state for ${Math.round(durationMs / 1000)}s`,
          });
        }
      }
      queueReport.stalledCount = queueReport.stalledJobs.length;
    } catch (err) {
      logger.error?.('[system-watchdog] Job queue inspection failed:', err);
    }

    // Inspect executor / runtime state
    const executor = (typeof localJobExecutor === 'function' ? localJobExecutor() : localJobExecutor)
      || (typeof localRuntime === 'function' ? localRuntime() : localRuntime);
    if (executor) {
      const isRunning = typeof executor.running === 'function' ? executor.running() : true;
      const fault = typeof executor.failure === 'function' ? executor.failure() : null;

      queueReport.worker.running = isRunning;
      queueReport.worker.fault = fault;

      if (fault) {
        incidents.push({
          type: 'executor',
          targetId: 'local_executor',
          code: 'executor_faulted',
          critical: true,
          fault,
          message: `Job executor entered fault state: ${fault.code || 'unknown'} (${fault.message || ''})`,
        });
      } else if (!isRunning) {
        incidents.push({
          type: 'executor',
          targetId: 'local_executor',
          code: 'executor_stopped',
          critical: true,
          message: 'Job executor is unexpectedly stopped',
        });
      }
    }

    return { queueReport, incidents };
  }

  async function inspectDaemons(currentTime) {
    const daemonReports = {};
    const incidents = [];
    const resolvedDaemons = typeof daemons === 'function' ? daemons() : (daemons ?? {});

    for (const [key, daemon] of Object.entries(resolvedDaemons)) {
      if (!daemon) continue;
      let healthy = true;
      let message = 'running';

      try {
        if (typeof daemon.status === 'function') {
          const res = await daemon.status();
          healthy = res.healthy !== false && res.status !== 'stopped' && res.status !== 'error';
          message = res.message || res.status || 'ok';
        } else if (typeof daemon.isRunning === 'function') {
          healthy = daemon.isRunning() === true;
          message = healthy ? 'running' : 'stopped';
        } else if (daemon.running !== undefined) {
          healthy = Boolean(daemon.running);
          message = healthy ? 'running' : 'stopped';
        }
      } catch (err) {
        healthy = false;
        message = err.message || 'check_failed';
      }

      daemonReports[key] = {
        name: daemon.name || key,
        healthy,
        status: message,
      };

      if (!healthy) {
        incidents.push({
          type: 'daemon',
          targetId: key,
          code: 'daemon_unhealthy',
          critical: daemon.critical === true,
          message: `Daemon ${daemon.name || key} is unhealthy: ${message}`,
        });
      }
    }

    return { daemons: daemonReports, incidents };
  }

  async function inspect({ serverId = null } = {}) {
    const currentTime = now();
    const [serviceRes, queueRes, daemonRes] = await Promise.all([
      inspectManagedServices(currentTime),
      inspectJobQueue(serverId, currentTime),
      inspectDaemons(currentTime),
    ]);

    const allIncidents = [
      ...serviceRes.incidents,
      ...queueRes.incidents,
      ...daemonRes.incidents,
    ];

    let overallStatus = 'healthy';
    const hasCriticalIncidents = allIncidents.some((i) => i.critical);
    const hasNonCriticalIncidents = allIncidents.some((i) => !i.critical);

    if (hasCriticalIncidents) {
      overallStatus = 'unhealthy';
    } else if (hasNonCriticalIncidents) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      serverId,
      timestamp: new Date(currentTime).toISOString(),
      summary: {
        servicesHealthy: serviceRes.incidents.length === 0,
        queueHealthy: queueRes.incidents.length === 0,
        executorHealthy: !queueRes.queueReport.worker.fault && queueRes.queueReport.worker.running,
        daemonsHealthy: daemonRes.incidents.length === 0,
        activeIncidentsCount: allIncidents.length,
      },
      services: serviceRes.services,
      queue: queueRes.queueReport,
      daemons: daemonRes.daemons,
      incidents: allIncidents,
      recovery: {
        autoRecoveryEnabled: autoRecoveryActive,
        totalRecoveries: recoveryLog.length,
        recentEvents: recoveryLog.slice(-20),
      },
    };
  }

  async function runAutoRecovery({ serverId = null, incidents = [] } = {}) {
    if (!autoRecoveryActive) {
      return { recovered: [], suppressed: [], errors: [] };
    }

    const recovered = [];
    const suppressed = [];
    const errors = [];
    const currentTime = now();

    for (const incident of incidents) {
      // 1. Inactive or Failed Managed Services
      if (incident.type === 'service' && incident.code === 'service_inactive' && incident.controllable) {
        const targetId = incident.targetId;
        const targetKey = `service:${targetId}`;

        if (isFlapping(targetKey, currentTime)) {
          const evt = logRecoveryEvent({
            targetType: 'service',
            targetId,
            action: 'restart',
            status: 'suppressed_flapping',
            reason: `Recovery suppressed: exceeded ${maxRecoveriesPerWindow} attempts within window`,
          });
          suppressed.push(evt);
          continue;
        }

        recordRecoveryAttempt(targetKey, currentTime);
        try {
          await effectiveServiceControl(targetId, 'restart');
          const evt = logRecoveryEvent({
            targetType: 'service',
            targetId,
            action: 'restart',
            status: 'succeeded',
            reason: 'Automatically restarted inactive service',
          });
          recovered.push(evt);
        } catch (err) {
          const evt = logRecoveryEvent({
            targetType: 'service',
            targetId,
            action: 'restart',
            status: 'failed',
            reason: 'Failed to restart inactive service',
            error: err,
          });
          errors.push(evt);
        }
      }

      // 2. Stalled Jobs
      if (incident.type === 'job' && incident.code === 'job_stalled') {
        const jobId = incident.targetId;
        const targetKey = `job:${jobId}`;

        if (isFlapping(targetKey, currentTime)) {
          const evt = logRecoveryEvent({
            targetType: 'job',
            targetId: jobId,
            action: 'fail_stalled',
            status: 'suppressed_flapping',
            reason: 'Job recovery attempt already recorded',
          });
          suppressed.push(evt);
          continue;
        }

        recordRecoveryAttempt(targetKey, currentTime);
        try {
          if (jobRegistry && typeof jobRegistry.complete === 'function') {
            await jobRegistry.complete({
              serverId: incident.job?.serverId ?? serverId,
              jobId,
              status: 'failed',
              error: {
                code: 'job_stalled_timeout',
                message: `Job exceeded execution timeout of ${Math.round((incident.job?.runningDurationMs ?? stalledJobTimeoutMs) / 1000)}s; cancelled by watchdog`,
              },
            });
            const evt = logRecoveryEvent({
              targetType: 'job',
              targetId: jobId,
              action: 'fail_stalled',
              status: 'succeeded',
              reason: 'Safely completed stalled job as failed to release queue deadlock',
            });
            recovered.push(evt);
          }
        } catch (err) {
          const evt = logRecoveryEvent({
            targetType: 'job',
            targetId: jobId,
            action: 'fail_stalled',
            status: 'failed',
            reason: 'Failed to complete stalled job',
            error: err,
          });
          errors.push(evt);
        }
      }

      // 3. Executor Stopped Unexpectedly (without fatal fault)
      if (incident.type === 'executor' && incident.code === 'executor_stopped') {
        const executor = (typeof localJobExecutor === 'function' ? localJobExecutor() : localJobExecutor)
          || (typeof localRuntime === 'function' ? localRuntime() : localRuntime);
        const targetKey = 'executor:local';

        if (isFlapping(targetKey, currentTime)) {
          const evt = logRecoveryEvent({
            targetType: 'executor',
            targetId: 'local_executor',
            action: 'restart',
            status: 'suppressed_flapping',
            reason: 'Executor recovery suppressed due to flapping threshold',
          });
          suppressed.push(evt);
          continue;
        }

        recordRecoveryAttempt(targetKey, currentTime);
        try {
          if (executor && typeof executor.start === 'function') {
            executor.start();
            const evt = logRecoveryEvent({
              targetType: 'executor',
              targetId: 'local_executor',
              action: 'restart',
              status: 'succeeded',
              reason: 'Safely restarted stopped local job executor',
            });
            recovered.push(evt);
          }
        } catch (err) {
          const evt = logRecoveryEvent({
            targetType: 'executor',
            targetId: 'local_executor',
            action: 'restart',
            status: 'failed',
            reason: 'Failed to restart local job executor',
            error: err,
          });
          errors.push(evt);
        }
      }

      // 4. Stopped Daemons with restart method
      if (incident.type === 'daemon' && incident.code === 'daemon_unhealthy') {
        const daemonKey = incident.targetId;
        const resolvedDaemons = typeof daemons === 'function' ? daemons() : (daemons ?? {});
        const daemon = resolvedDaemons[daemonKey];
        if (daemon && typeof daemon.start === 'function') {
          const targetKey = `daemon:${daemonKey}`;
          if (!isFlapping(targetKey, currentTime)) {
            recordRecoveryAttempt(targetKey, currentTime);
            try {
              await daemon.start();
              const evt = logRecoveryEvent({
                targetType: 'daemon',
                targetId: daemonKey,
                action: 'restart',
                status: 'succeeded',
                reason: `Restarted daemon ${daemonKey}`,
              });
              recovered.push(evt);
            } catch (err) {
              const evt = logRecoveryEvent({
                targetType: 'daemon',
                targetId: daemonKey,
                action: 'restart',
                status: 'failed',
                reason: `Failed to restart daemon ${daemonKey}`,
                error: err,
              });
              errors.push(evt);
            }
          }
        }
      }
    }

    return { recovered, suppressed, errors };
  }

  async function check({ serverId = null } = {}) {
    checkCount += 1;
    lastCheckAt = new Date(now()).toISOString();

    const initialReport = await inspect({ serverId });
    let recoveryResults = { recovered: [], suppressed: [], errors: [] };

    if (initialReport.incidents.length > 0 && autoRecoveryActive) {
      recoveryResults = await runAutoRecovery({ serverId, incidents: initialReport.incidents });
      if (recoveryResults.recovered.length > 0) {
        // Re-inspect to present up-to-date post-recovery status
        const postReport = await inspect({ serverId });
        lastReport = {
          ...postReport,
          lastCheckAt,
          checkCount,
          lastRecoveryResults: recoveryResults,
        };
        return lastReport;
      }
    }

    lastReport = {
      ...initialReport,
      lastCheckAt,
      checkCount,
      lastRecoveryResults: recoveryResults,
    };
    return lastReport;
  }

  async function recoverComponent({ serverId = null, targetType, targetId, confirmation }) {
    if (!VALID_TARGET_TYPES.has(targetType)) {
      throw new SystemWatchdogError('invalid_target_type', `Target type must be one of: ${[...VALID_TARGET_TYPES].join(', ')}`, 400);
    }
    if (!targetId || typeof targetId !== 'string') {
      throw new SystemWatchdogError('target_id_required', 'targetId is required', 400);
    }

    const expectedConfirmation1 = `recover:${targetType}:${targetId}`;
    const expectedConfirmation2 = `recover:${targetId}`;
    if (confirmation !== expectedConfirmation1 && confirmation !== expectedConfirmation2) {
      throw new SystemWatchdogError(
        'watchdog_confirmation_required',
        `Recovery requires confirmation matching ${expectedConfirmation1}`,
        400,
      );
    }

    // Reset flapping threshold on explicit manual recovery
    const targetKey = `${targetType}:${targetId}`;
    recoveryAttemptsByTarget.delete(targetKey);

    let result = null;
    if (targetType === 'service') {
      if (!MANAGED_SERVICE_CONTROL_IDS.includes(targetId)) {
        throw new SystemWatchdogError('managed_service_not_controllable', `Service ${targetId} is not controllable via systemctl`, 400);
      }
      try {
        result = await effectiveServiceControl(targetId, 'restart');
        logRecoveryEvent({
          targetType: 'service',
          targetId,
          action: 'restart',
          status: 'succeeded',
          reason: 'Manual on-demand recovery via API',
        });
      } catch (err) {
        logRecoveryEvent({
          targetType: 'service',
          targetId,
          action: 'restart',
          status: 'failed',
          reason: 'Manual on-demand recovery failed',
          error: err,
        });
        throw new SystemWatchdogError('service_restart_failed', `Failed to restart service ${targetId}: ${err.message}`, 500);
      }
    } else if (targetType === 'job') {
      if (!jobRegistry || typeof jobRegistry.complete !== 'function') {
        throw new SystemWatchdogError('job_registry_unavailable', 'Job registry is not available for recovery', 500);
      }
      try {
        result = await jobRegistry.complete({
          serverId,
          jobId: targetId,
          status: 'failed',
          error: {
            code: 'job_manual_recovery_failed',
            message: 'Job was manually terminated by administrator via watchdog recovery API',
          },
        });
        logRecoveryEvent({
          targetType: 'job',
          targetId,
          action: 'fail_stalled',
          status: 'succeeded',
          reason: 'Manual on-demand recovery via API',
        });
      } catch (err) {
        logRecoveryEvent({
          targetType: 'job',
          targetId,
          action: 'fail_stalled',
          status: 'failed',
          reason: 'Manual on-demand job recovery failed',
          error: err,
        });
        throw new SystemWatchdogError('job_recovery_failed', `Failed to terminate job ${targetId}: ${err.message}`, 500);
      }
    } else if (targetType === 'executor') {
      const executor = (typeof localJobExecutor === 'function' ? localJobExecutor() : localJobExecutor)
        || (typeof localRuntime === 'function' ? localRuntime() : localRuntime);
      if (!executor || typeof executor.start !== 'function') {
        throw new SystemWatchdogError('executor_not_restartable', 'Executor does not support direct restart', 400);
      }
      try {
        executor.start();
        result = { restarted: true };
        logRecoveryEvent({
          targetType: 'executor',
          targetId,
          action: 'restart',
          status: 'succeeded',
          reason: 'Manual on-demand executor restart via API',
        });
      } catch (err) {
        logRecoveryEvent({
          targetType: 'executor',
          targetId,
          action: 'restart',
          status: 'failed',
          reason: 'Manual on-demand executor restart failed',
          error: err,
        });
        throw new SystemWatchdogError('executor_restart_failed', `Failed to restart executor: ${err.message}`, 500);
      }
    } else if (targetType === 'daemon') {
      const resolvedDaemons = typeof daemons === 'function' ? daemons() : (daemons ?? {});
      const daemon = resolvedDaemons[targetId];
      if (!daemon || typeof daemon.start !== 'function') {
        throw new SystemWatchdogError('daemon_not_restartable', `Daemon ${targetId} does not support start/restart`, 400);
      }
      try {
        await daemon.start();
        result = { restarted: true };
        logRecoveryEvent({
          targetType: 'daemon',
          targetId,
          action: 'restart',
          status: 'succeeded',
          reason: 'Manual on-demand daemon restart via API',
        });
      } catch (err) {
        logRecoveryEvent({
          targetType: 'daemon',
          targetId,
          action: 'restart',
          status: 'failed',
          reason: 'Manual on-demand daemon restart failed',
          error: err,
        });
        throw new SystemWatchdogError('daemon_restart_failed', `Failed to restart daemon ${targetId}: ${err.message}`, 500);
      }
    }

    return {
      targetType,
      targetId,
      recovered: true,
      timestamp: new Date(now()).toISOString(),
      result,
    };
  }

  async function getStatus({ serverId = null } = {}) {
    if (lastReport) {
      return lastReport;
    }
    return check({ serverId });
  }

  function startPeriodicSweep({ intervalMs = 60_000, serverId = null } = {}) {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = setInterval(async () => {
      try {
        await check({ serverId });
      } catch (err) {
        logger.error?.('[system-watchdog] Periodic sweep error:', err);
      }
    }, intervalMs);
    sweepTimer.unref?.();
    return sweepTimer;
  }

  function stop() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function setAutoRecovery(enabled) {
    autoRecoveryActive = Boolean(enabled);
  }

  return {
    inspect,
    check,
    runAutoRecovery,
    recoverComponent,
    getStatus,
    getRecentRecoveries: (limit = 50) => recoveryLog.slice(-Math.min(limit, MAX_RECOVERY_HISTORY)),
    startPeriodicSweep,
    stop,
    setAutoRecovery,
    isAutoRecoveryEnabled: () => autoRecoveryActive,
    setLocalRuntime: (runtime) => { localRuntime = runtime; },
    setLocalJobExecutor: (executor) => { localJobExecutor = executor; },
    registerDaemon: (key, daemon) => {
      if (typeof daemons === 'object' && daemons !== null) {
        daemons[key] = daemon;
      }
    },
    getCheckCount: () => checkCount,
    getLastCheckAt: () => lastCheckAt,
  };
}

export const systemWatchdogInternals = Object.freeze({
  DEFAULT_STALLED_JOB_TIMEOUT_MS,
  DEFAULT_BACKLOG_WARNING_THRESHOLD,
  DEFAULT_OLDEST_QUEUED_WARNING_MS,
  DEFAULT_MAX_RECOVERIES_PER_WINDOW,
  DEFAULT_RECOVERY_WINDOW_MS,
  MAX_RECOVERY_HISTORY,
  DEFAULT_CRITICAL_SERVICES,
  VALID_TARGET_TYPES,
});
