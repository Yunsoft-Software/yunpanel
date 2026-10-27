import { useId } from 'react';
import { Button } from './PanelKit.jsx';

export const NGINX_HEADER_PRESETS = {
  cors: [
    { name: 'Access-Control-Allow-Origin', value: '*', always: true },
    { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, PATCH, DELETE, OPTIONS', always: true },
    { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization, X-Requested-With', always: true },
  ],
  security: [
    { name: 'X-Frame-Options', value: 'SAMEORIGIN', always: true },
    { name: 'X-Content-Type-Options', value: 'nosniff', always: true },
    { name: 'Referrer-Policy', value: 'strict-origin-when-cross-origin', always: true },
    { name: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()', always: true },
  ],
  no_cache: [
    { name: 'Cache-Control', value: 'no-store, no-cache, must-revalidate', always: true },
  ],
  immutable_cache: [
    { name: 'Cache-Control', value: 'public, max-age=31536000, immutable', always: true },
  ],
};

export const STATIC_CACHE_PRESETS = [
  ['1 Saat (3600s)', 3600],
  ['1 Gün (86400s)', 86400],
  ['30 Gün (2592000s)', 2592000],
  ['1 Yıl (31536000s)', 31536000],
];

export function applyNginxHeaderPreset(existingHeaders = [], presetKey) {
  const base = Array.isArray(existingHeaders)
    ? existingHeaders
        .filter(item => String(item?.name ?? '').trim() !== '' || String(item?.value ?? '').trim() !== '')
        .slice(0, 12)
        .map(item => ({
          name: String(item?.name ?? ''),
          value: String(item?.value ?? ''),
          always: item?.always !== false,
        }))
    : [];
  const additions = NGINX_HEADER_PRESETS[presetKey] ?? [];
  const next = [...base];
  for (const candidate of additions) {
    const existingIndex = next.findIndex(
      item => item.name.trim().toLowerCase() === candidate.name.toLowerCase(),
    );
    if (existingIndex !== -1) {
      next[existingIndex] = { ...candidate };
      continue;
    }
    if (next.length >= 12) break;
    next.push({ ...candidate });
  }
  return next;
}

export default function NginxSettingsFields({ targetType, settings, disabled, onChange, domainNames = [] }) {
  const hint = useId();
  const change = (key, value) => onChange({ ...settings, [key]: value });
  const header = (index, key, value) => change('headers', settings.headers.map((item, at) => at === index ? { ...item, [key]: value } : item));
  const number = event => event.target.value === '' ? null : Number(event.target.value);
  const rules = settings.redirectRules ?? [];
  const rule = (index, key, value) => change('redirectRules', rules.map((item, at) => at === index ? { ...item, [key]: value } : item));
  return <fieldset disabled={disabled} className="ws-form">
    <legend>Web sunucusu ayarları</legend>
    <div className="ws-form-grid">
      {['php', 'static'].includes(targetType) && <label>Document root<input
        value={settings.documentRoot ?? ''} maxLength="192" spellCheck={false} placeholder="Site kökü"
        onChange={event => change('documentRoot', event.target.value || null)} />
        <span className="ws-field-hint">Site köküne göre klasör yolu. Örneğin public veya uygulama/public. Klasör önceden oluşturulmalıdır.</span></label>}
      {domainNames.length > 0 && <label>Tercih edilen alan adı<select value={settings.preferredDomain ?? ''}
        onChange={event => change('preferredDomain', event.target.value || null)}>
        <option value="">Ana alan adı</option>{domainNames.map(name => <option value={name} key={name}>{name}</option>)}
      </select><span className="ws-field-hint">Ek alan adı yönlendirmesi açıkken bu adres kullanılır. www için önce ek alan adını bağlayın.</span></label>}

      <label>En büyük yükleme boyutu (MB)<input type="number" min="1" max="1024" step="1"
        value={settings.clientMaxBodySizeMb ?? ''} placeholder="Sunucu varsayılanı" aria-describedby={hint}
        onChange={event => change('clientMaxBodySizeMb', number(event))} /></label>
      {['proxy', 'python'].includes(targetType) && <label>Uygulama yanıt süresi (saniye)<input type="number" min="1" max="600" step="1"
        value={settings.proxyTimeoutSeconds ?? ''} placeholder="Sunucu varsayılanı" aria-describedby={hint}
        onChange={event => change('proxyTimeoutSeconds', number(event))} /></label>}
      {['php', 'static'].includes(targetType) && <label>Statik dosya önbelleği (saniye)<input type="number" min="0" max="31536000" step="1"
        value={settings.staticAssetCacheSeconds ?? ''} placeholder="Sunucu varsayılanı"
        onChange={event => change('staticAssetCacheSeconds', number(event))} /></label>}
      {['php', 'static'].includes(targetType) && <label><span id={`${hint}-index-label`}>Başlangıç dosyaları</span><input
        value={Array.isArray(settings.indexFiles) ? settings.indexFiles.join(' ') : settings.indexFiles ?? ''} maxLength="520" spellCheck={false}
        placeholder={targetType === 'php' ? 'index.php index.html' : 'index.html'}
        aria-labelledby={`${hint}-index-label`} aria-describedby={`${hint}-index-hint`}
        onChange={event => change('indexFiles', event.target.value)} />
        <span id={`${hint}-index-hint`} className="ws-field-hint">Öncelik sırasıyla, boşlukla ayırın. Boş bırakıldığında varsayılan kullanılır.</span></label>}
    </div>
    <p id={hint} className="ws-field-hint">Boş sayısal alanlar sunucunun varsayılanını kullanır. Yükleme boyutu 1–1024 MB; yanıt süresi 1–600 saniyedir.</p>
    <label className="ws-check"><input type="checkbox" checked={settings.gzip === true}
      onChange={event => change('gzip', event.target.checked)} />Sıkıştırma (gzip)</label>
    {targetType === 'php' && <div className="ws-actions" role="group" aria-label="Statik önbellek hızlı seçimleri">
      {STATIC_CACHE_PRESETS.map(([label, seconds]) => (
        <Button key={seconds} disabled={disabled} onClick={() => change('staticAssetCacheSeconds', seconds)}>{label}</Button>
      ))}
    </div>}
    {['proxy', 'python'].includes(targetType) && <label className="ws-check"><input type="checkbox" checked={settings.websocket}
      onChange={event => change('websocket', event.target.checked)} />WebSocket bağlantılarına izin ver</label>}
    {targetType === 'static' && <><label className="ws-check"><input type="checkbox" checked={settings.spaFallback}
      onChange={event => change('spaFallback', event.target.checked)} />Bulunamayan sayfalarda index.html kullan</label>
      <p className="ws-field-hint">Tek sayfa uygulamalarının bağlantıları için açın. Kapalıysa bulunamayan dosyalar 404 döner. Önbellekte 0, tarayıcıda saklamayı kapatır.</p>
      <div className="ws-actions" role="group" aria-label="Statik önbellek hızlı seçimleri">
        {STATIC_CACHE_PRESETS.map(([label, seconds]) => (
          <Button key={seconds} disabled={disabled} onClick={() => change('staticAssetCacheSeconds', seconds)}>{label}</Button>
        ))}
      </div></>}
    {['php', 'static'].includes(targetType) && <details>
      <summary>Özel hata sayfaları</summary>
      <p className="ws-field-hint">HTML dosyasını Dosya Yöneticisi ile siteye yükleyin. Örneğin /hatalar/404.html. Boş alan sunucunun varsayılanını kullanır; hata durum kodu korunur.</p>
      <div className="ws-form-grid">{['403', '404', '500', '502', '503', '504'].map(code => <label key={code}>{code} hata sayfası<input
        value={settings.errorPages?.[code] ?? ''} maxLength="192" placeholder={'/hatalar/' + code + '.html'} spellCheck={false}
        onChange={event => { const pages = { ...settings.errorPages }; if (event.target.value) pages[code] = event.target.value; else delete pages[code]; change('errorPages', pages); }} /></label>)}</div>
    </details>}
    <details open={rules.length > 0}>
      <summary>Yönlendirmeler</summary>
      <p className="ws-field-hint">Örnek: /eski → https://alan.com/yeni. Klasör eşleşmesinde iki taraf da / ile biter ve alt yollar korunur.</p>
      {rules.map((item, index) => <div className="ws-form-grid" key={index}>
        <label>Kaynak {index + 1}<input value={item.source} required maxLength="192" placeholder="/eski" spellCheck={false}
          onChange={event => rule(index, 'source', event.target.value)} /></label>
        <label>Hedef {index + 1}<input value={item.target} required maxLength="512" placeholder="https://alan.com/yeni" spellCheck={false}
          onChange={event => rule(index, 'target', event.target.value)} /></label>
        <label>Eşleşme {index + 1}<select value={item.match} onChange={event => rule(index, 'match', event.target.value)}>
          <option value="exact">Tam yol</option><option value="prefix">Klasör ve altı</option></select></label>
        <label>Tür {index + 1}<select value={item.status} onChange={event => rule(index, 'status', Number(event.target.value))}>
          <option value={301}>Kalıcı (301)</option><option value={302}>Geçici (302)</option></select></label>
        <div className="ws-actions"><Button onClick={() => change('redirectRules', rules.filter((_, at) => at !== index))}>Yönlendirme {index + 1} kaldır</Button></div>
      </div>)}
      <Button disabled={disabled || rules.length >= 50} onClick={() => change('redirectRules', [...rules, { source: '', target: '', status: 301, match: 'exact' }])}>Yönlendirme ekle</Button>
    </details>
    <fieldset>
      <legend>Özel yanıt başlıkları</legend>
      <p className="ws-field-hint">Site yanıtına en fazla 12 başlık ekleyebilirsiniz. Başlık adları benzersiz, değerleri tek satır olmalıdır.</p>
      {settings.headers.map((item, index) => <div className="ws-form" key={index}>
        <div className="ws-form-grid">
          <label>Başlık {index + 1} adı<input value={item.name} required maxLength="64" pattern="[A-Za-z][A-Za-z0-9-]*" spellCheck={false}
            onChange={event => header(index, 'name', event.target.value)} /></label>
          <label>Başlık {index + 1} değeri<input value={item.value} required maxLength="256" spellCheck={false}
            onChange={event => header(index, 'value', event.target.value)} /></label>
        </div>
        <div className="ws-actions"><label className="ws-check"><input type="checkbox" checked={item.always}
          onChange={event => header(index, 'always', event.target.checked)} />Başlık {index + 1}: hata yanıtlarında da gönder</label>
          <Button onClick={() => change('headers', settings.headers.filter((_, at) => at !== index))}>Başlık {index + 1} kaldır</Button></div>
      </div>)}
      <Button disabled={disabled || settings.headers.length >= 12} onClick={() => change('headers', [...settings.headers, { name: '', value: '', always: true }])}>Yanıt başlığı ekle</Button>
      <div className="ws-actions" role="group" aria-label="JAMstack ve güvenlik başlığı ön-ayarları">
        <Button disabled={disabled || settings.headers.length >= 12} onClick={() => change('headers', applyNginxHeaderPreset(settings.headers, 'cors'))}>CORS Başlıkları Ekle</Button>
        <Button disabled={disabled || settings.headers.length >= 12} onClick={() => change('headers', applyNginxHeaderPreset(settings.headers, 'security'))}>Güvenlik Başlıkları (HSTS/XSS) Ekle</Button>
        <Button disabled={disabled || settings.headers.length >= 12} onClick={() => change('headers', applyNginxHeaderPreset(settings.headers, 'immutable_cache'))}>Immutable Cache Başlığı Ekle</Button>
      </div>
    </fieldset>
  </fieldset>;
}
