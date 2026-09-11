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

test('Git authentication keeps tokens out of URLs and pins SSH host verification', () => {
  const token = 'github_pat_private_deploy_token';
  const tokenPlan = gitDeploymentInternals.gitAuthenticationPlan({
    repositoryUrl: 'https://github.com/example/private.git',
    credential: { type: 'github_token', token },
  });
  assert.equal(tokenPlan.repositoryUrl, 'https://github.com/example/private.git');
  assert.equal(tokenPlan.environment.YUNPANEL_GIT_TOKEN, token);
  assert.equal(tokenPlan.environment.GIT_ASKPASS, gitDeploymentInternals.askPassPath);
  assert.equal(JSON.stringify(tokenPlan.repositoryUrl).includes(token), false);

  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'A'.repeat(96)}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const sshPlan = gitDeploymentInternals.gitAuthenticationPlan({
    repositoryUrl: 'https://github.com/example/private.git',
    credential: { type: 'ssh_deploy_key', privateKey },
    privateKeyPath: '/var/lib/yunpanel/data/app/.git-key-job',
  });
  assert.equal(sshPlan.repositoryUrl, 'ssh://git@github.com/example/private.git');
  assert.equal(sshPlan.privateKey, privateKey);
  assert.match(sshPlan.environment.GIT_SSH_COMMAND, /StrictHostKeyChecking=yes/);
  assert.match(sshPlan.environment.GIT_SSH_COMMAND, /UserKnownHostsFile=\/etc\/ssh\/ssh_known_hosts/);
  assert.equal(sshPlan.environment.GIT_SSH_COMMAND.includes(privateKey), false);
});
