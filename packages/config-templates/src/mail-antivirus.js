import { createHash } from 'node:crypto';

const PROFILES = Object.freeze(['disabled', 'clamav']);
const DEFAULT_PROFILE = 'disabled';
const RSPAMD_ANTIVIRUS_CONFIG_PATH = '/etc/rspamd/local.d/antivirus.inc';
const CLAMAV_SOCKET_PATH = '/run/clamav/clamd.ctl';
const CLAMAV_FALLBACK_SOCKET_PATH = '/var/run/clamav/clamd.ctl';
const CLAMAV_SERVICE_UNIT = 'clamav-daemon.service';
const CLAMAV_PACKAGE = 'clamav-daemon';
const CLAMAV_REQUIREMENT = 'clamav';
const MIN_MEMORY_BYTES = 1024 * 1024 * 1024; // 1 GiB

export class MailAntivirusTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MailAntivirusTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function renderRspamdAntivirusConfig({ profile = 'clamav' } = {}) {
  if (profile === 'clamav') {
    return [
      'clamav {',
      '  type = "clamav";',
      `  servers = "${CLAMAV_SOCKET_PATH}";`,
      '  action = "reject";',
      '  scan_mime_parts = true;',
      '}',
      '',
    ].join('\n');
  }
  if (profile === 'disabled') {
    return '# Antivirus scanning disabled\n';
  }
  throw new MailAntivirusTemplateError('invalid_antivirus_profile', `Unsupported antivirus profile: ${profile}`);
}

export function enableManagedMailAntivirus(preview, { profile = DEFAULT_PROFILE } = {}) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)
    || preview.version !== 1 || typeof preview.sha256 !== 'string'
    || !Array.isArray(preview.artifacts) || !Array.isArray(preview.requirements)) {
    throw new MailAntivirusTemplateError('invalid_mail_preview', 'Managed mail preview is invalid');
  }
  if (!PROFILES.includes(profile)) {
    throw new MailAntivirusTemplateError('invalid_antivirus_profile', `Antivirus profile must be one of: ${PROFILES.join(', ')}`);
  }

  if (profile === 'disabled') {
    const artifacts = Object.freeze(preview.artifacts.filter(
      (artifact) => artifact?.path !== RSPAMD_ANTIVIRUS_CONFIG_PATH,
    ));
    const requirements = Object.freeze(preview.requirements.filter(
      (req) => req !== CLAMAV_REQUIREMENT,
    ));
    const antivirus = Object.freeze({
      profile: 'disabled',
      enabled: false,
    });
    const identity = {
      version: 1,
      baseSha256: preview.sha256,
      antivirus,
      artifactDigests: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
      requirements,
    };
    return Object.freeze({
      ...preview,
      sha256: sha256(JSON.stringify(identity)),
      artifacts,
      requirements,
      antivirus,
      readyToApply: false,
      sideEffects: false,
    });
  }

  // profile === 'clamav'
  const content = renderRspamdAntivirusConfig({ profile: 'clamav' });
  const artifact = Object.freeze({
    version: 1,
    path: RSPAMD_ANTIVIRUS_CONFIG_PATH,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    content,
    sensitive: false,
    validate: Object.freeze({ file: '/usr/bin/rspamadm', args: Object.freeze(['configtest']) }),
    sideEffects: false,
  });

  const existingWithout = preview.artifacts.filter(
    (entry) => entry?.path !== RSPAMD_ANTIVIRUS_CONFIG_PATH,
  );
  const artifacts = Object.freeze([...existingWithout, artifact].sort(
    (left, right) => left.path.localeCompare(right.path),
  ));

  const requirementSet = new Set(preview.requirements);
  requirementSet.add(CLAMAV_REQUIREMENT);
  const requirements = Object.freeze([...requirementSet]);

  const antivirus = Object.freeze({
    profile: 'clamav',
    enabled: true,
    socketPath: CLAMAV_SOCKET_PATH,
    fallbackSocketPath: CLAMAV_FALLBACK_SOCKET_PATH,
    serviceUnit: CLAMAV_SERVICE_UNIT,
    packageName: CLAMAV_PACKAGE,
  });

  const identity = {
    version: 1,
    baseSha256: preview.sha256,
    antivirus,
    artifactDigests: artifacts.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    requirements,
  };

  return Object.freeze({
    ...preview,
    sha256: sha256(JSON.stringify(identity)),
    artifacts,
    requirements,
    antivirus,
    readyToApply: false,
    sideEffects: false,
  });
}

export const mailAntivirusTemplatePolicy = Object.freeze({
  profiles: PROFILES,
  defaultProfile: DEFAULT_PROFILE,
  requirement: CLAMAV_REQUIREMENT,
  rspamdAntivirusConfigPath: RSPAMD_ANTIVIRUS_CONFIG_PATH,
  clamavSocketPath: CLAMAV_SOCKET_PATH,
  clamavFallbackSocketPath: CLAMAV_FALLBACK_SOCKET_PATH,
  serviceUnit: CLAMAV_SERVICE_UNIT,
  packageName: CLAMAV_PACKAGE,
  minMemoryBytes: MIN_MEMORY_BYTES,
});
