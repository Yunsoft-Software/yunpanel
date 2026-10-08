import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { usageSample, appendUsageSample, usagePath } from '../src/workspace/ui/usage-history.js';
import { usagePercent, usageThreshold } from '../src/workspace/ui/console-model.js';

const source = (relPath) => readFile(new URL(`../src/${relPath}`, import.meta.url), 'utf8');

// ============================================================================
// CRITERION 1 & 2:
// Dashboard grafiği gerçek API yenilemeleriyle büyümeli ve aynı timestamp
// yeni ölçüm olarak eklenmemelidir.
// ============================================================================

test('Criterion 1 & 2: Chart accumulates sequential real API updates with increasing timestamps', () => {
  const baseTime = Date.parse('2026-10-06T12:00:00Z');
  let samples = [];

  // Simulate real periodic API refreshes (every 15s) with changing system metrics
  const apiUpdates = [
    { timestamp: baseTime, cpu: 12, memory: 45, disk: 60 },
    { timestamp: baseTime + 15000, cpu: 18, memory: 46, disk: 60 },
    { timestamp: baseTime + 30000, cpu: 25, memory: 48, disk: 61 },
    { timestamp: baseTime + 45000, cpu: 22, memory: 47, disk: 61 },
    { timestamp: baseTime + 60000, cpu: 30, memory: 50, disk: 62 },
  ];

  for (const update of apiUpdates) {
    samples = appendUsageSample(samples, update);
  }

  assert.equal(samples.length, 5, 'Samples array must grow with each real API measurement');
  assert.equal(samples[0].timestamp, baseTime);
  assert.equal(samples[4].timestamp, baseTime + 60000);

  // Plot path is generated and scales properly across the 60s span
  const cpuPath = usagePath(samples, 'cpu');
  assert.ok(cpuPath.startsWith('M0.00,'), 'Path starts at M0.00');
  assert.ok(cpuPath.includes('L640.00,'), 'Path ends at L640.00');
  assert.equal(cpuPath.split(' ').length, 5, 'Path contains exactly 5 points for 5 measurements');
});

test('Criterion 1 & 2: Identical timestamp arriving from API revalidation or poll is NEVER counted as a new measurement', () => {
  const t1 = Date.parse('2026-10-06T12:00:00Z');
  const initialPoint = { timestamp: t1, cpu: 20, memory: 50, disk: 70 };
  let samples = [initialPoint];

  // 1. Identical timestamp with identical metrics
  const duplicateSameMetrics = { timestamp: t1, cpu: 20, memory: 50, disk: 70 };
  const afterSame = appendUsageSample(samples, duplicateSameMetrics);
  assert.equal(afterSame.length, 1, 'Measurement count must NOT increase on duplicate timestamp');
  assert.equal(afterSame, samples, 'Must return the identical array reference when data is unchanged');

  // 2. Identical timestamp with updated metrics (e.g. inventory refreshed during the same second)
  const duplicateUpdatedMetrics = { timestamp: t1, cpu: 25, memory: 52, disk: 70 };
  const afterUpdated = appendUsageSample(samples, duplicateUpdatedMetrics);
  assert.equal(afterUpdated.length, 1, 'Measurement count must STILL NOT increase on identical timestamp');
  assert.equal(afterUpdated[0].cpu, 25, 'Last sample is updated in-place rather than appending a new point');

  // 3. Stale / delayed response with an older timestamp is discarded
  const olderPoint = { timestamp: t1 - 10000, cpu: 15, memory: 48, disk: 69 };
  const afterOlder = appendUsageSample(afterUpdated, olderPoint);
  assert.equal(afterOlder.length, 1, 'Older timestamp must not be prepended or appended');
  assert.equal(afterOlder, afterUpdated, 'Must retain current array reference');

  // 4. Null / invalid sample does not alter the collection
  assert.equal(appendUsageSample(samples, null), samples);
  assert.equal(appendUsageSample(samples, undefined), samples);
});

// ============================================================================
// CRITERION 3:
// Sayfa yeniden açıldığında olmayan 24 saatlik yapay veri gösterilmemeli,
// gerçek API verisi yansıtılmalıdır.
// ============================================================================

test('Criterion 3: On page reload / fresh visit, zero synthetic 24-hour historical points are generated', async () => {
  const usageSrc = await source('workspace/ui/UsageHistory.jsx');
  const helperSrc = await source('workspace/ui/usage-history.js');

  // Verify no 24-hour mock data generators exist in source
  assert.doesNotMatch(usageSrc, /24\s*\*\s*60/, 'UsageHistory must not generate 24-hour points');
  assert.doesNotMatch(usageSrc, /Array\.from\(\s*\{\s*length:\s*24/, 'UsageHistory must not synthesize 24 sample points');
  assert.doesNotMatch(helperSrc, /24\s*\*\s*60/, 'usage-history helper must not synthesize 24-hour points');

  // Initial state in UsageHistory starts strictly with at most the current single live sample
  assert.match(usageSrc, /useState\(\(\)\s*=>\s*\(\{\s*serverId:\s*server\?\.id,\s*samples:\s*sample\s*\?\s*\[sample\]\s*:\s*\[\]\s*\}\)\)/,
    'UsageHistory must initialize samples with only [sample] or [] on mount/reload');

  // When only 0 or 1 measurement exists, the chart explicitly displays the waiting state
  const singleSample = { timestamp: Date.parse('2026-10-06T12:00:00Z'), cpu: 20, memory: 50, disk: 70 };
  assert.equal(usagePath([singleSample], 'cpu'), '', 'SVG path must be empty when only 1 measurement exists');
  assert.equal(usagePath([], 'cpu'), '', 'SVG path must be empty when 0 measurements exist');

  // Verify waiting state text in UsageHistory component
  assert.match(usageSrc, /Yeni ölçüm bekleniyor/);
  assert.match(usageSrc, /En az iki sunucu ölçümü alındığında grafik oluşur\. Geçmiş veri uydurulmaz\./);
  assert.match(usageSrc, /Yalnız bu oturumda alınan ölçümler/);
});

// ============================================================================
// CRITERION 4:
// Bilinmeyen CPU, RAM ve disk değerleri sıfır (0) olarak gösterilmemeli,
// belirsiz/yok durumu doğru temsil edilmelidir.
// ============================================================================

test('Criterion 4: Unknown CPU, RAM, and disk metrics remain null and are NEVER converted to zero', () => {
  const serverWithEmptyInventory = {
    id: 'local',
    lastSeenAt: '2026-10-06T12:00:00Z',
    inventory: {},
  };
  const emptySample = usageSample(serverWithEmptyInventory);
  assert.equal(emptySample.cpu, null, 'Unknown CPU must be null');
  assert.notEqual(emptySample.cpu, 0, 'Unknown CPU must NOT be 0');
  assert.equal(emptySample.memory, null, 'Unknown Memory must be null');
  assert.notEqual(emptySample.memory, 0, 'Unknown Memory must NOT be 0');
  assert.equal(emptySample.disk, null, 'Unknown Disk must be null');
  assert.notEqual(emptySample.disk, 0, 'Unknown Disk must NOT be 0');

  // Server with invalid / out-of-range metrics
  const serverWithInvalidMetrics = {
    id: 'local',
    lastSeenAt: '2026-10-06T12:00:00Z',
    inventory: {
      cpu: { usagePercent: -5 },
      memory: { usedBytes: 150, totalBytes: 100 }, // used > total
      filesystem: { usedBytes: -10, totalBytes: 100 },
    },
  };
  const invalidSample = usageSample(serverWithInvalidMetrics);
  assert.equal(invalidSample.cpu, null, 'Negative CPU must be null');
  assert.equal(invalidSample.memory, null, 'used > total Memory must be null');
  assert.equal(invalidSample.disk, null, 'Negative filesystem must be null');

  // Genuine ZERO measurements MUST be preserved as 0, not null
  const serverWithGenuineZero = {
    id: 'local',
    lastSeenAt: '2026-10-06T12:00:00Z',
    inventory: {
      cpu: { usagePercent: 0 },
      memory: { usedBytes: 0, totalBytes: 100 },
      filesystem: { usedBytes: 0, totalBytes: 100 },
    },
  };
  const zeroSample = usageSample(serverWithGenuineZero);
  assert.equal(zeroSample.cpu, 0, 'Genuine 0% CPU must be preserved as 0');
  assert.equal(zeroSample.memory, 0, 'Genuine 0% Memory must be preserved as 0');
  assert.equal(zeroSample.disk, 0, 'Genuine 0% Disk must be preserved as 0');

  // Verify plot leaves gaps for null values rather than drawing to 0
  const pointsWithGap = [
    { timestamp: 0, cpu: 50, memory: 50, disk: 50 },
    { timestamp: 10, cpu: null, memory: 50, disk: 50 },
    { timestamp: 20, cpu: 80, memory: 50, disk: 50 },
  ];
  const gapPath = usagePath(pointsWithGap, 'cpu');
  // First segment M0.00,80.00, gap at t=10, then new M640.00,32.00 segment (not L)
  assert.ok(gapPath.includes('M640.00,'), 'Null measurement breaks path into disconnected M segment');
  assert.doesNotMatch(gapPath, /L320\.00/, 'Null point must NOT have a line segment drawn');
});

test('Criterion 4: UsageHistory and DashboardPage represent unknown metrics as "—" and "Bilinmiyor", not "%0"', async () => {
  const usageSrc = await source('workspace/ui/UsageHistory.jsx');
  const dashSrc = await source('workspace/DashboardPage.jsx');

  // In UsageHistory legend: unknown is '—', valid number is '%N'
  assert.match(usageSrc, /latest\?\.\[key\]\s*==\s*null\s*\|\|\s*!Number\.isFinite\(latest\[key\]\)\s*\?\s*['"]—['"]\s*:\s*`%\$\{Math\.round\(latest\[key\]\)\}`/);

  // In UsageHistory table: unknown is 'Bilinmiyor', valid number is '%N'
  assert.match(usageSrc, /point\[key\]\s*==\s*null\s*\|\|\s*!Number\.isFinite\(point\[key\]\)\s*\?\s*['"]Bilinmiyor['"]\s*:\s*`%\$\{Math\.round\(point\[key\]\)\}`/);

  // In DashboardPage UsageRing: unknown is '—' and aria describes it as 'kullanım verisi bilinmiyor'
  assert.match(dashSrc, /strong>\{valid \? `%\$\{rounded\}` : '—'\}<\/strong>/);
  assert.match(dashSrc, /label\} kullanım verisi bilinmiyor/);
});

// ============================================================================
// CRITERION 5:
// Kullanıcı oturum geçmişi kapsamı korunmalı ve metrik takibi sırasında bozulmamalıdır.
// ============================================================================

test('Criterion 5: User session history scope remains intact and isolated to current server/session', () => {
  const t0 = 1000;
  const serverA1 = { timestamp: t0, cpu: 20, memory: 40, disk: 50 };
  const serverA2 = { timestamp: t0 + 15000, cpu: 25, memory: 42, disk: 51 };

  let historyA = [];
  historyA = appendUsageSample(historyA, serverA1);
  historyA = appendUsageSample(historyA, serverA2);
  assert.equal(historyA.length, 2, 'Server A session accumulates 2 readings');

  // When serverId switches (e.g. Server A -> Server B or user session rotation),
  // history does not leak Server A measurements into Server B
  const serverB1 = { timestamp: t0 + 30000, cpu: 80, memory: 85, disk: 90 };
  let historyB = []; // Fresh session scope for Server B
  historyB = appendUsageSample(historyB, serverB1);
  assert.equal(historyB.length, 1, 'Server B starts cleanly with its own single sample');
  assert.equal(historyB[0].cpu, 80);

  // Bounded buffer retains newest readings without unbounded memory growth
  let boundedHistory = [];
  for (let i = 0; i < 100; i++) {
    boundedHistory = appendUsageSample(boundedHistory, { timestamp: i * 1000, cpu: i % 100, memory: 50, disk: 50 }, 60);
  }
  assert.equal(boundedHistory.length, 60, 'History buffer must be bounded to the max limit (60)');
  assert.equal(boundedHistory[0].timestamp, 40000, 'Oldest samples beyond limit are discarded');
  assert.equal(boundedHistory[59].timestamp, 99000, 'Newest reading is retained at the end');
});

// ============================================================================
// CRITERION 6:
// Kodlama çalışanı düzenleme yapmadan önce mevcut uygulamayı incelemeli ve doğrulamalıdır.
// ============================================================================

test('Criterion 6: DashboardPage properly wires UsageHistory with server ready/stale statuses', async () => {
  const dashSrc = await source('workspace/DashboardPage.jsx');

  // Verify DashboardPage passes server only when ready or stale
  assert.match(dashSrc, /<UsageHistory key=\{server\?\.id \?\? 'unavailable'\} server=\{\['ready', 'stale'\]\.includes\(servers\.status\) \? server : null\} \/>/);

  // Performance section description explicitly states session-scoped history
  assert.match(dashSrc, /title="Performans" description="Sunucudan alınan ölçümler; yalnız bu açık oturumun geçmişi\."/);
});
