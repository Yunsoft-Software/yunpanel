import assert from 'node:assert/strict';
import test from 'node:test';
import { gitDeploymentInternals } from '../src/index.js';

test('Git fetch arguments use exact branch, tag or commit without shell input', () => {
  assert.deepEqual(
    gitDeploymentInternals.gitFetchArguments({ kind: 'branch', value: 'production' }, { prune: true }),
    ['fetch', '--prune', '--no-tags', 'origin', 'refs/heads/production'],
  );
  assert.deepEqual(
    gitDeploymentInternals.gitFetchArguments({ kind: 'tag', value: 'v2.0.0' }, { depth: 1 }),
    ['fetch', '--depth', '1', '--no-tags', 'origin', 'refs/tags/v2.0.0'],
  );
  assert.deepEqual(
    gitDeploymentInternals.gitFetchArguments({ kind: 'commit', value: 'a'.repeat(40) }, { depth: 1 }),
    ['fetch', '--depth', '1', '--no-tags', 'origin', 'a'.repeat(40)],
  );
});

test('an immutable commit target must resolve to the requested SHA', () => {
  assert.equal(gitDeploymentInternals.resolvedGitCommit(`${'A'.repeat(40)}\n`, {
    kind: 'commit', value: 'a'.repeat(40),
  }), 'a'.repeat(40));
  assert.equal(gitDeploymentInternals.resolvedGitCommit(`${'b'.repeat(40)}\n`, {
    kind: 'commit', value: 'a'.repeat(40),
  }), null);
  assert.equal(gitDeploymentInternals.resolvedGitCommit('HEAD\n', { kind: 'tag', value: 'v1.0.0' }), null);
});
