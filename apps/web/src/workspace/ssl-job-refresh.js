// Refresh dependent inventories on a tracked SSL job's terminal transition,
// even when its detail drawer is closed. This never starts or retries a job.
export function createSslJobRefresh() {
  const seen = new Map();
  return (jobs) => {
    let refresh = false;
    for (const job of jobs) {
      if (!job || typeof job.id !== 'string' || !job.id || job.resourceType !== 'certificate'
        || !['ssl.issue', 'ssl.renew'].includes(job.operation)
        || typeof job.resourceId !== 'string' || !job.resourceId
        || typeof job.serverId !== 'string' || !job.serverId
        || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status)) continue;
      const identity = JSON.stringify([job.serverId, job.resourceId, job.operation]);
      const previous = seen.get(job.id);
      if (previous && previous.identity !== identity) continue;
      const terminal = ['succeeded', 'failed', 'cancelled'].includes(job.status);
      if (terminal && !previous?.terminal) refresh = true;
      seen.set(job.id, { identity, terminal: terminal || previous?.terminal === true });
    }
    const retained = new Set(jobs.map((job) => job?.id));
    for (const id of seen.keys()) if (!retained.has(id)) seen.delete(id);
    return refresh;
  };
}
