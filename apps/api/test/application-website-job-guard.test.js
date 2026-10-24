import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { assertApplicationWebsiteIdle } from '../src/application-website-job-guard.js';

test('both backup and WordPress jobs block linked Application mutations, with sibling Website isolation', async () => {
  for (const operation of [OPERATIONS.WEBSITE_BACKUP_ACTION, OPERATIONS.WEBSITE_PHP_ACTION]) {
    const dependencies = { applicationId: 'application-a', websiteRegistry: { listWebsites: async () => [
      { id: 'website-a', applicationId: 'application-a' }, { id: 'website-b', applicationId: 'application-b' },
    ] }, jobRegistry: { listJobs: async () => [{ status: 'running', operation, resourceType: 'backup', resourceId: 'operation-a', payload: { websiteId: 'website-a' } }] } };
    await assert.rejects(assertApplicationWebsiteIdle(dependencies), { code: 'application_website_job_conflict' });
    await assertApplicationWebsiteIdle({ ...dependencies, applicationId: 'application-b' });
  }
});
