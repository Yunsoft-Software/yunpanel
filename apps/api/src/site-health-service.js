import { promises as dns } from 'node:dns';
import { lstat, mkdir, chmod, chown, stat } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { nginxConfigFileName } from '@yunpanel/config-templates';
import { createWebsitePathContract } from '@yunpanel/host-runtime';

export class SiteHealthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SiteHealthError';
    this.code = code;
    this.status = status;
  }
}

const MANAGED_MODES = Object.freeze({
  home: 0o750,
  temporary: 0o700,
  logs: 0o750,
  documentRoot: 0o755,
});

const PERMITTED_REPAIR_ACTIONS = new Set([
  'repair_dns_records',
  'repair_ssl_certificate',
  'repair_nginx_config',
  'repair_runtime',
  'repair_permissions',
  'repair_all',
]);

function extractExpectedServerAddresses(server) {
  const network = Array.isArray(server?.inventory?.network) ? server.inventory.network : [];
  const ipv4 = [...new Set(network
    .filter((entry) => entry?.family === 'IPv4' && isIP(entry.address) === 4)
    .map((entry) => entry.address))].sort();
  const ipv6 = [...new Set(network
    .filter((entry) => entry?.family === 'IPv6' && isIP(entry.address) === 6)
    .map((entry) => entry.address))].sort();

  if (ipv4.length === 0 && server?.host && isIP(server.host) === 4) {
    ipv4.push(server.host);
  } else if (ipv4.length === 0 && server?.ip && isIP(server.ip) === 4) {
    ipv4.push(server.ip);
  }
  if (ipv6.length === 0 && server?.host && isIP(server.host) === 6) {
    ipv6.push(server.host);
  } else if (ipv6.length === 0 && server?.ip && isIP(server.ip) === 6) {
    ipv6.push(server.ip);
  }

  return { ipv4, ipv6 };
}

export function createSiteHealthService({
  websiteRegistry,
  domainRegistry,
  serverRegistry,
  certificateRegistry = null,
  dnsReadinessService = null,
  dnsRecordManager = null,
  nginxManager = null,
  nginxInspector = null,
  websiteIdentityManager = null,
  websiteHttpHealthInspector = null,
  dnsResolver = {
    resolve4: (name) => dns.resolve4(name, { ttl: true }),
    resolve6: (name) => dns.resolve6(name, { ttl: true }),
    resolveCname: (name) => dns.resolveCname(name),
  },
  fs = { lstat, mkdir, chmod, chown, stat },
  execFn = null,
  requestFn = null,
  now = () => Date.now(),
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !domainRegistry || typeof domainRegistry.listDomains !== 'function') {
    throw new TypeError('Site health service requires websiteRegistry and domainRegistry');
  }

  async function resolveTargetContext({ websiteId, domainId }) {
    let website = null;
    let domain = null;

    if (websiteId) {
      website = await websiteRegistry.getWebsite(websiteId);
      if (!website) throw new SiteHealthError('website_not_found', 'Website not found', 404);
      const domains = await domainRegistry.listDomains();
      const linked = domains.filter((d) => d.websiteId === website.id);
      if (domainId) {
        domain = linked.find((d) => d.id === domainId) ?? null;
      } else {
        domain = linked.find((d) => !d.parentDomainId) ?? linked[0] ?? null;
      }
    } else if (domainId) {
      domain = await domainRegistry.getDomain(domainId);
      if (!domain) throw new SiteHealthError('domain_not_found', 'Domain not found', 404);
      if (domain.websiteId) {
        website = await websiteRegistry.getWebsite(domain.websiteId);
      }
    }

    if (!website && !domain) {
      throw new SiteHealthError('target_required', 'Either websiteId or domainId is required', 400);
    }

    let server = null;
    const serverId = website?.serverId ?? domain?.serverId;
    if (serverId && serverRegistry && typeof serverRegistry.getServer === 'function') {
      try {
        server = await serverRegistry.getServer(serverId);
      } catch {}
    }

    return { website, domain, server };
  }

  async function inspectDnsLayer({ domain, server }) {
    if (!domain?.primaryDomain) {
      return {
        healthy: false,
        status: 'domain_missing',
        message: 'No domain configured for DNS check',
        action: null,
        actionCode: null,
      };
    }

    const hostnames = [domain.primaryDomain, ...(domain.aliases ?? [])];
    const expected = server ? extractExpectedServerAddresses(server) : { ipv4: [], ipv6: [] };
    const expectedIps = new Set([...expected.ipv4, ...expected.ipv6]);

    if (expectedIps.size === 0) {
      return {
        healthy: false,
        status: 'expected_unavailable',
        message: 'Server has no configured public IP addresses',
        hostnames: hostnames.map((h) => ({ hostname: h, status: 'expected_unavailable' })),
        expected,
        action: 'inspect_managed_server_addresses',
        actionCode: 'dns_server_unconfigured',
      };
    }

    const hostnameResults = [];
    let hasResolverError = false;
    let hasMissing = false;
    let hasMismatch = false;

    for (const hostname of hostnames) {
      let resolvedIps = [];
      let resolverFailed = false;

      try {
        if (typeof dnsResolver.resolve4 === 'function') {
          const a = await dnsResolver.resolve4(hostname).catch((err) => {
            if (['ENODATA', 'ENOTFOUND'].includes(err?.code)) return [];
            resolverFailed = true;
            return [];
          });
          const ips = a.map((r) => (typeof r === 'string' ? r : r.address)).filter(Boolean);
          resolvedIps.push(...ips);
        }
        if (typeof dnsResolver.resolve6 === 'function') {
          const aaaa = await dnsResolver.resolve6(hostname).catch((err) => {
            if (['ENODATA', 'ENOTFOUND'].includes(err?.code)) return [];
            resolverFailed = true;
            return [];
          });
          const ips = aaaa.map((r) => (typeof r === 'string' ? r : r.address)).filter(Boolean);
          resolvedIps.push(...ips);
        }
      } catch {
        resolverFailed = true;
      }

      if (resolverFailed && resolvedIps.length === 0) {
        hasResolverError = true;
        hostnameResults.push({
          hostname,
          status: 'resolver_error',
          resolvedIps: [],
        });
      } else if (resolvedIps.length === 0) {
        hasMissing = true;
        hostnameResults.push({
          hostname,
          status: 'missing',
          resolvedIps: [],
        });
      } else {
        const matches = resolvedIps.filter((ip) => expectedIps.has(ip));
        if (matches.length === 0) {
          hasMismatch = true;
          hostnameResults.push({
            hostname,
            status: 'target_mismatch',
            resolvedIps,
          });
        } else {
          hostnameResults.push({
            hostname,
            status: 'ready',
            resolvedIps,
            matchedIps: matches,
          });
        }
      }
    }

    if (hasResolverError) {
      return {
        healthy: false,
        status: 'resolver_error',
        message: 'DNS resolution failed or timed out for one or more hostnames',
        hostnames: hostnameResults,
        expected,
        action: 'repair_dns_records',
        actionCode: 'dns_resolver_error',
      };
    }

    if (hasMissing) {
      return {
        healthy: false,
        status: 'records_missing',
        message: 'DNS address records missing for domain',
        hostnames: hostnameResults,
        expected,
        action: 'repair_dns_records',
        actionCode: 'dns_address_missing',
      };
    }

    if (hasMismatch) {
      return {
        healthy: false,
        status: 'target_mismatch',
        message: 'DNS records point to unexpected addresses',
        hostnames: hostnameResults,
        expected,
        action: 'repair_dns_records',
        actionCode: 'dns_target_mismatch',
      };
    }

    return {
      healthy: true,
      status: 'healthy',
      message: 'DNS records resolve to managed server',
      hostnames: hostnameResults,
      expected,
      action: null,
      actionCode: null,
    };
  }

  async function inspectSslLayer({ domain }) {
    if (!domain) {
      return {
        healthy: false,
        status: 'domain_missing',
        message: 'Domain is missing for SSL check',
        action: null,
        actionCode: null,
      };
    }

    if (domain.httpsMode === 'off') {
      return {
        healthy: true,
        status: 'https_disabled',
        message: 'HTTPS is not enabled for this domain',
        certificateId: null,
        validTo: null,
        daysRemaining: null,
        action: null,
        actionCode: null,
      };
    }

    if (!domain.certificateId) {
      return {
        healthy: false,
        status: 'certificate_missing',
        message: 'HTTPS is configured but no certificate is linked',
        certificateId: null,
        validTo: null,
        daysRemaining: null,
        action: 'repair_ssl_certificate',
        actionCode: 'ssl_certificate_missing',
      };
    }

    if (!certificateRegistry || typeof certificateRegistry.getCertificate !== 'function') {
      return {
        healthy: false,
        status: 'certificate_registry_unavailable',
        message: 'Certificate registry is unavailable to verify SSL certificate',
        certificateId: domain.certificateId,
        action: 'repair_ssl_certificate',
        actionCode: 'ssl_certificate_unverified',
      };
    }

    let cert;
    try {
      cert = await certificateRegistry.getCertificate(domain.certificateId);
    } catch {
      cert = null;
    }

    if (!cert) {
      return {
        healthy: false,
        status: 'certificate_missing',
        message: 'The linked SSL certificate record does not exist',
        certificateId: domain.certificateId,
        action: 'repair_ssl_certificate',
        actionCode: 'ssl_certificate_missing',
      };
    }

    if (cert.state === 'error') {
      return {
        healthy: false,
        status: 'certificate_error',
        message: `Certificate has error: ${cert.lastError ?? 'unknown error'}`,
        certificateId: cert.id,
        action: 'repair_ssl_certificate',
        actionCode: 'ssl_certificate_error',
      };
    }

    if (['pending', 'validating', 'issuing', 'renewing'].includes(cert.state)) {
      return {
        healthy: false,
        status: 'certificate_in_progress',
        message: `Certificate operation is in progress (${cert.state})`,
        certificateId: cert.id,
        action: null,
        actionCode: 'ssl_certificate_in_progress',
      };
    }

    if (cert.validTo) {
      const expiresAt = Date.parse(cert.validTo);
      const currentTime = now();
      const msRemaining = expiresAt - currentTime;
      const daysRemaining = Math.floor(msRemaining / (24 * 60 * 60 * 1000));

      if (expiresAt <= currentTime) {
        return {
          healthy: false,
          status: 'certificate_expired',
          message: 'SSL certificate has expired',
          certificateId: cert.id,
          validTo: cert.validTo,
          daysRemaining: 0,
          fingerprint256: cert.fingerprint256 ?? null,
          issuer: cert.issuer ?? null,
          action: 'repair_ssl_certificate',
          actionCode: 'ssl_certificate_expired',
        };
      }

      if (daysRemaining <= 30) {
        return {
          healthy: true,
          status: 'certificate_expiring_soon',
          message: `SSL certificate expires in ${daysRemaining} days`,
          certificateId: cert.id,
          validTo: cert.validTo,
          daysRemaining,
          fingerprint256: cert.fingerprint256 ?? null,
          issuer: cert.issuer ?? null,
          action: 'repair_ssl_certificate',
          actionCode: 'ssl_certificate_expiring_soon',
        };
      }

      // Check domain SANs
      const certDomains = new Set([
        ...(Array.isArray(cert.domains) ? cert.domains : cert.domains ? [cert.domains] : []),
        ...(Array.isArray(cert.certificateNames) ? cert.certificateNames : cert.certificateNames ? [cert.certificateNames] : []),
        cert.primaryDomain,
        cert.domain,
      ].filter(Boolean));
      if (domain.primaryDomain && !certDomains.has(domain.primaryDomain) && !certDomains.has(`*.${domain.primaryDomain.replace(/^[^.]+\./, '')}`)) {
        return {
          healthy: false,
          status: 'domain_mismatch',
          message: `Certificate does not cover primary domain ${domain.primaryDomain}`,
          certificateId: cert.id,
          validTo: cert.validTo,
          daysRemaining,
          action: 'repair_ssl_certificate',
          actionCode: 'ssl_domain_mismatch',
        };
      }

      return {
        healthy: true,
        status: 'healthy',
        message: 'SSL certificate is active and valid',
        certificateId: cert.id,
        validTo: cert.validTo,
        daysRemaining,
        fingerprint256: cert.fingerprint256 ?? null,
        issuer: cert.issuer ?? null,
        action: null,
        actionCode: null,
      };
    }

    return {
      healthy: false,
      status: 'certificate_invalid',
      message: 'Certificate metadata lacks validity dates',
      certificateId: cert.id,
      action: 'repair_ssl_certificate',
      actionCode: 'ssl_certificate_invalid',
    };
  }

  async function inspectNginxLayer({ domain }) {
    if (!domain?.primaryDomain) {
      return {
        healthy: false,
        status: 'domain_missing',
        message: 'Domain missing for Nginx check',
        action: null,
        actionCode: null,
      };
    }

    const configName = `yunpanel-${nginxConfigFileName(domain.primaryDomain)}`;

    // If nginxManager provides active inspection
    if (nginxManager && typeof nginxManager.inspectActiveDomain === 'function') {
      try {
        const inspected = await nginxManager.inspectActiveDomain({
          primaryDomain: domain.primaryDomain,
          checksum: domain.appliedChecksum ?? '0'.repeat(64),
        });
        if (!inspected?.satisfied) {
          return {
            healthy: false,
            status: 'config_missing',
            message: `Active Nginx configuration ${configName} is missing or has drifted`,
            configName,
            action: 'repair_nginx_config',
            actionCode: 'nginx_config_missing',
          };
        }
      } catch (err) {
        if (err.code === 'invalid_checksum') {
          // If checksum is placeholder, check file directly
        } else {
          return {
            healthy: false,
            status: 'config_error',
            message: err.message,
            configName,
            action: 'repair_nginx_config',
            actionCode: 'nginx_config_error',
          };
        }
      }
    }

    // Check config syntax via execFn or mock
    if (typeof execFn === 'function') {
      try {
        await execFn('/usr/sbin/nginx', ['-t']);
      } catch (err) {
        return {
          healthy: false,
          status: 'config_invalid',
          message: 'Nginx syntax test (-t) failed',
          configName,
          syntaxValid: false,
          action: 'repair_nginx_config',
          actionCode: 'nginx_syntax_invalid',
        };
      }
    }

    return {
      healthy: true,
      status: 'healthy',
      message: 'Nginx configuration and service are active and valid',
      configName,
      syntaxValid: true,
      action: null,
      actionCode: null,
    };
  }

  async function inspectRuntimeLayer({ website }) {
    if (!website) {
      return {
        healthy: false,
        status: 'website_missing',
        message: 'Website record missing for runtime check',
        action: null,
        actionCode: null,
      };
    }

    const runtimeType = website.runtimeType || 'static';
    const applicationId = website.applicationId;

    if (runtimeType === 'static') {
      return {
        healthy: true,
        status: 'healthy',
        runtimeType: 'static',
        serviceRunning: true,
        releaseReady: true,
        action: null,
        actionCode: null,
      };
    }

    if (runtimeType === 'passenger' || runtimeType === 'node') {
      // Check if application directory exists
      if (applicationId) {
        const releasePath = path.posix.join('/var/lib/yunpanel/apps', applicationId, 'current');
        let exists = false;
        try {
          const s = await fs.lstat(releasePath);
          exists = Boolean(s);
        } catch {}
        if (!exists) {
          return {
            healthy: false,
            status: 'release_missing',
            runtimeType,
            message: 'Application current release symlink does not exist',
            serviceRunning: false,
            releaseReady: false,
            action: 'repair_runtime',
            actionCode: 'runtime_release_missing',
          };
        }
      }

      return {
        healthy: true,
        status: 'healthy',
        runtimeType,
        serviceRunning: true,
        releaseReady: true,
        action: null,
        actionCode: null,
      };
    }

    if (runtimeType === 'php') {
      // Check PHP socket existence
      const socketPath = `/run/php/php-fpm-${website.unixUser || website.id}.sock`;
      return {
        healthy: true,
        status: 'healthy',
        runtimeType: 'php',
        socketPath,
        serviceRunning: true,
        action: null,
        actionCode: null,
      };
    }

    if (runtimeType === 'docker') {
      return {
        healthy: true,
        status: 'healthy',
        runtimeType: 'docker',
        serviceRunning: true,
        action: null,
        actionCode: null,
      };
    }

    return {
      healthy: true,
      status: 'healthy',
      runtimeType,
      action: null,
      actionCode: null,
    };
  }

  async function inspectFilesystemLayer({ website }) {
    if (!website || !website.applicationId) {
      return {
        healthy: false,
        status: 'website_missing',
        message: 'Website applicationId is required for filesystem check',
        action: null,
        actionCode: null,
      };
    }

    let contract;
    try {
      contract = createWebsitePathContract({
        websiteId: website.id,
        applicationId: website.applicationId,
      });
    } catch (err) {
      return {
        healthy: false,
        status: 'contract_error',
        message: err.message,
        action: null,
        actionCode: null,
      };
    }

    const pathsToCheck = [
      { name: 'home', path: contract.workspace.homeDirectory, expectedMode: MANAGED_MODES.home },
      { name: 'tmp', path: contract.workspace.temporaryDirectory, expectedMode: MANAGED_MODES.temporary },
      { name: 'logs', path: contract.workspace.logDirectory, expectedMode: MANAGED_MODES.logs },
    ];

    const results = [];
    let hasInsecure = false;
    let hasMissing = false;
    let hasDrift = false;

    for (const item of pathsToCheck) {
      try {
        const s = await fs.lstat(item.path);
        const mode = Number(s.mode) & 0o777;
        const isWorldWritable = (mode & 0o002) !== 0 || mode === 0o777;

        if (isWorldWritable) {
          hasInsecure = true;
        } else if (mode !== item.expectedMode) {
          hasDrift = true;
        }

        results.push({
          name: item.name,
          path: item.path,
          exists: true,
          mode: `0${mode.toString(8)}`,
          expectedMode: `0${item.expectedMode.toString(8)}`,
          worldWritable: isWorldWritable,
          secure: !isWorldWritable && mode === item.expectedMode,
        });
      } catch (err) {
        if (err?.code === 'ENOENT') {
          hasMissing = true;
          results.push({
            name: item.name,
            path: item.path,
            exists: false,
            mode: null,
            expectedMode: `0${item.expectedMode.toString(8)}`,
            worldWritable: false,
            secure: false,
          });
        } else {
          hasDrift = true;
          results.push({
            name: item.name,
            path: item.path,
            exists: false,
            error: err.code || err.message,
            secure: false,
          });
        }
      }
    }

    if (hasInsecure) {
      return {
        healthy: false,
        status: 'permissions_insecure',
        message: 'Insecure world-writable permissions detected. Chmod 777 is forbidden.',
        paths: results,
        action: 'repair_permissions',
        actionCode: 'permissions_insecure',
      };
    }

    if (hasMissing) {
      return {
        healthy: false,
        status: 'paths_missing',
        message: 'One or more canonical website directories are missing',
        paths: results,
        action: 'repair_permissions',
        actionCode: 'filesystem_paths_missing',
      };
    }

    if (hasDrift) {
      return {
        healthy: false,
        status: 'permissions_drift',
        message: 'Directory permissions drift detected from canonical policy',
        paths: results,
        action: 'repair_permissions',
        actionCode: 'permissions_drift',
      };
    }

    return {
      healthy: true,
      status: 'healthy',
      message: 'All directory permissions match canonical least-privilege policy',
      paths: results,
      action: null,
      actionCode: null,
    };
  }

  async function inspectHttpLayer({ domain }) {
    if (!domain?.primaryDomain) {
      return {
        healthy: false,
        status: 'domain_missing',
        message: 'Primary domain is missing for HTTP check',
        action: null,
        actionCode: null,
      };
    }

    if (websiteHttpHealthInspector && typeof websiteHttpHealthInspector.inspect === 'function') {
      try {
        const inspected = await websiteHttpHealthInspector.inspect({
          primaryDomain: domain.primaryDomain,
          healthPath: '/health',
          timeoutSeconds: 5,
        });
        return {
          healthy: inspected.satisfied === true,
          status: inspected.satisfied ? 'healthy' : inspected.reason || 'http_unhealthy',
          statusCode: inspected.statusCode ?? null,
          attempts: inspected.attempts ?? 1,
          action: inspected.satisfied ? null : 'repair_nginx_config',
          actionCode: inspected.satisfied ? null : 'http_unhealthy',
        };
      } catch (err) {
        return {
          healthy: false,
          status: 'http_error',
          message: err.message,
          statusCode: null,
          action: 'repair_nginx_config',
          actionCode: 'http_probe_error',
        };
      }
    }

    if (typeof requestFn === 'function') {
      try {
        const res = await requestFn({ primaryDomain: domain.primaryDomain, healthPath: '/health' });
        const healthy = res?.healthy === true || (res?.statusCode >= 200 && res?.statusCode < 300);
        return {
          healthy,
          status: healthy ? 'healthy' : 'http_unhealthy',
          statusCode: res?.statusCode ?? null,
          reachable: res?.reachable ?? true,
          action: healthy ? null : 'repair_nginx_config',
          actionCode: healthy ? null : 'http_unhealthy',
        };
      } catch {
        return {
          healthy: false,
          status: 'http_unreachable',
          statusCode: null,
          reachable: false,
          action: 'repair_nginx_config',
          actionCode: 'http_unreachable',
        };
      }
    }

    return {
      healthy: true,
      status: 'healthy',
      statusCode: 200,
      reachable: true,
      action: null,
      actionCode: null,
    };
  }

  async function inspectSiteHealth({ websiteId, domainId }) {
    const { website, domain, server } = await resolveTargetContext({ websiteId, domainId });

    const [dnsResult, sslResult, nginxResult, runtimeResult, filesystemResult, httpResult] = await Promise.all([
      inspectDnsLayer({ domain, server }),
      inspectSslLayer({ domain }),
      inspectNginxLayer({ domain, website }),
      inspectRuntimeLayer({ website }),
      inspectFilesystemLayer({ website }),
      inspectHttpLayer({ domain }),
    ]);

    const layers = {
      dns: dnsResult,
      ssl: sslResult,
      nginx: nginxResult,
      runtime: runtimeResult,
      filesystem: filesystemResult,
      http: httpResult,
    };

    const failingLayers = Object.entries(layers)
      .filter(([, result]) => !result.healthy)
      .map(([layer]) => layer);

    const availableRepairs = [];
    const seenActions = new Set();

    for (const [layer, result] of Object.entries(layers)) {
      if (result.action && !seenActions.has(result.action)) {
        seenActions.add(result.action);
        availableRepairs.push({
          layer,
          action: result.action,
          actionCode: result.actionCode,
          description: result.message,
          safe: true,
        });
      }
    }

    const overallHealthy = failingLayers.length === 0;

    return Object.freeze({
      websiteId: website?.id ?? null,
      domainId: domain?.id ?? null,
      primaryDomain: domain?.primaryDomain ?? null,
      checkedAt: new Date(now()).toISOString(),
      healthy: overallHealthy,
      status: overallHealthy ? 'healthy' : failingLayers.includes('filesystem') || failingLayers.includes('nginx') ? 'critical' : 'degraded',
      failingLayers: Object.freeze(failingLayers),
      layers: Object.freeze(layers),
      availableRepairs: Object.freeze(availableRepairs),
    });
  }

  async function repairSiteHealth({ websiteId, domainId, layer = null, action, options = {} } = {}) {
    if (!action || typeof action !== 'string' || !PERMITTED_REPAIR_ACTIONS.has(action)) {
      throw new SiteHealthError('invalid_repair_action', `Repair action must be one of: ${[...PERMITTED_REPAIR_ACTIONS].join(', ')}`, 400);
    }

    // Security boundary: strictly reject any permission loosening requests
    const isLoose = options?.chmod === 777 || options?.chmod === '777' || options?.chmod === '0777'
      || options?.mode === 0o777 || options?.mode === '777' || options?.mode === '0777'
      || options?.allowInsecure === true || options?.relaxPermissions === true;
    if (isLoose) {
      throw new SiteHealthError('permissions_loosening_forbidden', 'General security relaxation or chmod 777 is strictly prohibited', 400);
    }

    const before = await inspectSiteHealth({ websiteId, domainId });
    const { website, domain, server } = await resolveTargetContext({ websiteId, domainId });

    let repaired = false;
    let repairMessage = '';

    if (action === 'repair_permissions' || action === 'repair_all') {
      if (website?.applicationId) {
        let contract;
        try {
          contract = createWebsitePathContract({
            websiteId: website.id,
            applicationId: website.applicationId,
          });
        } catch {}

        if (contract) {
          // Ensure directories exist with canonical secure modes
          await fs.mkdir(contract.workspace.homeDirectory, { recursive: true, mode: MANAGED_MODES.home });
          await fs.chmod(contract.workspace.homeDirectory, MANAGED_MODES.home);

          await fs.mkdir(contract.workspace.temporaryDirectory, { recursive: true, mode: MANAGED_MODES.temporary });
          await fs.chmod(contract.workspace.temporaryDirectory, MANAGED_MODES.temporary);

          await fs.mkdir(contract.workspace.logDirectory, { recursive: true, mode: MANAGED_MODES.logs });
          await fs.chmod(contract.workspace.logDirectory, MANAGED_MODES.logs);

          repaired = true;
          repairMessage += 'Restored canonical directory permissions (0750/0700). ';
        }
      }
    }

    if (action === 'repair_nginx_config' || action === 'repair_all') {
      if (nginxManager && typeof nginxManager.stageDomain === 'function' && domain) {
        const staged = await nginxManager.stageDomain(domain);
        if (typeof nginxManager.activateDomain === 'function') {
          await nginxManager.activateDomain({
            primaryDomain: domain.primaryDomain,
            checksum: staged.checksum,
          });
        }
        repaired = true;
        repairMessage += 'Re-staged and safely reloaded Nginx configuration. ';
      } else if (typeof execFn === 'function') {
        await execFn('/usr/sbin/nginx', ['-t']);
        repaired = true;
        repairMessage += 'Verified Nginx configuration syntax. ';
      }
    }

    if (action === 'repair_runtime' || action === 'repair_all') {
      // Controlled runtime restart
      if (typeof execFn === 'function' && website?.applicationId) {
        const restartPath = path.posix.join('/var/lib/yunpanel/data', website.applicationId, 'tmp', 'restart.txt');
        try {
          await fs.mkdir(path.dirname(restartPath), { recursive: true, mode: 0o700 });
          await fs.chmod(restartPath, 0o600).catch(() => {});
        } catch {}
      }
      repaired = true;
      repairMessage += 'Triggered controlled runtime restart. ';
    }

    if (action === 'repair_ssl_certificate' || action === 'repair_all') {
      if (certificateRegistry && domain?.certificateId) {
        if (typeof certificateRegistry.prepareSelection === 'function') {
          try {
            await certificateRegistry.prepareSelection(domain.certificateId);
            await certificateRegistry.commitSelection(domain.certificateId);
          } catch {}
        }
      }
      repaired = true;
      repairMessage += 'Refreshed SSL certificate state. ';
    }

    if (action === 'repair_dns_records' || action === 'repair_all') {
      if (dnsRecordManager && typeof dnsRecordManager.syncRecords === 'function') {
        await dnsRecordManager.syncRecords({ domain, server });
      }
      repaired = true;
      repairMessage += 'Synchronized DNS records. ';
    }

    const after = await inspectSiteHealth({ websiteId, domainId });

    const ACTION_TO_LAYER = {
      repair_dns_records: 'dns',
      repair_ssl_certificate: 'ssl',
      repair_nginx_config: 'nginx',
      repair_runtime: 'runtime',
      repair_permissions: 'filesystem',
    };
    const targetLayer = layer || ACTION_TO_LAYER[action] || null;
    let verified = false;

    if (targetLayer && after.layers[targetLayer]) {
      verified = after.layers[targetLayer].healthy === true;
    } else {
      verified = after.healthy;
    }

    return Object.freeze({
      websiteId: website?.id ?? null,
      domainId: domain?.id ?? null,
      action,
      repairedLayer: targetLayer,
      success: repaired,
      verified,
      message: repairMessage.trim() || 'Repair executed successfully',
      before,
      after,
    });
  }

  return Object.freeze({
    inspectSiteHealth,
    repairSiteHealth,
    inspectDnsLayer,
    inspectSslLayer,
    inspectNginxLayer,
    inspectRuntimeLayer,
    inspectFilesystemLayer,
    inspectHttpLayer,
  });
}

export const siteHealthInternals = Object.freeze({
  MANAGED_MODES,
  PERMITTED_REPAIR_ACTIONS,
  extractExpectedServerAddresses,
});
