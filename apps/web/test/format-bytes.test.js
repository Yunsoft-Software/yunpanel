import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatBinaryBytes, formatBytes, formatLocaleBytes, formatPreciseBytes, formatQuotaBytes,
} from '../src/workspace/format-bytes.js';
import { formatBytes as siteFormatBytes } from '../src/workspace/site-model.js';
import { formatDatabaseBytes } from '../src/workspace/database-model.js';

test('formatBytes keeps the general B/KB/MB/GB/TB label and rejects invalid input', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(formatBytes(3 * 1024 ** 5), '3072.0 TB');
  for (const invalid of [-1, NaN, Infinity, null, '12']) assert.equal(formatBytes(invalid), '—');
  assert.equal(siteFormatBytes, formatBytes);
});

test('formatPreciseBytes keeps significant digits and is the database label', () => {
  assert.equal(formatPreciseBytes(500), '500 B');
  assert.equal(formatPreciseBytes(1536), '1.5 KB');
  assert.equal(formatPreciseBytes(12.25 * 1024 ** 2), '12.3 MB');
  assert.equal(formatPreciseBytes(150 * 1024 ** 3), '150 GB');
  assert.equal(formatPreciseBytes(2048 * 1024 ** 4), '2048 TB');
  for (const invalid of [-1, 1.5, NaN, null]) assert.equal(formatPreciseBytes(invalid), '—');
  assert.equal(formatDatabaseBytes, formatPreciseBytes);
});

test('formatLocaleBytes uses Turkish grouping, KB below 1 GB and null for invalid input', () => {
  assert.equal(formatLocaleBytes(0), '0 B');
  assert.equal(formatLocaleBytes(512.4), '512 B');
  assert.equal(formatLocaleBytes(5000 * 1024), '5.000 KB');
  assert.equal(formatLocaleBytes(1.25 * 1024 ** 3), '1,3 GB');
  assert.equal(formatLocaleBytes(-5), null);
  assert.equal(formatLocaleBytes(NaN), null);
});

test('formatBinaryBytes and formatQuotaBytes keep mail size labels', () => {
  assert.equal(formatBinaryBytes(512), '512 B');
  assert.equal(formatBinaryBytes(1536), '1.5 KiB');
  assert.equal(formatBinaryBytes(2 * 1024 ** 2), '2.0 MiB');
  assert.equal(formatBinaryBytes(undefined), '—');
  assert.equal(formatQuotaBytes(512 * 1024 ** 2), '512 MiB');
  assert.equal(formatQuotaBytes(1.5 * 1024 ** 3), '1.5 GiB');
  assert.equal(formatQuotaBytes(20 * 1024 ** 3), '20 GiB');
  assert.equal(formatQuotaBytes(null), '—');
});
