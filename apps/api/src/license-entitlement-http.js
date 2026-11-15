import express from 'express';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { LicenseEntitlementError } from './license-entitlement-service.js';

function isOwnerManagement(auth) {
  return (
    auth?.user?.role === 'owner'
    && auth?.access?.mode === 'management'
    && auth?.security?.managementAllowed === true
    && Array.isArray(auth?.access?.permissions)
    && auth.access.permissions.includes('*')
  );
}

function requireOwnerManagement(request) {
  if (!isOwnerManagement(request.auth)) {
    throw new LicenseEntitlementError(
      'forbidden',
      'Only the server owner can manage panel license entitlements.',
      403,
    );
  }
}

function parsePlainObject(body, allowedKeys) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new LicenseEntitlementError(
      'invalid_request_body',
      'Request body must be a JSON object.',
      400,
    );
  }
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new LicenseEntitlementError(
        'unexpected_field',
        `Unsupported request property '${key}'.`,
        400,
      );
    }
  }
  return body;
}

function sanitizeAuditCode(rawCode) {
  if (typeof rawCode !== 'string' || !rawCode.trim()) return null;
  const cleaned = rawCode
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 118);
  return cleaned || null;
}

function recordLicenseAudit(auditStore, {
  actorId,
  action,
  resourceId = 'panel',
  outcome,
  code = null,
}) {
  if (!auditStore || typeof auditStore.record !== 'function') return;
  try {
    auditStore.record({
      actorId: typeof actorId === 'string' && actorId ? actorId : null,
      action,
      resourceType: 'license',
      resourceId: String(resourceId || 'panel').slice(0, 120),
      outcome,
      code: sanitizeAuditCode(code),
    });
  } catch {
    // Audit write failures must not leak raw license data.
  }
}

const ACTIVATE_KEYS = new Set(['token', 'licenseKey', 'domain']);
const DEACTIVATE_KEYS = new Set(['confirmation', 'notifyRemote']);

export function mountLicenseEntitlementRoutes(app, {
  licenseEntitlementService,
  auditStore = null,
} = {}) {
  if (!licenseEntitlementService) return;

  const jsonBody = express.json({ limit: '64kb' });

  app.get('/api/license', requirePanelRouteAccess, (request, response, next) => {
    try {
      const includeManagementDetails = isOwnerManagement(request.auth);
      const data = licenseEntitlementService.getStatus({ includeManagementDetails });
      return response.status(200).json({ data });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/license/activate', requirePanelRouteAccess, jsonBody, async (request, response, next) => {
    try {
      requireOwnerManagement(request);
      const body = parsePlainObject(request.body, ACTIVATE_KEYS);
      try {
        const data = await licenseEntitlementService.activate({
          token: body.token ?? null,
          licenseKey: body.licenseKey ?? null,
          domain: body.domain ?? null,
        });
        recordLicenseAudit(auditStore, {
          actorId: request.auth?.user?.id,
          action: 'license.activated',
          resourceId: data.instanceId,
          outcome: 'succeeded',
          code: data.billingPeriod || 'premium',
        });
        return response.status(200).json({ data });
      } catch (error) {
        recordLicenseAudit(auditStore, {
          actorId: request.auth?.user?.id,
          action: 'license.activated',
          outcome: 'failed',
          code: error?.reason || error?.code || 'activation_failed',
        });
        throw error;
      }
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/license/refresh', requirePanelRouteAccess, jsonBody, async (request, response, next) => {
    try {
      requireOwnerManagement(request);
      const body = parsePlainObject(request.body, ACTIVATE_KEYS);
      try {
        const data = await licenseEntitlementService.refresh({
          token: body.token ?? null,
          licenseKey: body.licenseKey ?? null,
          domain: body.domain ?? null,
        });
        recordLicenseAudit(auditStore, {
          actorId: request.auth?.user?.id,
          action: 'license.refreshed',
          resourceId: data.instanceId,
          outcome: 'succeeded',
          code: data.status || 'refreshed',
        });
        return response.status(200).json({ data });
      } catch (error) {
        recordLicenseAudit(auditStore, {
          actorId: request.auth?.user?.id,
          action: 'license.refreshed',
          outcome: 'failed',
          code: error?.reason || error?.code || 'refresh_failed',
        });
        throw error;
      }
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/license/deactivate', requirePanelRouteAccess, jsonBody, async (request, response, next) => {
    try {
      requireOwnerManagement(request);
      const body = parsePlainObject(request.body, DEACTIVATE_KEYS);
      if (body.confirmation !== 'deactivate-license') {
        throw new LicenseEntitlementError(
          'confirmation_required',
          'Confirm license deactivation with confirmation "deactivate-license".',
          400,
        );
      }
      const data = await licenseEntitlementService.deactivate({
        notifyRemote: body.notifyRemote !== false,
      });
      recordLicenseAudit(auditStore, {
        actorId: request.auth?.user?.id,
        action: 'license.deactivated',
        resourceId: data.instanceId,
        outcome: 'succeeded',
        code: 'free',
      });
      return response.status(200).json({ data });
    } catch (error) {
      return next(error);
    }
  });
}
