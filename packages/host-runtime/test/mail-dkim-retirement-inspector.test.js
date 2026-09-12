import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailDkimRetirementInspector,
  mailDkimRetirementInternals,
} from '../src/index.js';
import { mailDkimTemplatePolicy } from '@yunpanel/config-templates';

const domain = 'example.com';
const selector = 'mail-2026';
const keyPath = mailDkimTemplatePolicy.keyPath(domain, selector);
const cleanConfig = [
  'enabled = true;',
  'domain {',
  '  other.example {',
  '    selector = "mail";',
  `    path = "${mailDkimTemplatePolicy.keyPath('other.example', 'mail')}";`,
  '  }',
  '}',
  '',
].join('\n');

function missing() {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function fixture({ keyPresent = false, config = cleanConfig, commandFailure = null } = {}) {
  const calls = [];
  const inspector = createMailDkimRetirementInspector({
    lstatFn: async (filePath) => {
      if (filePath === keyPath) {
        if (!keyPresent) throw missing();
        return {
          size: 1024,
          mode: 0o640,
          uid: 0,
          gid: 108,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      }
      if (filePath === mailDkimTemplatePolicy.configPath) {
        return {
          size: Buffer.byteLength(config),
          mode: mailDkimRetirementInternals.configMode,
          uid: mailDkimRetirementInternals.rootUid,
          gid: mailDkimRetirementInternals.rootGid,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      }
      throw missing();
    },
    readFileFn: async (filePath) => {
      assert.equal(filePath, mailDkimTemplatePolicy.configPath);
      return config;
    },
    run: async (file, args) => {
      calls.push([file, [...args]]);
      if (commandFailure === file) throw new Error('fixture failure');
      return { stdout: '', stderr: '' };
    },
  });
  return { inspector, calls };
}

test('retirement evidence requires absent live key, absent generated domain config and healthy rspamd', async () => {
  const { inspector, calls } = fixture();
  const result = await inspector.inspect({ domain, selector });
  assert.deepEqual(result, {
    satisfied: true,
    result: {
      version: 1,
      domain,
      selector,
      retired: true,
      sideEffects: false,
    },
  });
  assert.deepEqual(calls, [
    ['/usr/bin/rspamadm', ['configtest']],
    ['/usr/bin/systemctl', ['is-active', '--quiet', 'rspamd']],
  ]);
});

test('retirement evidence fails closed while the live private key or generated domain block remains', async () => {
  const live = fixture({ keyPresent: true });
  assert.deepEqual(await live.inspector.inspect({ domain, selector }), { satisfied: false, result: null });
  assert.deepEqual(live.calls, []);

  const staleConfig = [
    'enabled = true;',
    'domain {',
    `  ${domain} {`,
    `    selector = "${selector}";`,
    `    path = "${keyPath}";`,
    '  }',
    '}',
    '',
  ].join('\n');
  const configured = fixture({ config: staleConfig });
  assert.deepEqual(await configured.inspector.inspect({ domain, selector }), { satisfied: false, result: null });
  assert.deepEqual(configured.calls, []);
});

test('retirement evidence fails closed when rspamd config validation or health is unavailable', async () => {
  for (const file of ['/usr/bin/rspamadm', '/usr/bin/systemctl']) {
    const { inspector } = fixture({ commandFailure: file });
    assert.deepEqual(await inspector.inspect({ domain, selector }), { satisfied: false, result: null });
  }
});
