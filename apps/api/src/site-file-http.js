import express from 'express';
import path from 'node:path';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { SiteFileManagerError } from './site-file-manager.js';
import { SiteFileWorkerError, siteFileWorkerInternals } from './site-file-worker.js';

const SMALL_JSON = express.json({ limit: '8kb' });
const TEXT_JSON = express.json({ limit: `${siteFileWorkerInternals.maxTextBytes + 8 * 1024}b` });

export class SiteFileHttpError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SiteFileHttpError';
    this.code = code;
    this.status = status;
  }
}

function exactObject(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && Object.keys(value).every((key) => fields.includes(key));
}

function queryPath(query, { optional = false } = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new SiteFileHttpError('site_file_query_invalid', 'File query is invalid');
  const keys = Object.keys(query);
  if (optional && keys.length === 0) return '';
  if (keys.length !== 1 || keys[0] !== 'path' || typeof query.path !== 'string') {
    throw new SiteFileHttpError('site_file_query_invalid', 'File query must contain one path');
  }
  return query.path;
}

async function rawBody(request) {
  if ((request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') {
    throw new SiteFileHttpError('site_file_content_type_invalid', 'Upload requires application/octet-stream', 415);
  }
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^(?:0|[1-9][0-9]{0,8})$/.test(declared)
    || Number(declared) > siteFileWorkerInternals.maxTransferBytes)) {
    throw new SiteFileHttpError('site_file_too_large', `Upload exceeds the ${siteFileWorkerInternals.maxTransferBytes} byte limit`, 413);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > siteFileWorkerInternals.maxTransferBytes) {
        settled = true;
        chunks.length = 0;
        reject(new SiteFileHttpError('site_file_too_large', `Upload exceeds the ${siteFileWorkerInternals.maxTransferBytes} byte limit`, 413));
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.once('aborted', () => {
      if (settled) return;
      settled = true;
      reject(new SiteFileHttpError('site_file_upload_aborted', 'Upload was interrupted', 400));
    });
    request.once('error', () => {
      if (settled) return;
      settled = true;
      reject(new SiteFileHttpError('site_file_upload_failed', 'Upload could not be read', 400));
    });
  });
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try { return await handler(request, response); }
    catch (error) {
      if (error instanceof SiteFileHttpError || error instanceof SiteFileManagerError || error instanceof SiteFileWorkerError) return next(error);
      return next(new SiteFileHttpError('site_file_backend_failed', 'Site file request could not be completed', 503));
    }
  };
}

function downloadName(filePath) {
  const name = path.posix.basename(filePath);
  return encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function mountSiteFileRoutes(app, { siteFileManager } = {}) {
  if (!app || !siteFileManager || typeof siteFileManager.execute !== 'function') {
    throw new TypeError('Site file HTTP dependencies are required');
  }
  app.get('/api/websites/:websiteId/files', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const data = await siteFileManager.execute(request.params.websiteId, { operation: 'list', path: queryPath(request.query, { optional: true }) });
    response.setHeader('cache-control', 'no-store');
    return response.json({ data });
  }));

  app.get('/api/websites/:websiteId/files/download', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const filePath = queryPath(request.query);
    const data = await siteFileManager.execute(request.params.websiteId, { operation: 'download', path: filePath });
    const content = Buffer.from(data.content, 'base64');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/octet-stream');
    response.setHeader('content-disposition', `attachment; filename="site-file"; filename*=UTF-8''${downloadName(filePath)}`);
    response.setHeader('x-content-type-options', 'nosniff');
    return response.send(content);
  }));

  app.get('/api/websites/:websiteId/files/text', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const data = await siteFileManager.execute(request.params.websiteId, { operation: 'read_text', path: queryPath(request.query) });
    response.setHeader('cache-control', 'no-store');
    return response.json({ data });
  }));

  app.put('/api/websites/:websiteId/files/upload', requirePanelRouteAccess, asyncRoute(async (request, response) => {
    const filePath = queryPath(request.query);
    const content = await rawBody(request);
    const data = await siteFileManager.execute(request.params.websiteId, {
      operation: 'upload', path: filePath, content: content.toString('base64'),
    });
    return response.status(data.created ? 201 : 200).json({ data });
  }));

  app.put('/api/websites/:websiteId/files/text', requirePanelRouteAccess, TEXT_JSON, asyncRoute(async (request, response) => {
    if (!exactObject(request.body, ['path', 'content', 'expectedSha256'])
      || typeof request.body.path !== 'string' || typeof request.body.content !== 'string'
      || typeof request.body.expectedSha256 !== 'string') {
      throw new SiteFileHttpError('site_file_request_invalid', 'Text edit request fields are invalid');
    }
    const data = await siteFileManager.execute(request.params.websiteId, { operation: 'write_text', ...request.body });
    return response.json({ data });
  }));

  app.post('/api/websites/:websiteId/files/mkdir', requirePanelRouteAccess, SMALL_JSON, asyncRoute(async (request, response) => {
    if (!exactObject(request.body, ['path']) || typeof request.body.path !== 'string') {
      throw new SiteFileHttpError('site_file_request_invalid', 'Directory request fields are invalid');
    }
    const data = await siteFileManager.execute(request.params.websiteId, { operation: 'mkdir', path: request.body.path });
    return response.status(201).json({ data });
  }));

  app.post('/api/websites/:websiteId/files/rename', requirePanelRouteAccess, SMALL_JSON, asyncRoute(async (request, response) => {
    if (!exactObject(request.body, ['path', 'destination'])
      || typeof request.body.path !== 'string' || typeof request.body.destination !== 'string') {
      throw new SiteFileHttpError('site_file_request_invalid', 'Rename request fields are invalid');
    }
    const data = await siteFileManager.execute(request.params.websiteId, { operation: 'rename', ...request.body });
    return response.json({ data });
  }));

  app.delete('/api/websites/:websiteId/files', requirePanelRouteAccess, SMALL_JSON, asyncRoute(async (request, response) => {
    if (!exactObject(request.body, ['path', 'confirmation'])
      || typeof request.body.path !== 'string' || request.body.confirmation !== `delete:${request.params.websiteId}:${request.body.path}`) {
      throw new SiteFileHttpError('site_file_delete_confirmation_required', 'Exact Website and path deletion confirmation is required');
    }
    const data = await siteFileManager.execute(request.params.websiteId, { operation: 'delete', path: request.body.path });
    return response.json({ data });
  }));
}

export const siteFileHttpInternals = Object.freeze({ downloadName, queryPath });
