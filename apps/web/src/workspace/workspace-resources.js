const none = () => ({ domains: false, applications: false, certificates: false, servers: false, jobs: false });

// This is a data-demand map, not an authorization policy. The authenticated API
// still validates every request, and AuthGate still owns management access.
export function workspaceResources(pathname, { observingJob = false, activeJob = false } = {}) {
  const path = typeof pathname === 'string' ? pathname.replace(/\/+$/, '') || '/' : '';
  const result = none();
  const enable = (...names) => { for (const name of names) result[name] = true; };
  if (path === '/' || path === '/dashboard') enable('domains', 'applications', 'certificates', 'servers', 'jobs');
  else if (path === '/websites') enable('domains', 'applications', 'certificates', 'servers');
  else if (path === '/websites/new') enable('domains', 'applications', 'servers');
  else if (/^\/websites\/[^/]+(?:\/[^/]+)?$/.test(path)) {
    enable('domains', 'applications', 'certificates', 'servers');
    const tab = path.split('/')[3] || 'overview';
    if (['overview', 'node', 'deploy', 'domains', 'ssl', 'logs'].includes(tab)) enable('jobs');
  } else if (path === '/applications') enable('applications', 'servers', 'jobs');
  else if (path === '/applications/new') enable('applications', 'servers');
  else if (path === '/domains') enable('domains', 'certificates', 'servers');
  else if (path === '/jobs') enable('jobs');
  else if (path === '/servers' || path === '/settings' || path === '/databases') enable('servers');
  if (observingJob || activeJob) enable('jobs');
  return result;
}
