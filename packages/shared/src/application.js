const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const SCRIPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
const RELATIVE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;

export class ApplicationValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApplicationValidationError';
    this.code = code;
  }
}

export function assertUuid(value, fieldName = 'id') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ApplicationValidationError('invalid_uuid', `${fieldName} must be a UUID`);
  }
  return value.toLowerCase();
}

export function normalizeGithubRepositoryUrl(value) {
  if (typeof value !== 'string' || value.length > 300) {
    throw new ApplicationValidationError('invalid_repository_url', 'Repository URL is invalid');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ApplicationValidationError('invalid_repository_url', 'Repository URL is invalid');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new ApplicationValidationError('invalid_repository_url', 'V1 supports credential-free HTTPS github.com repositories only');
  }

  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match || match[1].startsWith('.') || match[2].startsWith('.')) {
    throw new ApplicationValidationError('invalid_repository_url', 'GitHub repository path is invalid');
  }

  return `https://github.com/${match[1]}/${match[2]}.git`;
}

export function normalizeGitBranch(value) {
  if (typeof value !== 'string' || !BRANCH_PATTERN.test(value)) {
    throw new ApplicationValidationError('invalid_branch', 'Git branch is invalid');
  }
  if (value.includes('..') || value.includes('//') || value.includes('@{') || value.endsWith('/') || value.endsWith('.lock')) {
    throw new ApplicationValidationError('invalid_branch', 'Git branch contains unsupported sequences');
  }
  return value;
}

export function normalizeRelativeBuildPath(value, { allowDot = false } = {}) {
  if (value === '.' && allowDot) return '.';
  if (typeof value !== 'string' || value.length < 1 || value.length > 180 || !RELATIVE_PATH_PATTERN.test(value) || value.startsWith('/')) {
    throw new ApplicationValidationError('invalid_build_path', 'Build output path is invalid');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ApplicationValidationError('invalid_build_path', 'Build output path contains traversal or empty segments');
  }
  return value;
}

function normalizeHealthFile(value) {
  const normalized = normalizeRelativeBuildPath(value ?? 'index.html');
  if (normalized.endsWith('/')) {
    throw new ApplicationValidationError('invalid_health_file', 'Static health file must point to a file');
  }
  return normalized;
}

export function normalizeStaticBuildConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError('invalid_build_config', 'Build config must be an object');
  }

  const mode = value.mode ?? 'npm';
  if (!['npm', 'none'].includes(mode)) {
    throw new ApplicationValidationError('invalid_build_mode', 'Static build mode must be npm or none');
  }

  const healthFile = normalizeHealthFile(value.healthFile);
  if (mode === 'none') {
    return {
      mode: 'none',
      installMode: null,
      buildScript: null,
      outputDir: normalizeRelativeBuildPath(value.outputDir ?? '.', { allowDot: true }),
      healthFile,
    };
  }

  const installMode = value.installMode ?? 'ci';
  if (!['ci', 'install'].includes(installMode)) {
    throw new ApplicationValidationError('invalid_install_mode', 'npm install mode must be ci or install');
  }
  const buildScript = value.buildScript ?? 'build';
  if (typeof buildScript !== 'string' || !SCRIPT_PATTERN.test(buildScript)) {
    throw new ApplicationValidationError('invalid_build_script', 'npm build script name is invalid');
  }

  return {
    mode: 'npm',
    installMode,
    buildScript,
    outputDir: normalizeRelativeBuildPath(value.outputDir ?? 'dist'),
    healthFile,
  };
}

export function normalizeStaticApplicationSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApplicationValidationError('invalid_application_spec', 'Static application spec must be an object');
  }

  return {
    applicationId: assertUuid(value.applicationId, 'applicationId'),
    deploymentId: assertUuid(value.deploymentId, 'deploymentId'),
    repositoryUrl: normalizeGithubRepositoryUrl(value.repositoryUrl),
    branch: normalizeGitBranch(value.branch ?? 'main'),
    build: normalizeStaticBuildConfig(value.build),
    retention: Number.isInteger(value.retention) && value.retention >= 2 && value.retention <= 20 ? value.retention : 5,
  };
}
