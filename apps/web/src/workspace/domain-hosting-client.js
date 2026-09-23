import { DomainAliasError, aliasDomainSnapshot, assertAliasDomain } from './domain-alias-model.js';
import { hostingSettingsChanges, hostingSettingsDiff, hostingSettingsWarnings, validateHostingSettingsPreview } from './domain-hosting-model.js';

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// Reuses the existing Domain update API. This is not a server lock or an
// authorization boundary. Saving never stages/activates, retries or issues TLS.
export function createDomainHostingClient({ request, isCurrent }) {
  if (typeof request !== 'function' || typeof isCurrent !== 'function') throw new TypeError('Hosting client dependencies are required');
  const plans = new WeakSet(); const used = new WeakSet(); let pending = false;
  function check() {
    if (!isCurrent()) throw new DomainAliasError('hosting_context_changed', 'Site veya oturum değişti. Sonraki adımlar durduruldu; güncel kaydı kontrol edin.');
  }
  const route = (domain) => `/domains/${encodeURIComponent(domain.id)}`;
  async function call(path, options) { check(); const result = await request(path, options); check(); return result; }
  async function current(base) { return assertAliasDomain(base, await call(route(base))); }
  async function exclusive(action) {
    check();
    if (pending) throw new DomainAliasError('hosting_busy', 'Bu ekranda bir işlem zaten sürüyor.');
    pending = true;
    try { return await action(); } finally { pending = false; }
  }
  return Object.freeze({
    preview(domain, draft) {
      return exclusive(async () => {
        const base = aliasDomainSnapshot(domain);
        const values = { ...draft };
        const changes = hostingSettingsChanges(base, values);
        await current(base);
        const preview = await call(`${route(base)}/update-preview`, { method: 'POST', body: { changes } });
        const validated = validateHostingSettingsPreview(base, values, preview);
        const plan = freeze({ base, ...validated, rows: hostingSettingsDiff(base, values), warnings: hostingSettingsWarnings(base, values) });
        plans.add(plan); return plan;
      });
    },
    save(plan) {
      return exclusive(async () => {
        if (!plans.has(plan) || used.has(plan)) throw new DomainAliasError('hosting_preview_required', 'Yeni bir değişiklik önizlemesi gerekli.');
        await current(plan.base); check(); used.add(plan);
        try {
          const result = await call(route(plan.base), { method: 'PATCH', body: {
            changes: plan.changes, previewDigest: plan.previewDigest, confirmation: plan.confirmation,
          } });
          const expected = { ...plan.base, ...plan.changes, desiredRevision: plan.nextRevision };
          if (result?.previewDigest !== plan.previewDigest || result.impact?.certificate?.detached !== false) {
            throw new DomainAliasError('hosting_response_invalid', 'Kaydetme yanıtı doğrulanamadı.');
          }
          assertAliasDomain(expected, result.domain);
          return { domain: await current(expected) };
        } catch (error) {
          if (error?.code === 'hosting_context_changed') throw error;
          throw new DomainAliasError('hosting_save_unconfirmed', 'Kaydetme isteği gönderildi ancak sonucu doğrulanamadı. Tekrar göndermeden güncel kaydı yükleyin; taslağınızı koruyun.', true);
        }
      });
    },
  });
}
