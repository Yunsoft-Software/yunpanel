const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

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

export const gitDeploymentInternals = Object.freeze({ gitFetchArguments, resolvedGitCommit });
