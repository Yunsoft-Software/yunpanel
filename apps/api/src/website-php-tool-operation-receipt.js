import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/var/lib/yunpanel/recovery/website-php-tools';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB = /^[A-Za-z0-9._:-]{8,128}$/;
const USER = /^yunapp-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const ACTIONS = new Set(['wp.cache.flush', 'wp.transients.delete-all', 'composer.dump-autoload']);

export class WebsitePhpToolOperationReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsitePhpToolOperationReceiptError';
    this.code = code;
  }
}

function normalized(value) {
  const fields = ['version','recordedAt','serverId','jobId','payload','result'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))
    || value.version !== 1 || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt))
    || typeof value.serverId !== 'string' || !UUID.test(value.serverId)
    || typeof value.jobId !== 'string' || !JOB.test(value.jobId)) {
    throw new WebsitePhpToolOperationReceiptError('website_php_tool_receipt_invalid', 'PHP tool receipt is invalid');
  }
  const p = value.payload, r = value.result;
  if (!p || typeof p !== 'object' || Array.isArray(p)
    || !UUID.test(p.websiteId ?? '') || !UUID.test(p.applicationId ?? '') || !USER.test(p.unixUser ?? '')
    || !Number.isSafeInteger(p.expectedWebsiteRevision) || p.expectedWebsiteRevision < 1
    || !ACTIONS.has(p.actionId) || !SHA.test(p.previewDigest ?? '')
    || p.confirmation !== `php-tool:${p.websiteId}:${p.actionId}:${p.previewDigest}`
    || !r || typeof r !== 'object' || Array.isArray(r)
    || r.version !== 1 || r.websiteId !== p.websiteId || r.applicationId !== p.applicationId
    || r.unixUser !== p.unixUser || r.actionId !== p.actionId
    || r.websiteRevision !== p.expectedWebsiteRevision || r.previewDigest !== p.previewDigest
    || r.completed !== true || r.sideEffects !== true) {
    throw new WebsitePhpToolOperationReceiptError('website_php_tool_receipt_evidence_invalid', 'PHP tool receipt evidence is invalid');
  }
  return Object.freeze({
    version: 1,
    recordedAt: new Date(value.recordedAt).toISOString(),
    serverId: value.serverId.toLowerCase(),
    jobId: value.jobId,
    payload: Object.freeze({
      websiteId: p.websiteId.toLowerCase(),
      applicationId: p.applicationId.toLowerCase(),
      unixUser: p.unixUser,
      expectedWebsiteRevision: p.expectedWebsiteRevision,
      actionId: p.actionId,
      previewDigest: p.previewDigest,
      confirmation: p.confirmation,
    }),
    result: Object.freeze({
      version: 1,
      websiteId: r.websiteId.toLowerCase(),
      applicationId: r.applicationId.toLowerCase(),
      unixUser: r.unixUser,
      actionId: r.actionId,
      websiteRevision: r.websiteRevision,
      previewDigest: r.previewDigest,
      completed: true,
      sideEffects: true,
    }),
  });
}

export function createWebsitePhpToolOperationReceiptStore({
  root = ROOT, now = () => Date.now(), chmodFn = chmod, mkdirFn = mkdir,
  readFileFn = readFile, renameFn = rename, writeFileFn = writeFile,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new WebsitePhpToolOperationReceiptError('website_php_tool_receipt_root_invalid', 'PHP tool receipt root must be absolute');
  }
  const file = (serverId, jobId) => {
    if (!UUID.test(serverId ?? '') || !JOB.test(jobId ?? '')) {
      throw new WebsitePhpToolOperationReceiptError('website_php_tool_receipt_identity_invalid', 'PHP tool receipt identity is invalid');
    }
    return path.join(root, serverId.toLowerCase(), `${jobId}.json`);
  };
  async function write({ serverId, jobId, payload, result } = {}) {
    const receipt = normalized({ version: 1, recordedAt: new Date(now()).toISOString(), serverId, jobId, payload, result });
    const directory = path.dirname(file(serverId, jobId));
    const target = file(serverId, jobId);
    const temporary = `${target}.${process.pid}.tmp`;
    await mkdirFn(root, { recursive: true, mode: 0o700 }); await chmodFn(root, 0o700);
    await mkdirFn(directory, { recursive: true, mode: 0o700 }); await chmodFn(directory, 0o700);
    await writeFileFn(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await renameFn(temporary, target); await chmodFn(target, 0o600);
    return structuredClone(receipt);
  }
  async function read(serverId, jobId) {
    let raw;
    try { raw = await readFileFn(file(serverId, jobId), 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new WebsitePhpToolOperationReceiptError('website_php_tool_receipt_read_failed', 'PHP tool receipt could not be read');
    }
    try { return normalized(JSON.parse(raw)); }
    catch (error) {
      if (error instanceof WebsitePhpToolOperationReceiptError) throw error;
      throw new WebsitePhpToolOperationReceiptError('website_php_tool_receipt_invalid', 'PHP tool receipt is invalid');
    }
  }
  return Object.freeze({ write, read });
}

export const websitePhpToolOperationReceiptInternals = Object.freeze({ normalized, ROOT });
