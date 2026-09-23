const none = () => ({ domains: false, websites: false, applications: false, certificates: false, servers: false, jobs: false });

// Data demand only; authorization remains in the authenticated API.
export function workspaceResources(pathname, { observingJob = false, activeJob = false } = {}) {
  const path = typeof pathname === 'string' ? pathname.replace(/\/+$/, '') || '/' : '';
  const result = none();
  const enable = (...names) => { for (const name of names) result[name] = true; };
  if (path === '/dashboard') enable('domains', 'applications', 'certificates', 'servers', 'jobs');
  else if (path === '/' || path === '/websites') enable('domains', 'websites', 'applications', 'certificates', 'servers');
  else if (path === '/files') enable('domains', 'websites');
  else if (path === '/websites/new') enable('domains', 'websites', 'applications', 'servers');
  else if (/^\/websites\/[^/]+(?:\/[^/]+)?$/.test(path)) {
    enable('domains', 'websites', 'applications', 'certificates', 'servers');
    const tab = path.split('/')[3] || 'overview';
    if (['overview', 'node', 'deploy', 'domains', 'ssl', 'logs', 'resources', 'databases', 'mail', 'settings'].includes(tab)) enable('jobs');
  } else if (path === '/applications') enable('applications', 'servers', 'jobs');
  else if (path === '/applications/new') enable('applications', 'servers');
  else if (path === '/domains') enable('domains', 'certificates', 'servers');
  else if (path === '/jobs') enable('jobs');
  else if (path === '/mail') enable('domains', 'websites', 'servers', 'jobs');
  else if (/^\/mail\/[^/]+$/.test(path)) enable('domains', 'servers', 'jobs');
  else if (path === '/databases') enable('domains', 'websites', 'servers');
  else if (path === '/servers' || path === '/settings') enable('servers');
  else if (path === '/docker' || /^\/docker\/[^/]+$/.test(path)) enable('servers', 'jobs');
  if (observingJob || activeJob) enable('jobs');
  return result;
}
