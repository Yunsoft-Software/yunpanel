import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER = /^yunapp-[a-f0-9]{12}$/;
const ACTIONS = Object.freeze({
  'wp.cache.flush': Object.freeze({
    tool: 'wp-cli',
    command: 'cache',
    args: Object.freeze(['flush']),
    timeout: 60_000,
    label: 'WordPress önbelleğini temizle',
    impact: 'WordPress nesne önbelleği temizlenir. Site dosyaları ve veritabanı şeması değiştirilmez.',
  }),
  'wp.transients.delete-all': Object.freeze({
    tool: 'wp-cli',
    command: 'transient',
    args: Object.freeze(['delete', '--all']),
    timeout: 60_000,
    label: 'WordPress transient kayıtlarını temizle',
    impact: 'Süresi dolmamış transient kayıtları dahil geçici WordPress verileri silinebilir.',
  }),
  'composer.dump-autoload': Object.freeze({
    tool: 'composer',
    command: 'dump-autoload',
    args: Object.freeze(['--optimize']),
    timeout: 120_000,
    label: 'Composer autoload dosyalarını yeniden oluştur',
    impact: 'vendor içindeki autoload metadata dosyaları yeniden oluşturulur; paket sürümleri değiştirilmez.',
  }),
});

export class WebsitePhpToolActionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'WebsitePhpToolActionError';
    this.code = code;
    this.status = status;
  }
}

function canonicalBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !UUID.test(value.websiteId ?? '')
    || !UUID.test(value.serverId ?? '')
    || !UUID.test(value.applicationId ?? '')
    || !USER.test(value.unixUser ?? '')
    || !Number.isSafeInteger(value.websiteRevision)
    || value.websiteRevision < 1) {
    throw new WebsitePhpToolActionError('php_tool_binding_invalid', 'PHP tool binding is invalid', 409);
  }
  return Object.freeze({
    websiteId: value.websiteId.toLowerCase(),
    serverId: value.serverId.toLowerCase(),
    applicationId: value.applicationId.toLowerCase(),
    unixUser: value.unixUser,
    websiteRevision: value.websiteRevision,
  });
}

function action(value) {
  if (typeof value !== 'string' || !Object.hasOwn(ACTIONS, value)) {
    throw new WebsitePhpToolActionError('php_tool_action_unsupported', 'PHP tool action is not supported', 400);
  }
  return ACTIONS[value];
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function websitePhpToolActionPreview(bindingInput, actionId) {
  const binding = canonicalBinding(bindingInput);
  const definition = action(actionId);
  const identity = Object.freeze({
    version: 1,
    ...binding,
    actionId,
    tool: definition.tool,
    command: definition.command,
    args: definition.args,
    timeout: definition.timeout,
  });
  const previewDigest = digest(identity);
  return Object.freeze({
    ...identity,
    label: definition.label,
    impact: definition.impact,
    previewDigest,
    confirmation: `php-tool:${binding.websiteId}:${actionId}:${previewDigest}`,
  });
}

export function verifyWebsitePhpToolAction(preview, input = {}) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    throw new WebsitePhpToolActionError('php_tool_preview_invalid', 'PHP tool preview is invalid', 409);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WebsitePhpToolActionError('php_tool_action_input_invalid', 'PHP tool action input is invalid', 400);
  }
  const allowed = new Set(['actionId', 'expectedWebsiteRevision', 'previewDigest', 'confirmation']);
  if (Object.keys(input).length !== allowed.size || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new WebsitePhpToolActionError('php_tool_action_input_invalid', 'PHP tool action input is invalid', 400);
  }
  if (input.actionId !== preview.actionId
    || input.expectedWebsiteRevision !== preview.websiteRevision
    || input.previewDigest !== preview.previewDigest
    || input.confirmation !== preview.confirmation) {
    throw new WebsitePhpToolActionError('php_tool_action_stale', 'PHP tool action preview changed; inspect again before running', 409);
  }
  const expected = websitePhpToolActionPreview(preview, preview.actionId);
  if (expected.previewDigest !== preview.previewDigest || expected.confirmation !== preview.confirmation) {
    throw new WebsitePhpToolActionError('php_tool_preview_invalid', 'PHP tool preview integrity check failed', 409);
  }
  const definition = action(preview.actionId);
  return Object.freeze({
    tool: definition.tool,
    command: definition.command,
    args: definition.args,
    timeout: definition.timeout,
  });
}

export function websitePhpToolActionIds() {
  return Object.freeze(Object.keys(ACTIONS));
}

export const websitePhpToolActionInternals = Object.freeze({ canonicalBinding, action, digest, ACTIONS });
