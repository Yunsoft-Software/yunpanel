// An additional boundary for site-scoped UI resources. It does not replace
// authentication/CSRF, the existing route guards or lifecycle validation.
import { extractActorTenant } from './tenant-boundary.js';

class ScopeError extends Error {
  constructor(status = 403) { super('Site resource access denied'); this.status = status; }
}
const readOnly = (method) => method === 'GET' || method === 'HEAD';
function identity(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[%/\\\u0000-\u0020\u007f]/.test(value)) throw new ScopeError();
  return value;
}
function routeUrl(request) {
  const url = new URL(request.originalUrl ?? request.url, 'http://panel.internal');
  try { url.pathname = url.pathname.split('/').map((part) => encodeURIComponent(decodeURIComponent(part))).join('/'); }
  catch { throw new ScopeError(); }
  return url;
}
const decodeId = (value) => { try { return identity(decodeURIComponent(value)); } catch { throw new ScopeError(); } };
export function needsSiteResourceJson(request) {
  if (readOnly(request.method)) return false;
  const role = request.auth?.user?.role;
  const isSiteScoped = role === 'site_manager' || role === 'reseller' || role === 'customer'
    || request.auth?.user?.hosting?.kind === 'reseller'
    || request.auth?.user?.hosting?.kind === 'customer'
    || (role && !['owner', 'read_only'].includes(role));
  if (!isSiteScoped) return false;
  const path = new URL(request.originalUrl ?? request.url, 'http://panel.internal').pathname.replace(/\/$/, '');
  if (/\/files(?:\/|$)/.test(path)) return false;
  return /^\/api\/(?:mailboxes|mail-aliases|mail-domains|domains|websites(?:\/|$)|sites(?:\/|$)|terminal(?:\/|$))/.test(path)
    || /^\/api\/servers\/[^/]+\/websites\/[^/]+\/phpmyadmin-handoffs$/.test(path)
    || /^\/api\/servers\/[^/]+\/websites\/[^/]+\/elfinder-handoffs$/.test(path);
}
function replaceCollection(response, accept, project = (value) => value) {
  const original = response.json.bind(response);
  response.json = (payload) => {
    if (!Array.isArray(payload?.data)) return original(payload);
    // Do not retain global total/count metadata after applying a site scope.
    return original({ data: payload.data.filter(accept).map(project) });
  };
}
export function createSiteResourceBoundary(options = {}) {
  const { websiteRegistry, domainRegistry, databaseBindingRegistry, databaseCredentialRegistry,
    mailDomainRegistry, mailboxRegistry, mailAliasRegistry, jobRegistry, localServerId = null,
    customerLookup = null } = options;
  const get = async (registry, method, value) => {
    if (typeof registry?.[method] !== 'function') throw new ScopeError(503);
    try { return await registry[method](value); } catch { throw new ScopeError(503); }
  };
  return async function siteResourceBoundary(request, response, next) {
    const auth = request.auth;
    if (!auth?.user) return next();
    const actorTenant = extractActorTenant(auth);
    if (actorTenant.isGlobal) return next();
    if (!actorTenant.active) {
      response.setHeader?.('Cache-Control', 'no-store');
      return response.status(403).json({ error: { code: 'site_scope_forbidden', message: 'Inactive account cannot access site resources.' } });
    }
    try {
      const url = routeUrl(request);
      const path = url.pathname.replace(/\/$/, '');
      if (path.startsWith('/api/sites')) return next();
      const mode = auth.access?.mode ?? (actorTenant.isReseller || actorTenant.isCustomer || actorTenant.isLegacySiteManager ? 'site_management' : null);
      if (mode !== 'site_management' || auth.security?.managementAllowed === false) throw new ScopeError();
      const websiteIds = Array.isArray(auth.user.websiteIds) ? auth.user.websiteIds : (actorTenant.isReseller ? [] : null);
      if (websiteIds === null) throw new ScopeError();
      const allowed = new Set(websiteIds);
      const method = request.method;
      const cachedSites = new Map();

      const isAllowedSiteId = async (id, siteObj = null) => {
        let s = siteObj ?? cachedSites.get(id);
        if (!s && typeof websiteRegistry?.getWebsite === 'function') {
          s = await get(websiteRegistry, 'getWebsite', id).catch(() => null);
          if (s) cachedSites.set(id, s);
        }

        if (actorTenant.isCustomer) {
          if (!allowed.has(id)) return false;
          if (s && s.customerId && s.customerId !== actorTenant.actorId) {
            return false;
          }
          return true;
        }

        if (actorTenant.isReseller) {
          if (s) {
            if (s.resellerId !== undefined) {
              if (s.resellerId === null || s.resellerId !== actorTenant.actorId) {
                return false;
              }
              return true;
            }
            if (s.customerId) {
              if (typeof customerLookup === 'function') {
                try {
                  const cust = await Promise.resolve(customerLookup(s.customerId));
                  if (!cust || cust.resellerId === null || cust.resellerId !== actorTenant.actorId) {
                    return false;
                  }
                  return true;
                } catch {
                  return false;
                }
              }
              return false;
            }
          }
          if (allowed.has(id)) {
            return true;
          }
          return false;
        }

        if (actorTenant.isLegacySiteManager) {
          return allowed.has(id);
        }

        return false;
      };

      const site = async (id, serverId = null) => {
        identity(id);
        let value = cachedSites.get(id);
        if (!value) { value = await get(websiteRegistry, 'getWebsite', id); if (value) cachedSites.set(id, value); }
        if (!value || value.id !== id || (localServerId && value.serverId !== localServerId) || (serverId && value.serverId !== serverId)) throw new ScopeError();
        const ok = await isAllowedSiteId(id, value);
        if (!ok) throw new ScopeError();
        return value;
      };
      const domain = async (id) => {
        const value = await get(domainRegistry, 'getDomain', identity(id));
        if (!value?.websiteId) throw new ScopeError();
        await site(value.websiteId, value.serverId); return value;
      };
      const binding = async (id, serverId, websiteId = null) => {
        const value = await get(databaseBindingRegistry, 'getBinding', identity(id));
        if (!value || value.id !== id || value.serverId !== serverId || (websiteId && value.websiteId !== websiteId)) throw new ScopeError();
        const owner = await site(value.websiteId, serverId);
        if (value.applicationId !== owner.applicationId) throw new ScopeError();
        return value;
      };
      const credential = async (id, serverId, websiteId = null) => {
        const value = await get(databaseCredentialRegistry, 'getCredential', identity(id));
        if (!value || value.id !== id || value.serverId !== serverId || (websiteId && value.websiteId !== websiteId)) throw new ScopeError();
        const owned = await binding(value.databaseBindingId, serverId, value.websiteId);
        if (value.applicationId !== owned.applicationId || value.databaseName !== owned.databaseName) throw new ScopeError();
        return value;
      };
      const mail = async (id) => {
        const value = await get(mailDomainRegistry, 'getMailDomain', identity(id));
        if (!value?.webDomainId) throw new ScopeError();
        await domain(value.webDomainId); return value;
      };
      let siteList = null, domainList = null;
      const sites = async () => {
        if (siteList) return siteList;
        siteList = [];
        if (actorTenant.isReseller && typeof websiteRegistry?.listWebsites === 'function') {
          try {
            const allSites = await websiteRegistry.listWebsites(localServerId ? { serverId: localServerId } : {});
            for (const s of allSites) {
              if (await isAllowedSiteId(s.id, s)) {
                siteList.push(s);
              }
            }
          } catch (error) {
            if (error.status === 503) throw error;
          }
        } else {
          for (const id of allowed) {
            try {
              siteList.push(await site(id));
            } catch (error) {
              if (error.status === 503) throw error;
            }
          }
        }
        return siteList;
      };
      const domains = async () => {
        if (domainList) return domainList;
        const existing = new Map((await sites()).map((value) => [value.id, value]));
        const values = await get(domainRegistry, 'listDomains');
        if (!Array.isArray(values)) throw new ScopeError(503);
        domainList = values.filter((value) => value?.websiteId && existing.get(value.websiteId)?.serverId === value.serverId);
        return domainList;
      };
      const ownsJob = async (job) => {
        if (!job) return false;
        try {
          if (job.payload?.mailDomainId) { await mail(job.payload.mailDomainId); return true; }
          if (job.payload?.websiteId) { await site(job.payload.websiteId, job.serverId); return true; }
          if (job.resourceType === 'website') { await site(job.resourceId, job.serverId); return true; }
          if (job.resourceType === 'domain') { const value = await domain(job.resourceId); return value.serverId === job.serverId; }
          if (job.resourceType === 'application') return (await sites()).some((value) => value.applicationId === job.resourceId && value.serverId === job.serverId);
          if (job.resourceType === 'certificate') return (await domains()).some((value) => value.certificateId === job.resourceId && value.serverId === job.serverId);
          if (job.resourceType === 'database') {
            const values = await get(databaseBindingRegistry, 'listBindings', { serverId: job.serverId });
            if (!Array.isArray(values)) throw new ScopeError(503);
            const value = values.find((item) => item.databaseName === job.resourceId);
            if (!value) return false;
            await binding(value.id, job.serverId); return true;
          }
          if (job.resourceType === 'mail_domain') { await mail(job.resourceId); return true; }
        } catch (error) { if (error.status === 503) throw error; }
        return false;
      };
      if (readOnly(method) && ['/api/websites','/api/domains','/api/applications','/api/certificates','/api/servers'].includes(path)) {
        if (path === '/api/websites') { const ids = new Set((await sites()).map((v) => v.id)); replaceCollection(response, (v) => ids.has(v.id)); }
        if (path === '/api/domains') { const ids = new Set((await domains()).map((v) => v.id)); replaceCollection(response, (v) => ids.has(v.id)); }
        if (path === '/api/applications') { const ids = new Set((await sites()).map((v) => v.applicationId)); replaceCollection(response, (v) => ids.has(v.id)); }
        if (path === '/api/certificates') { const ids = new Set((await domains()).map((v) => v.certificateId)); replaceCollection(response, (v) => ids.has(v.id)); }
        if (path === '/api/servers') { const ids = new Set((await sites()).map((v) => v.serverId)); replaceCollection(response, (v) => ids.has(v.id), (v) => ({ id:v.id, hostname:v.hostname, displayName:v.displayName, executionMode:v.executionMode, connectivity:v.connectivity })); }
        return next();
      }
      let match;
      if ((match = /^\/api\/websites\/([^/]+)(?:\/|$)/.exec(path))) {
        const id = decodeId(match[1]); await site(id);
        // Identity migration and ownership changes remain Owner operations.
        if (/\/(?:migration|isolation|provisioning)/.test(path) && !readOnly(method)) throw new ScopeError();
        return next();
      }
      if ((match = /^\/api\/servers\/([^/]+)\/websites\/([^/]+)(?:\/|$)/.exec(path))) {
        const serverId = decodeId(match[1]), websiteId = decodeId(match[2]); await site(websiteId, serverId);
        const nestedBinding = /\/database-bindings\/([^/]+)/.exec(path);
        if (nestedBinding) {
          if (method === 'DELETE') throw new ScopeError();
          await binding(decodeId(nestedBinding[1]), serverId, websiteId);
        }
        if (path.endsWith('/phpmyadmin-handoffs')) await credential(request.body?.credentialId, serverId, websiteId);
        return next();
      }
      if ((match = /^\/api\/servers\/([^/]+)\/database-bindings\/([^/]+)(?:\/|$)/.exec(path))) {
        if (method === 'DELETE') throw new ScopeError();
        await binding(decodeId(match[2]), decodeId(match[1]));
        return next();
      }
      if ((match = /^\/api\/servers\/([^/]+)\/database-credentials\/([^/]+)(?:\/|$)/.exec(path))) { await credential(decodeId(match[2]), decodeId(match[1])); return next(); }
      if (/^\/api\/servers\/[^/]+\/(?:databases|database-bindings|database-credentials|mail)(?:\/|$)/.test(path)) throw new ScopeError();
      if (path === '/api/mail-domains') {
        if (!readOnly(method)) throw new ScopeError();
        const ids = new Set((await domains()).map((v) => v.id));
        replaceCollection(response, (value) => ids.has(value.webDomainId)); return next();
      }
      if ((match = /^\/api\/mail-domains\/([^/]+)(?:\/|$)/.exec(path))) {
        const ownedMail = await mail(decodeId(match[1]));
        // Site managers change their mailboxes, not shared webmail/DNS provisioning.
        const suffix = path.slice(match[0].replace(/\/$/,'').length);
        if (!readOnly(method) && suffix && !/^\/(?:config-(?:preview|apply)|test-delivery)$/.test(suffix)) throw new ScopeError();
        if (!readOnly(method) && ownedMail.managementMode !== 'local') throw new ScopeError();
        if (method === 'DELETE' || method === 'PATCH') throw new ScopeError();
        if (['/config-preview', '/config-apply'].includes(suffix) && request.body?.status && ownedMail.status && request.body.status !== ownedMail.status) {
          throw new ScopeError();
        }
        if (suffix === '/config-preview' && method === 'POST') {
          const original = response.json.bind(response);
          response.json = (payload) => {
            const preview = payload?.data;
            if (!preview) return original(payload);
            return original({ data: {
              readyToApply: preview.readyToApply, previewDigest: preview.previewDigest,
              confirmation: preview.confirmation, currentStatus: preview.currentStatus,
              desiredStatus: preview.desiredStatus, sideEffects: preview.sideEffects,
              configuration: preview.configuration ? { sha256: preview.configuration.sha256 } : null,
            } });
          };
        }
        return next();
      }
      if (path === '/api/mailboxes' || path === '/api/mail-aliases') {
        const values = url.searchParams.getAll('mailDomainId');
        const id = readOnly(method) ? values.length === 1 ? values[0] : null : request.body?.mailDomainId;
        const owner = await mail(id);
        if (!readOnly(method) && (method !== 'POST' || owner.managementMode !== 'local')) throw new ScopeError();
        replaceCollection(response, (value) => value.mailDomainId === id); return next();
      }
      if ((match = /^\/api\/(mailboxes|mail-aliases)\/([^/]+)(?:\/|$)/.exec(path))) {
        const value = await get(match[1] === 'mailboxes' ? mailboxRegistry : mailAliasRegistry, match[1] === 'mailboxes' ? 'getMailbox' : 'getAlias', decodeId(match[2]));
        if (!value?.mailDomainId) throw new ScopeError();
        const ownedMail = await mail(value.mailDomainId);
        if (!readOnly(method) && ownedMail.managementMode !== 'local') throw new ScopeError();
        return next();
      }
      if (path === '/api/jobs' && readOnly(method)) {
        const values = await get(jobRegistry, 'listJobs'); if (!Array.isArray(values)) throw new ScopeError(503);
        const ids = new Set(); for (const job of values) if (await ownsJob(job)) ids.add(job.id);
        replaceCollection(response, (job) => ids.has(job.id)); return next();
      }
      if ((match = /^\/api\/jobs\/([^/]+)(?:\/|$)/.exec(path))) {
        if (!await ownsJob(await get(jobRegistry, 'getJob', decodeId(match[1])))) throw new ScopeError();
        return next();
      }
      // Scope other site context reads, without changing their lifecycle handlers.
      if (method === 'POST' && path === '/api/domains') {
        const websiteId = request.body?.websiteId;
        if (!websiteId) throw new ScopeError();
        const ok = await isAllowedSiteId(websiteId);
        if (!ok) throw new ScopeError();
      }
      if (method === 'POST' && (path === '/api/websites' || path === '/api/applications')) {
        throw new ScopeError();
      }
      if ((match = /^\/api\/domains\/([^/]+)(?:\/|$)/.exec(path))) { await domain(decodeId(match[1])); return next(); }
      if ((match = /^\/api\/applications\/([^/]+)(?:\/|$)/.exec(path))) {
        if (!(await sites()).some((v) => v.applicationId === decodeId(match[1]))) throw new ScopeError(); return next();
      }
      if (path === '/api/phpmyadmin-gateway-access' && readOnly(method)) return next();
      if (/^\/api\/(?:mail(?:\/|$)|mail-service-identity|roundcube|panel\/settings|system\/packages|backups(?:\/|$))/.test(path)) throw new ScopeError();
      if (/^\/api\/audit(?:\/|$)/.test(path)) {
        if (actorTenant.isLegacySiteManager) throw new ScopeError();
        return next();
      }
      if (path === '/api/terminal/capabilities' && method === 'POST') {
        if (request.body?.scope === 'server') {
          throw new ScopeError();
        }
        if (request.body?.scope === 'site') {
          const websiteId = request.body.websiteId;
          if (!websiteId) throw new ScopeError();
          const ok = await isAllowedSiteId(websiteId);
          if (!ok) throw new ScopeError();
          return next();
        }
        throw new ScopeError();
      }
      if (/^\/api\/users(?:\/|$)/.test(path) && !path.startsWith('/api/users/hosting/accounts')) throw new ScopeError();
      if (/^\/api\/servers\//.test(path)) throw new ScopeError();
      // Unrelated integrations still have their existing guards. This boundary
      // does not claim to replace a full review of terminal, DNS and AI policies.
      return next();
    } catch (error) {
      const status = error instanceof ScopeError ? error.status : 503;
      response.setHeader?.('Cache-Control','no-store');
      return response.status(status).json({ error: { code: status === 503 ? 'site_scope_unavailable' : 'site_scope_forbidden', message: status === 503 ? 'Site permissions could not be verified.' : 'This resource is not available to this site account.' } });
    }
  };
}
