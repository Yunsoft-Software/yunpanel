const states = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
export function newerJob(previous, next) {
  if (!next || typeof next.id !== 'string' || !states.has(next.status)) return previous;
  if (!previous || previous.id !== next.id) return next;
  // The same job never becomes queued/running again; retries receive new IDs.
  if (terminal.has(previous.status) && !terminal.has(next.status)) return previous;
  if (previous.status === 'running' && next.status === 'queued') return previous;
  return next;
}
export function trackJob(current, next, limit = 100) {
  const selected = newerJob(current[next?.id], next);
  if (!selected) return current;
  const entries = Object.entries({ ...current, [selected.id]: selected });
  // Keep active jobs and the newest observed records; bound historic client memory.
  while (entries.length > limit) {
    const index = entries.findIndex(([id, job]) => id !== selected.id && terminal.has(job.status));
    if (index < 0) break;
    entries.splice(index, 1);
  }
  return Object.fromEntries(entries);
}
