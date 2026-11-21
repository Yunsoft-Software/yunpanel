import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { YUNPANEL_TRAFFIC_LOG_PATH } from '@yunpanel/config-templates';

const STORE_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T/;
const NON_NEG_INT_RE = /^\d+$/;
const TAIL_SAMPLE_BYTES = 64;

const NGINX_MONTHS = Object.freeze({
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
});
const COMBINED_LINE_RE = /^[^\s]+\s+\S+\s+\S+\s+\[(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{2})(\d{2})\]\s+"(?:\\.|[^"\\])*"\s+\d{3}\s+(\d+)(?:\s|$)/;

export class WebsiteTrafficLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WebsiteTrafficLedgerError';
    this.code = code;
  }
}

function currentUtcMonth(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 7);
}

function emptyCursor() {
  return { dev: null, ino: null, offset: 0, tailDigestSha256: null };
}

function emptyState() {
  return {
    version: STORE_VERSION,
    cursor: emptyCursor(),
    rotatedCursor: emptyCursor(),
    legacySources: {},
    monthGaps: {},
    sites: {},
    collector: {
      meterStartedAt: null,
      lastSweepAt: null,
      logFilePresent: false,
      lastErrorCode: null,
      lastRotationGapAt: null,
    },
  };
}

function normalizeCursor(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    dev: typeof c.dev === 'string' ? c.dev : null,
    ino: typeof c.ino === 'string' ? c.ino : null,
    offset: Number.isSafeInteger(c.offset) && c.offset >= 0 ? c.offset : 0,
    tailDigestSha256: typeof c.tailDigestSha256 === 'string' && /^[a-f0-9]{64}$/.test(c.tailDigestSha256)
      ? c.tailDigestSha256
      : null,
  };
}

function normalizePersistedState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== STORE_VERSION) {
    throw new WebsiteTrafficLedgerError('traffic_ledger_corrupted', 'Traffic ledger state is invalid');
  }
  const collector = raw.collector && typeof raw.collector === 'object' ? raw.collector : {};
  const monthGaps = {};
  if (raw.monthGaps && typeof raw.monthGaps === 'object' && !Array.isArray(raw.monthGaps)) {
    for (const [month, count] of Object.entries(raw.monthGaps)) {
      if (MONTH_RE.test(month) && Number.isSafeInteger(count) && count > 0) {
        monthGaps[month] = count;
      }
    }
  }
  const legacySources = {};
  if (raw.legacySources && typeof raw.legacySources === 'object' && !Array.isArray(raw.legacySources)) {
    for (const [sourcePath, entry] of Object.entries(raw.legacySources)) {
      if (typeof sourcePath !== 'string' || !sourcePath.startsWith('/') || !entry || typeof entry !== 'object') continue;
      if (typeof entry.websiteId !== 'string' || !UUID_RE.test(entry.websiteId)) continue;
      legacySources[sourcePath] = {
        websiteId: entry.websiteId,
        cursor: normalizeCursor(entry.cursor),
        rotatedCursor: normalizeCursor(entry.rotatedCursor),
        meterStartedAt: typeof entry.meterStartedAt === 'string' ? entry.meterStartedAt : null,
        healthy: entry.healthy !== false,
        lastErrorCode: typeof entry.lastErrorCode === 'string' ? entry.lastErrorCode : null,
      };
    }
  }
  const sites = {};
  if (raw.sites && typeof raw.sites === 'object' && !Array.isArray(raw.sites)) {
    for (const [siteId, entry] of Object.entries(raw.sites)) {
      if (!UUID_RE.test(siteId) || !entry || typeof entry !== 'object') continue;
      const months = {};
      if (entry.months && typeof entry.months === 'object' && !Array.isArray(entry.months)) {
        for (const [month, bucket] of Object.entries(entry.months)) {
          if (!MONTH_RE.test(month) || !bucket || typeof bucket !== 'object') continue;
          if (!Number.isSafeInteger(bucket.bytes) || bucket.bytes < 0) continue;
          if (!Number.isSafeInteger(bucket.requests) || bucket.requests < 0) continue;
          months[month] = {
            bytes: bucket.bytes,
            requests: bucket.requests,
            measuredAt: typeof bucket.measuredAt === 'string' ? bucket.measuredAt : null,
            rotationGapCount: Number.isSafeInteger(bucket.rotationGapCount) && bucket.rotationGapCount >= 0
              ? bucket.rotationGapCount
              : 0,
            accountingMode: bucket.accountingMode === 'legacy_applied_access_log'
              ? 'legacy_applied_access_log'
              : 'dedicated_traffic_log',
          };
        }
      }
      sites[siteId] = {
        months,
        lastMeasuredAt: typeof entry.lastMeasuredAt === 'string' ? entry.lastMeasuredAt : null,
        meterStartedAt: typeof entry.meterStartedAt === 'string' ? entry.meterStartedAt : null,
        accountingMode: entry.accountingMode === 'legacy_applied_access_log'
          ? 'legacy_applied_access_log'
          : 'dedicated_traffic_log',
      };
    }
  }
  return {
    version: STORE_VERSION,
    cursor: normalizeCursor(raw.cursor),
    rotatedCursor: normalizeCursor(raw.rotatedCursor),
    legacySources,
    monthGaps,
    sites,
    collector: {
      meterStartedAt: typeof collector.meterStartedAt === 'string' ? collector.meterStartedAt : null,
      lastSweepAt: typeof collector.lastSweepAt === 'string' ? collector.lastSweepAt : null,
      logFilePresent: collector.logFilePresent === true,
      lastErrorCode: typeof collector.lastErrorCode === 'string' ? collector.lastErrorCode : null,
      lastRotationGapAt: typeof collector.lastRotationGapAt === 'string' ? collector.lastRotationGapAt : null,
    },
  };
}

async function openRegularNoFollow(targetPath) {
  let st;
  try {
    st = await lstat(targetPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    return { status: 'error', code: 'traffic_log_unreadable' };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { status: 'unsafe', code: 'traffic_log_unsafe' };
  }

  let fh;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    fh = await open(targetPath, flags);
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing' };
    if (error?.code === 'ELOOP') return { status: 'unsafe', code: 'traffic_log_unsafe' };
    return { status: 'error', code: 'traffic_log_unreadable' };
  }

  try {
    const fhStat = await fh.stat({ bigint: true });
    if (!fhStat.isFile() || String(fhStat.dev) !== String(st.dev) || String(fhStat.ino) !== String(st.ino)) {
      await fh.close().catch(() => {});
      return { status: 'unsafe', code: 'traffic_log_unsafe' };
    }
    return {
      status: 'ok',
      fh,
      dev: String(fhStat.dev),
      ino: String(fhStat.ino),
      size: Number(fhStat.size),
    };
  } catch {
    await fh.close().catch(() => {});
    return { status: 'error', code: 'traffic_log_unreadable' };
  }
}

async function readTailDigest(fh, offset) {
  if (!Number.isSafeInteger(offset) || offset <= 0) return null;
  const start = Math.max(0, offset - TAIL_SAMPLE_BYTES);
  const length = offset - start;
  const buf = Buffer.allocUnsafe(length);
  const { bytesRead } = await fh.read(buf, 0, length, start);
  if (bytesRead <= 0) return null;
  return createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
}

function parseTrafficLine(line) {
  const cleaned = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!cleaned) return null;
  const parts = cleaned.split('\t');
  if (parts.length !== 3) return null;
  const [isoRaw, siteId, bytesRaw] = parts;
  if (!ISO_PREFIX_RE.test(isoRaw)) return null;
  const parsedTs = Date.parse(isoRaw);
  if (!Number.isFinite(parsedTs)) return null;
  if (!UUID_RE.test(siteId)) return null;
  if (!NON_NEG_INT_RE.test(bytesRaw)) return null;
  const bytes = Number.parseInt(bytesRaw, 10);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  return {
    month: new Date(parsedTs).toISOString().slice(0, 7),
    websiteId: siteId,
    bytes,
    accountingMode: 'dedicated_traffic_log',
  };
}

/**
 * Extracts ONLY [UTC YYYY-MM, body_bytes_sent] from Nginx's default combined access log line
 * for pre-upgrade already-applied managed vhosts. Client IP, URI, query string, referer, and
 * user-agent are discarded immediately and never persisted in the ledger.
 */
function parseLegacyCombinedLine(line, websiteId) {
  const cleaned = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!cleaned) return null;
  const match = COMBINED_LINE_RE.exec(cleaned);
  if (!match) return null;
  const [, day, mon, year, hh, mm, ss, tzH, tzM, bytesRaw] = match;
  const monthNum = NGINX_MONTHS[mon];
  if (!monthNum) return null;
  const parsedTs = Date.parse(`${year}-${monthNum}-${day}T${hh}:${mm}:${ss}${tzH}:${tzM}`);
  if (!Number.isFinite(parsedTs)) return null;
  const bytes = Number.parseInt(bytesRaw, 10);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  return {
    month: new Date(parsedTs).toISOString().slice(0, 7),
    websiteId,
    bytes,
    accountingMode: 'legacy_applied_access_log',
  };
}

function reasonForCode(code) {
  if (code === 'traffic_log_unsafe') {
    return 'Nginx trafik günlüğü güvenli bir normal dosya olmadığı için aylık trafik ölçülemedi.';
  }
  if (code === 'traffic_log_unreadable') {
    return 'Nginx trafik günlüğü okunamadığı için aylık trafik ölçülemedi.';
  }
  return 'Site bazında kalıcı aylık trafik günlüğü henüz oluşmadığı veya bu dönem için ölçüm bulunmadığı için trafik verisi gösterilmiyor.';
}

export function createWebsiteTrafficLedger({
  filePath = null,
  logPath = YUNPANEL_TRAFFIC_LOG_PATH,
  maxBytesPerPass = 16 * 1024 * 1024,
  maxRetainedMonths = 14,
  now = () => Date.now(),
  isMeteredWebsite = null,
  resolveLegacySources = null,
} = {}) {
  const effectiveMaxBytes = Number.isSafeInteger(maxBytesPerPass) && maxBytesPerPass > 0
    ? maxBytesPerPass
    : 16 * 1024 * 1024;
  const effectiveRetainedMonths = Number.isSafeInteger(maxRetainedMonths) && maxRetainedMonths >= 1
    ? maxRetainedMonths
    : 14;

  let state = emptyState();
  let loaded = false;
  let syncChain = Promise.resolve();

  async function ensureLoaded() {
    if (loaded) return;
    if (filePath) {
      try {
        const raw = await readFile(filePath, 'utf8');
        state = normalizePersistedState(JSON.parse(raw));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          if (error instanceof WebsiteTrafficLedgerError) throw error;
          throw new WebsiteTrafficLedgerError('traffic_ledger_corrupted', 'Traffic ledger file could not be loaded');
        }
        state = emptyState();
      }
    }
    loaded = true;
  }

  async function persist() {
    if (!filePath) return;
    const dir = path.dirname(filePath);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmpPath, filePath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  function recordTraffic(parsed, sweepIso, meterStartedAt = null) {
    let site = state.sites[parsed.websiteId];
    if (!site) {
      site = {
        months: {},
        lastMeasuredAt: null,
        meterStartedAt: meterStartedAt ?? state.collector.meterStartedAt ?? sweepIso,
        accountingMode: parsed.accountingMode ?? 'dedicated_traffic_log',
      };
      state.sites[parsed.websiteId] = site;
    }
    if (!site.meterStartedAt) {
      site.meterStartedAt = meterStartedAt ?? state.collector.meterStartedAt ?? sweepIso;
    }
    if (parsed.accountingMode === 'dedicated_traffic_log') {
      site.accountingMode = 'dedicated_traffic_log';
    }
    let bucket = site.months[parsed.month];
    if (!bucket) {
      bucket = {
        bytes: 0,
        requests: 0,
        measuredAt: sweepIso,
        rotationGapCount: state.monthGaps[parsed.month] ?? 0,
        accountingMode: parsed.accountingMode ?? 'dedicated_traffic_log',
      };
      site.months[parsed.month] = bucket;
    }
    if (parsed.accountingMode === 'dedicated_traffic_log') {
      bucket.accountingMode = 'dedicated_traffic_log';
    }
    bucket.bytes += parsed.bytes;
    bucket.requests += 1;
    bucket.measuredAt = sweepIso;
    site.lastMeasuredAt = sweepIso;
  }

  function recordRotationGap(month, sweepIso, siteId = null) {
    state.collector.lastRotationGapAt = sweepIso;
    if (siteId) {
      let site = state.sites[siteId];
      if (!site) {
        site = {
          months: {},
          lastMeasuredAt: null,
          meterStartedAt: state.collector.meterStartedAt ?? sweepIso,
          accountingMode: 'legacy_applied_access_log',
        };
        state.sites[siteId] = site;
      }
      const bucket = site.months[month];
      if (bucket) {
        bucket.rotationGapCount = (bucket.rotationGapCount ?? 0) + 1;
      } else {
        site.months[month] = {
          bytes: 0,
          requests: 0,
          measuredAt: sweepIso,
          rotationGapCount: 1,
          accountingMode: site.accountingMode,
        };
      }
      return;
    }
    state.monthGaps[month] = (state.monthGaps[month] ?? 0) + 1;
    for (const site of Object.values(state.sites)) {
      const bucket = site.months[month];
      if (bucket) {
        bucket.rotationGapCount = Math.max((bucket.rotationGapCount ?? 0) + 1, state.monthGaps[month]);
      }
    }
  }

  function pruneOldMonths() {
    for (const site of Object.values(state.sites)) {
      const keys = Object.keys(site.months).sort();
      if (keys.length > effectiveRetainedMonths) {
        const removeCount = keys.length - effectiveRetainedMonths;
        for (let i = 0; i < removeCount; i += 1) {
          delete site.months[keys[i]];
        }
      }
    }
    const gapKeys = Object.keys(state.monthGaps).sort();
    if (gapKeys.length > effectiveRetainedMonths) {
      const removeCount = gapKeys.length - effectiveRetainedMonths;
      for (let i = 0; i < removeCount; i += 1) {
        delete state.monthGaps[gapKeys[i]];
      }
    }
  }

  async function drainFileFromOffset(fh, startOffset, fileSize, maxBytes, sweepIso, parseLine, meterStartedAt = null) {
    const remaining = fileSize - startOffset;
    if (remaining <= 0) {
      return { bytesConsumed: 0, newOffset: startOffset, linesParsed: 0 };
    }
    const toRead = Math.min(remaining, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    let totalRead = 0;
    while (totalRead < toRead) {
      const { bytesRead } = await fh.read(buf, totalRead, toRead - totalRead, startOffset + totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    const slice = buf.subarray(0, totalRead);
    const lastNewline = slice.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return { bytesConsumed: 0, newOffset: startOffset, linesParsed: 0 };
    }
    const completeText = slice.subarray(0, lastNewline + 1).toString('utf8');
    const lines = completeText.split('\n');
    let linesParsed = 0;
    for (let i = 0; i < lines.length - 1; i += 1) {
      const parsed = parseLine(lines[i]);
      if (parsed) {
        recordTraffic(parsed, sweepIso, meterStartedAt);
        linesParsed += 1;
      }
    }
    const bytesConsumed = lastNewline + 1;
    return { bytesConsumed, newOffset: startOffset + bytesConsumed, linesParsed };
  }

  async function drainTrackedLogFile({
    targetPath,
    prevCursor,
    prevRotatedCursor,
    parseLine,
    maxBytes,
    sweepIso,
    currentMonth,
    initializeAtEof = false,
    gapSiteId = null,
    meterStartedAt = null,
  }) {
    const active = await openRegularNoFollow(targetPath);
    if (active.status !== 'ok') {
      return {
        status: active.status,
        code: active.status === 'missing' ? 'traffic_log_missing' : active.code,
        cursor: prevCursor,
        rotatedCursor: prevRotatedCursor,
        linesParsed: 0,
        bytesConsumed: 0,
      };
    }

    let totalLinesParsed = 0;
    let totalBytesConsumed = 0;
    let nextRotatedCursor = { ...prevRotatedCursor };

    try {
      if (initializeAtEof && prevCursor.ino === null) {
        const initOffset = active.size;
        const initDigest = initOffset > 0 ? await readTailDigest(active.fh, initOffset) : null;
        return {
          status: 'ok',
          cursor: {
            dev: active.dev,
            ino: active.ino,
            offset: initOffset,
            tailDigestSha256: initDigest,
          },
          rotatedCursor: emptyCursor(),
          linesParsed: 0,
          bytesConsumed: 0,
        };
      }

      const prev = prevCursor;
      const isActiveInodeChanged = prev.ino !== null && (prev.dev !== active.dev || prev.ino !== active.ino);
      const isSameInode = prev.ino !== null && prev.dev === active.dev && prev.ino === active.ino;
      let sameInodeUnchanged = false;
      if (isSameInode && active.size >= prev.offset) {
        if (prev.offset === 0) {
          sameInodeUnchanged = true;
        } else {
          const currentDigest = await readTailDigest(active.fh, prev.offset);
          sameInodeUnchanged = currentDigest === prev.tailDigestSha256;
        }
      }

      // 1. Drain any delayed post-rename USR1 worker flushes appended to the previously rotated .1 inode
      //    ONLY when the active file itself did not just undergo a new rename or copytruncate rotation.
      if (!isActiveInodeChanged && (!isSameInode || sameInodeUnchanged) && nextRotatedCursor.ino !== null) {
        const prevRotated = nextRotatedCursor;
        const rotated = await openRegularNoFollow(`${targetPath}.1`);
        if (rotated.status === 'ok') {
          try {
            if (rotated.dev === prevRotated.dev && rotated.ino === prevRotated.ino) {
              if (rotated.size > prevRotated.offset) {
                const checkDigest = prevRotated.offset > 0
                  ? await readTailDigest(rotated.fh, prevRotated.offset)
                  : null;
                if (prevRotated.offset === 0 || checkDigest === prevRotated.tailDigestSha256) {
                  const tail = await drainFileFromOffset(
                    rotated.fh,
                    prevRotated.offset,
                    rotated.size,
                    maxBytes,
                    sweepIso,
                    parseLine,
                    meterStartedAt,
                  );
                  totalLinesParsed += tail.linesParsed;
                  totalBytesConsumed += tail.bytesConsumed;
                  nextRotatedCursor = {
                    dev: rotated.dev,
                    ino: rotated.ino,
                    offset: tail.newOffset,
                    tailDigestSha256: tail.newOffset > 0 ? await readTailDigest(rotated.fh, tail.newOffset) : null,
                  };
                } else {
                  recordRotationGap(currentMonth, sweepIso, gapSiteId);
                  nextRotatedCursor = emptyCursor();
                }
              } else if (rotated.size < prevRotated.offset) {
                recordRotationGap(currentMonth, sweepIso, gapSiteId);
                nextRotatedCursor = emptyCursor();
              }
            } else {
              nextRotatedCursor = emptyCursor();
            }
          } finally {
            await rotated.fh.close().catch(() => {});
          }
        } else if (rotated.status === 'missing') {
          nextRotatedCursor = emptyCursor();
        }
      }

      // Helper to recover pre-truncate tail from .1 during copytruncate
      async function tryDrainCopytruncateRotated() {
        const rotated = await openRegularNoFollow(`${targetPath}.1`);
        let recovered = false;
        if (rotated.status === 'ok') {
          try {
            if (rotated.size >= prev.offset) {
              const rotatedDigest = prev.offset > 0 ? await readTailDigest(rotated.fh, prev.offset) : null;
              if (prev.offset === 0 || rotatedDigest === prev.tailDigestSha256) {
                recovered = true;
                const budget = Math.max(0, maxBytes - totalBytesConsumed);
                const tail = budget > 0
                  ? await drainFileFromOffset(rotated.fh, prev.offset, rotated.size, budget, sweepIso, parseLine, meterStartedAt)
                  : { bytesConsumed: 0, newOffset: prev.offset, linesParsed: 0 };
                totalLinesParsed += tail.linesParsed;
                totalBytesConsumed += tail.bytesConsumed;
              }
            }
          } finally {
            await rotated.fh.close().catch(() => {});
          }
        }
        return recovered;
      }

      // 2. Check active log inode for rename rotation or copytruncate
      let startOffset = 0;
      if (isActiveInodeChanged) {
        const rotated = await openRegularNoFollow(`${targetPath}.1`);
        let matchedRotated = false;
        if (rotated.status === 'ok') {
          try {
            if (rotated.dev === prev.dev && rotated.ino === prev.ino && rotated.size >= prev.offset) {
              const rotatedDigest = prev.offset > 0 ? await readTailDigest(rotated.fh, prev.offset) : null;
              if (prev.offset === 0 || rotatedDigest === prev.tailDigestSha256) {
                matchedRotated = true;
                const budget = Math.max(0, maxBytes - totalBytesConsumed);
                const tail = budget > 0
                  ? await drainFileFromOffset(rotated.fh, prev.offset, rotated.size, budget, sweepIso, parseLine, meterStartedAt)
                  : { bytesConsumed: 0, newOffset: prev.offset, linesParsed: 0 };
                totalLinesParsed += tail.linesParsed;
                totalBytesConsumed += tail.bytesConsumed;
                nextRotatedCursor = {
                  dev: rotated.dev,
                  ino: rotated.ino,
                  offset: tail.newOffset,
                  tailDigestSha256: tail.newOffset > 0 ? await readTailDigest(rotated.fh, tail.newOffset) : null,
                };
              }
            }
          } finally {
            await rotated.fh.close().catch(() => {});
          }
        }
        if (!matchedRotated) {
          recordRotationGap(currentMonth, sweepIso, gapSiteId);
          nextRotatedCursor = emptyCursor();
        }
        startOffset = 0;
      } else if (isSameInode) {
        if (sameInodeUnchanged) {
          startOffset = prev.offset;
        } else {
          // copytruncate shrunk or overwrote past previous offset: verify and drain unread tail from .1 if available; else honestly record gap
          const recovered = await tryDrainCopytruncateRotated();
          if (!recovered) {
            recordRotationGap(currentMonth, sweepIso, gapSiteId);
          }
          nextRotatedCursor = emptyCursor();
          startOffset = 0;
        }
      }

      const activeBudget = Math.max(0, maxBytes - totalBytesConsumed);
      const drained = activeBudget > 0
        ? await drainFileFromOffset(active.fh, startOffset, active.size, activeBudget, sweepIso, parseLine, meterStartedAt)
        : { bytesConsumed: 0, newOffset: startOffset, linesParsed: 0 };

      totalLinesParsed += drained.linesParsed;
      totalBytesConsumed += drained.bytesConsumed;

      const newOffset = drained.newOffset;
      const newTailDigest = newOffset > 0 ? await readTailDigest(active.fh, newOffset) : null;

      return {
        status: 'ok',
        cursor: {
          dev: active.dev,
          ino: active.ino,
          offset: newOffset,
          tailDigestSha256: newTailDigest,
        },
        rotatedCursor: nextRotatedCursor,
        linesParsed: totalLinesParsed,
        bytesConsumed: totalBytesConsumed,
      };
    } finally {
      await active.fh.close().catch(() => {});
    }
  }

  async function syncLegacySources(sweepIso, currentMonth) {
    if (typeof resolveLegacySources !== 'function') {
      return { linesParsed: 0, bytesConsumed: 0, activeCount: 0 };
    }
    let resolved = [];
    try {
      const candidate = await Promise.resolve(resolveLegacySources());
      if (Array.isArray(candidate)) resolved = candidate;
    } catch {
      return { linesParsed: 0, bytesConsumed: 0, activeCount: 0 };
    }

    const activePaths = new Map();
    for (const item of resolved) {
      if (!item || typeof item !== 'object') continue;
      const siteId = typeof item.websiteId === 'string' ? item.websiteId.trim().toLowerCase() : '';
      const srcPath = typeof item.logPath === 'string' ? item.logPath : '';
      if (!UUID_RE.test(siteId) || !srcPath.startsWith('/')) continue;
      activePaths.set(srcPath, siteId);
    }

    let linesParsed = 0;
    let bytesConsumed = 0;

    // 1. Perform one final drain and retire legacy sources that upgraded to dedicated yunpanel_site_traffic
    for (const existingPath of Object.keys(state.legacySources)) {
      if (activePaths.has(existingPath)) continue;
      const entry = state.legacySources[existingPath];
      const finalDrain = await drainTrackedLogFile({
        targetPath: existingPath,
        prevCursor: entry.cursor,
        prevRotatedCursor: entry.rotatedCursor,
        parseLine: (line) => parseLegacyCombinedLine(line, entry.websiteId),
        maxBytes: effectiveMaxBytes,
        sweepIso,
        currentMonth,
        initializeAtEof: false,
        gapSiteId: entry.websiteId,
        meterStartedAt: entry.meterStartedAt ?? sweepIso,
      });
      if (finalDrain.status === 'ok') {
        linesParsed += finalDrain.linesParsed;
        bytesConsumed += finalDrain.bytesConsumed;
      }
      delete state.legacySources[existingPath];
    }

    // 2. Initialize (non-retroactively at EOF!) or drain active legacy applied vhost logs
    let activeCount = 0;
    for (const [srcPath, siteId] of activePaths.entries()) {
      const existing = state.legacySources[srcPath];
      const isNew = !existing || existing.websiteId !== siteId;
      const entryMeterStartedAt = isNew ? sweepIso : (existing.meterStartedAt ?? sweepIso);
      const outcome = await drainTrackedLogFile({
        targetPath: srcPath,
        prevCursor: isNew ? emptyCursor() : existing.cursor,
        prevRotatedCursor: isNew ? emptyCursor() : existing.rotatedCursor,
        parseLine: (line) => parseLegacyCombinedLine(line, siteId),
        maxBytes: effectiveMaxBytes,
        sweepIso,
        currentMonth,
        initializeAtEof: isNew,
        gapSiteId: siteId,
        meterStartedAt: entryMeterStartedAt,
      });
      if (outcome.status === 'ok') {
        activeCount += 1;
        linesParsed += outcome.linesParsed;
        bytesConsumed += outcome.bytesConsumed;
        state.legacySources[srcPath] = {
          websiteId: siteId,
          cursor: outcome.cursor,
          rotatedCursor: outcome.rotatedCursor,
          meterStartedAt: entryMeterStartedAt,
          healthy: true,
          lastErrorCode: null,
        };
      } else {
        state.legacySources[srcPath] = {
          websiteId: siteId,
          cursor: isNew ? emptyCursor() : existing.cursor,
          rotatedCursor: isNew ? emptyCursor() : existing.rotatedCursor,
          meterStartedAt: isNew ? null : existing.meterStartedAt,
          healthy: false,
          lastErrorCode: outcome.code ?? 'traffic_log_unreadable',
        };
      }
    }

    return { linesParsed, bytesConsumed, activeCount };
  }

  async function syncInternal() {
    await ensureLoaded();
    const nowMs = now();
    const sweepIso = new Date(nowMs).toISOString();
    const currentMonth = currentUtcMonth(nowMs);

    const dedicated = await drainTrackedLogFile({
      targetPath: logPath,
      prevCursor: state.cursor,
      prevRotatedCursor: state.rotatedCursor,
      parseLine: parseTrafficLine,
      maxBytes: effectiveMaxBytes,
      sweepIso,
      currentMonth,
      initializeAtEof: false,
      meterStartedAt: state.collector.meterStartedAt ?? sweepIso,
    });

    if (dedicated.status === 'ok') {
      state.cursor = dedicated.cursor;
      state.rotatedCursor = dedicated.rotatedCursor;
      if (!state.collector.meterStartedAt) {
        state.collector.meterStartedAt = sweepIso;
      }
      state.collector = {
        ...state.collector,
        lastSweepAt: sweepIso,
        logFilePresent: true,
        lastErrorCode: null,
      };
    } else {
      state.collector = {
        ...state.collector,
        lastSweepAt: sweepIso,
        logFilePresent: false,
        lastErrorCode: dedicated.code,
      };
    }

    const legacy = await syncLegacySources(sweepIso, currentMonth);
    if (legacy.activeCount > 0 && !state.collector.meterStartedAt) {
      state.collector.meterStartedAt = sweepIso;
    }

    pruneOldMonths();
    await persist();

    const totalLinesParsed = dedicated.linesParsed + legacy.linesParsed;
    const totalBytesConsumed = dedicated.bytesConsumed + legacy.bytesConsumed;
    if (dedicated.status !== 'ok' && legacy.activeCount === 0) {
      return Object.freeze({
        ok: false,
        reasonCode: dedicated.code,
        linesParsed: totalLinesParsed,
        bytesConsumed: totalBytesConsumed,
        lastSweepAt: sweepIso,
      });
    }

    return Object.freeze({
      ok: true,
      linesParsed: totalLinesParsed,
      bytesConsumed: totalBytesConsumed,
      lastSweepAt: sweepIso,
    });
  }

  function sync() {
    const run = syncChain.then(() => syncInternal());
    syncChain = run.catch(() => {});
    return run;
  }

  function findActiveLegacySourceForSite(siteId) {
    let earliest = null;
    let firstErrorCode = null;
    for (const entry of Object.values(state.legacySources)) {
      if (entry.websiteId !== siteId) continue;
      if (entry.healthy === false || entry.lastErrorCode) {
        if (!firstErrorCode) firstErrorCode = entry.lastErrorCode ?? 'traffic_log_unreadable';
        continue;
      }
      if (!earliest || (entry.meterStartedAt && entry.meterStartedAt < earliest)) {
        earliest = entry.meterStartedAt;
      }
    }
    if (earliest) return { present: true, meterStartedAt: earliest, lastErrorCode: null };
    return { present: false, meterStartedAt: null, lastErrorCode: firstErrorCode };
  }

  async function readSiteMonth(websiteId, month) {
    const normalizedSiteId = typeof websiteId === 'string' ? websiteId.trim().toLowerCase() : '';
    if (!UUID_RE.test(normalizedSiteId) || !MONTH_RE.test(month)) {
      return Object.freeze({
        ok: false,
        trafficMb: null,
        bytes: null,
        requests: null,
        measuredAt: null,
        meterStartedAt: null,
        period: MONTH_RE.test(month) ? month : null,
        scope: null,
        accountingMode: null,
        includesStaticAssets: null,
        completeness: null,
        rotationGapCount: 0,
        reasonCode: 'invalid_traffic_query',
        reason: 'Geçersiz site kimliği veya ay parametresi nedeniyle aylık trafik okunamadı.',
      });
    }

    const siteEntry = state.sites[normalizedSiteId] ?? null;
    const bucket = siteEntry?.months?.[month] ?? null;
    const legacyInfo = findActiveLegacySourceForSite(normalizedSiteId);
    const gapCount = Math.max(bucket?.rotationGapCount ?? 0, state.monthGaps[month] ?? 0);
    const completeness = gapCount > 0 ? 'partial_rotation_gap' : 'complete';
    const activeMonth = currentUtcMonth(now());

    if (bucket) {
      const mode = bucket.accountingMode === 'legacy_applied_access_log' && legacyInfo.present
        ? 'legacy_applied_access_log'
        : (bucket.accountingMode ?? siteEntry?.accountingMode ?? 'dedicated_traffic_log');
      const includesStaticAssets = mode === 'dedicated_traffic_log';
      const scope = includesStaticAssets ? 'nginx_outbound_body_bytes' : 'nginx_legacy_applied_access_log';
      const meterStartedAt = siteEntry?.meterStartedAt ?? legacyInfo.meterStartedAt ?? state.collector.meterStartedAt ?? null;
      return Object.freeze({
        ok: true,
        bytes: bucket.bytes,
        trafficMb: Number((bucket.bytes / (1024 * 1024)).toFixed(2)),
        requests: bucket.requests,
        measuredAt: bucket.measuredAt,
        meterStartedAt,
        period: month,
        scope,
        accountingMode: mode,
        includesStaticAssets,
        completeness,
        rotationGapCount: gapCount,
      });
    }

    // Only synthesize a verified 0 for the CURRENT active UTC month when a real live source is confirmed!
    if (month === activeMonth) {
      if (state.collector.logFilePresent && !state.collector.lastErrorCode && typeof isMeteredWebsite === 'function') {
        let metered = false;
        try { metered = (await Promise.resolve(isMeteredWebsite(normalizedSiteId))) === true; } catch { metered = false; }
        if (metered) {
          return Object.freeze({
            ok: true,
            bytes: 0,
            trafficMb: 0,
            requests: 0,
            measuredAt: state.collector.lastSweepAt,
            meterStartedAt: siteEntry?.meterStartedAt ?? state.collector.meterStartedAt ?? state.collector.lastSweepAt,
            period: month,
            scope: 'nginx_outbound_body_bytes',
            accountingMode: 'dedicated_traffic_log',
            includesStaticAssets: true,
            completeness,
            rotationGapCount: gapCount,
          });
        }
      }
      if (legacyInfo.present) {
        return Object.freeze({
          ok: true,
          bytes: 0,
          trafficMb: 0,
          requests: 0,
          measuredAt: state.collector.lastSweepAt,
          meterStartedAt: legacyInfo.meterStartedAt ?? state.collector.lastSweepAt,
          period: month,
          scope: 'nginx_legacy_applied_access_log',
          accountingMode: 'legacy_applied_access_log',
          includesStaticAssets: false,
          completeness,
          rotationGapCount: gapCount,
        });
      }
    }

    const code = month !== activeMonth
      ? 'traffic_source_unavailable'
      : (legacyInfo.lastErrorCode ?? state.collector.lastErrorCode ?? 'traffic_source_unavailable');
    return Object.freeze({
      ok: false,
      trafficMb: null,
      bytes: null,
      requests: null,
      measuredAt: null,
      meterStartedAt: null,
      period: month,
      scope: null,
      accountingMode: null,
      includesStaticAssets: null,
      completeness: null,
      rotationGapCount: gapCount,
      reasonCode: code,
      reason: reasonForCode(code),
    });
  }

  async function getWebsiteTraffic(websiteId, { month = currentUtcMonth(now()), sync: shouldSync = true } = {}) {
    await ensureLoaded();
    if (shouldSync) {
      try { await sync(); } catch { /* sync records collector error state safely */ }
    }
    return readSiteMonth(websiteId, month);
  }

  async function getMonthlyTotalsForWebsites(websiteIds = [], { month = currentUtcMonth(now()), sync: shouldSync = true } = {}) {
    await ensureLoaded();
    if (shouldSync) {
      try { await sync(); } catch { /* preserve persisted state */ }
    }
    const uniqueIds = [...new Set((Array.isArray(websiteIds) ? websiteIds : []).map((id) => String(id).trim().toLowerCase()).filter(Boolean))];
    const perSite = {};
    const unmeasuredWebsiteIds = [];
    let totalBytes = 0;
    let totalRequests = 0;
    let measuredCount = 0;
    let latestMeasuredTs = 0;
    let maxGapCount = state.monthGaps[month] ?? 0;

    for (const id of uniqueIds) {
      const entry = await readSiteMonth(id, month);
      perSite[id] = entry;
      if (entry.rotationGapCount > maxGapCount) maxGapCount = entry.rotationGapCount;
      if (entry.ok) {
        measuredCount += 1;
        totalBytes += entry.bytes;
        totalRequests += entry.requests;
        const ts = entry.measuredAt ? Date.parse(entry.measuredAt) : Number.NaN;
        if (Number.isFinite(ts) && ts > latestMeasuredTs) latestMeasuredTs = ts;
      } else {
        unmeasuredWebsiteIds.push(id);
      }
    }

    const completeness = maxGapCount > 0 ? 'partial_rotation_gap' : 'complete';
    const activeMonth = currentUtcMonth(now());

    if (uniqueIds.length === 0) {
      if (month === activeMonth && state.collector.logFilePresent && !state.collector.lastErrorCode) {
        return Object.freeze({
          ok: true,
          bytes: 0,
          trafficMb: 0,
          requests: 0,
          measuredAt: state.collector.lastSweepAt,
          meterStartedAt: state.collector.meterStartedAt ?? state.collector.lastSweepAt,
          period: month,
          scope: 'nginx_outbound_body_bytes',
          completeness,
          rotationGapCount: maxGapCount,
          partial: false,
          perSite: Object.freeze(perSite),
          unmeasuredWebsiteIds: Object.freeze([]),
        });
      }
      const code = month !== activeMonth
        ? 'traffic_source_unavailable'
        : (state.collector.lastErrorCode ?? 'traffic_source_unavailable');
      return Object.freeze({
        ok: false,
        bytes: null,
        trafficMb: null,
        requests: null,
        measuredAt: null,
        meterStartedAt: null,
        period: month,
        scope: null,
        completeness: null,
        rotationGapCount: maxGapCount,
        partial: false,
        perSite: Object.freeze(perSite),
        unmeasuredWebsiteIds: Object.freeze([]),
        reasonCode: code,
        reason: reasonForCode(code),
      });
    }

    if (measuredCount === 0) {
      const code = month !== activeMonth
        ? 'traffic_source_unavailable'
        : (state.collector.lastErrorCode ?? 'traffic_source_unavailable');
      return Object.freeze({
        ok: false,
        bytes: null,
        trafficMb: null,
        requests: null,
        measuredAt: null,
        meterStartedAt: null,
        period: month,
        scope: null,
        completeness: null,
        rotationGapCount: maxGapCount,
        partial: false,
        perSite: Object.freeze(perSite),
        unmeasuredWebsiteIds: Object.freeze(unmeasuredWebsiteIds),
        reasonCode: code,
        reason: reasonForCode(code),
      });
    }

    return Object.freeze({
      ok: true,
      bytes: totalBytes,
      trafficMb: Number((totalBytes / (1024 * 1024)).toFixed(2)),
      requests: totalRequests,
      measuredAt: latestMeasuredTs > 0 ? new Date(latestMeasuredTs).toISOString() : state.collector.lastSweepAt,
      meterStartedAt: state.collector.meterStartedAt ?? null,
      period: month,
      scope: 'nginx_outbound_body_bytes',
      completeness,
      rotationGapCount: maxGapCount,
      partial: unmeasuredWebsiteIds.length > 0,
      perSite: Object.freeze(perSite),
      unmeasuredWebsiteIds: Object.freeze(unmeasuredWebsiteIds),
    });
  }

  async function snapshot() {
    await ensureLoaded();
    return structuredClone(state);
  }

  return Object.freeze({
    init: ensureLoaded,
    sync,
    getWebsiteTraffic,
    getTrafficUsage: (websiteId) => getWebsiteTraffic(websiteId),
    getMonthlyTotalsForWebsites,
    snapshot,
  });
}

export const websiteTrafficLedgerInternals = Object.freeze({
  storeVersion: STORE_VERSION,
  currentUtcMonth,
  parseTrafficLine,
  parseLegacyCombinedLine,
  openRegularNoFollow,
});
