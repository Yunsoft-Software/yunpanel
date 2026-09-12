import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mailTemplatePolicy,
  previewManagedMailApplyPlan,
  previewManagedMailConfiguration,
  renderDovecotPasswdFile,
} from '@yunpanel/config-templates';
import {
  createMailConfigEvidenceInspector,
  mailConfigBackupInternals,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 8).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 9).toString('base64').replace(/=+$/, '')}`;

function fixture() {
  const input = {
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
  };
  const preview = previewManagedMailConfiguration(input);
  const passwd = renderDovecotPasswdFile({ domains: input.domains, accounts: input.accounts });
  const files = new Map();
  for (const artifact of preview.artifacts) {
    files.set(artifact.path, Buffer.from(
      artifact.path === mailTemplatePolicy.dovecotPasswdFilePath ? passwd : artifact.content,
    ));
  }
  for (const compiledPath of mailConfigBackupInternals.postfixCompiledPaths) {
    files.set(compiledPath, Buffer.from('compiled-map'));
  }
  return { preview, files };
}

function commandKey(file, args) {
  return `${file}\u0000${args.join('\u0000')}`;
}

function inspectorFor({ preview, files, postfixOverride = null, readinessReady = true }) {
  const plan = previewManagedMailApplyPlan(preview);
  const parameters = new Map(plan.postfixParameters.map((entry) => [entry.name, entry.value]));
  return createMailConfigEvidenceInspector({
    readinessInspector: {
      inspect: async () => ({
        ready: readinessReady,
        previewSha256: preview.sha256,
        sha256: 'f'.repeat(64),
      }),
    },
    lstatFn: async (filePath) => {
      if (!files.has(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const sensitive = filePath === mailTemplatePolicy.dovecotPasswdFilePath;
      return {
        mode: sensitive ? 0o600 : 0o640,
        uid: 0,
        gid: 0,
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    },
    readFileFn: async (filePath) => Buffer.from(files.get(filePath)),
    run: async (file, args) => {
      if (file === '/usr/sbin/postconf' && args[0] === '-h') {
        const value = postfixOverride?.name === args[1] ? postfixOverride.value : parameters.get(args[1]);
        return { stdout: `${value ?? ''}\n`, stderr: '' };
      }
      const allowed = new Set([
        ...plan.stages.validate.map((command) => commandKey(command.file, command.args)),
        ...plan.stages.health.map((command) => commandKey(command.file, command.args)),
      ]);
      if (!allowed.has(commandKey(file, args))) throw new Error('unexpected command');
      return { stdout: '', stderr: '' };
    },
  });
}

test('active managed mail evidence requires exact live artifacts and returns no protected content', async () => {
  const state = fixture();
  const result = await inspectorFor(state).inspect(state.preview);
  const plan = previewManagedMailApplyPlan(state.preview);
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.result, {
    version: 1,
    previewSha256: state.preview.sha256,
    planSha256: plan.sha256,
    readinessSha256: 'f'.repeat(64),
    applied: true,
    sideEffects: true,
  });
  assert.equal(JSON.stringify(result).includes(ARGON2ID_HASH), false);
});

test('active managed mail evidence fails closed on artifact or postfix drift', async () => {
  const state = fixture();
  state.files.set(mailTemplatePolicy.dovecotAuthConfigPath, Buffer.from('tampered\n'));
  assert.deepEqual(await inspectorFor(state).inspect(state.preview), { satisfied: false, result: null });

  const clean = fixture();
  const parameter = previewManagedMailApplyPlan(clean.preview).postfixParameters[0];
  assert.deepEqual(await inspectorFor({
    ...clean,
    postfixOverride: { name: parameter.name, value: 'unexpected' },
  }).inspect(clean.preview), { satisfied: false, result: null });
});

test('active managed mail evidence fails closed when post-apply readiness is not satisfied', async () => {
  const state = fixture();
  assert.deepEqual(await inspectorFor({ ...state, readinessReady: false }).inspect(state.preview), {
    satisfied: false,
    result: null,
  });
});
