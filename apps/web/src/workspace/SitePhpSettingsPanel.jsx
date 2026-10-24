import { useEffect, useRef, useState } from 'react';
import { panelRequest, waitForJob } from '../api.js';
import { sessionTransitionPending, sessionVersion } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Button, EmptyState, ErrorNotice, Section } from './PanelKit.jsx';
import { resolvePhpToolsAccess } from './php-tools-model.js';
import SitePhpToolsPanel from './SitePhpToolsPanel.jsx';

export default function SitePhpSettingsPanel({ domainId }) {
  const { domains, websites, canManage } = useWorkspace();
  const access = resolvePhpToolsAccess({ domainId, domains, websites, canManage });
  if (access.state !== 'ready') return <EmptyState title="PHP ayarları açılamadı" detail="Güncel site bağlantısını ve PHP barındırma türünü kontrol edin." />;
  return <PhpSettings key={`${access.scope.websiteId}:${sessionVersion()}`} scope={access.scope} domainId={domainId} />;
}

function PhpSettings({ scope, domainId }) {
  const { refreshAll, updateJob, jobs } = useWorkspace();
  const [config, setConfig] = useState(null), [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [saved, setSaved] = useState(false);
  const live = useRef(true), generation = useRef(sessionVersion());
  const current = () => live.current && generation.current === sessionVersion() && !sessionTransitionPending();
  const endpoint = `/websites/${encodeURIComponent(scope.websiteId)}/php-tools/config`;
  const read = async () => {
    const result = await panelRequest(endpoint);
    if (result?.websiteId !== scope.websiteId || result.applicationId !== scope.applicationId
      || result.serverId !== scope.serverId || !Number.isSafeInteger(result.websiteRevision)) throw new Error('PHP ayarları siteyle eşleşmiyor. Sayfayı yenileyin.');
    return result;
  };
  useEffect(() => {
    live.current = true;
    read().then((result) => {
      if (!current()) return;
      setConfig(result); setDraft({ phpVersion: result.phpVersion, maxChildren: result.fpm.maxChildren,
        memoryLimitMb: result.fpm.memoryLimitMb, maxExecutionSeconds: result.fpm.maxExecutionSeconds });
    }).catch((failure) => { if (current()) setError(failure); });
    return () => { live.current = false; };
  }, [endpoint]);
  async function save(event) {
    event.preventDefault(); if (busy || !current()) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const preview = await panelRequest(`${endpoint}/preview`, { method: 'POST', body: draft });
      if (!current()) return;
      if (preview.websiteId !== scope.websiteId || preview.applicationId !== scope.applicationId
        || preview.websiteRevision !== config.websiteRevision) throw new Error('Site ayarları değişti. Sayfayı yenileyip tekrar kontrol edin.');
      const queued = await panelRequest(endpoint, { method: 'POST', body: { config: draft, expectedRevision: preview.websiteRevision,
        previewDigest: preview.previewDigest, confirmation: preview.confirmation } });
      if (!queued?.job?.id) throw new Error('PHP işlem kaydı alınamadı. İşlem geçmişini kontrol edin.');
      updateJob(queued.job); jobs.refresh();
      const terminal = await waitForJob(queued.job.id);
      if (!current()) return;
      updateJob(terminal);
      if (terminal.status !== 'succeeded') throw new Error('PHP ayarları uygulanamadı. Önceki çalışan yapılandırma korunuyor.');
      const result = await read();
      if (!current()) return;
      if (result.websiteRevision !== preview.websiteRevision + 1 || result.phpVersion !== draft.phpVersion
        || result.fpm.maxChildren !== draft.maxChildren || result.fpm.memoryLimitMb !== draft.memoryLimitMb
        || result.fpm.maxExecutionSeconds !== draft.maxExecutionSeconds) throw new Error('İşlem tamamlandı ancak kaydedilen PHP ayarları eşleşmiyor. Durumu yeniden kontrol edin.');
      setConfig(result); setSaved(true); refreshAll();
    } catch (failure) { if (current()) setError(failure); }
    finally { if (current()) setBusy(false); }
  }
  const change = (key, value) => { setSaved(false); setDraft((previous) => ({ ...previous, [key]: value })); };
  return <>
    <Section title="PHP Ayarları" description="Bu siteye ait PHP sınırlarını düzenleyin. Kaydetmeden önce yapılandırma kontrol edilir.">
      <div className="ws-section-body"><ErrorNotice error={error} />
        {!draft && !error && <p role="status">PHP ayarları yükleniyor…</p>}
        {saved && <p className="ws-notice" role="status">PHP ayarları uygulandı ve kaydedildi.</p>}
        {draft && <form onSubmit={save} className="ws-form">
          <div className="ws-field"><label htmlFor="site-php-version">PHP sürümü</label>
            <select id="site-php-version" value={draft.phpVersion} disabled={busy} onChange={(event) => change('phpVersion', event.target.value)}>
              {[...new Set([config.phpVersion, ...(config.availablePhpVersions ?? [config.phpVersion])])].map((version) => <option key={version} value={version}>{version}</option>)}
            </select><small>Çalışma biçimi: PHP-FPM</small></div>
          <div className="ws-form-grid">
            <div className="ws-field"><label htmlFor="site-php-memory">Bellek sınırı (MB)</label><input id="site-php-memory" type="number" required min="64" max="2048" disabled={busy} value={draft.memoryLimitMb} onChange={(event) => change('memoryLimitMb', Number(event.target.value))} /></div>
            <div className="ws-field"><label htmlFor="site-php-timeout">Çalışma süresi (saniye)</label><input id="site-php-timeout" type="number" required min="5" max="600" disabled={busy} value={draft.maxExecutionSeconds} onChange={(event) => change('maxExecutionSeconds', Number(event.target.value))} /></div>
          </div>
          <details className="ws-settings-advanced"><summary>Gelişmiş işlem havuzu ayarları</summary><div className="ws-field"><label htmlFor="site-php-workers">En fazla eşzamanlı PHP işlemi</label><input id="site-php-workers" type="number" required min="1" max="64" disabled={busy} value={draft.maxChildren} onChange={(event) => change('maxChildren', Number(event.target.value))} /></div></details>
          <div className="ws-actions"><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Ayarlar uygulanıyor…' : 'Kaydet'}</Button></div>
        </form>}
      </div>
    </Section>
    <details className="ws-settings-advanced"><summary>Composer ve bağımlılıklar</summary><SitePhpToolsPanel domainId={domainId} tool="composer" /></details>
  </>;
}
