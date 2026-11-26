// Shared byte/size labels. Each screen keeps its established label style;
// only the formatting code lives here.
const STEP = 1024;
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function scale(value) {
  let size = value;
  let index = 0;
  while (size >= STEP && index < UNITS.length - 1) { size /= STEP; index += 1; }
  return { size, index };
}

// General label: `0 B`, `12 KB`, `1.5 GB`. Invalid input renders as `—`.
export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const { size, index } = scale(value);
  return `${size.toFixed(index >= 3 ? 1 : 0)} ${UNITS[index]}`;
}

// Precise label for exact integer inventories: `1.5 KB`, `10 MB`, `120 GB`.
export function formatPreciseBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) return '—';
  const { size, index } = scale(value);
  if (index === 0) return `${value} B`;
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${Number(size.toFixed(digits))} ${UNITS[index]}`;
}

// Turkish-locale label used by site resource usage: KB below 1 GB, then GB.
// Returns null for invalid input so callers can hide the value.
export function formatLocaleBytes(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value === 0) return '0 B';
  if (value < STEP) return `${Math.round(value).toLocaleString('tr-TR')} B`;
  const kib = value / STEP;
  if (kib < STEP * STEP) return `${Math.round(kib).toLocaleString('tr-TR')} KB`;
  return `${(value / STEP ** 3).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} GB`;
}

// Mail queue/message sizes: `512 B`, `1.5 KiB`, `2.0 MiB`.
export function formatBinaryBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= STEP ** 2) return `${(value / STEP ** 2).toFixed(1)} MiB`;
  if (value >= STEP) return `${(value / STEP).toFixed(1)} KiB`;
  return `${value} B`;
}

// Mailbox quotas: whole MiB below 1 GiB, then GiB.
export function formatQuotaBytes(value) {
  if (!Number.isFinite(value)) return '—';
  const gib = value / STEP ** 3;
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB`;
  return `${Math.round(value / STEP ** 2)} MiB`;
}
