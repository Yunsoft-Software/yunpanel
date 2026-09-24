const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER = /^yunapp-[a-f0-9]{12}$/;
const record = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const text = (v, max = 200) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
export class PhpToolsError extends Error {
  constructor(code = 'php_tools_response_invalid') { super(code); this.code = code; }
}
function requireValue(value) { if (!value) throw new PhpToolsError(); }
export function phpToolsScope(value) {
  requireValue(record(value) && ['websiteId', 'serverId', 'applicationId'].every((key) => typeof value[key] === 'string' && UUID.test(value[key]))
    && typeof value.unixUser === 'string' && USER.test(value.unixUser));
  return Object.freeze({ websiteId: value.websiteId, serverId: value.serverId, applicationId: value.applicationId, unixUser: value.unixUser });
}
export function resolvePhpToolsAccess({ domainId, domains, websites, canManage }) {
  if (!canManage || [domains?.status, websites?.status].some((status) => ['unauthorized', 'forbidden'].includes(status))) return { state: 'forbidden' };
  if (domains?.status !== 'ready' || websites?.status !== 'ready' || !Array.isArray(domains.items) || !Array.isArray(websites.items)) return { state: 'unavailable' };
  const matches = domains.items.filter((v) => v?.id === domainId);
  if (matches.length !== 1) return { state: 'not_found' };
  const domain = matches[0];
  if (!domain.websiteId) return { state: 'unbound' };
  const sites = websites.items.filter((v) => v?.id === domain.websiteId);
  if (sites.length !== 1) return { state: 'not_found' };
  const website = sites[0];
  if (website.serverId !== domain.serverId) return { state: 'inconsistent' };
  if (website.runtimeType !== 'php') return { state: 'unsupported' };
  try { return { state: 'ready', scope: phpToolsScope({ ...website, websiteId: website.id }) }; }
  catch { return { state: 'inconsistent' }; }
}
function rows(value) {
  requireValue(Array.isArray(value) && value.length <= 2000);
  const seen = new Set();
  return Object.freeze(value.map((item) => {
    requireValue(record(item) && text(item.name) && item.name.length > 0 && text(item.status) && item.status.length > 0 && !seen.has(item.name));
    seen.add(item.name);
    const safe = { name: item.name, status: item.status };
    for (const field of ['version', 'update', 'update_version']) {
      if (item[field] !== undefined) { requireValue(text(item[field])); safe[field] = item[field]; }
    }
    return Object.freeze(safe);
  }));
}
export function phpToolsStatus(tool, value, scope) {
  requireValue(record(value) && value.schemaVersion === 1 && Object.keys(scope).every((key) => value[key] === scope[key])
    && [true, false, null].includes(value.available) && (value.version === null || text(value.version, 80))
    && typeof value.inspectedAt === 'string' && Number.isFinite(Date.parse(value.inspectedAt)) && record(value.checks));
  const common = { ...scope, available: value.available, version: value.version, inspectedAt: value.inspectedAt };
  if (tool === 'wordpress') {
    const keys = ['installation', 'coreVersion', 'plugins', 'themes'];
    requireValue(keys.every((key) => ['ready', 'unknown', 'not_checked'].includes(value.checks[key]))
      && [true, null].includes(value.installed) && (value.coreVersion === null || text(value.coreVersion, 80))
      && (value.checks.installation === 'ready') === (value.installed === true)
      && (value.installed !== true || value.available === true)
      && (value.checks.coreVersion === 'ready') === (value.coreVersion !== null));
    const plugins = rows(value.plugins), themes = rows(value.themes);
    requireValue((value.checks.plugins === 'ready' || plugins.length === 0) && (value.checks.themes === 'ready' || themes.length === 0)
      && (value.installed === true || keys.slice(1).every((key) => value.checks[key] === 'not_checked')));
    return Object.freeze({ ...common, installed: value.installed, coreVersion: value.coreVersion, plugins, themes,
      checks: Object.freeze(Object.fromEntries(keys.map((key) => [key, value.checks[key]]))) });
  }
  requireValue(tool === 'composer');
  const { project, lock, validation } = value.checks;
  requireValue(['present', 'absent', 'unknown'].includes(project) && ['present', 'absent', 'unknown', 'not_checked'].includes(lock)
    && ['ready', 'unknown', 'not_checked'].includes(validation)
    && value.hasComposerJson === ({ present: true, absent: false, unknown: null }[project])
    && value.hasComposerLock === ({ present: true, absent: false, unknown: null, not_checked: null }[lock])
    && [true, null].includes(value.valid) && (validation === 'ready') === (value.valid === true)
    && (project === 'present' ? ['root', 'public'].includes(value.projectLocation) : value.projectLocation === null)
    && (project === 'present' || (validation === 'not_checked' && lock === 'not_checked'))
    && (value.valid !== true || (value.available === true && project === 'present')));
  return Object.freeze({ ...common, hasComposerJson: value.hasComposerJson, hasComposerLock: value.hasComposerLock,
    valid: value.valid, projectLocation: value.projectLocation, checks: Object.freeze({ project, lock, validation }) });
}
export const PHP_TOOL_PATHS = Object.freeze({ wordpress: 'wp-cli/status', composer: 'composer/status' });
export function phpToolsErrorMessage(error) {
  return ({ php_tools_response_invalid: 'Yanıt bu sitenin PHP araçlarıyla eşleşmiyor. Sonuç kullanılmadı.',
    website_runtime_not_php: 'Bu araç yalnız PHP sitelerinde kullanılabilir.',
    website_php_context_changed: 'Site bağlantısı kontrol sırasında değişti. Site bilgilerini yenileyin.',
    website_php_path_unavailable: 'PHP çalışma klasörü okunamadı. İzinleri ve site kurulumunu kontrol edin.',
    php_tools_denied: 'Oturum veya site erişim izni geçerli değil. Eski bilgiler temizlendi.',
  })[error?.code] ?? 'Araç bilgisi alınamadı. Yeniden kontrol edin; bu hata aracın kurulu olmadığını göstermez.';
}
