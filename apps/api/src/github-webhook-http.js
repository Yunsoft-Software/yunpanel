import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApplicationEnvironmentRegistryError } from './application-environment-registry.js';
import { ApplicationRegistryError } from './application-registry.js';
import { JobRegistryError } from './job-registry.js';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PATH_PATTERN = new RegExp(`^/api/webhooks/github/(${UUID_PATTERN})$`, 'i');
const DELIVERY_PATTERN = new RegExp(`^${UUID_PATTERN}$`, 'i');
const SIGNATURE_PATTERN = /^sha256=([a-f0-9]{64})$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;
const EVENT_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_BODY_BYTES = 1024 * 1024;

export function isGithubWebhookPath(pathname) {
  return typeof pathname === 'string' && PATH_PATTERN.test(pathname);
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function header(request, name) {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

function error(response, status, code, message) {
  json(response, status, { error: { code, message } });
}

function readRawBody(request) {
  const declared = header(request, 'content-length');
  if (declared !== null && (!/^(?:0|[1-9][0-9]{0,7})$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return Promise.reject(Object.assign(new Error('Webhook body is too large'), { code: 'webhook_body_too_large', status: 413 }));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        reject(Object.assign(new Error('Webhook body is too large'), { code: 'webhook_body_too_large', status: 413 }));
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    request.on('error', reject);
    request.on('aborted', () => reject(Object.assign(new Error('Webhook request was interrupted'), { code: 'webhook_request_aborted', status: 400 })));
  });
}

function repositoryName(repositoryUrl) {
  const url = new URL(repositoryUrl);
  return url.pathname.replace(/^\//, '').replace(/\.git$/, '').toLowerCase();
}

function signatureMatches(rawBody, signature, secret) {
  const match = signature?.match(SIGNATURE_PATTERN);
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createGithubWebhookHandler({
  applicationRegistry,
  applicationEnvironmentRegistry,
  queueApplicationDeploy,
} = {}) {
  if (!applicationRegistry || !applicationEnvironmentRegistry || typeof queueApplicationDeploy !== 'function') {
    throw new TypeError('GitHub webhook dependencies are required');
  }

  return async function handleGithubWebhook(request, response, pathname) {
    const route = PATH_PATTERN.exec(pathname);
    if (!route) return false;
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      error(response, 405, 'method_not_allowed', 'Use POST for GitHub webhooks.');
      return true;
    }
    if (request.headers.cookie || request.headers.origin || request.headers.authorization) {
      error(response, 403, 'webhook_channel_only', 'This route accepts only signed GitHub webhook requests.');
      return true;
    }
    if (header(request, 'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      error(response, 415, 'json_required', 'Send an application/json webhook payload.');
      return true;
    }

    const applicationId = route[1].toLowerCase();
    const event = header(request, 'x-github-event');
    const deliveryId = header(request, 'x-github-delivery');
    const signature = header(request, 'x-hub-signature-256');
    if (!event || !EVENT_PATTERN.test(event) || !deliveryId || !DELIVERY_PATTERN.test(deliveryId) || !signature) {
      error(response, 400, 'github_webhook_headers_invalid', 'GitHub webhook headers are invalid.');
      return true;
    }

    try {
      const rawBody = await readRawBody(request);
      const application = await applicationRegistry.getApplication(applicationId);
      if (!application) {
        error(response, 404, 'github_webhook_not_found', 'GitHub webhook is not configured.');
        return true;
      }
      const secret = await applicationEnvironmentRegistry.materializeWebhookSecret(application.id);
      if (!secret) {
        error(response, 404, 'github_webhook_not_found', 'GitHub webhook is not configured.');
        return true;
      }
      if (!signatureMatches(rawBody, signature, secret)) {
        error(response, 401, 'github_webhook_signature_invalid', 'GitHub webhook signature is invalid.');
        return true;
      }

      let payload;
      try { payload = JSON.parse(rawBody.toString('utf8')); }
      catch {
        error(response, 400, 'github_webhook_json_invalid', 'GitHub webhook payload is invalid JSON.');
        return true;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        error(response, 400, 'github_webhook_payload_invalid', 'GitHub webhook payload is invalid.');
        return true;
      }
      if (event !== 'push') {
        json(response, 202, { data: { status: 'ignored', reason: 'event_not_supported', event, deliveryId } });
        return true;
      }
      if (typeof payload.repository?.full_name !== 'string'
        || payload.repository.full_name.toLowerCase() !== repositoryName(application.repositoryUrl)) {
        error(response, 403, 'github_webhook_repository_mismatch', 'GitHub webhook repository does not match the Application.');
        return true;
      }
      if (payload.ref !== `refs/heads/${application.branch}`) {
        json(response, 202, { data: { status: 'ignored', reason: 'branch_not_configured', deliveryId } });
        return true;
      }
      if (payload.deleted === true || payload.after === '0'.repeat(40)) {
        json(response, 202, { data: { status: 'ignored', reason: 'branch_deleted', deliveryId } });
        return true;
      }
      if (typeof payload.after !== 'string' || !COMMIT_PATTERN.test(payload.after)) {
        error(response, 400, 'github_webhook_commit_invalid', 'GitHub webhook commit is invalid.');
        return true;
      }

      const queued = await queueApplicationDeploy({
        applicationId: application.id,
        gitTarget: { kind: 'commit', value: payload.after.toLowerCase() },
        idempotencyKey: `github:${application.id}:${deliveryId.toLowerCase()}`,
      });
      json(response, queued.replayed ? 200 : 202, {
        data: {
          status: queued.replayed ? 'duplicate' : 'queued',
          applicationId: application.id,
          deliveryId,
          job: { id: queued.job.id, status: queued.job.status },
        },
      });
      return true;
    } catch (caught) {
      if (caught instanceof JobRegistryError || caught instanceof ApplicationRegistryError) {
        error(response, caught.status ?? 409, caught.code, caught.message);
        return true;
      }
      if (caught instanceof ApplicationEnvironmentRegistryError) {
        const status = caught.status >= 500 ? 503 : caught.status;
        error(response, status, status === 503 ? 'github_webhook_unavailable' : caught.code,
          status === 503 ? 'GitHub webhook processing is temporarily unavailable.' : caught.message);
        return true;
      }
      if (Number.isInteger(caught?.status) && typeof caught?.code === 'string') {
        error(response, caught.status, caught.code, caught.message);
        return true;
      }
      error(response, 503, 'github_webhook_unavailable', 'GitHub webhook processing is temporarily unavailable.');
      return true;
    }
  };
}

export const githubWebhookInternals = Object.freeze({ maxBodyBytes: MAX_BODY_BYTES, signatureMatches, repositoryName });
