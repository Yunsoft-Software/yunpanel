import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { panelRequest } from '../api.js';
import { useWorkspace } from './WorkspaceContext.jsx';
import { useUnsavedChanges } from './UnsavedChanges.jsx';
import { Badge, Button, CollectionNotice, ConfirmDialog, EmptyState, ErrorNotice, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';
import { applicationCreatePayload } from './application-form.js';
import EnvironmentPanel from './EnvironmentPanel.jsx';

export default function ApplicationsPage({ create = false }) {
  return create ? <NewApplication /> : <ApplicationInventory />;
}
function ApplicationInventory() {
  const { applications, servers, jobs, runJob, resourceBusy } = useWorkspace();
  const [params, setParams] = useSearchParams(); const [rollback, setRollback] = useState(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null); const pending = useRef(false);
  const query = params.get('q') ?? '';
  const items = applications.items.filter((app) => app.name.toLowerCase().includes(query.toLowerCase()));
  const selected = applications.items.find((app) => app.id === params.get('environment'));
  function filter(key, value) { setParams((current) => { const next = new URLSearchParams(current); value ? next.set(key, value) : next.delete(key); return next; }, { replace: key === 'q' }); }
  async function run(app, action, releaseId) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await runJob(`/applications/${encodeURIComponent(app.id)}/${action === 'status' ? 'status/refresh' : action}`, action === 'rollback' ? { releaseId } : {}); setRollback(null); }
    catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  }
  return <><PageHeading title="Uygulamalar" description="Bu panel sunucusundaki Node.js ve statik uygulama kayıtları; site bağlantıları Web Siteleri bölümündedir." actions={<LinkButton to="/applications/new" variant="primary" icon="plus">Uygulama ekle</LinkButton>} /><ErrorNotice error={error} /><Section title="Uygulama envanteri"><div className="ws-filters"><label className="ws-filter-search">Uygulama ara<input type="search" value={query} onChange={(event) => filter('q', event.target.value)} /></label></div><CollectionNotice resource={applications} label="Uygulamalar" />
    {items.length ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Uygulama</th><th>Runtime</th><th>Durum</th><th>Son deploy</th><th>İşlemler</th></tr></thead><tbody>{items.map((app) => {
      const locked = busy || applications.status !== 'ready' || jobs.status !== 'ready' || resourceBusy('application', app.id) || Boolean(app.activeDeploymentId);
      return <tr key={app.id}><td><strong>{app.name}</strong><small>{app.branch} · {servers.items.find((item) => item.id === app.serverId)?.hostname ?? 'Sunucu bilgisi yok'}</small></td><td>{app.type === 'node' ? `Node.js ${app.runtime?.nodeMajor ?? ''}` : 'Statik'}<small>{app.type === 'node' ? `Port ${app.runtime?.port ?? '—'}` : app.build?.outputDir}</small></td><td><Badge state={app.state} /></td><td>{formatDate(app.lastDeployedAt)}</td><td><div className="ws-actions"><Button disabled={locked} onClick={() => run(app, 'deploy')}>Deploy</Button>{app.type === 'node' && <><Button disabled={locked || !app.currentReleaseId} onClick={() => run(app, 'restart')}>Restart</Button><Button disabled={locked || !app.currentReleaseId} onClick={() => run(app, 'status')}>Durum</Button><Button onClick={() => filter('environment', app.id)}>Env</Button></>}<Button disabled={locked || !app.previousReleaseId} onClick={() => { setError(null); setRollback({ app, releaseId: app.previousReleaseId }); }}>Rollback</Button></div></td></tr>;
    })}</tbody></table></div> : applications.status === 'ready' && <EmptyState title="Uygulama bulunamadı" detail="Yeni uygulama oluşturun veya arama terimini değiştirin." icon="code" />}
    </Section>{selected && <><div className="ws-breadcrumb"><span>{selected.name} ortam değişkenleri</span><Link to="/applications">Ortam editörünü kapat</Link></div><EnvironmentPanel key={selected.id} application={selected} /></>}
    {rollback && <ConfirmDialog title="Önceki release’e dön" message={`${rollback.app.name} uygulaması ${rollback.releaseId} sürümüne dönecek.`} confirmation={rollback.app.name} busy={busy} error={error} onCancel={() => setRollback(null)} onConfirm={() => run(rollback.app, 'rollback', rollback.releaseId)} confirmLabel="Rollback başlat" />}
  </>;
}
function NewApplication() {
  const { servers, applications, refreshAll } = useWorkspace();
  const [form, setForm] = useState({ type: 'node', name: '', repositoryUrl: '', branch: 'main', port: '', entryFile: 'server.js', healthPath: '/health', outputDir: 'dist' });
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [created, setCreated] = useState(null); const [error, setError] = useState(null);
  const request = useRef(null); const pending = useRef(false);
  useEffect(() => { const controller = new AbortController(); request.current = controller; return () => controller.abort(); }, []);
  useUnsavedChanges(dirty && !created);
  function update(key, value) { setForm((current) => ({ ...current, [key]: value })); setDirty(true); }
  async function submit(event) {
    event.preventDefault(); if (pending.current || servers.status !== 'ready') return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const body = applicationCreatePayload(form, servers.items);
      if (body.type === 'node' && applications.items.some((item) => item.serverId === body.serverId && item.runtime?.port === body.runtime.port)) throw new Error('Bu sunucuda port başka bir uygulama kaydında kullanılıyor.');
      const app = await panelRequest('/applications', { method: 'POST', body, signal: request.current.signal }); setCreated(app); setDirty(false); refreshAll();
    } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    finally { pending.current = false; if (!request.current.signal.aborted) setBusy(false); }
  }
  return <><nav className="ws-breadcrumb"><Link to="/applications">Uygulamalar</Link><span>/ Yeni uygulama</span></nav><PageHeading title="Uygulama ekle" description="Git kaynağını ve çalışma ayarlarını belirleyin. Oluşturma işlemi otomatik deploy yapmaz." />{created ? <Section title="Uygulama kaydedildi"><EmptyState icon="check" title={created.name} detail="Uygulamalar ekranından ilk deploy’u başlatın. Ardından alan adınızı Web Siteleri bölümünden bağlayın." action={<div className="ws-actions"><LinkButton to="/applications" variant="primary">Uygulamalara git</LinkButton><LinkButton to="/websites/new">Alan adı bağla</LinkButton></div>} /></Section> : <Section title="Git ve çalışma ayarları"><CollectionNotice resource={servers} label="Yerel sunucu" /><form className="ws-form" onSubmit={submit}><ErrorNotice error={error} /><fieldset disabled={busy || servers.status !== 'ready'}><div className="ws-form-grid"><label>Uygulama adı<input value={form.name} required maxLength={80} onChange={(event) => update('name', event.target.value)} /></label><label>Tür<select value={form.type} onChange={(event) => update('type', event.target.value)}><option value="node">Node.js 24</option><option value="static">Statik build</option></select></label><label>GitHub repository<input type="url" required placeholder="https://github.com/organization/repository" value={form.repositoryUrl} onChange={(event) => update('repositoryUrl', event.target.value)} /></label><label>Branch<input value={form.branch} required onChange={(event) => update('branch', event.target.value)} /></label>{form.type === 'node' ? <><label>Uygulama portu<input type="number" min={1024} max={65535} required value={form.port} onChange={(event) => update('port', event.target.value)} /><span className="ws-field-hint">Otomatik port tahsisi henüz yok. Kullanılmayan yerel portu belirtin.</span></label><label>Başlangıç dosyası<input value={form.entryFile} required onChange={(event) => update('entryFile', event.target.value)} /></label><label>Sağlık kontrolü yolu<input value={form.healthPath} required onChange={(event) => update('healthPath', event.target.value)} /></label></> : <label>Build çıktı klasörü<input value={form.outputDir} required onChange={(event) => update('outputDir', event.target.value)} /><span className="ws-field-hint">npm ci ve npm run build kullanılır; index.html sağlık dosyasıdır.</span></label>}</div><footer className="ws-form-footer" style={{ marginTop: 24 }}><LinkButton to="/applications">Vazgeç</LinkButton><Button type="submit" variant="primary" disabled={busy || servers.items.length !== 1}>{busy ? 'Kaydediliyor…' : 'Uygulamayı oluştur'}</Button></footer></fieldset></form></Section>}</>;
}
