import { register } from 'node:module';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

register('./jsx-loader.js', import.meta.url);
const { WorkspaceContext } = await import('../src/workspace/WorkspaceContext.jsx');
const { default: JobsTable } = await import('../src/workspace/JobsTable.jsx');

export const sampleJob = Object.freeze({
  id: 'job-0123456789abcdef', type: 'website.deploy', status: 'queued',
  resourceType: 'website', resourceId: 'website-0123456789', createdAt: 1_700_000_000_000,
});

// Server-renders JobsTable with a minimal workspace, as the overview and logs screens do.
export function renderJobsTable(jobs = [sampleJob], props = {}) {
  const noop = () => {};
  const workspace = {
    observe: noop, refreshAll: noop, canManage: true,
    domains: { status: 'ready', items: [] }, websites: { status: 'ready', items: [] },
  };
  return renderToStaticMarkup(h(MemoryRouter, null,
    h(WorkspaceContext.Provider, { value: workspace }, h(JobsTable, { jobs, ...props }))));
}
