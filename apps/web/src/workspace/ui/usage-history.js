import { usagePercent } from './console-model.js';
const valid = (value) => Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
export function usageSample(server) {
  const timestamp = Date.parse(server?.lastSeenAt);
  if (!Number.isFinite(timestamp) || typeof server?.id !== 'string' || !server.id) return null;
  const { cpu = {}, memory = {}, filesystem = {} } = server.inventory ?? {};
  return { timestamp, cpu: valid(cpu?.usagePercent), memory: usagePercent(memory?.usedBytes, memory?.totalBytes), disk: usagePercent(filesystem?.usedBytes, filesystem?.totalBytes) };
}
export function appendUsageSample(samples, sample, limit = 60) {
  if (!sample) return samples;
  const last = samples.at(-1);
  if (last && sample.timestamp < last.timestamp) return samples;
  if (last && sample.timestamp === last.timestamp) {
    if (['cpu', 'memory', 'disk'].every((key) => last[key] === sample[key])) return samples;
    return [...samples.slice(0, -1), sample];
  }
  return [...samples, sample].slice(-Math.max(2, Math.min(120, Number.isInteger(limit) ? limit : 60)));
}
export function usagePath(samples, key, { width = 640, height = 160 } = {}) {
  if (samples.length < 2) return '';
  const first = samples[0].timestamp;
  const duration = samples.at(-1).timestamp - first;
  if (duration <= 0) return '';
  let connected = false;
  return samples.map((sample) => {
    const value = valid(sample[key]);
    if (value === null) { connected = false; return ''; }
    const x = ((sample.timestamp - first) / duration * width).toFixed(2);
    const y = (height - value / 100 * height).toFixed(2);
    const segment = `${connected ? 'L' : 'M'}${x},${y}`;
    connected = true;
    return segment;
  }).filter(Boolean).join(' ');
}
