import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const packagedPath = '/usr/lib/yunpanel/scripts/job-recovery.mjs';
const ACTIONS = Object.freeze({
  'recover-python-deploy': ['recoverPythonDeployment', 'app.python.deploy'],
  'recover-python-rollback': ['recoverPythonRollback', 'app.python.rollback'],
  'recover-python-restart': ['recoverPythonRestart', 'app.python.restart'],
});

function refuse(name) {
  return async () => { throw new Error(`${name} must not run`); };
}

for (const [action, [handlerName, operation]] of Object.entries(ACTIONS)) {
  test(`${action} requires confirmation and delegates only to its Python recovery runtime`, async () => {
    assert.deepEqual(parseJobRecoveryArguments([action, serverId, jobId, '--confirm']), { action, serverId, jobId, confirm: true });
    assert.throws(() => parseJobRecoveryArguments([action, serverId, jobId]), /Usage:/);

    const calls = [];
    const handlers = Object.fromEntries(Object.values(ACTIONS).map(([name]) => [name, refuse(name)]));
    handlers[handlerName] = async (input) => {
      calls.push(input);
      return {
        serverId, jobId, operation, status: 'succeeded', recoveryMethod: 'verified_python_receipt_and_status',
        statePaths: { jobStore: '/var/lib/yunpanel/control-plane/job-registry.json', recoveryStore: '/var/lib/yunpanel/control-plane/job-registry.json.recovery.json' },
      };
    };
    let output = '';
    await runJobRecoveryCli({
      argv: [action, serverId, jobId, '--confirm'],
      filePath: packagedPath,
      uid: 0,
      cwd: '/',
      env: {},
      ...handlers,
      recoveryAudit: null,
      stdout: { write(value) { output += value; } },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].packaged, true);
    assert.equal(calls[0].jobId, jobId);
    assert.match(output, new RegExp(`operation=${operation.replaceAll('.', '\\.')}`));
  });
}

test('Python recovery mutations stay unavailable outside packaged root installation', async () => {
  await assert.rejects(
    runJobRecoveryCli({ argv: ['recover-python-deploy', serverId, jobId, '--confirm'], filePath: '/work/scripts/job-recovery.mjs', uid: 0, recoverPythonDeployment: refuse('deploy') }),
    /available only from the packaged YunPanel installation/,
  );
  await assert.rejects(
    runJobRecoveryCli({ argv: ['recover-python-deploy', serverId, jobId, '--confirm'], filePath: packagedPath, uid: 1000, recoverPythonDeployment: refuse('deploy') }),
    /must be run as root/,
  );
});
