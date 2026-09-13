import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  getDockerDiagnosis,
  getDockerHistory,
  getDockerLogs,
  getDockerProject,
  getDockerRuntime,
  listDockerProjects,
} from './docker-compose-client.js';
import DockerConfigPanel from './DockerConfigPanel.jsx';
import DockerLifecyclePanel from './DockerLifecyclePanel.jsx';
import DockerProjectCreateDialog from './DockerProjectCreateDialog.jsx';
import { Badge, Button, EmptyState, KeyValues, LinkButton, PageHeading, Section } from './PanelKit.jsx';
import { formatDate } from './site-model.js';

function useAsyncResource(loader, dependencies = [], { enabled = true } = {}) {
  const [state, setState] = useState({ status: enabled ? 'loading' : 'idle', data: null, error: null });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) { setState({ status: 'idle', data: null, error: null }); return undefined; }
    const controller = new AbortController();
    setState((current) => ({ ...current, status: current.data ? 'stale' : 'loading', error: null }));
    Promise.resolve(loader(controller.signal))
      .then((data) => { if (!controller.signal.aborted) setState({ status: 'ready', data, error: null }); })
      .catch((error) => { if (!controller.signal.aborted) setState((current) => ({ status: current.data ? 'stale' : 'error', data: current.data, error })); });
    return () => controller.abort();
    // Callers pass stable identity primitives in dependencies; loader is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, enabled, revision]);
  return { ...state, refresh };
}

function Loading({ label }) {
  return <div className="ws-loading" role="status"><span className="ws-spinner" />{label} yükleniyor…</div>;
}

function LoadNotice({ resource, label }) {
  if (resource.status === 'loading') return <Loading label={label} />;
  if (!resource.error) return null;
  return <div className="ws-notice ws-notice-warn" role="alert"><div><strong>{label}</strong><p>{resource.error.message ?? 'Veri alınamadı.'}</p></div><Button icon="refresh" onClick={resource.refresh}>Yeniden dene</Button></div>;
}

function publishedPorts(service) {
  return Array.isArray(service?.publishedPorts) ? service.publishedPorts : [];
}

function portLabel(port) {
  const host = port.hostIp ?? '*';
  return `${host}:${port.publishedPort} → ${port.targetPort}/${port.protocol}`;
}

function runtimeBadge(status) {
  if (status === 'running') return 'active';
  if (['degraded', 'restarting'].includes(status)) return 'warning';
  if (['absent', 'stopped'].includes(status)) return 'offline';
  if (status === 'starting') return 'running';
  return 'unknown';
}

function DockerProjectList() {
  const projects = useAsyncResource(() => listDockerProjects(), [], { enabled: true });
  const [creating, setCreating] = useState(false);
  const items = Array.isArray(projects.data) ? projects.data : [];
  return <><PageHeading title="Docker" description="Bu sunucuda YunPanel tarafından yönetilen Docker Compose projeleri." actions={<><Button icon="refresh" onClick={projects.refresh}>Yenile</Button><Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Compose projesi ekle</Button></>} /><LoadNotice resource={projects} label="Docker projeleri" /><Section title="Compose projeleri" description="Compose desired state ve runtime birbirinden ayrı izlenir; container veya port tahmini yapılmaz.">
    {items.length > 0 ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Proje</th><th>Servis</th><th>Network</th><th>Volume</th><th>Revizyon</th><th /></tr></thead><tbody>{items.map((project) => <tr key={project.id}><td><strong>{project.projectName}</strong><small>{project.id}</small></td><td>{project.services?.length ?? 0}</td><td>{project.networks?.length ?? 0}</td><td>{project.volumes?.length ?? 0}</td><td>{project.revision}</td><td><LinkButton to={`/docker/${encodeURIComponent(project.id)}`}>Yönet</LinkButton></td></tr>)}</tbody></table></div> : projects.status === 'ready' && <EmptyState icon="box" title="Managed Compose projesi yok" detail="İlk Compose projesini ekleyin. Mevcut external Docker workload kayıtları Managed Compose projesi olarak gösterilmez." action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Compose projesi ekle</Button>} />}
  </Section>{creating && <DockerProjectCreateDialog onClose={() => setCreating(false)} />}</>;
}

function DiagnosisPanel({ project }) {
  const options = useMemo(() => (project.services ?? []).flatMap((service) => publishedPorts(service)
    .filter((port) => port.protocol === 'tcp')
    .map((port) => ({ serviceName: service.name, targetPort: port.targetPort, key: `${service.name}:${port.targetPort}` }))), [project]);
  const [selected, setSelected] = useState(options[0]?.key ?? '');
  useEffect(() => { if (!options.some((item) => item.key === selected)) setSelected(options[0]?.key ?? ''); }, [options, selected]);
  const binding = options.find((item) => item.key === selected) ?? null;
  const diagnosis = useAsyncResource(
    () => binding ? getDockerDiagnosis(project.id, { service: binding.serviceName, targetPort: binding.targetPort }) : null,
    [project.id, selected],
    { enabled: Boolean(binding) },
  );
  if (options.length === 0) return <EmptyState icon="alert" title="HTTP target seçilemiyor" detail="Projede TCP published port özeti yok. Website/Nginx binding için açık bir service target port publish edilmelidir." />;
  const result = diagnosis.data;
  return <div className="ws-section-body"><div className="ws-filters"><label>Website target<select value={selected} onChange={(event) => setSelected(event.target.value)}>{options.map((item) => <option key={item.key} value={item.key}>{item.serviceName} · {item.targetPort}/tcp</option>)}</select></label><Button icon="refresh" onClick={diagnosis.refresh}>Kontrol et</Button></div><LoadNotice resource={diagnosis} label="Target diagnosis" />{result && <><KeyValues items={[
    ['Durum', <Badge key="status" state={result.status === 'ready' ? 'active' : result.status === 'attention' ? 'warning' : 'error'}>{result.status}</Badge>],
    ['Nginx target', result.target?.ready ? `${result.target.host}:${result.target.port}` : 'Hazır değil'],
    ['Runtime', result.runtime?.status ?? 'unknown'],
    ['Container', result.runtime?.containerCount ?? 0],
  ]} />{result.issues?.length > 0 && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Sorun</th><th>Aksiyon</th><th>Açıklama</th></tr></thead><tbody>{result.issues.map((item) => <tr key={`${item.code}:${item.action}`}><td><Badge state={item.severity === 'error' ? 'error' : 'warning'}>{item.code}</Badge></td><td><code>{item.action}</code></td><td>{item.message}</td></tr>)}</tbody></table></div>}</>}</div>;
}

function RuntimePanel({ projectId }) {
  const runtime = useAsyncResource(() => getDockerRuntime(projectId), [projectId]);
  const result = runtime.data;
  return <Section title="Runtime" actions={<Button icon="refresh" onClick={runtime.refresh}>Yenile</Button>}><LoadNotice resource={runtime} label="Runtime" />{result && <div className="ws-section-body"><KeyValues items={[
    ['Durum', <Badge key="runtime" state={runtimeBadge(result.status)}>{result.status}</Badge>],
    ['Container', result.containerCount],
    ['Proje', result.projectName],
  ]} />{result.containers?.length > 0 && <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Container</th><th>Durum</th><th>Health</th><th>Exit</th></tr></thead><tbody>{result.containers.map((container) => <tr key={container.id}><td><strong>{container.name ?? container.id.slice(0, 12)}</strong><small>{container.image ?? '—'}</small></td><td><Badge state={container.runtime?.running ? 'active' : container.runtime?.restarting ? 'warning' : 'offline'}>{container.runtime?.status ?? 'unknown'}</Badge></td><td>{container.runtime?.health?.status ?? '—'}</td><td>{container.runtime?.exitCode ?? '—'}</td></tr>)}</tbody></table></div>}</div>}</Section>;
}

function LogsPanel({ project }) {
  const serviceNames = project.services?.map((service) => service.name) ?? [];
  const [service, setService] = useState(serviceNames[0] ?? '');
  const [tail, setTail] = useState(100);
  const logs = useAsyncResource(() => getDockerLogs(project.id, { service: service || null, tail }), [project.id, service, tail]);
  const result = logs.data;
  return <Section title="Container logları" actions={<Button icon="refresh" onClick={logs.refresh}>Yenile</Button>}><div className="ws-section-body"><div className="ws-filters"><label>Servis<select value={service} onChange={(event) => setService(event.target.value)}>{serviceNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label>Satır<select value={tail} onChange={(event) => setTail(Number(event.target.value))}><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option><option value={500}>500</option></select></label></div><LoadNotice resource={logs} label="Container logları" />{result?.containers?.map((container) => <div key={container.id} className="ws-log-block"><strong>{container.name ?? container.id}</strong>{container.unavailable ? <p className="ws-muted">Log okunamadı.</p> : <pre>{container.lines?.join('\n') || 'Log satırı yok.'}</pre>}</div>)}</div></Section>;
}

function HistoryPanel({ projectId }) {
  const history = useAsyncResource(() => getDockerHistory(projectId), [projectId]);
  const items = Array.isArray(history.data) ? history.data : [];
  return <Section title="Deploy / lifecycle geçmişi" actions={<Button icon="refresh" onClick={history.refresh}>Yenile</Button>}><LoadNotice resource={history} label="Docker geçmişi" />{items.length > 0 ? <div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>İşlem</th><th>Durum</th><th>Başlangıç</th><th>İş</th></tr></thead><tbody>{items.slice(0, 30).map((job) => <tr key={job.id}><td>{job.operation ?? job.type}</td><td><Badge state={job.status}>{job.status}</Badge></td><td>{formatDate(job.createdAt)}</td><td><code>{job.id}</code></td></tr>)}</tbody></table></div> : history.status === 'ready' && <EmptyState icon="clock" title="Henüz lifecycle işi yok" detail="Build, pull, start, stop veya restart işlemleri burada görünecek." />}</Section>;
}

function DockerProjectDetail({ projectId }) {
  const detail = useAsyncResource(() => getDockerProject(projectId), [projectId]);
  const data = detail.data;
  const project = data?.project ?? null;
  return <><nav className="ws-breadcrumb"><Link to="/docker">Docker</Link><span>/ {project?.projectName ?? projectId}</span></nav><PageHeading title={project?.projectName ?? 'Docker projesi'} description="Compose desired state, published target, runtime ve işlem geçmişi." actions={<Button icon="refresh" onClick={detail.refresh}>Yenile</Button>} /><LoadNotice resource={detail} label="Docker proje detayı" />{project && <><Section title="Desired state"><div className="ws-section-body"><KeyValues items={[
    ['Revizyon', project.revision], ['Compose SHA-256', project.composeSha256], ['Servis', project.services?.length ?? 0], ['Network', project.networks?.length ?? 0], ['Volume', project.volumes?.length ?? 0], ['Env revizyonu', data.environment?.revision ?? 0], ['Registry credential', data.credentials?.length ?? 0],
  ]} /><div className="ws-table-scroll"><table className="ws-table"><thead><tr><th>Servis</th><th>Kaynak</th><th>Published ports</th></tr></thead><tbody>{project.services?.map((service) => <tr key={service.name}><td><strong>{service.name}</strong></td><td>{service.imageConfigured ? 'image' : service.buildConfigured ? 'build' : '—'}</td><td>{publishedPorts(service).length ? publishedPorts(service).map((port) => <small key={portLabel(port)}>{portLabel(port)}</small>) : '—'}</td></tr>)}</tbody></table></div></div></Section><DockerConfigPanel data={data} onChanged={detail.refresh} /><DockerLifecyclePanel project={project} onChanged={detail.refresh} /><Section title="Website / Nginx diagnosis" description="Transient host port kalıcı Website veya Domain kaydına yazılmadan güncel Compose state’inden çözülür."><DiagnosisPanel project={project} /></Section><RuntimePanel projectId={project.id} /><LogsPanel project={project} /><HistoryPanel projectId={project.id} /></>}</>;
}

export default function DockerProjectsPage() {
  const { dockerProjectId } = useParams();
  return dockerProjectId ? <DockerProjectDetail projectId={dockerProjectId} /> : <DockerProjectList />;
}

export const dockerProjectsPageInternals = Object.freeze({ publishedPorts, portLabel, runtimeBadge });
