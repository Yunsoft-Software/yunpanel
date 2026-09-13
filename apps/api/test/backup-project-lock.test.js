import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackupProjectLockError,
  createBackupProjectLockProvider,
} from '../src/backup-project-lock.js';

const projectId = '0bb78242-03a6-429f-9d17-7725c521437c';
const otherProjectId = '5bc2c0f4-948a-4f34-826c-5a9703f9cbf0';

function operation(status, ids) {
  return {
    status,
    plan: {
      steps: ids.map((id) => ({ resourceType: 'docker_storage', input: { projectId: id } })),
    },
  };
}

test('project backup lock is derived only from queued or running parent operations', async () => {
  const provider = createBackupProjectLockProvider({
    backupOperationRegistry: {
      async listOperations() {
        return [
          operation('succeeded', [projectId]),
          operation('running', [otherProjectId]),
          operation('queued', [projectId]),
        ];
      },
    },
  });
  assert.equal(await provider(projectId), true);
  assert.equal(await provider(otherProjectId), true);
});

test('terminal or unrelated parent work does not lock a Docker project', async () => {
  const provider = createBackupProjectLockProvider({
    backupOperationRegistry: {
      async listOperations() {
        return [
          operation('succeeded', [projectId]),
          { status: 'running', plan: { steps: [{ resourceType: 'application', input: { applicationId: projectId } }] } },
        ];
      },
    },
  });
  assert.equal(await provider(projectId), false);
});

test('project backup lock fails closed when durable parent state cannot be read', async () => {
  const provider = createBackupProjectLockProvider({
    backupOperationRegistry: {
      async listOperations() { throw new Error('private state path'); },
    },
  });
  await assert.rejects(
    () => provider(projectId),
    (error) => error instanceof BackupProjectLockError
      && error.code === 'backup_project_lock_state_unavailable'
      && !error.message.includes('private state path'),
  );
});
