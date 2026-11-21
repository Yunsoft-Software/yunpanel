import { readFile } from 'node:fs/promises';
import path from 'node:path';

const NATIVE_QUOTA_MOUNT_OPTIONS = new Set([
  'prjquota',
  'usrquota',
  'grpquota',
  'pquota',
  'uquota',
  'gquota',
]);

function unescapeMountField(value) {
  return String(value ?? '').replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8)));
}

function parseProcMounts(text) {
  const entries = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const mountPoint = path.posix.normalize(unescapeMountField(parts[1])).replace(/\/+$/, '') || '/';
    const fsType = parts[2];
    const mountOptions = parts[3].split(',').map((opt) => opt.trim()).filter(Boolean);
    entries.push({ device: parts[0], mountPoint, fsType, mountOptions });
  }
  return entries;
}

function matchesMountPoint(targetPath, mountPoint) {
  if (mountPoint === '/') return true;
  return targetPath === mountPoint || targetPath.startsWith(`${mountPoint}/`);
}

export async function inspectNativeDiskQuotaSupport({
  targetPath = '/var/www/yunpanel/apps',
  procMountsPath = '/proc/mounts',
  readFileFn = readFile,
} = {}) {
  const normalizedTarget = typeof targetPath === 'string' && path.posix.isAbsolute(targetPath)
    ? (path.posix.normalize(targetPath.trim()).replace(/\/+$/, '') || '/')
    : null;

  if (!normalizedTarget) {
    return Object.freeze({
      nativeHardQuotaSupported: false,
      mountPoint: null,
      fsType: null,
      mountOptions: Object.freeze([]),
      enforcementMode: 'managed_write_guard',
      reasonCode: 'invalid_target_path',
    });
  }

  let content;
  try {
    content = await readFileFn(procMountsPath, 'utf8');
  } catch {
    return Object.freeze({
      nativeHardQuotaSupported: false,
      mountPoint: null,
      fsType: null,
      mountOptions: Object.freeze([]),
      enforcementMode: 'managed_write_guard',
      reasonCode: 'proc_mounts_unavailable',
    });
  }

  const mounts = parseProcMounts(content);
  let best = null;
  for (const entry of mounts) {
    if (!matchesMountPoint(normalizedTarget, entry.mountPoint)) continue;
    if (!best || entry.mountPoint.length >= best.mountPoint.length) {
      best = entry;
    }
  }

  if (!best) {
    return Object.freeze({
      nativeHardQuotaSupported: false,
      mountPoint: null,
      fsType: null,
      mountOptions: Object.freeze([]),
      enforcementMode: 'managed_write_guard',
      reasonCode: 'mount_point_not_found',
    });
  }

  const hasQuotaOption = best.mountOptions.some((opt) => NATIVE_QUOTA_MOUNT_OPTIONS.has(opt))
    && !best.mountOptions.includes('noquota');

  return Object.freeze({
    nativeHardQuotaSupported: hasQuotaOption,
    mountPoint: best.mountPoint,
    fsType: best.fsType,
    mountOptions: Object.freeze([...best.mountOptions]),
    enforcementMode: hasQuotaOption ? 'native_quota_available' : 'managed_write_guard',
    reasonCode: hasQuotaOption ? 'native_quota_mount_option_present' : 'mount_missing_quota_option',
  });
}

export const diskQuotaCapabilityInternals = Object.freeze({
  nativeQuotaMountOptions: Object.freeze([...NATIVE_QUOTA_MOUNT_OPTIONS]),
  parseProcMounts,
});
