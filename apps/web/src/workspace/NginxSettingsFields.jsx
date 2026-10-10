import { useId } from 'react';
import { Button } from './PanelKit.jsx';

export default function NginxSettingsFields({ targetType, settings, disabled, onChange }) {
  const hint = useId();
  const change = (key, value) => onChange({ ...settings, [key]: value });
  const header = (index, key, value) => change('headers', settings.headers.map((item, at) => at === index ? { ...item, [key]: value } : item));
  const number = event => event.target.value === '' ? null : Number(event.target.value);
  return <fieldset disabled={disabled} className="ws-form">
    <legend>Web sunucusu ayarları</legend>
    <div className="ws-form-grid">
      <label>En büyük yükleme boyutu (MB)<input type="number" min="1" max="1024" step="1"
        value={settings.clientMaxBodySizeMb ?? ''} placeholder="Sunucu varsayılanı" aria-describedby={hint}
        onChange={event => change('clientMaxBodySizeMb', number(event))} /></label>
      {['proxy', 'python'].includes(targetType) && <label>Uygulama yanıt süresi (saniye)<input type="number" min="1" max="600" step="1"
        value={settings.proxyTimeoutSeconds ?? ''} placeholder="Sunucu varsayılanı" aria-describedby={hint}
        onChange={event => change('proxyTimeoutSeconds', number(event))} /></label>}
      {targetType === 'static' && <label>Statik dosya önbelleği (saniye)<input type="number" min="0" max="31536000" step="1"
        value={settings.staticAssetCacheSeconds ?? ''} placeholder="Sunucu varsayılanı"
        onChange={event => change('staticAssetCacheSeconds', number(event))} /></label>}
      {['php', 'static'].includes(targetType) && <label>Başlangıç dosyaları<input
        value={Array.isArray(settings.indexFiles) ? settings.indexFiles.join(' ') : settings.indexFiles ?? ''} maxLength="520" spellCheck={false}
        placeholder={targetType === 'php' ? 'index.php index.html' : 'index.html'}
        onChange={event => change('indexFiles', event.target.value)} />
        <span className="ws-field-hint">Öncelik sırasıyla, boşlukla ayırın. Boş bırakıldığında varsayılan kullanılır.</span></label>}
    </div>
    <p id={hint} className="ws-field-hint">Boş sayısal alanlar sunucunun varsayılanını kullanır. Yükleme boyutu 1–1024 MB; yanıt süresi 1–600 saniyedir.</p>
    {['proxy', 'python'].includes(targetType) && <label className="ws-check"><input type="checkbox" checked={settings.websocket}
      onChange={event => change('websocket', event.target.checked)} />WebSocket bağlantılarına izin ver</label>}
    {targetType === 'static' && <><label className="ws-check"><input type="checkbox" checked={settings.spaFallback}
      onChange={event => change('spaFallback', event.target.checked)} />Bulunamayan sayfalarda index.html kullan</label>
      <p className="ws-field-hint">Tek sayfa uygulamalarının bağlantıları için açın. Kapalıysa bulunamayan dosyalar 404 döner. Önbellekte 0, tarayıcıda saklamayı kapatır.</p></>}
    {['php', 'static'].includes(targetType) && <details>
      <summary>Özel hata sayfaları</summary>
      <p className="ws-field-hint">HTML dosyasını Dosya Yöneticisi ile siteye yükleyin. Örneğin /hatalar/404.html. Boş alan sunucunun varsayılanını kullanır; hata durum kodu korunur.</p>
      <div className="ws-form-grid">{['403', '404', '500', '502', '503', '504'].map(code => <label key={code}>{code} hata sayfası<input
        value={settings.errorPages?.[code] ?? ''} maxLength="192" placeholder={'/hatalar/' + code + '.html'} spellCheck={false}
        onChange={event => { const pages = { ...settings.errorPages }; if (event.target.value) pages[code] = event.target.value; else delete pages[code]; change('errorPages', pages); }} /></label>)}</div>
    </details>}
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
    </fieldset>
  </fieldset>;
}
