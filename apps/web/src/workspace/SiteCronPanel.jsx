import { useEffect, useId, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { usePanelSession } from '../panel-session.jsx';
import { sessionTransitionPending, sessionVersion } from '../session-client.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, KeyValues, LinkButton, Modal, Section } from './PanelKit.jsx';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { CronTaskClientError, createCronTaskClient, cronDraft, cronErrorMessage } from './cron-task-client.js';
import { resolveCronAccess } from './cron-task-access.js';
import './ui/cron-tasks.css';

const ACCESS = {
  forbidden: 'Bu sitenin görevlerini yönetme izniniz yok veya oturumunuz geçerli değil.',
  unavailable: 'Site bilgisi güncel değil. Bilgiler yenilenene kadar işlemler duraklatıldı.',
  not_found: 'Alan adı için tek ve doğrulanmış bir site kaydı bulunamadı.',
  unbound: 'Önce alan adının mevcut Website kaydıyla bağlantısı kurulmalıdır.',
  inconsistent: 'Sitenin sunucu, uygulama veya sistem kullanıcısı bağı tutarsız.',
  unsupported: 'Bu araç şu anda statik, Node.js ve PHP sitelerinde kullanılabilir.',
};
const PRESETS = [['*/5 * * * *', 'Her 5 dakikada'], ['0 * * * *', 'Her saat'], ['0 3 * * *', 'Her gün 03:00'], ['0 3 * * 0', 'Her pazar 03:00']];
const INITIAL = { items: null, fresh: false, loading: true, busy: false, denied: false, error: null, operation: null, reads: 0 };
const EMPTY_DRAFT = { name: '', schedule: '0 3 * * *', command: '', enabled: true };
const waiting = (operation) => operation && !['succeeded', 'failed'].includes(operation.phase);
const fields = ['name', 'schedule', 'command', 'enabled'];
const isDirty = (editor) => Boolean(editor && fields.some((field) => editor.draft[field] !== editor.base[field]));

export default function SiteCronPanel({ domainId }) {
  const { session } = usePanelSession();
  const { domains, websites, canManage, refreshAll } = useWorkspace();
  const generation = sessionVersion();
  const identity = JSON.stringify([domainId, session?.user?.id, session?.user?.role, generation, canManage]);
  const access = resolveCronAccess({ domainId, domains, websites, canManage });
  const retained = useRef(null);
  if (access.state === 'ready') retained.current = { identity, ...access };
  else if (access.state !== 'unavailable' || retained.current?.identity !== identity) retained.current = null;
  // Keep an already validated form through a temporary collection refresh, but
  // never start a new scope from stale data or retain it after permission loss.
  const target = access.state === 'ready' ? access : retained.current;
  if (!target) return <Section title="Zamanlanmış Görevler"><EmptyState icon="clock" title="Görevler açılamadı" detail={ACCESS[access.state]}
    action={access.state !== 'forbidden' && <Button onClick={refreshAll} icon="refresh">Site bilgilerini yenile</Button>} /></Section>;
  return <CronWorkspace key={JSON.stringify([identity, target.scope])} scope={target.scope} name={target.name}
    ready={access.state === 'ready'} generation={generation} />;
}

function CronWorkspace({ scope, name, ready, generation }) {
  const { jobs, canManage, resourceBusy, observe, updateJob, refreshAll } = useWorkspace();
  const [state, setState] = useState(INITIAL);
  const [editor, setEditor] = useState(null), [removeTarget, setRemoveTarget] = useState(null);
  const [discard, setDiscard] = useState(false), [acknowledge, setAcknowledge] = useState(false);
  const [formError, setFormError] = useState(null), [query, setQuery] = useState('');
  const client = useRef(null), active = useRef(false), live = useRef(null), editorRef = useRef(null);
  live.current = { ready, canManage, jobs, resourceBusy, observe, updateJob };
  editorRef.current = editor;
  const hint = useId();
  const current = () => active.current && live.current.canManage && sessionVersion() === generation && !sessionTransitionPending();
  const canWrite = (task) => current() && live.current.ready && live.current.jobs.status === 'ready'
    && !live.current.resourceBusy('website', scope.websiteId)
    && (!task || !live.current.resourceBusy('website_cron', task.id))
    && !(client.current?.getSnapshot().items ?? []).some((entry) => live.current.resourceBusy('website_cron', entry.id));
  useEffect(() => {
    active.current = true;
    const instance = createCronTaskClient({ scope, isCurrent: current, canWrite,
      request: (path, options) => {
        if (!live.current.ready) throw new CronTaskClientError('cron_context_unready');
        return panelRequest(path, options);
      },
      onJob: (job, first) => { if (first) { live.current.observe(job); live.current.jobs.refresh(); } else live.current.updateJob(job); },
    });
    client.current = instance;
    const unsubscribe = instance.subscribe(setState);
    setState(instance.getSnapshot());
    return () => { active.current = false; unsubscribe(); instance.dispose(); client.current = null; };
  }, [generation, scope.websiteId, scope.serverId, scope.applicationId, scope.unixUser]);
  useEffect(() => { if (ready) void client.current?.load(); }, [ready, generation]);
  const operation = state.operation;
  useEffect(() => {
    if (!ready || !operation?.job || !['queued', 'running', 'verifying'].includes(operation.phase)) return undefined;
    let count = 0;
    // Only GETs; stopping UI observation never cancels or resubmits host work.
    const timer = setInterval(() => {
      if (++count > 20) { clearInterval(timer); return; }
      void client.current?.refreshOperation();
    }, 3000);
    void client.current?.refreshOperation();
    return () => clearInterval(timer);
  }, [ready, operation?.job?.id, operation?.phase]);
  useEffect(() => { if (state.denied) { setEditor(null); setRemoveTarget(null); setAcknowledge(false); } }, [state.denied]);
  useUnsavedChanges(isDirty(editor));
  const externalBusy = (state.items ?? []).some((task) => resourceBusy('website_cron', task.id));
  const locked = !ready || !canManage || jobs.status !== 'ready' || !state.fresh || state.busy || state.denied || waiting(operation) || externalBusy;
  const edit = (field, value) => {
    if (state.busy || !ready) return;
    setFormError(null); setEditor((valueBefore) => valueBefore ? { ...valueBefore, review: false, draft: { ...valueBefore.draft, [field]: value } } : null);
  };
  function openEditor(task = null) {
    if (locked || (task && resourceBusy('website_cron', task.id))) return;
    const draft = task ? cronDraft(task) : { ...EMPTY_DRAFT };
    setFormError(null); setDiscard(false); setEditor({ task, draft, base: draft, review: false });
  }
  function closeEditor() {
    if (state.busy) return;
    if (isDirty(editorRef.current)) setDiscard(true);
    else { setEditor(null); setDiscard(false); }
  }
  function review(event) {
    event.preventDefault(); if (locked || !editor) return;
    try { const draft = cronDraft(editor.draft); setFormError(null); setEditor({ ...editor, draft, review: true }); }
    catch (error) { setFormError(cronErrorMessage(error)); }
  }
  async function save() {
    if (locked || !editor?.review) return;
    const accepted = await client.current?.save(editor.draft, editor.task);
    if (active.current && (accepted || client.current?.getSnapshot().operation?.phase === 'unknown')) { setEditor(null); setDiscard(false); }
  }
  async function remove() {
    if (locked || !removeTarget) return;
    const accepted = await client.current?.remove(removeTarget);
    if (active.current && (accepted || client.current?.getSnapshot().operation?.phase === 'unknown')) setRemoveTarget(null);
  }
  const visible = (state.items ?? []).filter((task) => `${task.name} ${task.schedule}`.toLocaleLowerCase('tr-TR').includes(query.toLocaleLowerCase('tr-TR')));
  return <>
    <Section title="Zamanlanmış Görevler" description={`${name} · Komutlar bu sitenin sistem kullanıcısıyla çalışır.`}
      actions={<div className="ws-actions"><Button icon="refresh" disabled={!ready || state.busy || state.loading || state.denied} onClick={() => void client.current?.load()}>Görevleri yenile</Button><Button variant="primary" icon="plus" disabled={locked} onClick={() => openEditor()}>Görev ekle</Button></div>}>
      <div className="ws-section-body">
        {!ready && <div className="ws-notice ws-notice-warn" role="status"><span>{ACCESS.unavailable}</span><Button onClick={refreshAll}>Site bilgilerini yenile</Button></div>}
        {jobs.status !== 'ready' && <div className="ws-notice ws-notice-warn" role="status"><span>Devam eden işlemler doğrulanamadığı için değişiklikler kapalı.</span><Button onClick={jobs.refresh}>İşlemleri yenile</Button></div>}
        <ErrorNotice error={state.error} />
        {state.cronServiceActive === false && <p role="status" className="ws-notice ws-notice-warn">Cron servisi çalışmıyor. Görev kaydı oluşturulsa bile servis açılana kadar zamanlaması çalışmaz.</p>}
        {externalBusy && !waiting(operation) && <p role="status" className="ws-muted">Bu sitenin bir görevinde işlem sürüyor. Tamamlandıktan sonra görevleri yenileyin.</p>}
        <p className="ws-muted" id={hint}>Zamanlama sunucunun saat dilimini kullanır. Kaydetme sonucu yalnız cron yapılandırmasını doğrular; komutun çalıştırılması veya çıktısı ayrıca kontrol edilmelidir.</p>
        <label>Görev ara<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Görev adı veya zamanlama" /></label>
        {state.loading && <p role="status" className="ws-muted">Görevler okunuyor…</p>}
        {!state.fresh && state.items && <p role="status" className="ws-muted">Son alınan liste gösteriliyor; yeni işlemden önce güncel durum doğrulanmalıdır.</p>}
      </div>
      {state.items && !state.denied && (visible.length ? <div className="ws-table-wrap"><table className="ws-table"><thead><tr><th>Görev</th><th>Zamanlama</th><th>Kayıt tercihi</th><th>Sunucu durumu</th><th>İşlemler</th></tr></thead><tbody>
        {visible.map((task) => <tr key={task.id}><td><strong>{task.name}</strong><details><summary>Komutu göster</summary><code className="ws-cron-command">{task.command}</code></details></td>
          <td><code>{task.schedule}</code></td><td>{task.enabled ? 'Etkin' : 'Devre dışı'}</td><td><HostState task={task} /></td>
          <td><div className="ws-actions"><Button disabled={locked || resourceBusy('website_cron', task.id)} onClick={() => openEditor(task)}>Düzenle</Button><Button variant="danger" disabled={locked || resourceBusy('website_cron', task.id)} onClick={() => setRemoveTarget(task)}>Sil…</Button></div></td></tr>)}
      </tbody></table></div> : <EmptyState icon="clock" title={query ? 'Eşleşen görev yok' : 'Henüz zamanlanmış görev yok'} detail={query ? 'Aramayı değiştirerek yeniden deneyin.' : 'Bu site için düzenli çalışacak bir komut ekleyin.'} />)}
    </Section>
    {operation && <Section title="Görev işlemi"><div className="ws-section-body"><p role="status">{operationMessage(operation)}</p><p><LinkButton to="/jobs" icon="jobs">İşlem geçmişi</LinkButton></p>
      {operation.job && <div className="ws-actions"><Button onClick={() => observe(operation.job)}>İşlem kaydını aç</Button><Button disabled={state.busy || !ready || ['succeeded', 'failed'].includes(operation.phase)} onClick={() => void client.current?.refreshOperation()}>Sonucu kontrol et</Button></div>}
      {operation.phase === 'unknown' && <Button disabled={state.busy || !state.fresh || state.reads <= operation.reads} onClick={() => setAcknowledge(true)}>Listeyi inceledim…</Button>}
      {operation.phase === 'failed' && <p className="ws-muted">Kısmi değişiklik olabilir. Yeni bir işlemden önce kayıtları inceleyip görev listesini yenileyin.</p>}
    </div></Section>}
    {editor && !state.denied && <Modal title={editor.task ? 'Zamanlanmış görevi düzenle' : 'Zamanlanmış görev ekle'} busy={state.busy} onClose={closeEditor} wide>
      <ErrorNotice error={formError ?? state.error} />
      {discard ? <><p>Kaydedilmemiş görev değişiklikleri bırakılacak. Devam edilsin mi?</p><div className="ws-modal-footer"><Button onClick={() => setDiscard(false)}>Düzenlemeye dön</Button><Button variant="danger" onClick={() => { setEditor(null); setDiscard(false); }}>Değişiklikleri bırak</Button></div></>
        : editor.review ? <><KeyValues items={[["Görev", editor.draft.name], ["Site", name], ["Zamanlama", editor.draft.schedule], ["Komut", <code className="ws-cron-command">{editor.draft.command}</code>], ["Tercih", editor.draft.enabled ? 'Etkin' : 'Devre dışı'], ["Sistem kullanıcısı", scope.unixUser]]} /><p className="ws-muted">Bu kayıt kaydedilecek ve aynı işlemle sunucuya uygulanacak. Sonuç aşağıdaki işlem kaydından takip edilir.</p><div className="ws-modal-footer"><Button disabled={state.busy} onClick={() => setEditor({ ...editor, review: false })}>Düzenlemeye dön</Button><Button variant="primary" disabled={locked} onClick={() => void save()}>Kaydet ve sunucuya uygula</Button></div></>
          : <form onSubmit={review}><fieldset disabled={locked} className="ws-cron-fields"><label>Görev adı<input autoFocus required maxLength={80} value={editor.draft.name} onChange={(event) => edit('name', event.target.value)} /></label>
            <label>Hazır zamanlama<select value={PRESETS.some(([value]) => value === editor.draft.schedule) ? editor.draft.schedule : ''} onChange={(event) => edit('schedule', event.target.value)}><option value="">Özel zamanlama</option>{PRESETS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Cron ifadesi<input required maxLength={320} value={editor.draft.schedule} onChange={(event) => edit('schedule', event.target.value)} aria-describedby={`${hint}-schedule`} spellCheck={false} /></label><p id={`${hint}-schedule`} className="ws-muted">Dakika · saat · ayın günü · ay · haftanın günü. Örnek: 0 3 * * * — her gün sunucu saatiyle 03:00.</p>
            <label>Çalıştırılacak komut<input required maxLength={4096} value={editor.draft.command} onChange={(event) => edit('command', event.target.value)} spellCheck={false} autoComplete="off" aria-describedby={hint} /></label>
            <label><input type="checkbox" checked={editor.draft.enabled} onChange={(event) => edit('enabled', event.target.checked)} /> Görev etkin olsun</label>
          </fieldset><div className="ws-modal-footer"><Button disabled={state.busy} onClick={closeEditor}>Vazgeç</Button><Button type="submit" variant="primary" disabled={locked}>Değişikliği incele</Button></div></form>}
    </Modal>}
    {removeTarget && !state.denied && <ConfirmDialog title="Zamanlanmış görevi sil" message={`${name} sitesindeki “${removeTarget.name}” görevinin zamanlaması ve kaydı kaldırılacak. Önceden başlatılmış bir komutun durduğu anlamına gelmez.`}
      confirmation={removeTarget.name} error={state.error} busy={state.busy} onCancel={() => setRemoveTarget(null)} onConfirm={() => void remove()} confirmLabel="Görevi sil" />}
    {acknowledge && <ConfirmDialog title="Bilinmeyen sonucu incelediniz mi?" message="Görev listesini ve işlem geçmişini incelemeden aynı görevi tekrar oluşturmak yinelenen komutlara neden olabilir. Devam etmek önceki işlemi başarılı saymaz veya yeniden göndermez."
      onCancel={() => setAcknowledge(false)} onConfirm={() => { if (client.current?.acknowledgeUnknown()) { setAcknowledge(false); setEditor(null); setRemoveTarget(null); } }} confirmLabel="İnceledim, yeni işlemlere dön" />}
  </>;
}
function HostState({ task }) {
  const label = { unknown: 'Doğrulanmadı', service_inactive: 'Cron servisi kapalı', missing_host_file: 'Sunucu dosyası eksik', drifted: 'Kayıtla uyuşmuyor', ready: task.enabled ? 'Yapılandırma hazır' : 'Devre dışı yapılandırma hazır' }[task.hostState];
  return <Badge state={task.hostState === 'ready' ? 'active' : task.hostState === 'unknown' ? 'unknown' : 'warning'}>{label}</Badge>;
}
function operationMessage(operation) {
  if (operation.phase === 'succeeded') return operation.kind === 'remove' ? 'Görev sunucudan ve kayıt listesinden kaldırıldı.' : 'Görev yapılandırması sunucuya uygulandı. Bu sonuç komutun başarıyla çalıştığı anlamına gelmez.';
  return { submitting: 'İstek gönderiliyor…', queued: 'Sunucu işlemi sırada.', running: 'Sunucu işlemi devam ediyor.', verifying: 'Sunucu sonucu ve güncel görev kaydı doğrulanıyor.', failed: 'İşlem tamamlanmadı. İşlem kaydını inceleyin.', unverified: 'Sonuç doğrulanamadı. Otomatik tekrar yapılmadı.', unknown: 'İsteğin sonucu bilinmiyor. Listeyi yenileyin ve işlem geçmişini inceleyin; istek yeniden gönderilmedi.' }[operation.phase];
}
