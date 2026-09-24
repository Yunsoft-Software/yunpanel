import { useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionTransitionPending, sessionVersion } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, LinkButton, Section } from './PanelKit.jsx';
import { formatDate, siteHref } from './site-model.js';
import { PHP_TOOL_ACTIONS, resolvePhpToolsAccess } from './php-tools-model.js';
import { createPhpToolsClient } from './php-tools-client.js';

const ACCESS = { forbidden: 'Bu siteye erişim izniniz yok.', unavailable: 'Güncel site bilgileri bekleniyor.',
  not_found: 'Bu alan adına bağlı tek bir site kaydı bulunamadı.', unbound: 'Alan adı henüz bir siteye bağlanmamış.',
  inconsistent: 'Site, sunucu ve uygulama bağlantısı doğrulanamadı.', unsupported: 'PHP araçları yalnız PHP sitelerinde kullanılabilir.' };
const toolState = (available) => available === true ? 'Komut aracı tespit edildi' : available === false ? 'Komut aracı bulunamadı' : 'Doğrulanamadı';
export default function SitePhpToolsPanel({ domainId }) {
  const { session } = usePanelSession();
  const { domains, websites, canManage, refreshAll } = useWorkspace();
  const access = resolvePhpToolsAccess({ domainId, domains, websites, canManage });
  if (access.state !== 'ready') return <Section title="PHP / WordPress"><EmptyState icon="code" title="PHP araçları açılamadı" detail={ACCESS[access.state]}
    action={access.state !== 'forbidden' && <Button onClick={refreshAll} icon="refresh">Site bilgilerini yenile</Button>} /></Section>;
  const generation = sessionVersion();
  const identity = JSON.stringify([domainId, access.scope, session?.user?.id, session?.user?.role, generation, canManage]);
  return <PhpToolsWorkspace key={identity} domainId={domainId} scope={access.scope} generation={generation} />;
}
function PhpToolsWorkspace({ domainId, scope, generation }) {
  const { canManage, jobs, resourceBusy, observe, updateJob } = useWorkspace();
  const ref = useRef(null), live = useRef(canManage); live.current = canManage;
  const [state, setState] = useState(null);
  useEffect(() => {
    const client = createPhpToolsClient({ scope, request: panelRequest,
      isCurrent: () => live.current && generation === sessionVersion() && !sessionTransitionPending(),
      onJob: (job, first) => { if (first) { observe(job); jobs.refresh(); } else updateJob(job); },
    });
    ref.current = client;
    const unsubscribe = client.subscribe(setState);
    setState(client.getSnapshot()); void client.loadAll();
    return () => { unsubscribe(); client.dispose(); ref.current = null; };
  }, [scope.websiteId, scope.serverId, scope.applicationId, scope.unixUser, generation, observe, updateJob, jobs.refresh]);
  useEffect(() => {
    const job = state?.action?.job;
    if (!job || !['queued', 'running'].includes(job.status)) return undefined;
    const timer = setInterval(() => { void ref.current?.refreshAction(); }, 3000);
    return () => clearInterval(timer);
  }, [state?.action?.job?.id, state?.action?.job?.status]);
  const actionBusy = state?.action?.busy || jobs.status !== 'ready' || resourceBusy('application', scope.applicationId);
  const actionReady = (item) => {
    const status = state?.[item.tool];
    if (!status?.fresh || !status.data) return false;
    if (item.tool === 'wordpress') return status.data.available === true && status.data.installed === true;
    return status.data.available === true && status.data.hasComposerJson === true;
  };
  const actionsFor = (tool) => PHP_TOOL_ACTIONS.filter((item) => item.tool === tool)
    .map((item) => ({ ...item, ready: actionReady(item) }));
  return <>
    <Section title="PHP araçları" description="WordPress ve Composer durumunu bu site kapsamında kontrol edin.">
      <div className="ws-section-body"><div className="ws-actions"><LinkButton to={siteHref(domainId, 'files')} icon="folder">Dosya Yöneticisi</LinkButton><LinkButton to={siteHref(domainId, 'terminal')} icon="terminal">Site terminali</LinkButton></div>
        <p className="ws-muted">Durum kontrolleri mevcut PHP araçlarını site kullanıcısıyla çağırır. Yazma etkili eylemler sabit katalogdan seçilir, açık onaydan sonra durable işlem kuyruğuna alınır; paket/eklenti güncellemesi veya serbest komut çalıştırma sunulmaz.</p></div>
    </Section>
    <ToolSection title="WordPress" tool="wordpress" status={state?.wordpress} denied={state?.denied} client={ref}
      actions={actionsFor('wordpress')} actionBusy={actionBusy} onAction={(id) => void ref.current?.prepareAction(id)}>
      {state?.wordpress?.data && <WordPressStatus data={state.wordpress.data} fresh={state.wordpress.fresh} />}
    </ToolSection>
    <ToolSection title="Composer" tool="composer" status={state?.composer} denied={state?.denied} client={ref}
      actions={actionsFor('composer')} actionBusy={actionBusy} onAction={(id) => void ref.current?.prepareAction(id)}>
      {state?.composer?.data && <ComposerStatus data={state.composer.data} />}
    </ToolSection>
    {state?.action?.job && <Section title="Son PHP araç işlemi"><div className="ws-section-body">
      <p><Badge state={state.action.job.status} /> <code>{state.action.job.id}</code></p>
      <p className="ws-muted">{state.action.job.status === 'succeeded'
        ? 'İşlem doğrulandı; WordPress ve Composer durumu yeniden okundu.'
        : state.action.job.status === 'failed' || state.action.job.status === 'cancelled'
          ? 'İşlem tamamlanmadı. Teknik ayrıntı için işlem kaydını açın.'
          : 'İşlem sunucuda yürütülmek üzere takip ediliyor.'}</p>
      <Button onClick={() => observe(state.action.job)}>İşlem kaydını aç</Button>
    </div></Section>}
    <ErrorNotice error={state?.action?.error} />
    {state?.action?.preview && <ConfirmDialog
      title={state.action.preview.label}
      message={`${state.action.preview.impact} İşlem yalnız bu sitenin sistem kullanıcısıyla çalıştırılır. Kuyruğa alındıktan sonra sonuç İşlem Geçmişi üzerinden takip edilir.`}
      confirmation={state.action.preview.label}
      busy={state.action.busy}
      error={state.action.error}
      onCancel={() => ref.current?.dismissPreview()}
      onConfirm={() => void ref.current?.queueAction()}
      confirmLabel="İşlemi kuyruğa al"
    />}
  </>;
}
function ToolSection({ title, tool, status, denied, client, children, actions = [], actionBusy = false, onAction }) {
  return <Section title={title} actions={<div className="ws-actions">
    <Button icon="refresh" disabled={!status || status.loading || denied} onClick={() => void client.current?.load(tool)}>Durumu kontrol et</Button>
    {actions.map((item) => <Button key={item.id} disabled={denied || actionBusy || !item.ready}
      onClick={() => onAction(item.id)}>{item.label}</Button>)}
  </div>}>
    <div className="ws-section-body"><ErrorNotice error={status?.error} />
      {(!status || status.loading) && <p role="status">Araç durumu kontrol ediliyor…</p>}
      {status?.data && <p className="ws-muted" role="status">{status.fresh ? 'Son kontrol' : 'Önceki kontrol; güncel durumu doğrulanmadı'}: {formatDate(status.data.inspectedAt)}</p>}
      {children}
    </div>
  </Section>;
}
function WordPressStatus({ data, fresh }) {
  return <><KeyValues items={[
    ['WP-CLI', toolState(data.available)], ['WP-CLI sürümü', data.version ?? 'Doğrulanamadı'],
    ['WordPress kurulumu', data.installed === true ? 'Doğrulandı' : data.available === false ? 'WP-CLI doğrulanmadan kontrol edilmedi' : 'Doğrulanamadı'],
    ['WordPress sürümü', data.coreVersion ?? 'Doğrulanamadı'],
  ]} />
    {data.checks.installation === 'unknown' && <p className="ws-muted">WordPress kontrolü tamamlanmadı. Bu sonuç WordPress'in kurulu olmadığını göstermez.</p>}
    <Inventory key={`plugins:${data.inspectedAt}`} label="Eklentiler" items={data.plugins} check={data.checks.plugins} fresh={fresh} />
    <Inventory key={`themes:${data.inspectedAt}`} label="Temalar" items={data.themes} check={data.checks.themes} fresh={fresh} />
  </>;
}
function Inventory({ label, items, check, fresh }) {
  const [page, setPage] = useState(0);
  const size = 20, pages = Math.max(1, Math.ceil(items.length / size)), current = Math.min(page, pages - 1);
  const statusLabel = (value) => ({ active: 'Etkin', inactive: 'Devre dışı', 'active-network': 'Ağda etkin', 'must-use': 'Zorunlu eklenti', dropin: 'Drop-in', parent: 'Üst tema' })[value] ?? value;
  return <div><h3>{label}</h3>{check !== 'ready' ? <p className="ws-muted">{check === 'unknown' ? 'Liste alınamadı; boş olduğu varsayılmadı.' : 'Henüz kontrol edilmedi.'}</p>
    : items.length === 0 ? <p className="ws-muted">Kontrol edilen listede kayıt yok.</p> : <>
      <div className="ws-table-wrap"><table className="ws-table"><thead><tr><th scope="col">Ad</th><th scope="col">Durum</th><th scope="col">Sürüm</th><th scope="col">Güncelleme</th></tr></thead><tbody>
        {items.slice(current * size, (current + 1) * size).map((item) => <tr key={item.name}><td>{item.name}</td><td>{statusLabel(item.status)}</td><td>{item.version || 'Bilinmiyor'}</td>
          <td>{item.update === 'available' ? <Badge state={fresh ? 'warning' : 'unknown'}>{item.update_version ? `${item.update_version} mevcut` : 'Güncelleme mevcut'}</Badge> : item.update === 'none' ? 'Bildirilen güncelleme yok' : 'Doğrulanamadı'}</td></tr>)}
      </tbody></table></div><div className="ws-actions"><span>{items.length} kayıt · Sayfa {current + 1}/{pages}</span><Button disabled={current === 0} onClick={() => setPage(current - 1)} aria-label={`${label}: önceki sayfa`}>Önceki</Button><Button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)} aria-label={`${label}: sonraki sayfa`}>Sonraki</Button></div>
    </>}</div>;
}
function ComposerStatus({ data }) {
  const presence = (value) => value === true ? 'Var' : value === false ? 'Yok' : 'Doğrulanamadı';
  return <><KeyValues items={[
    ['Composer', toolState(data.available)], ['Composer sürümü', data.version ?? 'Doğrulanamadı'],
    ['composer.json', presence(data.hasComposerJson)], ['composer.lock', data.checks.lock === 'not_checked' ? 'Kontrol edilmedi' : presence(data.hasComposerLock)],
    ['Proje konumu', data.projectLocation === 'root' ? 'Uygulama kökü' : data.projectLocation === 'public' ? 'public klasörü' : 'Doğrulanamadı'],
    ['Proje doğrulaması', data.valid === true ? 'Kontrol başarılı' : data.checks.validation === 'not_checked' ? 'Kontrol edilmedi' : 'Kontrol tamamlanmadı'],
  ]} /><p className="ws-muted">Bu kontrol bağımlılık kurmaz veya güncellemez; uygulamanın çalıştığını ya da paketlerin güvenli olduğunu tek başına kanıtlamaz.</p></>;
}
