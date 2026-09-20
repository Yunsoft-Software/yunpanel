import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enableManagedMailSql,
  mailForwardingTemplatePolicy,
  mailSqlTemplatePolicy,
  mailSubmissionTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailApplyPlan,
  previewManagedMailSubmissionConfiguration,
  renderDovecotQuotaPasswdFile,
  renderManagedMailSqlSeed,
} from '@yunpanel/config-templates';
import {
  createMailConfigEvidenceInspector,
  mailConfigBackupInternals,
} from '../src/index.js';

const ARGON2ID_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 8).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 9).toString('base64').replace(/=+$/, '')}`;
const VMAIL_UID = 5000;
const VMAIL_GID = 5000;
const POSTFIX_UID = 110;
const POSTFIX_GID = 117;
const MAIL_AUTH_GID = 6000;

function fixture() {
  const input = {
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['backup@elsewhere.test'] }],
  };
  const preview = previewManagedMailSubmissionConfiguration(input);
  const passwd = renderDovecotQuotaPasswdFile({ domains: input.domains, accounts: input.accounts });
  const files = new Map();
  for (const artifact of preview.artifacts) {
    files.set(artifact.path, Buffer.from(
      artifact.path === mailTemplatePolicy.dovecotPasswdFilePath ? passwd : artifact.content,
    ));
  }
  for (const compiledPath of mailConfigBackupInternals.postfixCompiledPaths) {
    files.set(compiledPath, Buffer.from('compiled-map'));
  }
  files.set(mailConfigBackupInternals.postfixMainCfPath, Buffer.from('# no managed SRS overrides\n'));
  files.set(mailConfigBackupInternals.sieveCompiledPath, Buffer.from('compiled-sieve'));
  return { preview, files };
}

function sqliteFixture() {
  const input = {
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [],
    accounts: [{ address: 'owner@example.com', passwordHash: ARGON2ID_HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [{ source: 'owner@example.com', mode: 'copy', destinations: ['backup@elsewhere.test'] }],
  };
  const preview = enableManagedMailSql(
    previewManagedMailSubmissionConfiguration(input),
    input,
  );
  const seed = renderManagedMailSqlSeed(input);
  const files = new Map();
  for (const artifact of preview.artifacts) {
    files.set(artifact.path, Buffer.from(
      artifact.path === mailSqlTemplatePolicy.seedPath ? seed : artifact.content,
    ));
  }
  files.set(mailSqlTemplatePolicy.databasePath, Buffer.from('fixture-sqlite-db'));
  files.set(mailConfigBackupInternals.postfixMainCfPath, Buffer.from('# no managed SRS overrides\n'));
  files.set(mailConfigBackupInternals.sieveCompiledPath, Buffer.from('compiled-sieve'));
  const directories = new Map([
    [mailSqlTemplatePolicy.databaseDirectory, { uid: 0, gid: MAIL_AUTH_GID, mode: 0o750 }],
    [mailSqlTemplatePolicy.postfixSqlDirectory, { uid: 0, gid: POSTFIX_GID, mode: 0o750 }],
    ['/etc/yunpanel/mail/sql', { uid: 0, gid: 0, mode: 0o750 }],
  ]);
  return { preview, files, directories };
}

function commandKey(file, args) {
  return `${file}\u0000${args.join('\u0000')}`;
}

function inspectorFor({
  preview,
  files,
  postfixOverride = null,
  masterDefinitionOverride = null,
  masterParameterOverride = null,
  readinessReady = true,
  compiledSieveMode = 0o640,
  compiledSieveUid = 0,
  compiledSieveGid = VMAIL_GID,
  sieveSourceGid = VMAIL_GID,
  invalidVmailIdentity = false,
  invalidPostfixIdentity = false,
  submissionSocketMode = 0o660,
  submissionSocketUid = POSTFIX_UID,
  submissionSocketGid = POSTFIX_GID,
  directories = new Map(),
  sqlStateOverride = null,
} = {}) {
  const plan = previewManagedMailApplyPlan(preview);
  const parameters = new Map(plan.postfixParameters.map((entry) => [entry.name, entry.value]));
  const masterDefinitions = new Map(plan.postfixMasterServices.map((service) => [
    `${service.service}/${service.type}`,
    service.definition,
  ]));
  const masterParameters = new Map();
  for (const service of plan.postfixMasterServices) {
    const identity = `${service.service}/${service.type}`;
    for (const parameter of service.parameters) {
      masterParameters.set(`${identity}/${parameter.name}`, parameter.value);
    }
  }
  return createMailConfigEvidenceInspector({
    readinessInspector: {
      inspect: async (_candidate, { phase } = {}) => ({
        ready: readinessReady,
        previewSha256: preview.sha256,
        phase,
        sha256: 'f'.repeat(64),
      }),
    },
    lstatFn: async (filePath) => {
      if (filePath === mailSubmissionTemplatePolicy.dovecotAuthSocket) {
        return {
          mode: submissionSocketMode,
          uid: submissionSocketUid,
          gid: submissionSocketGid,
          isFile: () => false,
          isSocket: () => true,
          isSymbolicLink: () => false,
        };
      }
      if (directories.has(filePath)) {
        const directory = directories.get(filePath);
        return {
          mode: directory.mode,
          uid: directory.uid,
          gid: directory.gid,
          isFile: () => false,
          isDirectory: () => true,
          isSocket: () => false,
          isSymbolicLink: () => false,
        };
      }
      if (!files.has(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const compiledSieve = filePath === mailConfigBackupInternals.sieveCompiledPath;
      const sieveSource = filePath === mailForwardingTemplatePolicy.sievePath;
      const sensitive = filePath === mailTemplatePolicy.dovecotPasswdFilePath
        || filePath === mailSqlTemplatePolicy.seedPath;
      const postfixSql = filePath.startsWith(mailSqlTemplatePolicy.postfixSqlDirectory + '/');
      const sqlDatabase = filePath === mailSqlTemplatePolicy.databasePath;
      return {
        mode: compiledSieve ? compiledSieveMode
          : sqlDatabase ? mailSqlTemplatePolicy.databaseMode
            : sensitive ? 0o600 : 0o640,
        uid: compiledSieve ? compiledSieveUid : 0,
        gid: compiledSieve ? compiledSieveGid
          : sieveSource ? sieveSourceGid
            : postfixSql ? POSTFIX_GID
              : sqlDatabase ? MAIL_AUTH_GID : 0,
        isFile: () => true,
        isDirectory: () => false,
        isSocket: () => false,
        isSymbolicLink: () => false,
      };
    },
    readFileFn: async (filePath) => Buffer.from(files.get(filePath)),
    run: async (file, args) => {
      if (file === '/usr/bin/getent') {
        if (args[0] === 'group' && args[1] === 'yunpanel-mailauth') {
          return { stdout: 'yunpanel-mailauth:x:' + MAIL_AUTH_GID + ':postfix,dovecot\n', stderr: '' };
        }
        if (args[0] !== 'passwd' || !['vmail', 'postfix'].includes(args[1])) throw new Error('unexpected identity');
        if (args[1] === 'vmail') {
          return {
            stdout: invalidVmailIdentity
              ? 'vmail:x:0:0::/var/lib/yunpanel/mail:/usr/sbin/nologin\n'
              : `vmail:x:${VMAIL_UID}:${VMAIL_GID}::/var/lib/yunpanel/mail:/usr/sbin/nologin\n`,
            stderr: '',
          };
        }
        return {
          stdout: invalidPostfixIdentity
            ? 'postfix:x:0:0::/var/spool/postfix:/usr/sbin/nologin\n'
            : `postfix:x:${POSTFIX_UID}:${POSTFIX_GID}::/var/spool/postfix:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      if (file === '/usr/bin/sqlite3') {
        if (args[1] === 'PRAGMA quick_check;') return { stdout: 'ok\n', stderr: '' };
        if (args[1] === "SELECT value FROM yunpanel_meta WHERE key='state_sha256';") {
          return { stdout: (sqlStateOverride ?? plan.sql?.stateSha256 ?? '') + '\n', stderr: '' };
        }
        throw new Error('unexpected sqlite query');
      }
      if (file === '/usr/sbin/postconf' && args[0] === '-h') {
        const value = postfixOverride?.name === args[1] ? postfixOverride.value : parameters.get(args[1]);
        return { stdout: `${value ?? ''}\n`, stderr: '' };
      }
      if (file === '/usr/sbin/postconf' && args[0] === '-M') {
        const definition = masterDefinitions.get(args[1]);
        if (!definition) throw new Error('unexpected master service');
        return { stdout: `${masterDefinitionOverride ?? definition}\n`, stderr: '' };
      }
      if (file === '/usr/sbin/postconf' && args[0] === '-P') {
        const lastSlash = args[1].lastIndexOf('/');
        const paramName = lastSlash >= 0 ? args[1].slice(lastSlash + 1) : args[1];
        const value = (masterParameterOverride?.name === paramName || masterParameterOverride?.name === args[1])
          ? masterParameterOverride.value
          : masterParameters.get(args[1]);
        if (value === undefined) throw new Error('unexpected master parameter');
        return { stdout: `${args[1]}=${value}\n`, stderr: '' };
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

test('active managed mail evidence requires exact live submission state without protected content', async () => {
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
  assert.equal(state.files.has(mailSubmissionTemplatePolicy.senderLoginPath), true);
  assert.equal(state.files.has(`${mailSubmissionTemplatePolicy.senderLoginPath}.db`), true);
  assert.equal(state.files.has(mailForwardingTemplatePolicy.sievePath), true);
  assert.equal(state.files.has(mailConfigBackupInternals.sieveCompiledPath), true);
  assert.equal(JSON.stringify(result).includes(ARGON2ID_HASH), false);
});

test('SQLite mail evidence requires exact DB state, directory ownership and retired legacy lookup files', async () => {
  const state = sqliteFixture();
  const result = await inspectorFor(state).inspect(state.preview);
  assert.equal(result.satisfied, true);

  const staleDb = sqliteFixture();
  assert.deepEqual(await inspectorFor({
    ...staleDb,
    sqlStateOverride: '0'.repeat(64),
  }).inspect(staleDb.preview), { satisfied: false, result: null });

  const legacyLeak = sqliteFixture();
  legacyLeak.files.set(mailTemplatePolicy.dovecotPasswdFilePath, Buffer.from('stale hash'));
  assert.deepEqual(await inspectorFor(legacyLeak).inspect(legacyLeak.preview), {
    satisfied: false,
    result: null,
  });

  const unsafeDirectory = sqliteFixture();
  unsafeDirectory.directories.set(mailSqlTemplatePolicy.databaseDirectory, {
    uid: 0,
    gid: 0,
    mode: 0o750,
  });
  assert.deepEqual(await inspectorFor(unsafeDirectory).inspect(unsafeDirectory.preview), {
    satisfied: false,
    result: null,
  });
});

test('active managed mail evidence fails closed on artifact, sieve ownership or postfix main/master drift', async () => {
  const state = fixture();
  state.files.set(mailTemplatePolicy.dovecotAuthConfigPath, Buffer.from('tampered\n'));
  assert.deepEqual(await inspectorFor(state).inspect(state.preview), { satisfied: false, result: null });

  const missingSieve = fixture();
  missingSieve.files.delete(mailConfigBackupInternals.sieveCompiledPath);
  assert.deepEqual(await inspectorFor(missingSieve).inspect(missingSieve.preview), { satisfied: false, result: null });

  const unsafeSieve = fixture();
  for (const input of [
    { compiledSieveMode: 0o600 },
    { compiledSieveUid: 1000 },
    { compiledSieveGid: 0 },
    { sieveSourceGid: 0 },
    { invalidVmailIdentity: true },
    { invalidPostfixIdentity: true },
  ]) {
    assert.deepEqual(await inspectorFor({ ...unsafeSieve, ...input }).inspect(unsafeSieve.preview), {
      satisfied: false,
      result: null,
    });
  }

  const clean = fixture();
  const parameter = previewManagedMailApplyPlan(clean.preview).postfixParameters[0];
  assert.deepEqual(await inspectorFor({
    ...clean,
    postfixOverride: { name: parameter.name, value: 'unexpected' },
  }).inspect(clean.preview), { satisfied: false, result: null });
  assert.deepEqual(await inspectorFor({
    ...clean,
    masterDefinitionOverride: 'submission inet n - y - - smtpd',
  }).inspect(clean.preview), { satisfied: false, result: null });
  assert.deepEqual(await inspectorFor({
    ...clean,
    masterParameterOverride: { name: 'smtpd_tls_security_level', value: 'may' },
  }).inspect(clean.preview), { satisfied: false, result: null });
});

test('active managed mail evidence requires postfix-owned 0660 Dovecot auth socket', async () => {
  const state = fixture();
  for (const input of [
    { submissionSocketMode: 0o666 },
    { submissionSocketUid: 0 },
    { submissionSocketGid: 0 },
  ]) {
    assert.deepEqual(await inspectorFor({ ...state, ...input }).inspect(state.preview), {
      satisfied: false,
      result: null,
    });
  }
});

test('active managed mail evidence fails closed when post-apply readiness is not satisfied', async () => {
  const state = fixture();
  assert.deepEqual(await inspectorFor({ ...state, readinessReady: false }).inspect(state.preview), {
    satisfied: false,
    result: null,
  });
});
