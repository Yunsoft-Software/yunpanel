function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function statusTone(status) {
  if (status === 'succeeded') return 'online';
  if (status === 'failed') return 'failed';
  return 'pending';
}

export default function JobList({ jobs, access, busyId = null, onCancel = null, limit = 8 }) {
  const recent = [...jobs]
    .sort((left, right) => Date.parse(right.createdAt ?? 0) - Date.parse(left.createdAt ?? 0))
    .slice(0, limit);

  if (!recent.length) {
    return (
      <div className="domain-empty">
        <strong>{access === 'protected' ? 'Job history protected' : 'No jobs yet'}</strong>
        <span>
          {access === 'protected'
            ? 'Operational jobs will appear after authenticated control-plane access is enabled.'
            : 'Deploy, domain, certificate and backup jobs will appear here.'}
        </span>
      </div>
    );
  }

  return (
    <div className="domain-list">
      {recent.map((job) => (
        <article className="domain-row" key={job.id}>
          <div className="domain-primary">
            <span className={`status-dot ${statusTone(job.status)}`} />
            <div>
              <strong>{job.type}</strong>
              <span>{job.operation}</span>
            </div>
          </div>
          <div className="domain-cell">
            <span>Resource</span>
            <strong>{job.resourceType}</strong>
          </div>
          <div className="domain-cell">
            <span>Attempts</span>
            <strong>{job.attempts ?? 0}</strong>
          </div>
          <div className="domain-cell">
            <span>Created</span>
            <strong>{formatTime(job.createdAt)}</strong>
          </div>
          <div className={`domain-state ${job.status === 'succeeded' ? 'active' : job.status === 'failed' ? 'error' : 'draft'}`}>
            {job.status}
          </div>
          {onCancel && job.status === 'queued' && (
            <div className="row-actions">
              <button className="secondary-button" type="button" disabled={busyId === job.id} onClick={() => onCancel(job)}>Cancel</button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
