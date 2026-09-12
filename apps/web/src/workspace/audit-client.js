const ACTION = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const TYPE = /^[a-z][a-z0-9._-]{0,63}$/;
const CODE = ACTION;
const OUTCOMES = new Set(['accepted', 'succeeded', 'failed', 'denied', 'cancelled']);
const CONTROL = /[\u0000-\u001f\u007f]/;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const denied = (error) => [401, 403].includes(error?.status);

function problem(code) { const error = new Error(code); error.code = code; return error; }
function safeId(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 128 && !CONTROL.test(value); }
function optionalText(value, validator) {
  if (value == null || value === '') return null;
  if (!validator(value)) throw problem('invalid_audit_filter');
  return value;
}

export function auditFilterInput(input = {}) {
  if (!object(input)) throw problem('invalid_audit_filter');
  const actorId = optionalText(input.actorId, safeId);
  const action = optionalText(input.action, (value) => ACTION.test(value));
  const outcome = input.outcome == null || input.outcome === '' || input.outcome === 'all' ? null : input.outcome;
  if (outcome !== null && !OUTCOMES.has(outcome)) throw problem('invalid_audit_filter');
  const resourceType = optionalText(input.resourceType, (value) => TYPE.test(value));
  const resourceId = optionalText(input.resourceId, safeId);
  if ((resourceType == null) !== (resourceId == null)) throw problem('audit_resource_pair_required');
  const from = input.from == null ? null : input.from;
  const to = input.to == null ? null : input.to;
  if ((from !== null && !integer(from)) || (to !== null && !integer(to)) || (from !== null && to !== null && from > to)) {
    throw problem('invalid_audit_time_range');
  }
  return { actorId, action, outcome, resourceType, resourceId, from, to };
}

export function auditRequestPath({ filters = {}, offset = 0, limit = 50 } = {}) {
  if (!integer(offset) || !integer(limit, 1) || limit > 100) throw problem('invalid_audit_pagination');
  const normalized = auditFilterInput(filters);
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  for (const [key, value] of Object.entries(normalized)) if (value !== null) query.set(key, String(value));
  return `/audit?${query}`;
}

export function readAuditEvent(value) {
  if (!object(value) || !integer(value.id, 1) || !safeId(value.actorId) && value.actorId !== null
    || typeof value.action !== 'string' || !ACTION.test(value.action)
    || !OUTCOMES.has(value.outcome) || !integer(value.createdAt)
    || value.code !== null && (typeof value.code !== 'string' || !CODE.test(value.code))) {
    throw problem('audit_result_invalid');
  }
  const resourceType = value.resourceType;
  const resourceId = value.resourceId;
  if ((resourceType === null) !== (resourceId === null)
    || resourceType !== null && (typeof resourceType !== 'string' || !TYPE.test(resourceType) || !safeId(resourceId))) {
    throw problem('audit_result_invalid');
  }
  return {
    id: value.id,
    actorId: value.actorId,
    action: value.action,
    resourceType,
    resourceId,
    outcome: value.outcome,
    code: value.code,
    createdAt: value.createdAt,
  };
}

export function readAuditPage(value, { offset, limit }) {
  try {
    if (!object(value) || value.offset !== offset || value.limit !== limit || !integer(value.total)
      || !Array.isArray(value.events) || value.events.length !== Math.max(0, Math.min(limit, value.total - offset))) throw new Error();
    const events = value.events.map(readAuditEvent);
    if (new Set(events.map((event) => event.id)).size !== events.length) throw new Error();
    return { events, total: value.total, offset, limit };
  } catch { throw problem('audit_page_invalid'); }
}

export function auditMessage(error) {
  const messages = {
    audit_resource_pair_required: 'Kaynak türü ve kaynak kimliği birlikte girilmelidir.',
    invalid_audit_filter: 'Denetim filtresi geçersiz. Kimlikleri ve işlem adını kontrol edin.',
    invalid_audit_time_range: 'Başlangıç ve bitiş zamanı geçerli bir aralık oluşturmalıdır.',
    invalid_audit_pagination: 'Denetim sayfası geçersiz.',
    invalid_audit_query: 'Sunucu denetim filtresini kabul etmedi.',
    audit_page_invalid: 'API geçerli bir denetim sayfası döndürmedi. API ve arayüz sürümlerini kontrol edin.',
    audit_result_invalid: 'API geçerli bir denetim kaydı döndürmedi.',
    audit_unavailable: 'Denetim geçmişi şu anda kullanılamıyor.',
    forbidden: 'Denetim geçmişi yalnız Owner tarafından görüntülenebilir.',
    unauthorized: 'Oturumunuz sona erdi. Yeniden giriş yapın.',
  };
  return messages[error?.code] ?? (error?.status === 404
    ? 'Denetim API’si bulunamadı. API ve arayüz sürümlerini kontrol edin.'
    : 'Denetim kayıtları alınamadı. Bağlantıyı ve sunucu durumunu kontrol edin.');
}

export const emptyAuditPage = () => ({ status: 'loading', data: null, error: null });

export function createAuditClient({ request, generation, onPage, onAccessLost }) {
  let disposed = false;
  let sequence = 0;
  let reader = null;
  return {
    async load({ filters = {}, offset = 0, limit = 50 } = {}) {
      if (disposed) return;
      reader?.abort();
      const controller = new AbortController();
      reader = controller;
      const current = ++sequence;
      const stamp = generation();
      const valid = () => !disposed && generation() === stamp && !controller.signal.aborted && current === sequence;
      onPage(emptyAuditPage());
      try {
        const result = await request(auditRequestPath({ filters, offset, limit }), { signal: controller.signal });
        if (valid()) onPage({ status: 'ready', data: readAuditPage(result, { offset, limit }), error: null });
      } catch (error) {
        if (!valid() || error.name === 'AbortError') return;
        onPage({ status: 'error', data: null, error });
        if (denied(error)) onAccessLost(error);
      }
    },
    dispose() { disposed = true; sequence += 1; reader?.abort(); },
  };
}

export const auditClientInternals = Object.freeze({ outcomes: Object.freeze([...OUTCOMES]) });
