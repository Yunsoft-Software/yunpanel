import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { panelRequest } from '../api.js';
import { useCollection } from './useCollection.js';
import { jobActive, jobFromResponse } from './site-model.js';

const WorkspaceContext = createContext(null);
export function WorkspaceProvider({ children }) {
  const domains = useCollection('/domains');
  const applications = useCollection('/applications');
  const certificates = useCollection('/certificates');
  const servers = useCollection('/servers');
  const jobs = useCollection('/jobs');
  const [tracked, setTracked] = useState({});
  const [observedId, setObservedId] = useState(null);
  const [jobOpen, setJobOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const requests = useRef(null);
  const submitting = useRef(new Set());
  useEffect(() => { const controller = new AbortController(); requests.current = controller; return () => controller.abort(); }, []);
  const refreshAll = useCallback(() => { domains.refresh(); applications.refresh(); certificates.refresh(); servers.refresh(); jobs.refresh(); }, [domains.refresh, applications.refresh, certificates.refresh, servers.refresh, jobs.refresh]);
  useEffect(() => {
    if (jobs.status !== 'ready') return;
    setTracked((current) => {
      const next = { ...current };
      for (const id of Object.keys(next)) {
        const fresh = jobs.items.find((job) => job.id === id);
        if (fresh) next[id] = fresh;
      }
      return next;
    });
  }, [jobs.items, jobs.status]);
  const observe = useCallback((job) => { setTracked((current) => ({ ...current, [job.id]: job })); setObservedId(job.id); setJobOpen(true); }, []);
  const updateJob = useCallback((job) => setTracked((current) => ({ ...current, [job.id]: job })), []);
  const runJob = useCallback(async (path, body = {}) => {
    if (submitting.current.has(path)) throw new Error('Bu istek zaten gönderiliyor.');
    submitting.current.add(path);
    try {
      const result = await panelRequest(path, { method: 'POST', body, signal: requests.current?.signal });
      const job = jobFromResponse(result);
      observe(job); jobs.refresh();
      return job;
    } finally { submitting.current.delete(path); }
  }, [observe, jobs.refresh]);
  const resourceBusy = (type, id) => [...jobs.items, ...Object.values(tracked)].some((job) => job.resourceType === type && job.resourceId === id && jobActive(job));
  return <WorkspaceContext.Provider value={{ domains, applications, certificates, servers, jobs, runJob, resourceBusy, refreshAll, observe, updateJob, observedJob: tracked[observedId] ?? null, jobOpen, closeJob: () => setJobOpen(false), notice, setNotice }}>{children}</WorkspaceContext.Provider>;
}
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Workspace provider is missing');
  return value;
}
