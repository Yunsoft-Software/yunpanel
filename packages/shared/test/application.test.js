import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationValidationError,
  normalizeGithubRepositoryUrl,
  normalizeGitBranch,
  normalizeGitDeploymentTarget,
  normalizeStaticApplicationSpec,
  normalizeStaticBuildConfig,
} from '../src/index.js';

test('normalizes supported GitHub repositories and npm static build profiles', () => {
  assert.equal(
    normalizeGithubRepositoryUrl('https://github.com/Yunsoft-Software/yunpanel'),
    'https://github.com/Yunsoft-Software/yunpanel.git',
  );
  assert.equal(normalizeGitBranch('release/2026-09'), 'release/2026-09');
  assert.deepEqual(normalizeStaticBuildConfig({}), {
    mode: 'npm',
    installMode: 'ci',
    buildScript: 'build',
    outputDir: 'dist',
    healthFile: 'index.html',
  });
});

test('plain static profile can serve repository root without executing npm', () => {
  assert.deepEqual(normalizeStaticBuildConfig({ mode: 'none', outputDir: '.', healthFile: 'public/index.html' }), {
    mode: 'none',
    installMode: null,
    buildScript: null,
    outputDir: '.',
    healthFile: 'public/index.html',
  });
});

test('Git deployment targets distinguish configured branch, exact tag and immutable commit', () => {
  assert.deepEqual(normalizeGitDeploymentTarget(null, { defaultBranch: 'main' }), { kind: 'branch', value: 'main' });
  assert.deepEqual(normalizeGitDeploymentTarget({ kind: 'tag', value: 'v2.4.0' }), { kind: 'tag', value: 'v2.4.0' });
  assert.deepEqual(normalizeGitDeploymentTarget({ kind: 'commit', value: 'A'.repeat(40) }), {
    kind: 'commit', value: 'a'.repeat(40),
  });
  for (const target of [
    { kind: 'commit', value: 'abc123' },
    { kind: 'tag', value: '--upload-pack=evil' },
    { kind: 'branch', value: 'main', extra: true },
    { kind: 'ref', value: 'refs/pull/1/head' },
  ]) assert.throws(() => normalizeGitDeploymentTarget(target), ApplicationValidationError);
});

test('rejects credentials, non-GitHub URLs, branch option injection and output traversal', () => {
  for (const url of [
    'https://token@github.com/org/repo.git',
    'https://gitlab.com/org/repo.git',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => normalizeGithubRepositoryUrl(url), ApplicationValidationError);
  }

  for (const branch of ['--upload-pack=evil', 'main..evil', 'refs//bad']) {
    assert.throws(() => normalizeGitBranch(branch), ApplicationValidationError);
  }

  assert.throws(
    () => normalizeStaticBuildConfig({ outputDir: '../secret' }),
    (error) => error instanceof ApplicationValidationError && error.code === 'invalid_build_path',
  );
  assert.throws(
    () => normalizeStaticBuildConfig({ healthFile: '../outside.html' }),
    (error) => error instanceof ApplicationValidationError && error.code === 'invalid_build_path',
  );
});

test('normalizes complete static deployment specs', () => {
  const spec = normalizeStaticApplicationSpec({
    applicationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9',
    deploymentId: 'ff830043-9752-4640-83b4-3a1998de78a0',
    repositoryUrl: 'https://github.com/example/site',
    branch: 'main',
    build: { mode: 'npm', installMode: 'ci', buildScript: 'build', outputDir: 'dist' },
    retention: 7,
  });

  assert.equal(spec.repositoryUrl, 'https://github.com/example/site.git');
  assert.deepEqual(spec.gitTarget, { kind: 'branch', value: 'main' });
  assert.equal(spec.retention, 7);
  assert.equal(spec.build.outputDir, 'dist');
  assert.equal(spec.build.healthFile, 'index.html');
});
