import assert from 'node:assert/strict';
import test from 'node:test';
import { usageSample, appendUsageSample, usagePath } from '../src/workspace/ui/usage-history.js';
const server = { id: 'local', lastSeenAt: '2026-09-22T03:00:00Z', inventory: { cpu: { usagePercent: 0 }, memory: { usedBytes: 91, totalBytes: 100 }, filesystem: { usedBytes: 50, totalBytes: 100 } } };
const point = (timestamp, cpu = 0) => ({ timestamp, cpu, memory: 50, disk: 70 });
test('samples use real timestamps and keep zero rather than fabricating history', () => {
  assert.deepEqual(usageSample(server), { timestamp: Date.parse(server.lastSeenAt), cpu: 0, memory: 91, disk: 50 });
  assert.equal(usageSample({ ...server, lastSeenAt: 'bad' }), null);
  assert.equal(usageSample({ ...server, id: '' }), null);
  assert.equal(usagePath([point(0)], 'cpu'), '');
});
test('absent or invalid metrics remain unknown', () => {
  assert.equal(usageSample({ ...server, inventory: {} }).cpu, null);
  assert.equal(usageSample({ ...server, inventory: { cpu: { usagePercent: 101 } } }).cpu, null);
  assert.equal(usageSample({ ...server, inventory: { cpu: null, memory: null, filesystem: null } }).disk, null);
});
test('duplicate samples are not counted as new measurements', () => {
  const samples = [point(100, 20)];
  assert.equal(appendUsageSample(samples, point(100, 20)), samples);
  assert.equal(appendUsageSample(samples, null), samples);
  assert.equal(appendUsageSample(samples, point(99, 30)), samples);
  assert.deepEqual(appendUsageSample(samples, point(100, 30)), [point(100, 30)]);
});
test('history is bounded while keeping the newest readings', () => {
  let samples = [];
  for (let index = 0; index < 80; index++) samples = appendUsageSample(samples, point(index));
  assert.equal(samples.length, 60); assert.equal(samples[0].timestamp, 20);
  assert.equal(appendUsageSample(samples, point(81), 3).length, 3);
});
test('plot scales actual time intervals rather than equally spacing every point', () => {
  assert.equal(usagePath([point(0, 0), point(50, 50), point(100, 100)], 'cpu'), 'M0.00,160.00 L320.00,80.00 L640.00,0.00');
  assert.equal(usagePath([point(0, 0), point(10, 50), point(100, 100)], 'cpu'), 'M0.00,160.00 L64.00,80.00 L640.00,0.00');
});
test('plot leaves gaps for missing or invalid values', () => {
  assert.equal(usagePath([point(0, 0), point(50, null), point(100, 100)], 'cpu'), 'M0.00,160.00 M640.00,0.00');
  assert.equal(usagePath([point(0, NaN), point(50, 110)], 'cpu'), '');
  assert.equal(usagePath([point(0, 0), point(0, 20)], 'cpu'), '');
});
