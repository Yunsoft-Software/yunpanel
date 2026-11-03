import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runSentinelCheck } from '../src/notification-sentinel.js';

async function fixture(t, { address = 'owner@example.com' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yp-sentinel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notificationStore = path.join(directory, 'operational-notifications.json');
  if (address !== undefined) await writeFile(notificationStore, JSON.stringify({ alertAddress: address }));
  const sent = [];
  const logged = [];
  const state = { up: { api: true, web: true }, mailFails: false };
  const run = () => runSentinelCheck({
    targets: [{ id: 'api', label: 'Panel API' }, { id: 'web', label: 'Panel arayüzü' }],
    probe: async (target) => state.up[target.id],
    notificationStore,
    stateFile: path.join(directory, 'sentinel.json'),
    hostname: 'srv1',
    mailer: { async sendMail(mail) { if (state.mailFails) throw new Error('smtp down'); sent.push(mail); } },
    logger: { error: (...args) => logged.push(args) },
  });
  return { run, state, sent, logged, directory };
}

test('one failed check stays quiet; the second sends one alert; recovery sends one all-clear', async (t) => {
  const { run, state, sent, directory } = await fixture(t);
  await run();
  assert.equal(sent.length, 0);

  state.up.api = false;
  await run();
  assert.equal(sent.length, 0, 'a restart or a single blip must not alert');
  await run();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.match(sent[0].subject, /Panel API/);
  assert.match(sent[0].text, /srv1/);
  await run();
  assert.equal(sent.length, 1, 'an ongoing outage alerts once');

  state.up.api = true;
  await run();
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /düzeldi/i);
  await run();
  assert.equal(sent.length, 2);
  assert.equal((await stat(path.join(directory, 'sentinel.json'))).mode & 0o777, 0o600);
});

test('a failed send is retried on the next run', async (t) => {
  const { run, state, sent, logged } = await fixture(t);
  state.up.web = false;
  state.mailFails = true;
  await run();
  await run();
  assert.equal(sent.length, 0);
  assert.equal(logged.length, 1);

  state.mailFails = false;
  await run();
  assert.equal(sent.length, 1);
});

test('without an address the outage is logged and nothing throws', async (t) => {
  const { run, state, sent, logged } = await fixture(t, { address: null });
  state.up.api = false;
  await run();
  await run();
  assert.equal(sent.length, 0);
  assert.equal(logged.length, 1);
});

test('a broken state file does not stop the sentinel', async (t) => {
  const { run, state, sent, directory } = await fixture(t);
  await writeFile(path.join(directory, 'sentinel.json'), '{ broken');
  state.up.api = false;
  await run();
  await run();
  assert.equal(sent.length, 1);
  assert.equal(typeof JSON.parse(await readFile(path.join(directory, 'sentinel.json'), 'utf8')), 'object');
});
