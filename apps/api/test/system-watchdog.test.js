import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  createSystemWatchdogService,
  SystemWatchdogError,
  systemWatchdogInternals,
  mountSystemWatchdogRoutes,
  SystemWatchdogHttpError,
} from '../src/local-api-health.js';

const TEST_SERVER_ID = 'srv-test-1234';

function createMockServiceManager({ initialServices = [] } = {}) {
  let services = initialServices.length > 0 ? [...initialServices] : [
    {
      id: 'nginx',
      label: 'Nginx',
      category: 'web',
      installed: true,
      active: true,
      units: [{ unit: 'nginx.service', activeState: 'active', subState: 'running' }],
      health: { status: 'ready' },
    },
    {
      id: 'mariadb',
      label: 'MariaDB',
      category: 'database',
      installed: true,
      active: true,
      units: [{ unit: 'mariadb.service', activeState: 'active', subState: 'running' }],
      health: { status: 'ready' },
    },
    {
      id: 'cron',
      label: 'Cron',
      category: 'scheduler',
      installed: true,
      active: true,
      units: [{ unit: 'cron.service', activeState: 'active', subState: 'running' }],
      health: { status: 'ready' },
    },
  ];

  const controlCalls = [];

  return {
    getServices: () => services,
    setServices: (newServices) => { services = newServices; },
    inspectServices: async () => services.map((s) => ({ ...s, units: s.units.map((u) => ({ ...u })) })),
    serviceControl: async (serviceId, action) => {
      controlCalls.push({ serviceId, action });
      const target = services.find((s) => s.id === serviceId);
      if (target) {
        if (action === 'restart' || action === 'start') {
          target.active = true;
          target.units.forEach((u) => { u.activeState = 'active'; u.subState = 'running'; });
          target.health = { status: 'ready' };
        } else if (action === 'stop') {
          target.active = false;
          target.units.forEach((u) => { u.activeState = 'inactive'; u.subState = 'dead'; });
          target.health = { status: 'inactive' };
        }
      }
      return { id: serviceId, action, active: target?.active ?? true };
    },
    getControlCalls: () => [...controlCalls],
  };
}

function createMockJobRegistry({ initialJobs = [] } = {}) {
  let jobs = [...initialJobs];
  const completions = [];

  return {
    getJobs: () => jobs,
    setJobs: (newJobs) => { jobs = newJobs; },
    listJobs: async (filter = {}) => {
      return jobs.filter((j) => {
        if (filter.serverId && j.serverId !== filter.serverId) return false;
        if (filter.status && j.status !== filter.status) return false;
        return true;
      });
    },
    complete: async ({ serverId, jobId, status, error, result }) => {
      completions.push({ serverId, jobId, status, error, result });
      const target = jobs.find((j) => j.id === jobId);
      if (!target) {
        throw new Error('job_not_found');
      }
      target.status = status;
      target.error = error;
      target.result = result;
      target.finishedAt = new Date().toISOString();
      return { ...target };
    },
    getCompletions: () => [...completions],
  };
}

function createWatchdogTestApp({ watchdogService, role = 'owner', userId = 'usr-admin' } = {}) {
  const routes = [];

  const app = {
    use() {},
    get(pathPattern, ...handlers) {
      routes.push({ method: 'GET', pathPattern, handlers });
    },
    post(pathPattern, ...handlers) {
      routes.push({ method: 'POST', pathPattern, handlers });
    },
    listen(port, callback) {
      const server = http.createServer(async (req, res) => {
        res.status = function (statusCode) {
          res.statusCode = statusCode;
          return res;
        };
        res.json = function (data) {
          if (!res.headersSent) {
            res.setHeader('content-type', 'application/json');
          }
          res.end(JSON.stringify(data));
          return res;
        };

        req.originalUrl = req.url;
        req.auth = {
          user: { id: userId, username: 'admin', role },
          access: {
            mode: role === 'owner' ? 'management' : role === 'read_only' ? 'read_only' : 'site_management',
            permissions: role === 'owner' ? ['*'] : role === 'read_only' ? ['servers.read'] : ['sites.manage'],
          },
          security: { managementAllowed: role !== 'read_only' },
        };

        if (req.method === 'POST') {
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('utf8');
            req.body = raw ? JSON.parse(raw) : {};
          } catch {
            req.body = {};
          }
        }

        // Match routes
        const urlObj = new URL(req.url, 'http://127.0.0.1');
        const reqPath = urlObj.pathname;

        for (const route of routes) {
          if (route.method !== req.method) continue;

          let matched = false;
          const params = {};

          if (route.pathPattern.includes(':')) {
            const patternParts = route.pathPattern.split('/');
            const reqParts = reqPath.split('/');
            if (patternParts.length === reqParts.length) {
              matched = true;
              for (let i = 0; i < patternParts.length; i++) {
                if (patternParts[i].startsWith(':')) {
                  params[patternParts[i].slice(1)] = reqParts[i];
                } else if (patternParts[i] !== reqParts[i]) {
                  matched = false;
                  break;
                }
              }
            }
          } else if (route.pathPattern === reqPath) {
            matched = true;
          }

          if (matched) {
            req.params = params;
            let handlerIdx = 0;
            const next = async (err) => {
              if (err) {
                const status = err.status || 500;
                return res.status(status).json({
                  error: { code: err.code || 'internal_error', message: err.message },
                });
              }
              handlerIdx++;
              if (handlerIdx < route.handlers.length) {
                try {
                  await route.handlers[handlerIdx](req, res, next);
                } catch (e) {
                  await next(e);
                }
              }
            };
            try {
              await route.handlers[0](req, res, next);
              return;
            } catch (err) {
              await next(err);
              return;
            }
          }
        }

        return res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
      });

      return server.listen(port, callback);
    },
  };

  mountSystemWatchdogRoutes(app, {
    watchdogService,
    localServerId: TEST_SERVER_ID,
  });

  return app;
}

// ============================================================================
// Unit Tests: Failure Detection Logic
// ============================================================================

test('system watchdog: healthy state when all services, jobs, executor and daemons are normal', async () => {
  const serviceMock = createMockServiceManager();
  const jobMock = createMockJobRegistry({
    initialJobs: [
      { id: 'job-1', serverId: TEST_SERVER_ID, status: 'queued', createdAt: new Date().toISOString() },
    ],
  });
  const executorMock = {
    running: () => true,
    failure: () => null,
  };
  const daemonMock = {
    status: async () => ({ healthy: true, status: 'active' }),
  };

  const service = createSystemWatchdogService({
    jobRegistry: jobMock,
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    localJobExecutor: executorMock,
    daemons: { testDaemon: daemonMock },
  });

  const report = await service.inspect({ serverId: TEST_SERVER_ID });

  assert.equal(report.status, 'healthy');
  assert.equal(report.summary.servicesHealthy, true);
  assert.equal(report.summary.queueHealthy, true);
  assert.equal(report.summary.executorHealthy, true);
  assert.equal(report.summary.daemonsHealthy, true);
  assert.equal(report.summary.activeIncidentsCount, 0);
  assert.equal(report.services.length, 3);
  assert.equal(report.queue.queuedCount, 1);
  assert.equal(report.queue.runningCount, 0);
  assert.equal(report.queue.stalledCount, 0);
});

test('system watchdog: detects inactive critical service and reports unhealthy', async () => {
  const serviceMock = createMockServiceManager();
  // Turn nginx inactive
  serviceMock.setServices([
    {
      id: 'nginx',
      label: 'Nginx',
      category: 'web',
      installed: true,
      active: false,
      units: [{ unit: 'nginx.service', activeState: 'inactive', subState: 'dead' }],
      health: { status: 'inactive' },
    },
  ]);

  const service = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
  });

  const report = await service.inspect({ serverId: TEST_SERVER_ID });

  assert.equal(report.status, 'unhealthy');
  assert.equal(report.summary.servicesHealthy, false);
  assert.equal(report.incidents.length, 1);
  assert.equal(report.incidents[0].code, 'service_inactive');
  assert.equal(report.incidents[0].targetId, 'nginx');
  assert.equal(report.incidents[0].critical, true);
});

test('system watchdog: detects stalled jobs exceeding execution timeout', async () => {
  const serviceMock = createMockServiceManager();
  const mockNow = 1_700_000_000_000;
  // Job running for 10 minutes (600,000 ms), timeout is 300,000 ms
  const startedAt = new Date(mockNow - 600_000).toISOString();

  const jobMock = createMockJobRegistry({
    initialJobs: [
      {
        id: 'job-stalled-99',
        serverId: TEST_SERVER_ID,
        operation: 'database.create',
        status: 'running',
        startedAt,
        createdAt: startedAt,
      },
    ],
  });

  const service = createSystemWatchdogService({
    jobRegistry: jobMock,
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    stalledJobTimeoutMs: 300_000,
    now: () => mockNow,
  });

  const report = await service.inspect({ serverId: TEST_SERVER_ID });

  assert.equal(report.status, 'unhealthy');
  assert.equal(report.summary.queueHealthy, false);
  assert.equal(report.queue.stalledCount, 1);
  assert.equal(report.queue.stalledJobs[0].id, 'job-stalled-99');
  assert.equal(report.incidents.some((i) => i.code === 'job_stalled'), true);
});

test('system watchdog: detects executor fault and unexpected stop', async () => {
  const serviceMock = createMockServiceManager();
  const jobMock = createMockJobRegistry();

  // 1. Faulted executor
  const faultedExecutor = {
    running: () => false,
    failure: () => ({ code: 'local_claim_unconfirmed', message: 'Claim failure', phase: 'claim', jobId: 'job-1' }),
  };

  const watchdogFaulted = createSystemWatchdogService({
    jobRegistry: jobMock,
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    localJobExecutor: faultedExecutor,
  });

  const reportFaulted = await watchdogFaulted.inspect({ serverId: TEST_SERVER_ID });
  assert.equal(reportFaulted.status, 'unhealthy');
  assert.equal(reportFaulted.summary.executorHealthy, false);
  assert.equal(reportFaulted.incidents.some((i) => i.code === 'executor_faulted'), true);

  // 2. Stopped executor (no fault)
  const stoppedExecutor = {
    running: () => false,
    failure: () => null,
  };

  const watchdogStopped = createSystemWatchdogService({
    jobRegistry: jobMock,
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    localJobExecutor: stoppedExecutor,
  });

  const reportStopped = await watchdogStopped.inspect({ serverId: TEST_SERVER_ID });
  assert.equal(reportStopped.status, 'unhealthy');
  assert.equal(reportStopped.incidents.some((i) => i.code === 'executor_stopped'), true);
});

test('system watchdog: detects elevated queue backlog and reports degraded', async () => {
  const serviceMock = createMockServiceManager();
  const mockNow = 1_700_000_000_000;

  // 25 queued jobs (exceeding threshold of 20)
  const queuedJobs = Array.from({ length: 25 }, (_, idx) => ({
    id: `job-queue-${idx}`,
    serverId: TEST_SERVER_ID,
    operation: 'mail.config.apply',
    status: 'queued',
    createdAt: new Date(mockNow - 5_000).toISOString(),
  }));

  const jobMock = createMockJobRegistry({ initialJobs: queuedJobs });

  const service = createSystemWatchdogService({
    jobRegistry: jobMock,
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    backlogWarningThreshold: 20,
    now: () => mockNow,
  });

  const report = await service.inspect({ serverId: TEST_SERVER_ID });

  assert.equal(report.status, 'degraded');
  assert.equal(report.queue.backlogWarning, true);
  assert.equal(report.incidents.some((i) => i.code === 'queue_backlog_elevated'), true);
});

test('system watchdog: detects unhealthy daemon', async () => {
  const serviceMock = createMockServiceManager();
  const daemons = {
    scheduler: {
      name: 'Certificate Renewal Scheduler',
      status: async () => ({ healthy: false, status: 'error', message: 'connection refused' }),
      critical: false,
    },
  };

  const service = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    daemons,
  });

  const report = await service.inspect({ serverId: TEST_SERVER_ID });

  assert.equal(report.status, 'degraded');
  assert.equal(report.summary.daemonsHealthy, false);
  assert.equal(report.daemons.scheduler.healthy, false);
});

// ============================================================================
// Auto-Recovery & Flapping Protection Tests
// ============================================================================

test('system watchdog auto-recovery: safely restarts inactive service', async () => {
  const serviceMock = createMockServiceManager({
    initialServices: [
      {
        id: 'nginx',
        label: 'Nginx',
        category: 'web',
        installed: true,
        active: false,
        units: [{ unit: 'nginx.service', activeState: 'inactive', subState: 'dead' }],
        health: { status: 'inactive' },
      },
    ],
  });

  const service = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    autoRecoveryEnabled: true,
  });

  // check() triggers inspect + runAutoRecovery + post-recovery inspect
  const report = await service.check({ serverId: TEST_SERVER_ID });

  assert.equal(report.status, 'healthy');
  assert.equal(report.lastRecoveryResults.recovered.length, 1);
  assert.equal(report.lastRecoveryResults.recovered[0].targetId, 'nginx');
  assert.equal(report.lastRecoveryResults.recovered[0].action, 'restart');
  assert.equal(report.lastRecoveryResults.recovered[0].status, 'succeeded');

  // Verify service control was called
  const calls = serviceMock.getControlCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { serviceId: 'nginx', action: 'restart' });
});

test('system watchdog auto-recovery: safely terminates stalled job to release deadlock', async () => {
  const serviceMock = createMockServiceManager();
  let time = 1_700_000_000_000;
  const startedAt = new Date(time - 400_000).toISOString();

  const jobMock = createMockJobRegistry({
    initialJobs: [
      {
        id: 'job-locked-42',
        serverId: TEST_SERVER_ID,
        operation: 'ssl.issue',
        status: 'running',
        startedAt,
        createdAt: startedAt,
      },
    ],
  });

  const service = createSystemWatchdogService({
    jobRegistry: jobMock,
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    stalledJobTimeoutMs: 300_000,
    now: () => time,
  });

  const report = await service.check({ serverId: TEST_SERVER_ID });

  assert.equal(report.lastRecoveryResults.recovered.length, 1);
  assert.equal(report.lastRecoveryResults.recovered[0].targetId, 'job-locked-42');
  assert.equal(report.lastRecoveryResults.recovered[0].action, 'fail_stalled');
  assert.equal(report.lastRecoveryResults.recovered[0].status, 'succeeded');

  // Verify job was completed with failure
  const completions = jobMock.getCompletions();
  assert.equal(completions.length, 1);
  assert.equal(completions[0].jobId, 'job-locked-42');
  assert.equal(completions[0].status, 'failed');
  assert.equal(completions[0].error.code, 'job_stalled_timeout');
});

test('system watchdog auto-recovery: flapping protection suppresses repeated restarts within window', async () => {
  // Service that refuses to stay active (failing repeatedly)
  let active = false;
  const inspectServices = async () => [
    {
      id: 'mariadb',
      label: 'MariaDB',
      category: 'database',
      installed: true,
      active,
      units: [{ unit: 'mariadb.service', activeState: active ? 'active' : 'inactive', subState: active ? 'running' : 'failed' }],
      health: { status: active ? 'ready' : 'inactive' },
    },
  ];
  let restartCount = 0;
  const serviceControl = async (id, action) => {
    restartCount++;
    // Keep it inactive so it fails again next check
    active = false;
    return { id, action, active: false };
  };

  let time = 1_700_000_000_000;
  const service = createSystemWatchdogService({
    inspectServices,
    serviceControl,
    maxRecoveriesPerWindow: 3,
    recoveryWindowMs: 10 * 60 * 1000,
    now: () => time,
  });

  // Cycle 1: restart attempted (1st attempt)
  await service.check({ serverId: TEST_SERVER_ID });
  assert.equal(restartCount, 1);

  // Cycle 2: restart attempted (2nd attempt)
  time += 30_000;
  await service.check({ serverId: TEST_SERVER_ID });
  assert.equal(restartCount, 2);

  // Cycle 3: restart attempted (3rd attempt - limit reached)
  time += 30_000;
  await service.check({ serverId: TEST_SERVER_ID });
  assert.equal(restartCount, 3);

  // Cycle 4: flapping threshold reached! Recovery must be SUPPRESSED!
  time += 30_000;
  const report4 = await service.check({ serverId: TEST_SERVER_ID });
  assert.equal(restartCount, 3); // Did NOT increment
  assert.equal(report4.lastRecoveryResults.suppressed.length, 1);
  assert.equal(report4.lastRecoveryResults.suppressed[0].status, 'suppressed_flapping');
  assert.equal(report4.services[0].flapping, true);

  // Cycle 5: After recovery window expires (11 minutes later), recovery is permitted again
  time += 11 * 60 * 1000;
  await service.check({ serverId: TEST_SERVER_ID });
  assert.equal(restartCount, 4); // Reset and incremented
});

test('system watchdog auto-recovery: can be disabled completely', async () => {
  const serviceMock = createMockServiceManager({
    initialServices: [
      {
        id: 'cron',
        label: 'Cron',
        category: 'scheduler',
        installed: true,
        active: false,
        units: [{ unit: 'cron.service', activeState: 'inactive' }],
        health: { status: 'inactive' },
      },
    ],
  });

  const service = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    autoRecoveryEnabled: false,
  });

  const report = await service.check({ serverId: TEST_SERVER_ID });
  assert.equal(report.status, 'unhealthy');
  assert.equal(report.lastRecoveryResults.recovered.length, 0);
  assert.equal(serviceMock.getControlCalls().length, 0);
});

// ============================================================================
// On-Demand Manual Component Recovery Tests
// ============================================================================

test('system watchdog on-demand recovery: executes with valid confirmation token', async () => {
  const serviceMock = createMockServiceManager({
    initialServices: [
      {
        id: 'nginx',
        label: 'Nginx',
        category: 'web',
        installed: true,
        active: false,
        units: [{ unit: 'nginx.service', activeState: 'inactive' }],
      },
    ],
  });

  const service = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
  });

  // Valid confirmation format 1: recover:service:nginx
  const res = await service.recoverComponent({
    serverId: TEST_SERVER_ID,
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });

  assert.equal(res.recovered, true);
  assert.equal(res.targetType, 'service');
  assert.equal(res.targetId, 'nginx');
  assert.equal(serviceMock.getControlCalls().length, 1);

  // Valid confirmation format 2: recover:nginx
  const res2 = await service.recoverComponent({
    serverId: TEST_SERVER_ID,
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:nginx',
  });
  assert.equal(res2.recovered, true);
});

test('system watchdog on-demand recovery: rejects invalid or missing confirmation token', async () => {
  const service = createSystemWatchdogService();

  await assert.rejects(
    service.recoverComponent({
      targetType: 'service',
      targetId: 'nginx',
      confirmation: 'wrong-confirmation',
    }),
    (err) => err instanceof SystemWatchdogError && err.code === 'watchdog_confirmation_required' && err.status === 400,
  );

  await assert.rejects(
    service.recoverComponent({
      targetType: 'invalid_type',
      targetId: 'nginx',
      confirmation: 'recover:nginx',
    }),
    (err) => err instanceof SystemWatchdogError && err.code === 'invalid_target_type' && err.status === 400,
  );
});

// ============================================================================
// HTTP API Endpoints Integration Tests
// ============================================================================

test('watchdog HTTP routes: GET /api/servers/:serverId/watchdog/status returns health report', async () => {
  const serviceMock = createMockServiceManager();
  const watchdogService = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
  });
  const app = createWatchdogTestApp({ watchdogService });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/api/servers/${TEST_SERVER_ID}/watchdog/status`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(body.data);
    assert.equal(body.data.status, 'healthy');
    assert.ok(body.data.summary);
    assert.ok(Array.isArray(body.data.services));
    assert.ok(body.data.queue);
    assert.ok(body.data.recovery);
  } finally {
    server.close();
  }
});

test('watchdog HTTP routes: POST /api/servers/:serverId/watchdog/check triggers check & recovery', async () => {
  const serviceMock = createMockServiceManager({
    initialServices: [
      {
        id: 'nginx',
        label: 'Nginx',
        category: 'web',
        installed: true,
        active: false,
        units: [{ unit: 'nginx.service', activeState: 'inactive' }],
      },
    ],
  });
  const watchdogService = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    autoRecoveryEnabled: true,
  });
  const app = createWatchdogTestApp({ watchdogService });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/api/servers/${TEST_SERVER_ID}/watchdog/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(body.data);
    assert.equal(body.data.status, 'healthy');
    assert.equal(body.data.lastRecoveryResults.recovered.length, 1);
  } finally {
    server.close();
  }
});

test('watchdog HTTP routes: POST /api/servers/:serverId/watchdog/recover executes on-demand recovery with confirmation', async () => {
  const serviceMock = createMockServiceManager();
  const watchdogService = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
  });
  const app = createWatchdogTestApp({ watchdogService, role: 'owner' });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Successful manual recovery
    const res = await fetch(`${baseUrl}/api/servers/${TEST_SERVER_ID}/watchdog/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetType: 'service',
        targetId: 'nginx',
        confirmation: 'recover:service:nginx',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.recovered, true);
    assert.equal(body.data.targetId, 'nginx');

    // 2. Rejected when confirmation missing
    const badRes = await fetch(`${baseUrl}/api/servers/${TEST_SERVER_ID}/watchdog/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetType: 'service',
        targetId: 'nginx',
      }),
    });
    assert.equal(badRes.status, 400);
    const badBody = await badRes.json();
    assert.equal(badBody.error.code, 'confirmation_required');
  } finally {
    server.close();
  }
});

test('watchdog HTTP routes: /api/system/watchdog shortcut routes work', async () => {
  const serviceMock = createMockServiceManager();
  const watchdogService = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
  });
  const app = createWatchdogTestApp({ watchdogService, role: 'owner' });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET status shortcut
    const getRes = await fetch(`${baseUrl}/api/system/watchdog/status`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.data.status, 'healthy');

    // 2. POST check shortcut
    const checkRes = await fetch(`${baseUrl}/api/system/watchdog/check`, { method: 'POST' });
    assert.equal(checkRes.status, 200);

    // 3. POST recover shortcut
    const recRes = await fetch(`${baseUrl}/api/system/watchdog/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetType: 'service',
        targetId: 'nginx',
        confirmation: 'recover:service:nginx',
      }),
    });
    assert.equal(recRes.status, 200);
    const recData = await recRes.json();
    assert.equal(recData.data.recovered, true);
  } finally {
    server.close();
  }
});

test('watchdog HTTP routes: role authorization restricts check and recover', async () => {
  const serviceMock = createMockServiceManager();
  const watchdogService = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
  });

  // App with read_only user role
  const readOnlyApp = createWatchdogTestApp({ watchdogService, role: 'read_only' });
  const server = readOnlyApp.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // read_only can view status
    const statusRes = await fetch(`${baseUrl}/api/system/watchdog/status`);
    assert.equal(statusRes.status, 200);

    // read_only cannot run check (403)
    const checkRes = await fetch(`${baseUrl}/api/system/watchdog/check`, { method: 'POST' });
    assert.equal(checkRes.status, 403);

    // read_only cannot run recover (403)
    const recRes = await fetch(`${baseUrl}/api/system/watchdog/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetType: 'service', targetId: 'nginx', confirmation: 'recover:service:nginx' }),
    });
    assert.equal(recRes.status, 403);
  } finally {
    server.close();
  }
});
