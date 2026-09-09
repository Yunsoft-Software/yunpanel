import { useState } from 'react';
import ApplicationList from './ApplicationList.jsx';
import EnvironmentEditor from './EnvironmentEditor.jsx';
import { panelRequest, waitForJob } from './api.js';

const initialForm = {
  type: 'static',
  name: '',
  repositoryUrl: '',
  branch: 'main',
  port: '4301',
  entryFile: 'server.js',
  healthPath: '/health',
};

export default function ApplicationManager({ applications, access, servers, onChanged }) {
  const [form, setForm] = useState(initialForm);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [environmentApplication, setEnvironmentApplication] = useState(null);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function createApplication(event) {
    event.preventDefault();
    if (!servers[0]) return;
    setBusyId('create');
    setError(null);
    setMessage(null);
    try {
      const body = {
        serverId: servers[0].id,
        type: form.type,
        name: form.name,
        repositoryUrl: form.repositoryUrl,
        branch: form.branch,
        retention: 5,
      };
      if (form.type === 'static') {
        body.build = { mode: 'npm', installMode: 'ci', buildScript: 'build', outputDir: 'dist', healthFile: 'index.html' };
      } else {
        body.runtime = {
          nodeMajor: 24,
          installMode: 'ci',
          buildScript: null,
          startMode: 'node',
          entryFile: form.entryFile,
          port: Number(form.port),
          healthPath: form.healthPath,
          healthTimeoutSeconds: 30,
          restartPolicy: 'on-failure',
        };
      }
      const application = await panelRequest('/applications', { method: 'POST', body });
      setForm(initialForm);
      setMessage(`${application.name} created. Use Deploy to publish its first release.`);
      onChanged();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusyId(null);
    }
  }

  async function runAction(application, action) {
    setBusyId(application.id);
    setError(null);
    setMessage(null);
    try {
      const path = action === 'status'
        ? `/applications/${application.id}/status/refresh`
        : `/applications/${application.id}/${action}`;
      const payload = action === 'rollback' ? { releaseId: application.previousReleaseId } : {};
      const response = await panelRequest(path, { method: 'POST', body: payload });
      const job = response.job ?? response;
      const completed = await waitForJob(job.id);
      if (action === 'status') {
        setMessage(`${application.name}: ${completed.result.activeState}/${completed.result.subState}, PID ${completed.result.mainPid}, health ${completed.result.healthy ? 'ok' : 'failed'}.`);
      } else {
        setMessage(`${application.name}: ${action} succeeded.`);
      }
      onChanged();
    } catch (requestError) {
      setError(`${application.name}: ${requestError.message}`);
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <section className="panel domain-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">Deployments</p><h2>Applications</h2></div>
          <span className="panel-meta">{access}</span>
        </div>
        <ApplicationList applications={applications} access={access} busyId={busyId} onAction={runAction} onEnvironment={setEnvironmentApplication} />
        {message && <div className="operation-result"><span>{message}</span></div>}
        {error && <div className="operation-error">{error}</div>}
      </section>
      {environmentApplication && <EnvironmentEditor application={environmentApplication} onClose={() => setEnvironmentApplication(null)} />}
      <section className="panel domain-panel">
        <div className="panel-heading"><div><p className="eyebrow">Git deployment</p><h2>New application</h2></div></div>
        <form className="inline-form" onSubmit={createApplication}>
          <label>Type<select value={form.type} onChange={(event) => update('type', event.target.value)}><option value="static">Static</option><option value="node">Node.js</option></select></label>
          <label>Name<input value={form.name} maxLength="80" required onChange={(event) => update('name', event.target.value)} /></label>
          <label>GitHub repository<input type="url" placeholder="https://github.com/org/repo" value={form.repositoryUrl} required onChange={(event) => update('repositoryUrl', event.target.value)} /></label>
          <label>Branch<input value={form.branch} required onChange={(event) => update('branch', event.target.value)} /></label>
          {form.type === 'node' && <><label>Port<input type="number" min="1024" max="65535" value={form.port} required onChange={(event) => update('port', event.target.value)} /></label><label>Entry file<input value={form.entryFile} required onChange={(event) => update('entryFile', event.target.value)} /></label><label>Health path<input value={form.healthPath} required onChange={(event) => update('healthPath', event.target.value)} /></label></>}
          <button className="primary-button" type="submit" disabled={!servers.length || busyId === 'create'}>{busyId === 'create' ? 'Creating…' : 'Create application'}</button>
        </form>
      </section>
    </>
  );
}
