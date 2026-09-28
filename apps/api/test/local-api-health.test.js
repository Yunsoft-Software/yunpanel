import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import {
  checkLocalApiHealth,
  LocalApiHealthError,
  resolveLocalApiHealthTarget,
  createSiteHealthService,
  SiteHealthError,
  siteHealthInternals,
  mountSiteHealthRoutes,
  SiteHealthHttpError,
  siteHealthHttpInternals,
} from '../src/local-api-health.js';

function requestFixture({ statusCode = 200, body = '{"status":"ok"}', requestError = null, timeout = false } = {}) {
  const calls = [];
  const request = (options, onResponse) => {
    calls.push(options);
    const probe = new EventEmitter();
    probe.destroy = () => {};
    probe.end = () => {
      queueMicrotask(() => {
        if (timeout) {
          probe.emit('timeout');
          return;
        }
        if (requestError) {
          probe.emit('error', requestError);
          return;
        }
        const response = new EventEmitter();
        response.statusCode = statusCode;
        response.destroy = () => {};
        onResponse(response);
        if (body != null) response.emit('data', Buffer.from(body));
        response.emit('end');
      });
    };
    return probe;
  };
  return { calls, request };
}

test('health target is restricted to loopback API bindings', () => {
  assert.deepEqual(resolveLocalApiHealthTarget({ env: {} }), { host: '127.0.0.1', port: 3001 });
  assert.deepEqual(resolveLocalApiHealthTarget({ env: { YUNPANEL_API_HOST: '::1', YUNPANEL_API_PORT: '4011' } }), { host: '::1', port: 4011 });
  assert.throws(
    () => resolveLocalApiHealthTarget({ env: { YUNPANEL_API_HOST: '0.0.0.0' } }),
    (error) => error instanceof LocalApiHealthError && error.code === 'local_api_health_host_unsafe',
  );
  assert.throws(
    () => resolveLocalApiHealthTarget({ env: { YUNPANEL_API_PORT: '3001oops' } }),
    (error) => error instanceof LocalApiHealthError && error.code === 'local_api_health_port_invalid',
  );
});

test('health probe performs an unauthenticated bounded loopback GET only', async () => {
  const fixture = requestFixture();
  const result = await checkLocalApiHealth({
    env: { YUNPANEL_API_HOST: '127.0.0.1', YUNPANEL_API_PORT: '3001' },
    request: fixture.request,
  });
  assert.deepEqual(result, { healthy: true, host: '127.0.0.1', port: 3001, statusCode: 200 });
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].method, 'GET');
  assert.equal(fixture.calls[0].path, '/api/health');
  assert.equal(Object.hasOwn(fixture.calls[0].headers, 'authorization'), false);
  assert.equal(Object.hasOwn(fixture.calls[0].headers, 'cookie'), false);
});

test('non-200, malformed and oversized health responses fail closed', async () => {
  for (const [options, code] of [
    [{ statusCode: 503, body: '{"status":"ok"}' }, 'local_api_health_unhealthy'],
    [{ body: 'not-json' }, 'local_api_health_response_invalid'],
    [{ body: '{"status":"down"}' }, 'local_api_health_unhealthy'],
    [{ body: 'x'.repeat(5000) }, 'local_api_health_response_invalid'],
  ]) {
    const fixture = requestFixture(options);
    await assert.rejects(
      checkLocalApiHealth({ env: {}, request: fixture.request }),
      (error) => error instanceof LocalApiHealthError && error.code === code,
    );
  }
});

test('transport errors and timeout do not expose raw network error text', async () => {
  for (const [options, code] of [
    [{ requestError: new Error('SECRET=/root/private/socket') }, 'local_api_health_unavailable'],
    [{ timeout: true }, 'local_api_health_timeout'],
  ]) {
    const fixture = requestFixture(options);
    await assert.rejects(
      checkLocalApiHealth({ env: {}, request: fixture.request }),
      (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /SECRET|\/root\/private|socket/i);
        return true;
      },
    );
  }
});

// ============================================================================
// PROD-11: Site Health Diagnostics & Verifiable Auto-Repair Test Suite
// ============================================================================

const TEST_WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DOMAIN_ID = '22222222-2222-4222-8222-222222222222';
const TEST_APPLICATION_ID = '33333333-3333-4333-8333-333333333333';
const TEST_SERVER_ID = '44444444-4444-4444-8444-444444444444';
const TEST_CERT_ID = '55555555-5555-4555-8555-555555555555';

function createMockFs(initialState = {}) {
  const files = new Map(Object.entries(initialState));
  return {
    async lstat(p) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      const entry = files.get(p);
      return {
        mode: entry.mode,
        isFile: () => entry.type === 'file',
        isDirectory: () => entry.type === 'dir',
        isSymbolicLink: () => entry.type === 'symlink',
      };
    },
    async mkdir(p, options) {
      files.set(p, { type: 'dir', mode: options?.mode ?? 0o755 });
    },
    async chmod(p, mode) {
      if (files.has(p)) {
        files.get(p).mode = mode;
      } else {
        files.set(p, { type: 'dir', mode });
      }
    },
    async chown() {},
    async stat(p) {
      return this.lstat(p);
    },
    _files: files,
  };
}

function createHealthyFixtures() {
  const homeDir = `/var/lib/yunpanel/data/${TEST_APPLICATION_ID}`;
  const tmpDir = `${homeDir}/tmp`;
  const logsDir = `${homeDir}/logs`;
  const releaseDir = `/var/lib/yunpanel/apps/${TEST_APPLICATION_ID}/current`;

  const website = {
    id: TEST_WEBSITE_ID,
    applicationId: TEST_APPLICATION_ID,
    serverId: TEST_SERVER_ID,
    runtimeType: 'passenger',
  };

  const domain = {
    id: TEST_DOMAIN_ID,
    websiteId: TEST_WEBSITE_ID,
    serverId: TEST_SERVER_ID,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    httpsMode: 'on',
    certificateId: TEST_CERT_ID,
    appliedChecksum: '0'.repeat(64),
  };

  const server = {
    id: TEST_SERVER_ID,
    host: '198.51.100.10',
    inventory: {
      network: [
        { family: 'IPv4', address: '198.51.100.10' },
        { family: 'IPv6', address: '2001:db8::1' },
      ],
    },
  };

  const certificate = {
    id: TEST_CERT_ID,
    state: 'issued',
    validFrom: new Date(Date.now() - 30 * 86400 * 1000).toISOString(),
    validTo: new Date(Date.now() + 60 * 86400 * 1000).toISOString(),
    domains: ['example.com', 'www.example.com'],
    fingerprint256: 'a'.repeat(64),
    issuer: "Let's Encrypt",
  };

  const fs = createMockFs({
    [homeDir]: { type: 'dir', mode: 0o750 },
    [tmpDir]: { type: 'dir', mode: 0o700 },
    [logsDir]: { type: 'dir', mode: 0o750 },
    [releaseDir]: { type: 'dir', mode: 0o755 },
  });

  const websiteRegistry = {
    getWebsite: async (id) => (id === TEST_WEBSITE_ID ? website : null),
  };

  const domainRegistry = {
    getDomain: async (id) => (id === TEST_DOMAIN_ID ? domain : null),
    listDomains: async () => [domain],
  };

  const serverRegistry = {
    getServer: async (id) => (id === TEST_SERVER_ID ? server : null),
  };

  const certificateRegistry = {
    getCertificate: async (id) => (id === TEST_CERT_ID ? certificate : null),
    prepareSelection: async () => {},
    commitSelection: async () => {},
  };

  const dnsResolver = {
    resolve4: async (hostname) => [{ address: '198.51.100.10', ttl: 300 }],
    resolve6: async (hostname) => [{ address: '2001:db8::1', ttl: 300 }],
  };

  const nginxManager = {
    inspectActiveDomain: async () => ({ satisfied: true, primaryDomain: 'example.com' }),
    stageDomain: async () => ({ checksum: 'c'.repeat(64) }),
    activateDomain: async () => ({ active: true }),
  };

  const websiteHttpHealthInspector = {
    inspect: async () => ({ satisfied: true, statusCode: 200, attempts: 1 }),
  };

  const dnsRecordManager = {
    syncRecords: async () => ({ synced: true }),
  };

  const execFn = async () => ({ exitCode: 0, stdout: '', stderr: '' });

  return {
    website,
    domain,
    server,
    certificate,
    fs,
    websiteRegistry,
    domainRegistry,
    serverRegistry,
    certificateRegistry,
    dnsResolver,
    nginxManager,
    websiteHttpHealthInspector,
    dnsRecordManager,
    execFn,
    homeDir,
    tmpDir,
    logsDir,
    releaseDir,
  };
}

function createHealthTestApp({ siteHealthService, role = 'owner', user = null } = {}) {
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
          user: user ?? { id: 'usr-1', username: 'admin', role },
          access: { mode: 'management', permissions: ['*'] },
          security: { managementAllowed: true },
        };

        if (req.method === 'POST') {
          try {
            const chunks = [];
            for await (const chunk of req) {
              chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            req.body = raw ? JSON.parse(raw) : {};
          } catch {
            req.body = {};
          }
        } else {
          req.body = {};
        }

        const urlObj = new URL(req.url, 'http://127.0.0.1');
        const pathname = urlObj.pathname;

        let matchedRoute = null;
        const routeParams = {};

        for (const r of routes) {
          if (r.method !== req.method) continue;
          const paramNames = [];
          const regexStr = '^' + r.pathPattern.replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
            paramNames.push(name);
            return '([^/]+)';
          }) + '$';
          const match = pathname.match(new RegExp(regexStr));
          if (match) {
            matchedRoute = r;
            paramNames.forEach((name, idx) => {
              routeParams[name] = match[idx + 1];
            });
            break;
          }
        }

        req.params = routeParams;

        if (!matchedRoute) {
          res.status(404).json({ error: { code: 'not_found', message: 'Not Found' } });
          return;
        }

        const allHandlers = [...matchedRoute.handlers];
        let idx = 0;
        const next = async (err) => {
          if (err) {
            if (res.headersSent) return;
            if (err instanceof SiteHealthError) {
              return res.status(err.status).json({ error: { code: err.code, message: err.message } });
            }
            return res.status(500).json({ error: { code: 'internal_error', message: err.message } });
          }
          if (idx < allHandlers.length) {
            const handler = allHandlers[idx++];
            try {
              await handler(req, res, next);
            } catch (handlerErr) {
              await next(handlerErr);
            }
          }
        };

        await next();
      });

      return server.listen(port, callback);
    },
  };

  mountSiteHealthRoutes(app, {
    siteHealthService,
    websiteRegistry: { getWebsite: async () => null },
    domainRegistry: { getDomain: async () => null, listDomains: async () => [] },
  });

  return app;
}

test('site health service requires websiteRegistry and domainRegistry to initialize', () => {
  assert.throws(
    () => createSiteHealthService({ websiteRegistry: null }),
    /requires websiteRegistry and domainRegistry/,
  );
  assert.throws(
    () => createSiteHealthService({ websiteRegistry: {}, domainRegistry: null }),
    /requires websiteRegistry and domainRegistry/,
  );
});

test('site health service: target context resolution and errors', async () => {
  const fix = createHealthyFixtures();
  const service = createSiteHealthService(fix);

  // Missing both websiteId and domainId
  await assert.rejects(
    () => service.inspectSiteHealth({}),
    (err) => err instanceof SiteHealthError && err.code === 'target_required' && err.status === 400,
  );

  // Non-existent websiteId
  await assert.rejects(
    () => service.inspectSiteHealth({ websiteId: '99999999-9999-4999-8999-999999999999' }),
    (err) => err instanceof SiteHealthError && err.code === 'website_not_found' && err.status === 404,
  );

  // Non-existent domainId
  await assert.rejects(
    () => service.inspectSiteHealth({ domainId: '99999999-9999-4999-8999-999999999999' }),
    (err) => err instanceof SiteHealthError && err.code === 'domain_not_found' && err.status === 404,
  );

  // Resolves domain automatically from websiteId
  const byWebsite = await service.inspectSiteHealth({ websiteId: TEST_WEBSITE_ID });
  assert.equal(byWebsite.websiteId, TEST_WEBSITE_ID);
  assert.equal(byWebsite.domainId, TEST_DOMAIN_ID);

  // Resolves website automatically from domainId
  const byDomain = await service.inspectSiteHealth({ domainId: TEST_DOMAIN_ID });
  assert.equal(byDomain.websiteId, TEST_WEBSITE_ID);
  assert.equal(byDomain.domainId, TEST_DOMAIN_ID);
});

test('site health: DNS layer diagnostics detect missing records, mismatch, resolver error, and unconfigured server', async () => {
  const fix = createHealthyFixtures();

  // 1. Healthy resolution
  const healthyService = createSiteHealthService(fix);
  const dnsHealthy = await healthyService.inspectDnsLayer({ domain: fix.domain, server: fix.server });
  assert.equal(dnsHealthy.healthy, true);
  assert.equal(dnsHealthy.status, 'healthy');
  assert.equal(dnsHealthy.action, null);

  // 2. Records missing (empty resolution)
  const missingDns = {
    ...fix,
    dnsResolver: {
      resolve4: async () => [],
      resolve6: async () => [],
    },
  };
  const missingService = createSiteHealthService(missingDns);
  const dnsMissing = await missingService.inspectDnsLayer({ domain: fix.domain, server: fix.server });
  assert.equal(dnsMissing.healthy, false);
  assert.equal(dnsMissing.status, 'records_missing');
  assert.equal(dnsMissing.action, 'repair_dns_records');
  assert.equal(dnsMissing.actionCode, 'dns_address_missing');

  // 3. Target address mismatch (points to external unknown IP)
  const mismatchDns = {
    ...fix,
    dnsResolver: {
      resolve4: async () => [{ address: '203.0.113.123', ttl: 300 }],
      resolve6: async () => [],
    },
  };
  const mismatchService = createSiteHealthService(mismatchDns);
  const dnsMismatch = await mismatchService.inspectDnsLayer({ domain: fix.domain, server: fix.server });
  assert.equal(dnsMismatch.healthy, false);
  assert.equal(dnsMismatch.status, 'target_mismatch');
  assert.equal(dnsMismatch.action, 'repair_dns_records');
  assert.equal(dnsMismatch.actionCode, 'dns_target_mismatch');

  // 4. DNS resolver error (timeout / resolution error)
  const errorDns = {
    ...fix,
    dnsResolver: {
      resolve4: async () => {
        const err = new Error('SERVFAIL');
        err.code = 'SERVFAIL';
        throw err;
      },
      resolve6: async () => [],
    },
  };
  const errorService = createSiteHealthService(errorDns);
  const dnsError = await errorService.inspectDnsLayer({ domain: fix.domain, server: fix.server });
  assert.equal(dnsError.healthy, false);
  assert.equal(dnsError.status, 'resolver_error');
  assert.equal(dnsError.action, 'repair_dns_records');
  assert.equal(dnsError.actionCode, 'dns_resolver_error');

  // 5. Server has no public IP addresses configured
  const emptyServer = { ...fix.server, host: 'internal-only', inventory: { network: [] } };
  const dnsUnconfigured = await healthyService.inspectDnsLayer({ domain: fix.domain, server: emptyServer });
  assert.equal(dnsUnconfigured.healthy, false);
  assert.equal(dnsUnconfigured.status, 'expected_unavailable');
  assert.equal(dnsUnconfigured.actionCode, 'dns_server_unconfigured');

  // 6. Domain missing primaryDomain
  const dnsNoDomain = await healthyService.inspectDnsLayer({ domain: null, server: fix.server });
  assert.equal(dnsNoDomain.healthy, false);
  assert.equal(dnsNoDomain.status, 'domain_missing');
});

test('site health: SSL layer diagnostics detect missing cert, expired, expiring soon, SAN mismatch, and error state', async () => {
  const fix = createHealthyFixtures();

  // 1. Healthy certificate
  const service = createSiteHealthService(fix);
  const sslHealthy = await service.inspectSslLayer({ domain: fix.domain });
  assert.equal(sslHealthy.healthy, true);
  assert.equal(sslHealthy.status, 'healthy');
  assert.equal(sslHealthy.action, null);

  // 2. HTTPS disabled
  const sslDisabled = await service.inspectSslLayer({ domain: { ...fix.domain, httpsMode: 'off' } });
  assert.equal(sslDisabled.healthy, true);
  assert.equal(sslDisabled.status, 'https_disabled');

  // 3. Certificate missing on domain
  const sslMissing = await service.inspectSslLayer({ domain: { ...fix.domain, certificateId: null } });
  assert.equal(sslMissing.healthy, false);
  assert.equal(sslMissing.status, 'certificate_missing');
  assert.equal(sslMissing.action, 'repair_ssl_certificate');
  assert.equal(sslMissing.actionCode, 'ssl_certificate_missing');

  // 4. Certificate record not found in registry
  const missingCertFix = {
    ...fix,
    certificateRegistry: {
      getCertificate: async () => null,
    },
  };
  const missingCertService = createSiteHealthService(missingCertFix);
  const sslCertNotFound = await missingCertService.inspectSslLayer({ domain: fix.domain });
  assert.equal(sslCertNotFound.healthy, false);
  assert.equal(sslCertNotFound.status, 'certificate_missing');
  assert.equal(sslCertNotFound.action, 'repair_ssl_certificate');

  // 5. Expired certificate
  const expiredFix = {
    ...fix,
    certificateRegistry: {
      getCertificate: async () => ({
        ...fix.certificate,
        validTo: new Date(Date.now() - 10_000).toISOString(),
      }),
    },
  };
  const expiredService = createSiteHealthService(expiredFix);
  const sslExpired = await expiredService.inspectSslLayer({ domain: fix.domain });
  assert.equal(sslExpired.healthy, false);
  assert.equal(sslExpired.status, 'certificate_expired');
  assert.equal(sslExpired.action, 'repair_ssl_certificate');
  assert.equal(sslExpired.actionCode, 'ssl_certificate_expired');

  // 6. Expiring soon (within 30 days)
  const expiringSoonFix = {
    ...fix,
    certificateRegistry: {
      getCertificate: async () => ({
        ...fix.certificate,
        validTo: new Date(Date.now() + 15 * 86400 * 1000).toISOString(),
      }),
    },
  };
  const expiringSoonService = createSiteHealthService(expiringSoonFix);
  const sslExpiringSoon = await expiringSoonService.inspectSslLayer({ domain: fix.domain });
  assert.equal(sslExpiringSoon.status, 'certificate_expiring_soon');
  assert.equal(sslExpiringSoon.action, 'repair_ssl_certificate');
  assert.equal(sslExpiringSoon.actionCode, 'ssl_certificate_expiring_soon');

  // 7. Domain SAN mismatch
  const mismatchFix = {
    ...fix,
    certificateRegistry: {
      getCertificate: async () => ({
        ...fix.certificate,
        domains: ['other-domain.net'],
      }),
    },
  };
  const mismatchService = createSiteHealthService(mismatchFix);
  const sslMismatch = await mismatchService.inspectSslLayer({ domain: fix.domain });
  assert.equal(sslMismatch.healthy, false);
  assert.equal(sslMismatch.status, 'domain_mismatch');
  assert.equal(sslMismatch.action, 'repair_ssl_certificate');
  assert.equal(sslMismatch.actionCode, 'ssl_domain_mismatch');

  // 8. Certificate in error state
  const errorFix = {
    ...fix,
    certificateRegistry: {
      getCertificate: async () => ({
        ...fix.certificate,
        state: 'error',
        lastError: 'ACME HTTP-01 challenge failed',
      }),
    },
  };
  const errorService = createSiteHealthService(errorFix);
  const sslError = await errorService.inspectSslLayer({ domain: fix.domain });
  assert.equal(sslError.healthy, false);
  assert.equal(sslError.status, 'certificate_error');
  assert.equal(sslError.action, 'repair_ssl_certificate');

  // 9. Certificate in progress
  const progressFix = {
    ...fix,
    certificateRegistry: {
      getCertificate: async () => ({
        ...fix.certificate,
        state: 'issuing',
      }),
    },
  };
  const progressService = createSiteHealthService(progressFix);
  const sslProgress = await progressService.inspectSslLayer({ domain: fix.domain });
  assert.equal(sslProgress.healthy, false);
  assert.equal(sslProgress.status, 'certificate_in_progress');
});

test('site health: Nginx layer diagnostics detect missing active config and syntax error', async () => {
  const fix = createHealthyFixtures();

  // 1. Healthy Nginx
  const service = createSiteHealthService(fix);
  const nginxHealthy = await service.inspectNginxLayer({ domain: fix.domain, website: fix.website });
  assert.equal(nginxHealthy.healthy, true);
  assert.equal(nginxHealthy.status, 'healthy');
  assert.equal(nginxHealthy.syntaxValid, true);

  // 2. Nginx configuration missing or drifted
  const missingNginxFix = {
    ...fix,
    nginxManager: {
      inspectActiveDomain: async () => ({ satisfied: false }),
    },
  };
  const missingNginxService = createSiteHealthService(missingNginxFix);
  const nginxMissing = await missingNginxService.inspectNginxLayer({ domain: fix.domain, website: fix.website });
  assert.equal(nginxMissing.healthy, false);
  assert.equal(nginxMissing.status, 'config_missing');
  assert.equal(nginxMissing.action, 'repair_nginx_config');
  assert.equal(nginxMissing.actionCode, 'nginx_config_missing');

  // 3. Nginx syntax test failed (-t)
  const invalidSyntaxFix = {
    ...fix,
    execFn: async (bin, args) => {
      if (bin === '/usr/sbin/nginx' && args.includes('-t')) {
        throw new Error('nginx: [emerg] invalid directive "foo"');
      }
      return { exitCode: 0 };
    },
  };
  const invalidSyntaxService = createSiteHealthService(invalidSyntaxFix);
  const nginxInvalid = await invalidSyntaxService.inspectNginxLayer({ domain: fix.domain, website: fix.website });
  assert.equal(nginxInvalid.healthy, false);
  assert.equal(nginxInvalid.status, 'config_invalid');
  assert.equal(nginxInvalid.syntaxValid, false);
  assert.equal(nginxInvalid.action, 'repair_nginx_config');
  assert.equal(nginxInvalid.actionCode, 'nginx_syntax_invalid');
});

test('site health: Runtime layer diagnostics check release existence across runtime types', async () => {
  const fix = createHealthyFixtures();

  // 1. Static runtime
  const staticService = createSiteHealthService(fix);
  const staticRuntime = await staticService.inspectRuntimeLayer({ website: { ...fix.website, runtimeType: 'static' } });
  assert.equal(staticRuntime.healthy, true);
  assert.equal(staticRuntime.runtimeType, 'static');

  // 2. Passenger / Node runtime healthy with release symlink
  const passengerRuntime = await staticService.inspectRuntimeLayer({ website: fix.website });
  assert.equal(passengerRuntime.healthy, true);
  assert.equal(passengerRuntime.releaseReady, true);

  // 3. Passenger / Node runtime missing current release
  const missingReleaseFix = {
    ...fix,
    fs: createMockFs({
      // releaseDir omitted
    }),
  };
  const missingReleaseService = createSiteHealthService(missingReleaseFix);
  const missingReleaseRuntime = await missingReleaseService.inspectRuntimeLayer({ website: fix.website });
  assert.equal(missingReleaseRuntime.healthy, false);
  assert.equal(missingReleaseRuntime.status, 'release_missing');
  assert.equal(missingReleaseRuntime.action, 'repair_runtime');
  assert.equal(missingReleaseRuntime.actionCode, 'runtime_release_missing');

  // 4. PHP runtime
  const phpRuntime = await staticService.inspectRuntimeLayer({ website: { ...fix.website, runtimeType: 'php' } });
  assert.equal(phpRuntime.healthy, true);
  assert.equal(phpRuntime.runtimeType, 'php');

  // 5. Docker runtime
  const dockerRuntime = await staticService.inspectRuntimeLayer({ website: { ...fix.website, runtimeType: 'docker' } });
  assert.equal(dockerRuntime.healthy, true);
  assert.equal(dockerRuntime.runtimeType, 'docker');
});

test('site health: Filesystem layer diagnostics detect missing canonical paths, drift, and insecure 0777 permissions', async () => {
  const fix = createHealthyFixtures();

  // 1. Healthy canonical permissions (0750 / 0700)
  const service = createSiteHealthService(fix);
  const fsHealthy = await service.inspectFilesystemLayer({ website: fix.website });
  assert.equal(fsHealthy.healthy, true);
  assert.equal(fsHealthy.status, 'healthy');
  assert.equal(fsHealthy.paths.every((p) => p.secure), true);

  // 2. Insecure world-writable / 0777 permissions detected
  const insecureFsFix = {
    ...fix,
    fs: createMockFs({
      [fix.homeDir]: { type: 'dir', mode: 0o777 }, // Insecure!
      [fix.tmpDir]: { type: 'dir', mode: 0o700 },
      [fix.logsDir]: { type: 'dir', mode: 0o750 },
    }),
  };
  const insecureService = createSiteHealthService(insecureFsFix);
  const fsInsecure = await insecureService.inspectFilesystemLayer({ website: fix.website });
  assert.equal(fsInsecure.healthy, false);
  assert.equal(fsInsecure.status, 'permissions_insecure');
  assert.match(fsInsecure.message, /chmod 777 is forbidden/i);
  assert.equal(fsInsecure.action, 'repair_permissions');
  assert.equal(fsInsecure.actionCode, 'permissions_insecure');

  // 3. Canonical directories missing
  const missingPathsFix = {
    ...fix,
    fs: createMockFs({
      [fix.homeDir]: { type: 'dir', mode: 0o750 },
      // tmpDir missing!
      [fix.logsDir]: { type: 'dir', mode: 0o750 },
    }),
  };
  const missingPathsService = createSiteHealthService(missingPathsFix);
  const fsMissing = await missingPathsService.inspectFilesystemLayer({ website: fix.website });
  assert.equal(fsMissing.healthy, false);
  assert.equal(fsMissing.status, 'paths_missing');
  assert.equal(fsMissing.action, 'repair_permissions');
  assert.equal(fsMissing.actionCode, 'filesystem_paths_missing');

  // 4. Permissions drift (e.g. 0770 instead of 0750, but not world-writable)
  const driftFsFix = {
    ...fix,
    fs: createMockFs({
      [fix.homeDir]: { type: 'dir', mode: 0o750 },
      [fix.tmpDir]: { type: 'dir', mode: 0o700 },
      [fix.logsDir]: { type: 'dir', mode: 0o770 }, // Drift
    }),
  };
  const driftService = createSiteHealthService(driftFsFix);
  const fsDrift = await driftService.inspectFilesystemLayer({ website: fix.website });
  assert.equal(fsDrift.healthy, false);
  assert.equal(fsDrift.status, 'permissions_drift');
  assert.equal(fsDrift.action, 'repair_permissions');
  assert.equal(fsDrift.actionCode, 'permissions_drift');
});

test('site health: HTTP layer diagnostics probe /health and detect 5xx and unreachable state', async () => {
  const fix = createHealthyFixtures();

  // 1. Healthy HTTP response
  const service = createSiteHealthService(fix);
  const httpHealthy = await service.inspectHttpLayer({ domain: fix.domain });
  assert.equal(httpHealthy.healthy, true);
  assert.equal(httpHealthy.statusCode, 200);

  // 2. HTTP status error (e.g. 502 Bad Gateway)
  const badGatewayFix = {
    ...fix,
    websiteHttpHealthInspector: {
      inspect: async () => ({ satisfied: false, statusCode: 502, reason: 'http_bad_gateway' }),
    },
  };
  const badGatewayService = createSiteHealthService(badGatewayFix);
  const httpBadGateway = await badGatewayService.inspectHttpLayer({ domain: fix.domain });
  assert.equal(httpBadGateway.healthy, false);
  assert.equal(httpBadGateway.statusCode, 502);
  assert.equal(httpBadGateway.action, 'repair_nginx_config');

  // 3. HTTP network probe error (unreachable)
  const unreachableFix = {
    ...fix,
    websiteHttpHealthInspector: {
      inspect: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:80');
      },
    },
  };
  const unreachableService = createSiteHealthService(unreachableFix);
  const httpUnreachable = await unreachableService.inspectHttpLayer({ domain: fix.domain });
  assert.equal(httpUnreachable.healthy, false);
  assert.equal(httpUnreachable.status, 'http_error');
  assert.equal(httpUnreachable.action, 'repair_nginx_config');
});

test('site health: aggregated inspectSiteHealth accurately identifies failing layers and computes overall status', async () => {
  const fix = createHealthyFixtures();

  // All layers healthy
  const healthyService = createSiteHealthService(fix);
  const reportHealthy = await healthyService.inspectSiteHealth({ websiteId: TEST_WEBSITE_ID });
  assert.equal(reportHealthy.healthy, true);
  assert.equal(reportHealthy.status, 'healthy');
  assert.equal(reportHealthy.failingLayers.length, 0);
  assert.equal(reportHealthy.availableRepairs.length, 0);

  // Critical failure (insecure permissions)
  const criticalFix = {
    ...fix,
    fs: createMockFs({
      [fix.homeDir]: { type: 'dir', mode: 0o777 },
      [fix.tmpDir]: { type: 'dir', mode: 0o700 },
      [fix.logsDir]: { type: 'dir', mode: 0o750 },
      [fix.releaseDir]: { type: 'dir', mode: 0o755 },
    }),
  };
  const criticalService = createSiteHealthService(criticalFix);
  const reportCritical = await criticalService.inspectSiteHealth({ websiteId: TEST_WEBSITE_ID });
  assert.equal(reportCritical.healthy, false);
  assert.equal(reportCritical.status, 'critical');
  assert.ok(reportCritical.failingLayers.includes('filesystem'));
  assert.ok(reportCritical.availableRepairs.some((r) => r.action === 'repair_permissions'));

  // Degraded failure (DNS records missing only)
  const degradedFix = {
    ...fix,
    dnsResolver: {
      resolve4: async () => [],
      resolve6: async () => [],
    },
  };
  const degradedService = createSiteHealthService(degradedFix);
  const reportDegraded = await degradedService.inspectSiteHealth({ websiteId: TEST_WEBSITE_ID });
  assert.equal(reportDegraded.healthy, false);
  assert.equal(reportDegraded.status, 'degraded');
  assert.deepEqual(reportDegraded.failingLayers, ['dns']);
  assert.ok(reportDegraded.availableRepairs.some((r) => r.action === 'repair_dns_records'));
});

test('site health: repairSiteHealth strictly forbids permission loosening and invalid actions', async () => {
  const fix = createHealthyFixtures();
  const service = createSiteHealthService(fix);

  // Invalid action
  await assert.rejects(
    () => service.repairSiteHealth({ websiteId: TEST_WEBSITE_ID, action: 'invalid_action_name' }),
    (err) => err instanceof SiteHealthError && err.code === 'invalid_repair_action' && err.status === 400,
  );

  // General chmod 777 / permission loosening is strictly forbidden across all variants
  const looseningVariants = [
    { chmod: 777 },
    { chmod: '777' },
    { chmod: '0777' },
    { mode: 0o777 },
    { mode: '777' },
    { mode: '0777' },
    { allowInsecure: true },
    { relaxPermissions: true },
  ];

  for (const options of looseningVariants) {
    await assert.rejects(
      () => service.repairSiteHealth({
        websiteId: TEST_WEBSITE_ID,
        action: 'repair_permissions',
        options,
      }),
      (err) => err instanceof SiteHealthError
        && err.code === 'permissions_loosening_forbidden'
        && err.status === 400
        && /chmod 777 is strictly prohibited/i.test(err.message),
    );
  }
});

test('site health: repairSiteHealth executes controlled adapter operations and verifies post-repair state', async () => {
  const fix = createHealthyFixtures();

  // Setup filesystem with broken/insecure permissions initially
  fix.fs = createMockFs({
    [fix.homeDir]: { type: 'dir', mode: 0o777 }, // world-writable
    // tmpDir missing!
    [fix.logsDir]: { type: 'dir', mode: 0o777 }, // world-writable
    [fix.releaseDir]: { type: 'dir', mode: 0o755 },
  });

  const service = createSiteHealthService(fix);

  // 1. Repair filesystem permissions safely (restoring 0750 / 0700)
  const repairResult = await service.repairSiteHealth({
    websiteId: TEST_WEBSITE_ID,
    action: 'repair_permissions',
  });

  assert.equal(repairResult.success, true);
  assert.equal(repairResult.repairedLayer, 'filesystem');
  assert.equal(repairResult.verified, true);
  assert.match(repairResult.message, /Restored canonical directory permissions/);

  // Verify before and after states
  assert.equal(repairResult.before.layers.filesystem.healthy, false);
  assert.equal(repairResult.after.layers.filesystem.healthy, true);

  // Verify resulting filesystem modes in mock
  const homeStat = await fix.fs.lstat(fix.homeDir);
  const tmpStat = await fix.fs.lstat(fix.tmpDir);
  const logsStat = await fix.fs.lstat(fix.logsDir);
  assert.equal(homeStat.mode, siteHealthInternals.MANAGED_MODES.home);
  assert.equal(tmpStat.mode, siteHealthInternals.MANAGED_MODES.temporary);
  assert.equal(logsStat.mode, siteHealthInternals.MANAGED_MODES.logs);

  // 2. Repair Nginx config
  let staged = false;
  let activated = false;
  const nginxFix = {
    ...fix,
    nginxManager: {
      inspectActiveDomain: async () => ({ satisfied: staged && activated }),
      stageDomain: async () => {
        staged = true;
        return { checksum: '1'.repeat(64) };
      },
      activateDomain: async () => {
        activated = true;
        return { active: true };
      },
    },
  };
  const nginxService = createSiteHealthService(nginxFix);
  const nginxRepair = await nginxService.repairSiteHealth({
    websiteId: TEST_WEBSITE_ID,
    action: 'repair_nginx_config',
  });
  assert.equal(nginxRepair.success, true);
  assert.equal(nginxRepair.verified, true);
  assert.equal(staged, true);
  assert.equal(activated, true);

  // 3. Repair all
  const repairAllResult = await service.repairSiteHealth({
    websiteId: TEST_WEBSITE_ID,
    action: 'repair_all',
  });
  assert.equal(repairAllResult.success, true);
  assert.equal(repairAllResult.verified, true);
});

test('site health HTTP routes: GET and POST website health endpoints', async () => {
  const fix = createHealthyFixtures();
  const siteHealthService = createSiteHealthService(fix);
  const app = createHealthTestApp({ siteHealthService });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /api/websites/:websiteId/health
    const getRes = await fetch(`${baseUrl}/api/websites/${TEST_WEBSITE_ID}/health`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.data.websiteId, TEST_WEBSITE_ID);
    assert.equal(getData.data.healthy, true);
    assert.ok(getData.data.layers.dns);
    assert.ok(getData.data.layers.ssl);
    assert.ok(getData.data.layers.nginx);
    assert.ok(getData.data.layers.runtime);
    assert.ok(getData.data.layers.filesystem);
    assert.ok(getData.data.layers.http);

    // 2. POST /api/websites/:websiteId/health/repair (successful)
    const postRes = await fetch(`${baseUrl}/api/websites/${TEST_WEBSITE_ID}/health/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'repair_permissions' }),
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.data.action, 'repair_permissions');
    assert.equal(postData.data.success, true);
    assert.equal(postData.data.verified, true);

    // 3. POST /api/websites/:websiteId/health/repair (missing action in body)
    const badActionRes = await fetch(`${baseUrl}/api/websites/${TEST_WEBSITE_ID}/health/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(badActionRes.status, 400);
    const badActionData = await badActionRes.json();
    assert.equal(badActionData.error.code, 'repair_action_required');

    // 4. POST /api/websites/:websiteId/health/repair (attempt chmod 777 loosening rejected)
    const looseningRes = await fetch(`${baseUrl}/api/websites/${TEST_WEBSITE_ID}/health/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'repair_permissions', options: { chmod: 777 } }),
    });
    assert.equal(looseningRes.status, 400);
    const looseningData = await looseningRes.json();
    assert.equal(looseningData.error.code, 'permissions_loosening_forbidden');
  } finally {
    server.close();
  }
});

test('site health HTTP routes: GET and POST domain health endpoints', async () => {
  const fix = createHealthyFixtures();
  const siteHealthService = createSiteHealthService(fix);
  const app = createHealthTestApp({ siteHealthService });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /api/domains/:domainId/health
    const getRes = await fetch(`${baseUrl}/api/domains/${TEST_DOMAIN_ID}/health`);
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.data.domainId, TEST_DOMAIN_ID);
    assert.equal(getData.data.healthy, true);

    // 2. POST /api/domains/:domainId/health/repair
    const postRes = await fetch(`${baseUrl}/api/domains/${TEST_DOMAIN_ID}/health/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'repair_nginx_config' }),
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json();
    assert.equal(postData.data.action, 'repair_nginx_config');
    assert.equal(postData.data.success, true);
  } finally {
    server.close();
  }
});

test('site health HTTP routes: role security guard denies read_only and unauthenticated users', async () => {
  const fix = createHealthyFixtures();
  const siteHealthService = createSiteHealthService(fix);

  // App with read_only user role
  const readOnlyApp = createHealthTestApp({ siteHealthService, role: 'read_only' });
  const server = readOnlyApp.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const postRes = await fetch(`${baseUrl}/api/websites/${TEST_WEBSITE_ID}/health/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'repair_permissions' }),
    });
    assert.equal(postRes.status, 403);
    const data = await postRes.json();
    assert.equal(data.error.code, 'forbidden');
  } finally {
    server.close();
  }
});
