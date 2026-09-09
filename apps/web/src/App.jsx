import { useEffect, useMemo, useState } from 'react';
import ApplicationManager from './ApplicationManager.jsx';
import ApplicationList from './ApplicationList.jsx';
import CertificateList from './CertificateList.jsx';
import DomainManager from './DomainManager.jsx';
import DomainList from './DomainList.jsx';
import JobList from './JobList.jsx';
import ServerManager from './ServerManager.jsx';
import SystemUpdatePanel from './SystemUpdatePanel.jsx';
import { panelRequest } from './api.js';

const navigation = [
  'Dashboard',
  'Servers',
  'Applications',
  'Domains',
  'Databases',
  'Docker',
  'Mail',
  'Backups',
  'Jobs',
  'Audit Log',
  'Settings',
];

const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;
const COLLECTION_ROOT = import.meta.env.DEV ? '/api/dev' : '/api/panel';

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  const digits = index >= 3 ? 1 : 0;
  return `${amount.toFixed(digits)} ${units[index]}`;
}

function percentage(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : '—';
}

function formatLastSeen(value) {
  if (!value) return 'Waiting for first heartbeat';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown heartbeat time' : date.toLocaleString();
}

function certificateNeedsAttention(certificate) {
  if (certificate.state === 'error') return true;
  if (certificate.staging || certificate.state !== 'active' || !certificate.validTo) return false;
  const expiry = Date.parse(certificate.validTo);
  return Number.isFinite(expiry) && expiry - Date.now() <= EXPIRY_WARNING_MS;
}

function readCollectionResult(result, setItems, setAccess) {
  if (result.status !== 'fulfilled') {
    if (result.reason?.name !== 'AbortError') setAccess('error');
    return;
  }

  const response = result.value;
  if (response.status === 404) {
    setAccess('protected');
    setItems([]);
    return;
  }
  if (!response.ok) {
    setAccess('error');
    return;
  }

  response.json().then((payload) => {
    setItems(Array.isArray(payload.data) ? payload.data : []);
    setAccess('ready');
  }).catch(() => setAccess('error'));
}

function App() {
  const [apiState, setApiState] = useState({ status: 'checking', version: null });
  const [agentState, setAgentState] = useState({ status: 'checking', hostname: null });
  const [servers, setServers] = useState([]);
  const [serverAccess, setServerAccess] = useState('checking');
  const [applications, setApplications] = useState([]);
  const [applicationAccess, setApplicationAccess] = useState('checking');
  const [domains, setDomains] = useState([]);
  const [domainAccess, setDomainAccess] = useState('checking');
  const [jobs, setJobs] = useState([]);
  const [jobAccess, setJobAccess] = useState('checking');
  const [certificates, setCertificates] = useState([]);
  const [certificateAccess, setCertificateAccess] = useState('checking');
  const [activeView, setActiveView] = useState('Dashboard');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer;

    async function refreshControlPlane() {
      try {
        const apiResponse = await fetch('/api/health', { signal: controller.signal });
        if (!apiResponse.ok) throw new Error(`HTTP ${apiResponse.status}`);

        const apiPayload = await apiResponse.json();
        setApiState({ status: apiPayload.status ?? 'ok', version: apiPayload.version ?? null });

        const [serverResult, applicationResult, domainResult, jobResult, certificateResult] = await Promise.allSettled([
          fetch(`${COLLECTION_ROOT}/servers`, { signal: controller.signal }),
          fetch(`${COLLECTION_ROOT}/applications`, { signal: controller.signal }),
          fetch(`${COLLECTION_ROOT}/domains`, { signal: controller.signal }),
          fetch(`${COLLECTION_ROOT}/jobs`, { signal: controller.signal }),
          fetch(`${COLLECTION_ROOT}/certificates`, { signal: controller.signal }),
        ]);

        readCollectionResult(serverResult, setServers, setServerAccess);
        readCollectionResult(applicationResult, setApplications, setApplicationAccess);
        readCollectionResult(domainResult, setDomains, setDomainAccess);
        readCollectionResult(jobResult, setJobs, setJobAccess);
        readCollectionResult(certificateResult, setCertificates, setCertificateAccess);
      } catch (error) {
        if (error.name !== 'AbortError') {
          setApiState({ status: 'offline', version: null });
          setAgentState({ status: 'offline', hostname: null });
          setServerAccess('error');
          setApplicationAccess('error');
          setDomainAccess('error');
          setJobAccess('error');
          setCertificateAccess('error');
        }
      }
    }

    refreshControlPlane();
    timer = setInterval(refreshControlPlane, 15_000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [refreshKey]);

  function refreshNow() {
    setRefreshKey((value) => value + 1);
  }

  useEffect(() => {
    if (serverAccess !== 'ready') return;
    const online = servers.find((server) => server.connectivity === 'online');
    setAgentState(online
      ? { status: 'running', hostname: online.hostname }
      : { status: servers.length ? 'offline' : 'checking', hostname: null });
  }, [serverAccess, servers]);

  const operationalSummary = useMemo(() => {
    const onlineServers = servers.filter((server) => server.connectivity === 'online').length;
    const offlineServers = servers.filter((server) => server.connectivity === 'offline').length;
    const activeApplications = applications.filter((application) => application.state === 'active').length;
    const activeDomains = domains.filter((domain) => domain.state === 'active').length;
    const failedJobs = jobs.filter((job) => job.status === 'failed').length;
    const runningJobs = jobs.filter((job) => job.status === 'running').length;
    const queuedJobs = jobs.filter((job) => job.status === 'queued').length;
    const sslWarnings = certificates.filter(certificateNeedsAttention).length;

    return {
      failedJobs,
      runningJobs,
      queuedJobs,
      sslWarnings,
      cards: [
        {
          label: 'Servers',
          value: String(servers.length),
          note: servers.length ? `${onlineServers} online · ${offlineServers} offline` : 'No enrolled servers yet',
        },
        {
          label: 'Applications',
          value: String(applications.length),
          note: applications.length ? `${activeApplications} active · ${applications.length - activeApplications} pending` : 'No managed applications yet',
        },
        {
          label: 'Domains',
          value: String(domains.length),
          note: domains.length ? `${activeDomains} active · ${domains.length - activeDomains} pending` : 'No desired state yet',
        },
        {
          label: 'Failed jobs',
          value: String(failedJobs),
          note: runningJobs || queuedJobs ? `${runningJobs} running · ${queuedJobs} queued` : 'No active jobs',
        },
        {
          label: 'SSL warnings',
          value: String(sslWarnings),
          note: certificates.length ? `${certificates.length} certificate records` : 'No certificates tracked yet',
        },
      ],
    };
  }, [applications, certificates, domains, jobs, servers]);

  const jobRuntimeStatus = operationalSummary.failedJobs > 0
    ? 'failed'
    : operationalSummary.runningJobs > 0
      ? 'running'
      : operationalSummary.queuedJobs > 0
        ? 'pending'
        : jobAccess === 'ready'
          ? 'running'
          : jobAccess;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">Y</div>
          <div>
            <strong>YunPanel</strong>
            <span>Server control plane</span>
          </div>
        </div>

        <nav className="navigation" aria-label="Primary navigation">
          {navigation.map((item) => (
            <button className={activeView === item ? 'nav-item active' : 'nav-item'} type="button" key={item} onClick={() => setActiveView(item)}>
              <span className="nav-dot" />
              {item}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className={`status-dot ${apiState.status}`} />
          <div>
            <strong>Control plane</strong>
            <span>{apiState.status === 'checking' ? 'Checking API…' : `API ${apiState.status}`}</span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Infrastructure control plane</p>
            <h1>{activeView}</h1>
          </div>
          <div className="topbar-actions">
            {apiState.version && <span className="version-chip">API {apiState.version}</span>}
            <button className="secondary-button" type="button" onClick={() => setActiveView('Servers')}>Enroll server</button>
            <button className="primary-button" type="button" onClick={() => setActiveView('Applications')}>New application</button>
          </div>
        </header>

        {activeView === 'Dashboard' && <><section className="summary-grid" aria-label="Infrastructure summary">
          {operationalSummary.cards.map((card) => (
            <article className="summary-card" key={card.label}>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <small>{card.note}</small>
            </article>
          ))}
        </section>

        <section className="content-grid">
          <article className="panel wide-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Managed infrastructure</p>
                <h2>Servers</h2>
              </div>
              <span className="panel-meta">{serverAccess === 'ready' ? '15s refresh' : serverAccess}</span>
            </div>

            {servers.length > 0 ? (
              <div className="server-list">
                {servers.map((server) => <ServerCard server={server} key={server.id} />)}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">01</div>
                <h3>{serverAccess === 'protected' ? 'Server list protected' : 'No server enrolled'}</h3>
                <p>
                  {serverAccess === 'protected'
                    ? 'Production server inventory will be shown after user authentication and RBAC are enabled.'
                    : 'Create a one-time enrollment token, start yun-agent on Ubuntu 24.04 and its first heartbeat will appear here.'}
                </p>
                <button className="secondary-button" type="button" onClick={() => setActiveView('Servers')}>Enrollment via control API</button>
              </div>
            )}
          </article>

          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Runtime</p>
                <h2>System status</h2>
              </div>
            </div>

            <div className="status-list">
              <StatusRow label="Web interface" status="running" detail="React" />
              <StatusRow label="Control API" status={apiState.status === 'ok' ? 'running' : apiState.status} detail="Node.js" />
              <StatusRow
                label="yun-agent"
                status={agentState.status}
                detail={agentState.hostname ? `Local agent · ${agentState.hostname}` : 'Development connection'}
              />
              <StatusRow
                label="Job queue"
                status={jobRuntimeStatus}
                detail={`${operationalSummary.runningJobs} running · ${operationalSummary.queuedJobs} queued`}
              />
            </div>
          </article>
        </section>

        <section className="panel domain-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Deployments</p>
              <h2>Applications</h2>
            </div>
            <span className="panel-meta">{applicationAccess}</span>
          </div>
          <ApplicationList applications={applications} access={applicationAccess} />
        </section>

        <section className="panel domain-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Desired state</p>
              <h2>Domains</h2>
            </div>
            <span className="panel-meta">{domainAccess}</span>
          </div>
          <DomainList domains={domains} access={domainAccess} />
        </section>

        <section className="panel domain-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ACME / TLS</p>
              <h2>Certificates</h2>
            </div>
            <span className="panel-meta">{certificateAccess}</span>
          </div>
          <CertificateList certificates={certificates} access={certificateAccess} />
        </section>

        <section className="panel domain-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Operations</p>
              <h2>Recent jobs</h2>
            </div>
            <span className="panel-meta">{jobAccess}</span>
          </div>
          <JobList jobs={jobs} access={jobAccess} />
        </section></>}

        {activeView === 'Servers' && (
          <ServerManager
            servers={servers}
            access={serverAccess}
            renderServer={(server) => <ServerCard server={server} key={server.id} />}
          />
        )}

        {activeView === 'Applications' && (
          <ApplicationManager
            applications={applications}
            access={applicationAccess}
            servers={servers}
            onChanged={refreshNow}
          />
        )}

        {activeView === 'Domains' && (
          <DomainManager
            domains={domains}
            domainAccess={domainAccess}
            certificates={certificates}
            certificateAccess={certificateAccess}
            servers={servers}
            onChanged={refreshNow}
          />
        )}

        {activeView === 'Jobs' && <JobManager jobs={jobs} access={jobAccess} onChanged={refreshNow} />}

        {activeView === 'Settings' && !import.meta.env.DEV && <SystemUpdatePanel server={servers[0] ?? null} />}

        {['Databases', 'Docker', 'Mail', 'Backups', 'Audit Log'].includes(activeView) && (
          <UnavailableView name={activeView} server={servers[0] ?? null} />
        )}
      </main>
    </div>
  );
}

function JobManager({ jobs, access, onChanged }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  async function cancel(job) {
    setBusyId(job.id);
    setError(null);
    try {
      await panelRequest(`/jobs/${job.id}/cancel`, { method: 'POST', body: {} });
      onChanged();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel domain-panel">
      <div className="panel-heading"><div><p className="eyebrow">Operations</p><h2>All jobs</h2></div><span className="panel-meta">{access}</span></div>
      <JobList jobs={jobs} access={access} busyId={busyId} onCancel={cancel} limit={100} />
      {error && <div className="operation-error">{error}</div>}
    </section>
  );
}

function UnavailableView({ name, server }) {
  const docker = server?.inventory?.docker;
  const dockerDetail = name === 'Docker' && docker
    ? `Docker installed: ${docker.installed ? 'yes' : 'no'} · reachable: ${docker.reachable ? 'yes' : 'no'} · containers: ${docker.containers?.length ?? 0}`
    : null;
  return (
    <section className="panel domain-panel">
      <div className="panel-heading"><div><p className="eyebrow">Capability status</p><h2>{name}</h2></div><span className="panel-meta">not implemented</span></div>
      <div className="domain-empty">
        <strong>{name} operations are not available in the current backend.</strong>
        <span>{dockerDetail ?? 'This menu is connected and intentionally read-only until its allowlisted agent operations and persistence model are implemented.'}</span>
      </div>
    </section>
  );
}

function ServerCard({ server }) {
  const inventory = server.inventory ?? {};
  const memory = inventory.memory ?? {};
  const filesystem = inventory.filesystem ?? {};
  const memoryPercent = percentage(memory.usedBytes, memory.totalBytes);
  const diskPercent = percentage(filesystem.usedBytes, filesystem.totalBytes);
  const capabilities = Object.entries(inventory.capabilities ?? {})
    .filter(([, value]) => value?.installed)
    .map(([name]) => name)
    .slice(0, 6);

  return (
    <article className="server-card">
      <div className="server-card-heading">
        <div className="server-title">
          <span className={`status-dot ${server.connectivity}`} />
          <div>
            <strong>{server.name}</strong>
            <span>{server.hostname}</span>
          </div>
        </div>
        <span className={`connectivity-badge ${server.connectivity}`}>{server.connectivity}</span>
      </div>

      <div className="server-facts">
        <Metric label="CPU" value={formatPercent(inventory.cpu?.usagePercent)} detail={`${inventory.cpu?.count ?? '—'} cores`} />
        <Metric label="Memory" value={formatPercent(memoryPercent)} detail={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`} />
        <Metric label="Disk" value={formatPercent(diskPercent)} detail={`${formatBytes(filesystem.usedBytes)} / ${formatBytes(filesystem.totalBytes)}`} />
      </div>

      <div className="server-meta-row">
        <span>{inventory.operatingSystem?.prettyName ?? 'Waiting for inventory'}</span>
        <span>{inventory.runtimes?.node?.version ? `Node ${inventory.runtimes.node.version}` : 'Node unknown'}</span>
        <span>Agent {server.agentVersion ?? 'pending'}</span>
      </div>

      {capabilities.length > 0 && (
        <div className="capability-list">
          {capabilities.map((capability) => <span key={capability}>{capability}</span>)}
        </div>
      )}

      <div className="server-last-seen">Last heartbeat · {formatLastSeen(server.lastSeenAt)}</div>
    </article>
  );
}

function Metric({ label, value, detail }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function StatusRow({ label, status, detail }) {
  return (
    <div className="status-row">
      <span className={`status-dot ${status}`} />
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <span className="status-label">{status}</span>
    </div>
  );
}

export default App;
