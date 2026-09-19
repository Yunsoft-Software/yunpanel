import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailProtocolHealthInspector,
  mailProtocolHealthInternals,
} from '../src/index.js';

function key(file, args) {
  return `${file} ${args.join(' ')}`;
}

function inspector({ missing = [] } = {}) {
  const absent = new Set(missing);
  return createMailProtocolHealthInspector({
    run: async (file, args) => {
      const match = args.at(-1).match(/:(\\d+)$/);
      const port = match ? Number.parseInt(match[1], 10) : null;
      return {
        stdout: absent.has(port)
          ? ''
          : `LISTEN 0 100 0.0.0.0:${port} 0.0.0.0:*\n`,
      };
    },
  });
}

test('requires SMTP, submission and IMAP listeners without exposing socket addresses', async () => {
  const result = await inspector().inspect();
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.protocols, [
    { id: 'smtp', port: 25, satisfied: true },
    { id: 'submission', port: 587, satisfied: true },
    { id: 'imap', port: 143, satisfied: true },
  ]);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('0.0.0.0'), false);
});

test('reports missing protocol listeners as bounded blockers', async () => {
  const result = await inspector({ missing: [587, 143] }).inspect();
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, ['submission', 'imap']);
  assert.equal(result.protocols.find((entry) => entry.id === 'smtp').satisfied, true);
});

test('uses the fixed ss binary and port-scoped listener filters', async () => {
  const calls = [];
  const result = await createMailProtocolHealthInspector({
    run: async (file, args) => {
      calls.push(key(file, args));
      return { stdout: 'LISTEN 0 100 127.0.0.1:1 0.0.0.0:*\n' };
    },
  }).inspect();

  assert.equal(result.ready, true);
  assert.deepEqual(calls, [
    `${mailProtocolHealthInternals.ssPath} -H -ltn sport = :25`,
    `${mailProtocolHealthInternals.ssPath} -H -ltn sport = :587`,
    `${mailProtocolHealthInternals.ssPath} -H -ltn sport = :143`,
  ]);
});
