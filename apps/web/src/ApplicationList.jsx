function shortCommit(value) {
  return typeof value === 'string' && value.length >= 8 ? value.slice(0, 8) : '—';
}

function repositoryLabel(value) {
  if (typeof value !== 'string') return 'Unknown repository';
  return value
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/\.git$/, '');
}

function stateDot(state) {
  if (state === 'active') return 'online';
  if (state === 'error') return 'failed';
  return 'pending';
}

export default function ApplicationList({ applications, access }) {
  if (!applications.length) {
    return (
      <div className="domain-empty">
        <strong>{access === 'protected' ? 'Application inventory protected' : 'No managed application yet'}</strong>
        <span>
          {access === 'protected'
            ? 'Production applications will appear after authenticated control-plane access is enabled.'
            : 'Create a static application with a GitHub repository and deploy it through the control API.'}
        </span>
      </div>
    );
  }

  return (
    <div className="domain-list">
      {applications.map((application) => (
        <article className="domain-row" key={application.id}>
          <div className="domain-primary">
            <span className={`status-dot ${stateDot(application.state)}`} />
            <div>
              <strong>{application.name}</strong>
              <span>{repositoryLabel(application.repositoryUrl)}</span>
            </div>
          </div>
          <div className="domain-cell">
            <span>Branch</span>
            <strong>{application.branch}</strong>
          </div>
          <div className="domain-cell">
            <span>Commit</span>
            <strong>{shortCommit(application.currentCommitSha)}</strong>
          </div>
          <div className="domain-cell">
            <span>Releases</span>
            <strong>{application.releases?.length ?? 0} / {application.retention}</strong>
          </div>
          <div className={`domain-state ${application.state === 'active' ? 'active' : application.state === 'error' ? 'error' : 'draft'}`}>
            {application.state}
          </div>
          {application.lastError && <div className="server-last-seen">Last operation · {application.lastError}</div>}
        </article>
      ))}
    </div>
  );
}
