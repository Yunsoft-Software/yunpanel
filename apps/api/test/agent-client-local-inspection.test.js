import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectLocalAgent } from '../src/agent-client.js';

test('development compatibility inspection uses the local host inspector without agent URL or token input', async () => {
  const calls = [];
  const previousUrl = process.env.YUN_AGENT_URL;
  const previousToken = process.env.YUN_AGENT_TOKEN;
  process.env.YUN_AGENT_URL = 'http://must-not-connect.invalid:9999';
  process.env.YUN_AGENT_TOKEN = 'PRIVATE_AGENT_TOKEN';
  try {
    const result = await inspectLocalAgent({
      inspect: async (options) => {
        calls.push(options);
        return { hostname: 'host-1.example.local', mode: 'local' };
      },
    });
    assert.deepEqual(calls, [{ mode: 'local' }]);
    assert.equal(result.operation, 'server.inspect');
    assert.equal(result.status, 'succeeded');
    assert.equal(typeof result.requestId, 'string');
    assert.deepEqual(result.result, { hostname: 'host-1.example.local', mode: 'local' });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AGENT_TOKEN|must-not-connect/);
  } finally {
    if (previousUrl === undefined) delete process.env.YUN_AGENT_URL;
    else process.env.YUN_AGENT_URL = previousUrl;
    if (previousToken === undefined) delete process.env.YUN_AGENT_TOKEN;
    else process.env.YUN_AGENT_TOKEN = previousToken;
  }
});

test('local inspection failures are reduced to a fixed compatibility error', async () => {
  await assert.rejects(
    inspectLocalAgent({ inspect: async () => { throw new Error('SECRET=/private/path token=PRIVATE'); } }),
    (error) => error.message === 'Local host inspection failed'
      && !error.message.includes('SECRET')
      && !error.message.includes('/private/path'),
  );
});

test('invalid local inspection results fail closed', async () => {
  for (const value of [null, [], 'invalid']) {
    await assert.rejects(
      inspectLocalAgent({ inspect: async () => value }),
      /Local host inspection returned invalid state/,
    );
  }
});
