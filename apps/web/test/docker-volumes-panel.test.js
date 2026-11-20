import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  applyDockerVolumeDelete,
  getDockerProjectVolumes,
  previewDockerVolumeDelete,
} from '../src/workspace/docker-compose-client.js';
import { setSession } from '../src/session-client.js';

register('./jsx-loader.js', import.meta.url);

const { WorkspaceContext } = await import('../src/workspace/WorkspaceContext.jsx');
const { ConfirmDialog } = await import('../src/workspace/PanelKit.jsx');
const {
  default: DockerVolumesPanel,
  dockerVolumesPanelInternals,
} = await import('../src/workspace/DockerVolumesPanel.jsx');

const ok = (data, status = 200) => new Response(JSON.stringify({ data }), { status });

const DIGEST = 'c'.repeat(64);
const PROJECT = Object.freeze({
  id: '22222222-2222-4222-8222-222222222222',
  projectName: 'shop_stack',
  revision: 4,
});

function workspaceValue(overrides = {}) {
  return {
    isOwner: true,
    observe: () => {},
    jobs: { status: 'ready', items: [], refresh: () => {} },
    resourceBusy: () => false,
    setNotice: () => {},
    ...overrides,
  };
}

function sampleInventory() {
  return {
    version: 1,
    projectId: PROJECT.id,
    projectName: PROJECT.projectName,
    projectRevision: PROJECT.revision,
    sideEffects: false,
    volumes: [
      {
        volumeKey: 'pg_data',
        volumeName: 'shop_stack_pg_data',
        scope: 'project',
        declaredActive: true,
        present: true,
        driver: 'local',
        volumeScope: 'local',
        createdAt: '2026-11-19T10:00:00Z',
        composeLabelsVerified: true,
        containerCount: 0,
        containers: [],
        crossProjectRefCount: 0,
        deletable: true,
        blockCode: null,
        blockReason: null,
      },
      {
        volumeKey: 'uploads',
        volumeName: 'shop_stack_uploads',
        scope: 'project',
        declaredActive: true,
        present: true,
        driver: 'local',
        volumeScope: 'local',
        createdAt: '2026-11-19T10:00:00Z',
        composeLabelsVerified: true,
        containerCount: 1,
        containers: [{ id: 'abcdef123456', name: 'shop_stack-web-1', state: 'running', status: 'Up 2 hours' }],
        crossProjectRefCount: 0,
        deletable: false,
        blockCode: 'docker_volume_in_use',
        blockReason: 'Volume aktif bir konteynere bağlı.',
      },
      {
        volumeKey: 'shared_assets',
        volumeName: 'corp_shared_assets',
        scope: 'external',
        declaredActive: true,
        present: true,
        driver: 'local',
        volumeScope: 'local',
        createdAt: '2026-11-18T10:00:00Z',
        composeLabelsVerified: false,
        containerCount: 0,
        containers: [],
        crossProjectRefCount: 1,
        deletable: false,
        blockCode: 'docker_volume_external',
        blockReason: 'Harici volume bu projeden silinemez.',
      },
      {
        volumeKey: 'cache_vol',
        volumeName: 'shop_stack_cache_vol',
        scope: 'project',
        declaredActive: true,
        present: false,
        driver: null,
        volumeScope: null,
        createdAt: null,
        composeLabelsVerified: false,
        containerCount: 0,
        containers: [],
        crossProjectRefCount: 0,
        deletable: false,
        blockCode: 'docker_volume_not_found',
        blockReason: 'Volume sunucuda henüz oluşturulmadı.',
      },
    ],
  };
}

test('Docker volume client sends exact paths, CSRF header, and strict request payloads', async (t) => {
  setSession({ csrfToken: 'csrf-vol-token' });
  t.after(() => setSession(null));

  const calls = [];
  const previewData = {
    version: 1,
    action: 'delete',
    operation: 'docker.volume.delete',
    projectId: PROJECT.id,
    projectName: PROJECT.projectName,
    volumeKey: 'pg_data',
    volumeName: 'shop_stack_pg_data',
    containerCount: 0,
    previewDigest: DIGEST,
    confirmation: `docker-volume:delete:shop_stack:pg_data:${DIGEST}`,
    sideEffects: false,
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/volumes/delete-preview')) return ok(previewData);
    if (url.endsWith('/volumes/delete')) {
      return ok({ previewDigest: DIGEST, job: { id: 'job-vol-1', status: 'queued' }, sideEffects: false }, 202);
    }
    return ok(sampleInventory());
  });

  const controller = new AbortController();
  const listResult = await getDockerProjectVolumes('project/one', { signal: controller.signal });
  assert.equal(listResult.volumes.length, 4);

  const preview = await previewDockerVolumeDelete('project/one', 'pg_data');
  assert.equal(preview.previewDigest, DIGEST);

  const queued = await applyDockerVolumeDelete('project/one', { volumeKey: 'pg_data', preview });
  assert.equal(queued.job.id, 'job-vol-1');

  assert.deepEqual(
    calls.map((entry) => [entry.url, entry.options.method]),
    [
      ['/api/panel/docker/projects/project%2Fone/volumes', 'GET'],
      ['/api/panel/docker/projects/project%2Fone/volumes/delete-preview', 'POST'],
      ['/api/panel/docker/projects/project%2Fone/volumes/delete', 'POST'],
    ],
  );
  assert.equal(calls[0].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), { volumeKey: 'pg_data' });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    volumeKey: 'pg_data',
    expectedPreviewDigest: DIGEST,
    confirmation: previewData.confirmation,
  });
  assert.equal(calls[1].options.headers['x-csrf-token'], 'csrf-vol-token');
  assert.equal(calls[2].options.headers['x-csrf-token'], 'csrf-vol-token');
});

test('Docker volume client rejects invalid projectId, volumeKey, and incomplete previews before fetch', async (t) => {
  let fetchCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCount += 1;
    return ok({});
  });

  assert.throws(() => getDockerProjectVolumes(''), /dockerProjectId is required/);
  assert.throws(() => previewDockerVolumeDelete(PROJECT.id, ''), /volumeKey is required/);
  assert.throws(() => previewDockerVolumeDelete(PROJECT.id, '   '), /volumeKey is required/);
  assert.throws(() => previewDockerVolumeDelete(PROJECT.id, 'pg/data'), /volumeKey is invalid/);
  assert.throws(() => previewDockerVolumeDelete(PROJECT.id, 'pg data'), /volumeKey is invalid/);
  assert.throws(() => previewDockerVolumeDelete(PROJECT.id, '--force'), /volumeKey is invalid/);
  assert.throws(() => previewDockerVolumeDelete(PROJECT.id, 'bad..key'), /volumeKey is invalid/);
  assert.throws(() => applyDockerVolumeDelete(PROJECT.id, { volumeKey: '', preview: { previewDigest: DIGEST, confirmation: 'ok' } }), /volumeKey is required/);
  assert.throws(() => applyDockerVolumeDelete(PROJECT.id, { volumeKey: 'pg_data', preview: {} }), /preview is required/);
  assert.throws(() => applyDockerVolumeDelete(PROJECT.id, { volumeKey: 'pg_data', preview: { previewDigest: DIGEST } }), /preview is required/);
  assert.equal(fetchCount, 0);
});

test('DockerVolumesPanel renders nothing for non-Owner accounts and enforces single-row delete button for Owner', () => {
  const nonOwnerHtml = renderToStaticMarkup(createElement(
    WorkspaceContext.Provider,
    { value: workspaceValue({ isOwner: false }) },
    createElement(DockerVolumesPanel, { project: PROJECT, initialData: sampleInventory() }),
  ));
  assert.equal(nonOwnerHtml, '');

  const ownerHtml = renderToStaticMarkup(createElement(
    WorkspaceContext.Provider,
    { value: workspaceValue({ isOwner: true }) },
    createElement(DockerVolumesPanel, { project: PROJECT, initialData: sampleInventory() }),
  ));
  assert.ok(ownerHtml.includes('Kalıcı volume yönetimi'));
  assert.ok(ownerHtml.includes('pg_data'));
  assert.ok(ownerHtml.includes('shop_stack_pg_data'));
  assert.ok(ownerHtml.includes('Proje'));
  assert.ok(ownerHtml.includes('Harici'));
  assert.ok(ownerHtml.includes('Silinebilir'));
  assert.ok(ownerHtml.includes('Kullanımda'));
  assert.ok(ownerHtml.includes('Engelli'));
  assert.ok(ownerHtml.includes('Yok'));
  assert.ok(ownerHtml.includes('shop_stack-web-1'));
  assert.ok(ownerHtml.includes('Volume aktif bir konteynere bağlı.'));
  assert.ok(ownerHtml.includes('Harici volume bu projeden silinemez.'));

  // Exactly one Sil button (only for the single deletable row)
  const deleteButtons = ownerHtml.match(/>Sil<\/button>/g) ?? [];
  assert.equal(deleteButtons.length, 1);
  assert.equal(ownerHtml.includes('disabled="">Sil</button>'), false);

  // Locked while project has active job or jobs collection is not ready
  const busyHtml = renderToStaticMarkup(createElement(
    WorkspaceContext.Provider,
    { value: workspaceValue({ isOwner: true, resourceBusy: (type, id) => type === 'docker_project' && id === PROJECT.id }) },
    createElement(DockerVolumesPanel, { project: PROJECT, initialData: sampleInventory() }),
  ));
  assert.match(busyHtml, /<button[^>]*disabled=""[^>]*>.*Sil<\/button>/);

  const jobsLoadingHtml = renderToStaticMarkup(createElement(
    WorkspaceContext.Provider,
    { value: workspaceValue({ isOwner: true, jobs: { status: 'loading', items: [], refresh: () => {} } }) },
    createElement(DockerVolumesPanel, { project: PROJECT, initialData: sampleInventory() }),
  ));
  assert.match(jobsLoadingHtml, /<button[^>]*disabled=""[^>]*>.*Sil<\/button>/);

  // Empty state when project has no volumes
  const emptyHtml = renderToStaticMarkup(createElement(
    WorkspaceContext.Provider,
    { value: workspaceValue({ isOwner: true }) },
    createElement(DockerVolumesPanel, { project: PROJECT, initialData: { ...sampleInventory(), volumes: [] } }),
  ));
  assert.ok(emptyHtml.includes('Kayıtlı volume bulunamadı'));
});

test('DockerVolumesPanel confirmation message names the single volume and warns about permanent data loss', () => {
  const preview = {
    volumeKey: 'pg_data',
    volumeName: 'shop_stack_pg_data',
    confirmation: `docker-volume:delete:shop_stack:pg_data:${DIGEST}`,
  };
  const message = dockerVolumesPanelInternals.buildDeleteMessage(preview);
  assert.ok(message.includes('shop_stack_pg_data'));
  assert.match(message, /kalıcı/i);
  assert.match(message, /geri alınamaz/i);

  const dialogHtml = renderToStaticMarkup(createElement(ConfirmDialog, {
    title: 'Volume kaydını kalıcı olarak sil',
    message,
    confirmation: preview.confirmation,
    onCancel: () => {},
    onConfirm: () => {},
    confirmLabel: 'Kalıcı olarak sil',
  }));
  assert.ok(dialogHtml.includes('Volume kaydını kalıcı olarak sil'));
  assert.ok(dialogHtml.includes('shop_stack_pg_data'));
  assert.ok(dialogHtml.includes(preview.confirmation));
  assert.ok(dialogHtml.includes('Kalıcı olarak sil'));

  assert.equal(dockerVolumesPanelInternals.isDeleteLocked({ busy: false, jobsStatus: 'ready', projectBusy: false }), false);
  assert.equal(dockerVolumesPanelInternals.isDeleteLocked({ busy: true, jobsStatus: 'ready', projectBusy: false }), true);
  assert.equal(dockerVolumesPanelInternals.isDeleteLocked({ busy: false, jobsStatus: 'loading', projectBusy: false }), true);
  assert.equal(dockerVolumesPanelInternals.isDeleteLocked({ busy: false, jobsStatus: 'ready', projectBusy: true }), true);
});

test('DockerVolumesPanel wires single-volume delete flow without bulk/prune/force actions and mounts cleanly below StoragePanel', async () => {
  const [panelSource, pageSource] = await Promise.all([
    readFile(new URL('../src/workspace/DockerVolumesPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/DockerProjectsPage.jsx', import.meta.url), 'utf8'),
  ]);

  // Core flow wiring: preview -> ConfirmDialog -> apply -> observe(result.job) -> refresh
  assert.match(panelSource, /if \(!isOwner \|\| !project\) return null;/);
  assert.match(panelSource, /previewDockerVolumeDelete\(project\.id, item\.volumeKey\)/);
  assert.match(panelSource, /applyDockerVolumeDelete\(project\.id, \{[\s\S]*?volumeKey: pending\.volumeKey,[\s\S]*?preview: pending\.preview,/);
  assert.match(panelSource, /if \(result\?\.job\) observe\(result\.job\);/);
  assert.match(panelSource, /setNotice\(/);
  assert.match(panelSource, /jobs\?\.refresh\?\.\(\);/);
  assert.match(panelSource, /volumes\.refresh\(\);/);
  assert.match(panelSource, /onChanged\?\.\(\);/);
  assert.match(panelSource, /<ConfirmDialog[\s\S]*?confirmation=\{pending\.preview\.confirmation\}/);
  assert.match(panelSource, /from '\.\/PanelKit\.jsx';/);

  // Strictly forbidden bulk / prune / force controls or jargon
  assert.doesNotMatch(panelSource, /\bprune\b/i);
  assert.doesNotMatch(panelSource, /\bforce\b/i);
  assert.doesNotMatch(panelSource, /tümünü sil|hepsini sil|toplu sil|kullanılmayanları temizle/i);
  assert.doesNotMatch(panelSource, /\((?:volumeKey|volumeName|Container|Host|Plesk|Easypanel|desired revision)\)/i);

  // DockerProjectsPage mounting right after StoragePanel while preserving StoragePanel & DockerLifecyclePanel
  assert.match(pageSource, /import DockerVolumesPanel from '\.\/DockerVolumesPanel\.jsx';/);
  assert.match(
    pageSource,
    /<StoragePanel project=\{project\} backup=\{storageBackup\.data\} \/><DockerVolumesPanel project=\{project\} onChanged=\{refresh\} \/>/,
  );
  assert.match(pageSource, /<DockerLifecyclePanel project=\{project\} onChanged=\{detail\.refresh\} \/>/);
});
