import { useEffect, useState } from 'react';

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

const summaryCards = [
  { label: 'Servers', value: '0', note: 'No enrolled servers yet' },
  { label: 'Applications', value: '0', note: 'Static, Node and Docker' },
  { label: 'Failed jobs', value: '0', note: 'Nothing requires attention' },
  { label: 'SSL warnings', value: '0', note: 'No certificates tracked yet' },
];

function App() {
  const [apiState, setApiState] = useState({ status: 'checking', version: null });
  const [agentState, setAgentState] = useState({ status: 'checking', hostname: null });

  useEffect(() => {
    const controller = new AbortController();

    async function checkControlPlane() {
      let apiOnline = false;

      try {
        const apiResponse = await fetch('/api/health', { signal: controller.signal });
        if (!apiResponse.ok) throw new Error(`HTTP ${apiResponse.status}`);

        const apiPayload = await apiResponse.json();
        apiOnline = true;
        setApiState({ status: apiPayload.status ?? 'ok', version: apiPayload.version ?? null });

        const agentResponse = await fetch('/api/dev/agent/inspect', { signal: controller.signal });
        if (agentResponse.status === 404) {
          setAgentState({ status: 'protected', hostname: null });
          return;
        }
        if (!agentResponse.ok) throw new Error(`Agent HTTP ${agentResponse.status}`);

        const agentPayload = await agentResponse.json();
        setAgentState({
          status: agentPayload.status === 'succeeded' ? 'running' : 'offline',
          hostname: agentPayload.result?.hostname ?? null,
        });
      } catch (error) {
        if (error.name !== 'AbortError') {
          if (!apiOnline) setApiState({ status: 'offline', version: null });
          setAgentState({ status: 'offline', hostname: null });
        }
      }
    }

    checkControlPlane();
    return () => controller.abort();
  }, []);

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
          {navigation.map((item, index) => (
            <button className={index === 0 ? 'nav-item active' : 'nav-item'} type="button" key={item}>
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
            <p className="eyebrow">Infrastructure overview</p>
            <h1>Dashboard</h1>
          </div>
          <div className="topbar-actions">
            {apiState.version && <span className="version-chip">API {apiState.version}</span>}
            <button className="secondary-button" type="button">Enroll server</button>
            <button className="primary-button" type="button">New application</button>
          </div>
        </header>

        <section className="summary-grid" aria-label="Infrastructure summary">
          {summaryCards.map((card) => (
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
              <button className="text-button" type="button">View all</button>
            </div>

            <div className="empty-state">
              <div className="empty-icon">01</div>
              <h3>No server enrolled</h3>
              <p>Milestone 1 will connect Ubuntu 24.04 servers through the read-only yun-agent enrollment flow.</p>
              <button className="secondary-button" type="button">Enrollment not enabled yet</button>
            </div>
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
              <StatusRow label="Job queue" status="pending" detail="Not initialized" />
            </div>
          </article>
        </section>
      </main>
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
