import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  enableManagedMailSrs,
  mailForwardingTemplatePolicy,
  mailSrsTemplatePolicy,
  mailSubmissionTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailApplyPlan,
  previewManagedMailSubmissionConfiguration,
  renderDovecotQuotaPasswdFile,
} from '@yunpanel/config-templates';
import {
  createMailConfigEvidenceInspector,
  mailConfigBackupInternals,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 31).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 32).toString('base64').replace(/=+$/, '')}`;
const VMAIL_GID = 5000;
const POSTFIX_UID = 110;
const POSTFIX_GID = 117;
const SRS_SECRET = 'R'.repeat(43);
const SRS_SECRET_CONTENT = `${SRS_SECRET}\n`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function baseFixture() {
  const input = {
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['external@gmail.com'] }],
  };
  const preview = previewManagedMailSubmissionConfiguration(input);
  return { input, preview };
}

function activeFixture() {
  const state = baseFixture();
  const preview = enableManagedMailSrs(state.preview, {
    domains: state.input.domains,
    forwardings: state.input.forwardings,
    srsDomain: 'mail.example.com',
    secretRevision: 1,
    secretSha256: sha256(SRS_SECRET_CONTENT),
    secretBytes: Buffer.byteLength(SRS_SECRET_CONTENT),
  });
  return buildLiveState(state.input, preview, 'myhostname = mail.example.com\n');
}

function teardownFixture({ staleSrs = false } = {}) {
  const state = baseFixture();
  const mainCf = staleSrs
    ? 'myhostname = mail.example.com\nsender_canonical_maps = tcp:127.0.0.1:10001\n'
    : 'myhostname = mail.example.com\n';
  return buildLiveState(state.input, state.preview, mainCf);
}

function buildLiveState(input, preview, mainCf) {
  const passwd = renderDovecotQuotaPasswdFile({ domains: input.domains, accounts: input.accounts });
  const files = new Map();
  for (const artifact of preview.artifacts) {
    let content = artifact.content;
    if (artifact.path === mailTemplatePolicy.dovecotPasswdFilePath) content = passwd;
    if (artifact.path === mailSrsTemplatePolicy.secretPath) content = SRS_SECRET_CONTENT;
    files.set(artifact.path, Buffer.from(content ?? ''));
  }
  for (const compiledPath of mailConfigBackupInternals.postfixCompiledPaths) {
    files.set(compiledPath, Buffer.from('compiled-map'));
  }
  files.set(mailConfigBackupInternals.sieveCompiledPath, Buffer.from('compiled-sieve'));
  files.set(mailConfigBackupInternals.postfixMainCfPath, Buffer.from(mainCf));
  return { preview, files };
}

function commandKey(file, args) {
  return `${file}\u0000${args.join('\u0000')}`;
}

function inspectorFor({ preview, files, parameterOverride = null } = {}) {
  const plan = previewManagedMailApplyPlan(preview);
  const parameters = new Map(plan.postfixParameters.map((entry) => [entry.name, entry.value]));
  const masterService = plan.postfixMasterServices[0];
  const masterIdentity = `${masterService.service}/${masterService.type}`;
  const masterParameters = new Map(masterService.parameters.map((entry) => [entry.name, entry.value]));
  return createMailConfigEvidenceInspector({
    readinessInspector: {
      inspect: async (_candidate, { phase } = {}) => ({
        ready: true,
        phase,
        previewSha256: preview.sha256,
        sha256: 'f'.repeat(64),
      }),
    },
    lstatFn: async (filePath) => {
      if (filePath === mailSubmissionTemplatePolicy.dovecotAuthSocket) {
        return {
          mode: 0o660,
          uid: POSTFIX_UID,
          gid: POSTFIX_GID,
          isFile: () => false,
          isSocket: () => true,
          isSymbolicLink: () => false,
        };
      }
      if (!files.has(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const artifact = plan.artifacts.find((entry) => entry.path === filePath);
      const compiledSieve = filePath === mailConfigBackupInternals.sieveCompiledPath;
      const sieveSource = filePath === mailForwardingTemplatePolicy.sievePath;
      return {
        mode: compiledSieve ? 0o640 : artifact?.sensitive ? 0o600 : 0o640,
        uid: 0,
        gid: compiledSieve || sieveSource ? VMAIL_GID : 0,
        isFile: () => true,
        isSocket: () => false,
        isSymbolicLink: () => false,
      };
    },
    readFileFn: async (filePath) => Buffer.from(files.get(filePath)),
    run: async (file, args) => {
      if (file === '/usr/bin/getent') {
        if (args[1] === 'vmail') {
          return { stdout: `vmail:x:5000:${VMAIL_GID}::/var/lib/yunpanel/mail:/usr/sbin/nologin\n`, stderr: '' };
        }
        if (args[1] === 'postfix') {
          return { stdout: `postfix:x:${POSTFIX_UID}:${POSTFIX_GID}::/var/spool/postfix:/usr/sbin/nologin\n`, stderr: '' };
        }
        throw new Error('unexpected identity');
      }
      if (file === '/usr/sbin/postconf' && args[0] === '-h') {
        const value = parameterOverride?.name === args[1] ? parameterOverride.value : parameters.get(args[1]);
        return { stdout: `${value ?? ''}\n`, stderr: '' };
      }
      if (file === '/usr/sbin/postconf' && args[0] === '-M') {
        if (args[1] !== masterIdentity) throw new Error('unexpected master service');
        return { stdout: `${masterService.definition}\n`, stderr: '' };
      }
      if (file === '/usr/sbin/postconf' && args[0] === '-P') {
        const prefix = `${masterIdentity}/`;
        if (!args[1].startsWith(prefix)) throw new Error('unexpected master parameter');
        const name = args[1].slice(prefix.length);
        return { stdout: `${args[1]}=${masterParameters.get(name) ?? ''}\n`, stderr: '' };
      }
      const allowed = new Set([
        ...plan.stages.validate.map((command) => commandKey(command.file, command.args)),
        ...plan.stages.health.map((command) => commandKey(command.file, command.args)),
      ]);
      if (!allowed.has(commandKey(file, args))) throw new Error(`unexpected command ${commandKey(file, args)}`);
      return { stdout: '', stderr: '' };
    },
  });
}

test('SRS recovery evidence requires exact protected files and Postfix canonical map state', async () => {
  const state = activeFixture();
  const healthy = await inspectorFor(state).inspect(state.preview);
  assert.equal(healthy.satisfied, true);
  assert.equal(JSON.stringify(healthy).includes(SRS_SECRET), false);
  assert.equal(JSON.stringify(healthy).includes(ARGON2ID_HASH), false);

  const secretDrift = activeFixture();
  secretDrift.files.set(mailSrsTemplatePolicy.secretPath, Buffer.from(`${'X'.repeat(43)}\n`));
  assert.deepEqual(await inspectorFor(secretDrift).inspect(secretDrift.preview), { satisfied: false, result: null });

  const defaultsDrift = activeFixture();
  defaultsDrift.files.set(mailSrsTemplatePolicy.defaultsPath, Buffer.from('SRS_DOMAIN=attacker.example\n'));
  assert.deepEqual(await inspectorFor(defaultsDrift).inspect(defaultsDrift.preview), { satisfied: false, result: null });

  const mapDrift = activeFixture();
  assert.deepEqual(await inspectorFor({
    ...mapDrift,
    parameterOverride: { name: 'sender_canonical_maps', value: 'hash:/unsafe' },
  }).inspect(mapDrift.preview), { satisfied: false, result: null });
});

test('SRS teardown evidence rejects stale explicit canonical-map configuration in main.cf', async () => {
  const clean = teardownFixture();
  assert.equal((await inspectorFor(clean).inspect(clean.preview)).satisfied, true);

  const stale = teardownFixture({ staleSrs: true });
  assert.deepEqual(await inspectorFor(stale).inspect(stale.preview), { satisfied: false, result: null });
});
