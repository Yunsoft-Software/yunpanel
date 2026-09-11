import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGitDeploymentCredential } from '@yunpanel/shared';

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const PRIVATE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]{1,500}$/;
const ASKPASS_PATH = fileURLToPath(new URL('./git-askpass.js', import.meta.url));
const SSH_PATH = '/usr/bin/ssh';
const SSH_KNOWN_HOSTS_PATH = '/etc/ssh/ssh_known_hosts';

export function gitFetchArguments(target, { prune = false, depth = null } = {}) {
  const args = ['fetch'];
  if (prune) args.push('--prune');
  if (Number.isInteger(depth) && depth > 0) args.push('--depth', String(depth));
  args.push('--no-tags', 'origin');
  if (target.kind === 'branch') args.push(`refs/heads/${target.value}`);
  else if (target.kind === 'tag') args.push(`refs/tags/${target.value}`);
  else args.push(target.value);
  return args;
}

export function resolvedGitCommit(stdout, target) {
  const commitSha = String(stdout ?? '').trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commitSha)) return null;
  if (target.kind === 'commit' && commitSha !== target.value) return null;
  return commitSha;
}

export function gitAuthenticationPlan({ repositoryUrl, credential = null, privateKeyPath = null } = {}) {
  const normalized = normalizeGitDeploymentCredential(credential);
  if (!normalized) return { repositoryUrl, environment: {}, privateKey: null };
  if (normalized.type === 'github_token') {
    return {
      repositoryUrl,
      environment: {
        GIT_ASKPASS: ASKPASS_PATH,
        GIT_ASKPASS_REQUIRE: 'force',
        YUNPANEL_GIT_TOKEN: normalized.token,
      },
      privateKey: null,
    };
  }
  if (typeof privateKeyPath !== 'string' || !PRIVATE_PATH_PATTERN.test(privateKeyPath)
    || privateKeyPath.split(path.sep).includes('..')) {
    throw new Error('A fixed absolute private key path is required for SSH Git authentication');
  }
  const url = new URL(repositoryUrl);
  return {
    repositoryUrl: `ssh://git@github.com${url.pathname}`,
    environment: {
      GIT_SSH_COMMAND: `${SSH_PATH} -i ${privateKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${SSH_KNOWN_HOSTS_PATH}`,
      GIT_SSH_VARIANT: 'ssh',
    },
    privateKey: normalized.privateKey,
  };
}

export const gitDeploymentInternals = Object.freeze({
  gitFetchArguments,
  resolvedGitCommit,
  gitAuthenticationPlan,
  askPassPath: ASKPASS_PATH,
  sshKnownHostsPath: SSH_KNOWN_HOSTS_PATH,
});
