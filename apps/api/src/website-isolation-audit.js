import { createHash } from 'node:crypto';
import path from 'node:path';
import { createApplicationIdentity } from '@yunpanel/host-runtime/application-identity';

const HOSTED_RUNTIME_TYPES = new Set(['static', 'node', 'php']);
const ISOLATION_STEPS = Object.freeze({
  static: Object.freeze(['unix_identity', 'runtime', 'sftp']),
  node: Object.freeze(['unix_identity', 'runtime', 'sftp']),
  php: Object.freeze(['unix_identity', 'php_runtime', 'sftp']),
});

export class WebsiteIsolationAuditError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'WebsiteIsolationAuditError';
    this.code = code;
    this.status = status;
  }
}

function expectedDocumentRoot(runtimeType, identity) {
  if (runtimeType === 'static') return path.posix.join(identity.paths.static.publishRoot, 'current');
  if (runtimeType === 'node') return identity.paths.runtime.currentRelease;
  if (runtimeType === 'php') return path.posix.join(identity.paths.runtime.currentRelease, 'public');
  return null;
}

function finding(code, severity, message, action) {
  return Object.freeze({ code, severity, message, action });
}

function migrationDigest(core) {
  return createHash('sha256').update(JSON.stringify(core)).digest('hex');
}

function valueDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boundedText(value, maxLength = 1024) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
}

function boundedPathWithin(value, root) {
  return boundedText(value) !== null
    && boundedText(root) !== null
    && value.startsWith('/')
    && root.startsWith('/')
    && (value === root || value.startsWith(`${root}/`));
}

function boundedIdentityMigrationPreview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1
    || typeof value.satisfied !== 'boolean'
    || typeof value.safeCreateCandidate !== 'boolean'
    || !value.current || typeof value.current !== 'object' || Array.isArray(value.current)
    || !value.desired || typeof value.desired !== 'object' || Array.isArray(value.desired)
    || !Array.isArray(value.differences) || value.differences.length > 20
    || value.differences.some((code) => typeof code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(code))) {
    return null;
  }

  const account = value.current.account === null ? null : value.current.account;
  const group = value.current.group === null ? null : value.current.group;
  const home = value.current.home === null ? null : value.current.home;
  if ((account !== null && (
    !account || typeof account !== 'object' || Array.isArray(account)
    || !Number.isSafeInteger(account.uid) || account.uid < 1
    || !Number.isSafeInteger(account.gid) || account.gid < 1
    || boundedText(account.homeDirectory) === null
    || boundedText(account.shell, 256) === null
  )) || (group !== null && (
    !group || typeof group !== 'object' || Array.isArray(group)
    || !Number.isSafeInteger(group.gid) || group.gid < 1
    || !Number.isSafeInteger(group.memberCount) || group.memberCount < 0 || group.memberCount > 10_000
  )) || (home !== null && (
    !home || typeof home !== 'object' || Array.isArray(home)
    || !Number.isSafeInteger(home.uid) || home.uid < 1
    || !Number.isSafeInteger(home.gid) || home.gid < 1
    || typeof home.mode !== 'string' || !/^0[0-7]{3}$/.test(home.mode)
  ))) return null;

  const desiredUser = boundedText(value.desired.user, 64);
  const desiredHome = boundedText(value.desired.homeDirectory);
  if (!desiredUser || !desiredHome
    || value.desired.shellPolicy !== 'nologin'
    || value.desired.privateGroup !== true
    || value.desired.groupMemberCount !== 0
    || typeof value.desired.homeMode !== 'string' || !/^0[0-7]{3}$/.test(value.desired.homeMode)) {
    return null;
  }

  return Object.freeze({
    version: 1,
    satisfied: value.satisfied,
    safeCreateCandidate: value.safeCreateCandidate,
    current: Object.freeze({
      account: account ? Object.freeze({
        uid: account.uid,
        gid: account.gid,
        homeDirectory: account.homeDirectory,
        shell: account.shell,
      }) : null,
      group: group ? Object.freeze({
        gid: group.gid,
        memberCount: group.memberCount,
      }) : null,
      home: home ? Object.freeze({
        uid: home.uid,
        gid: home.gid,
        mode: home.mode,
      }) : null,
    }),
    desired: Object.freeze({
      user: desiredUser,
      homeDirectory: desiredHome,
      shellPolicy: 'nologin',
      privateGroup: true,
      groupMemberCount: 0,
      homeMode: value.desired.homeMode,
    }),
    differences: Object.freeze([...value.differences]),
  });
}

async function inspectIdentityMigrationPreview(handler, context, identity) {
  if (!handler || typeof handler.previewMigration !== 'function' || !identity) return null;
  try {
    const preview = boundedIdentityMigrationPreview(await handler.previewMigration(context));
    if (!preview
      || preview.desired.user !== identity.unixUser
      || preview.desired.homeDirectory !== identity.paths.workspace.homeDirectory) {
      return null;
    }
    return preview;
  } catch {
    return null;
  }
}

function boundedSha256(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function boundedSftpDirectoryState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.present !== 'boolean') return null;
  if (value.present === false) return Object.freeze({ present: false });
  if (typeof value.directory !== 'boolean' || typeof value.symbolicLink !== 'boolean'
    || !Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.gid) || value.gid < 0
    || typeof value.mode !== 'string' || !/^0[0-7]{3}$/.test(value.mode)) return null;
  return Object.freeze({
    present: true,
    directory: value.directory,
    symbolicLink: value.symbolicLink,
    uid: value.uid,
    gid: value.gid,
    mode: value.mode,
  });
}

function boundedSftpMigrationPreview(value, { websiteId, applicationId, identity } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || typeof value.satisfied !== 'boolean'
    || !value.current || typeof value.current !== 'object' || Array.isArray(value.current)
    || !value.desired || typeof value.desired !== 'object' || Array.isArray(value.desired)
    || !Array.isArray(value.differences) || value.differences.length > 30
    || value.differences.some((code) => typeof code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(code))
    || value.desired.websiteId !== websiteId
    || value.desired.applicationId !== applicationId
    || value.desired.unixUser !== identity?.unixUser
    || value.desired.sourceDirectory !== identity?.paths?.workspace?.sftpRoot) return null;

  const configSha256 = boundedSha256(value.current.sshdConfig?.sha256, { nullable: true });
  const mountSha256 = boundedSha256(value.current.mountUnit?.sha256, { nullable: true });
  const desiredSshdSha256 = boundedSha256(value.desired.sshdSha256);
  const desiredMountSha256 = boundedSha256(value.desired.mountSha256);
  const chrootRoot = boundedSftpDirectoryState(value.current.chrootRoot);
  const chrootDirectory = boundedSftpDirectoryState(value.current.chrootDirectory);
  const mountDirectory = boundedSftpDirectoryState(value.current.mountDirectory);
  const desiredPaths = [
    value.desired.chrootRoot,
    value.desired.chrootDirectory,
    value.desired.mountDirectory,
    value.desired.sshdConfigPath,
  ];
  if (configSha256 === undefined || mountSha256 === undefined
    || desiredSshdSha256 === undefined || desiredMountSha256 === undefined
    || !chrootRoot || !chrootDirectory || !mountDirectory
    || desiredPaths.some((entry) => boundedText(entry) === null || !entry.startsWith('/'))
    || boundedText(value.desired.unitName, 255) === null
    || value.desired.directoryMode !== '0755'
    || value.desired.directoryUid !== 0 || value.desired.directoryGid !== 0
    || typeof value.current.sshdConfig?.present !== 'boolean'
    || typeof value.current.sshdConfig?.matchesDesired !== 'boolean'
    || typeof value.current.mountUnit?.present !== 'boolean'
    || typeof value.current.mountUnit?.matchesDesired !== 'boolean'
    || typeof value.current.mountUnit?.active !== 'boolean'
    || typeof value.current.sshdConfigValid !== 'boolean'
    || (value.current.receiptState !== null && !['prepared', 'active', 'compensated'].includes(value.current.receiptState))
    || (value.current.receiptError !== null
      && (typeof value.current.receiptError !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.current.receiptError)))) {
    return null;
  }

  let authorizedKeys = null;
  if (value.authorizedKeys !== undefined) {
    if (!value.authorizedKeys || typeof value.authorizedKeys !== 'object' || Array.isArray(value.authorizedKeys)
      || typeof value.authorizedKeys.satisfied !== 'boolean') return null;
    if (value.authorizedKeys.satisfied) {
      if (value.authorizedKeys.adapter !== 'openssh-authorized-keys'
        || !Number.isSafeInteger(value.authorizedKeys.keyCount) || value.authorizedKeys.keyCount < 0 || value.authorizedKeys.keyCount > 100
        || boundedSha256(value.authorizedKeys.sha256) === undefined) return null;
      authorizedKeys = Object.freeze({
        satisfied: true,
        adapter: 'openssh-authorized-keys',
        keyCount: value.authorizedKeys.keyCount,
        sha256: value.authorizedKeys.sha256,
      });
    } else {
      if (typeof value.authorizedKeys.reason !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.authorizedKeys.reason)) return null;
      authorizedKeys = Object.freeze({ satisfied: false, reason: value.authorizedKeys.reason });
    }
  }

  return Object.freeze({
    version: 1,
    satisfied: value.satisfied,
    current: Object.freeze({
      receiptState: value.current.receiptState,
      receiptError: value.current.receiptError,
      sshdConfig: Object.freeze({
        present: value.current.sshdConfig.present,
        sha256: configSha256,
        matchesDesired: value.current.sshdConfig.matchesDesired,
      }),
      mountUnit: Object.freeze({
        present: value.current.mountUnit.present,
        sha256: mountSha256,
        matchesDesired: value.current.mountUnit.matchesDesired,
        active: value.current.mountUnit.active,
      }),
      chrootRoot,
      chrootDirectory,
      mountDirectory,
      sshdConfigValid: value.current.sshdConfigValid,
    }),
    desired: Object.freeze({
      websiteId,
      applicationId,
      unixUser: identity.unixUser,
      sourceDirectory: identity.paths.workspace.sftpRoot,
      chrootRoot: value.desired.chrootRoot,
      chrootDirectory: value.desired.chrootDirectory,
      mountDirectory: value.desired.mountDirectory,
      sshdConfigPath: value.desired.sshdConfigPath,
      unitName: value.desired.unitName,
      sshdSha256: desiredSshdSha256,
      mountSha256: desiredMountSha256,
      directoryMode: '0755',
      directoryUid: 0,
      directoryGid: 0,
    }),
    ...(authorizedKeys ? { authorizedKeys } : {}),
    differences: Object.freeze([...value.differences]),
  });
}

async function inspectSftpMigrationPreview(handler, context, scope) {
  if (!handler || typeof handler.previewMigration !== 'function') return null;
  try {
    return boundedSftpMigrationPreview(await handler.previewMigration(context), scope);
  } catch {
    return null;
  }
}

function boundedPassengerMigrationPreview(value, { applicationId, identity } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.adapter !== 'passenger'
    || typeof value.satisfied !== 'boolean'
    || !value.current || typeof value.current !== 'object' || Array.isArray(value.current)
    || !value.desired || typeof value.desired !== 'object' || Array.isArray(value.desired)
    || !Array.isArray(value.differences) || value.differences.length > 20
    || value.differences.some((code) => typeof code !== 'string' || !/^[a-z0-9_]{1,120}$/.test(code))
    || value.desired.applicationId !== applicationId
    || value.desired.unixUser !== identity?.unixUser
    || value.desired.homeDirectory !== identity?.paths?.workspace?.homeDirectory
    || value.desired.currentRoot !== identity?.paths?.runtime?.currentRelease
    || value.desired.releasesDirectory !== identity?.paths?.runtime?.releasesDirectory
    || !Number.isInteger(value.desired.nodeMajor) || value.desired.nodeMajor < 20 || value.desired.nodeMajor > 40
    || !Array.isArray(value.desired.nodeCandidates) || value.desired.nodeCandidates.length < 1 || value.desired.nodeCandidates.length > 3
    || value.desired.nodeCandidates.some((candidate) => boundedText(candidate, 512) === null || !candidate.startsWith('/'))
    || !boundedPathWithin(value.desired.appRoot, value.desired.currentRoot)
    || !boundedPathWithin(value.desired.documentRoot, value.desired.appRoot)
    || boundedText(value.desired.startupFile, 240) === null || value.desired.startupFile.startsWith('/')) {
    return null;
  }

  const passenger = value.current.passenger;
  if (!passenger || typeof passenger !== 'object' || Array.isArray(passenger)
    || typeof passenger.healthy !== 'boolean'
    || (passenger.installedVersion !== null && boundedText(passenger.installedVersion, 80) === null)) return null;

  const currentIdentity = value.current.identity;
  if (!currentIdentity || typeof currentIdentity !== 'object' || Array.isArray(currentIdentity)
    || typeof currentIdentity.satisfied !== 'boolean') return null;
  let identityProjection;
  if (currentIdentity.satisfied) {
    if (!Number.isSafeInteger(currentIdentity.uid) || currentIdentity.uid < 1
      || !Number.isSafeInteger(currentIdentity.gid) || currentIdentity.gid < 1
      || currentIdentity.homeDirectory !== identity.paths.workspace.homeDirectory
      || !['/usr/sbin/nologin', '/sbin/nologin'].includes(currentIdentity.shell)
      || currentIdentity.homeMode !== '0750') return null;
    identityProjection = Object.freeze({
      satisfied: true,
      uid: currentIdentity.uid,
      gid: currentIdentity.gid,
      homeDirectory: currentIdentity.homeDirectory,
      shell: currentIdentity.shell,
      homeMode: currentIdentity.homeMode,
    });
  } else {
    if (typeof currentIdentity.reason !== 'string' || !/^[a-z0-9_]{1,120}$/.test(currentIdentity.reason)) return null;
    identityProjection = Object.freeze({ satisfied: false, reason: currentIdentity.reason });
  }

  if (!Array.isArray(value.current.nodeCandidates)
    || value.current.nodeCandidates.length !== value.desired.nodeCandidates.length) return null;
  const nodeCandidates = [];
  for (const candidate of value.current.nodeCandidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || !value.desired.nodeCandidates.includes(candidate.path)
      || typeof candidate.available !== 'boolean'
      || typeof candidate.matchesRequestedMajor !== 'boolean'
      || (candidate.version !== null && !/^v\d{1,2}\.\d+\.\d+$/.test(candidate.version))) return null;
    nodeCandidates.push(Object.freeze({
      path: candidate.path,
      available: candidate.available,
      version: candidate.version,
      matchesRequestedMajor: candidate.matchesRequestedMajor,
    }));
  }

  const currentReleaseTarget = value.current.currentReleaseTarget === null
    ? null
    : boundedText(value.current.currentReleaseTarget, 512);
  if (value.current.currentReleaseTarget !== null && currentReleaseTarget === null) return null;
  const currentReleaseTargetError = value.current.currentReleaseTargetError === null
    ? null
    : value.current.currentReleaseTargetError;
  if (currentReleaseTargetError !== null
    && (typeof currentReleaseTargetError !== 'string' || !/^[a-z0-9_]{1,120}$/.test(currentReleaseTargetError))) return null;

  let release = null;
  if (value.current.release !== null) {
    const candidate = value.current.release;
    const roots = [candidate?.resolvedAppRoot, candidate?.resolvedDocumentRoot, candidate?.resolvedStartup];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || typeof candidate.releaseId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.releaseId)
      || roots.some((entry) => boundedText(entry) === null
        || !entry.startsWith(`${identity.paths.runtime.releasesDirectory}/`))) return null;
    release = Object.freeze({
      releaseId: candidate.releaseId.toLowerCase(),
      resolvedAppRoot: candidate.resolvedAppRoot,
      resolvedDocumentRoot: candidate.resolvedDocumentRoot,
      resolvedStartup: candidate.resolvedStartup,
    });
  }

  let runtimeUmask = null;
  if (value.runtimeUmask !== undefined) {
    if (!value.runtimeUmask || typeof value.runtimeUmask !== 'object' || Array.isArray(value.runtimeUmask)
      || typeof value.runtimeUmask.satisfied !== 'boolean') return null;
    if (value.runtimeUmask.satisfied) {
      if (value.runtimeUmask.umask !== '0027') return null;
      runtimeUmask = Object.freeze({ satisfied: true, umask: '0027' });
    } else {
      const reason = boundedReason(value.runtimeUmask.reason);
      if (!reason) return null;
      runtimeUmask = Object.freeze({ satisfied: false, reason });
    }
  }

  return Object.freeze({
    version: 1,
    adapter: 'passenger',
    satisfied: value.satisfied,
    current: Object.freeze({
      passenger: Object.freeze({
        healthy: passenger.healthy,
        installedVersion: passenger.installedVersion,
      }),
      identity: identityProjection,
      nodeCandidates: Object.freeze(nodeCandidates),
      currentReleaseTarget,
      currentReleaseTargetError,
      release,
      ...(runtimeUmask ? { runtimeUmask } : {}),
    }),
    desired: Object.freeze({
      applicationId,
      nodeMajor: value.desired.nodeMajor,
      nodeCandidates: Object.freeze([...value.desired.nodeCandidates]),
      currentRoot: value.desired.currentRoot,
      releasesDirectory: value.desired.releasesDirectory,
      homeDirectory: value.desired.homeDirectory,
      appRoot: value.desired.appRoot,
      documentRoot: value.desired.documentRoot,
      startupFile: value.desired.startupFile,
      unixUser: value.desired.unixUser,
    }),
    differences: Object.freeze([...value.differences]),
  });
}

async function inspectPassengerMigrationPreview(handler, context, scope) {
  if (!handler || typeof handler.previewMigration !== 'function') return null;
  try {
    return boundedPassengerMigrationPreview(await handler.previewMigration(context), scope);
  } catch {
    return null;
  }
}

function boundedFsState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.present !== 'boolean') return null;
  if (value.present === false) return Object.freeze({ present: false });
  if (!Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.gid) || value.gid < 0
    || typeof value.mode !== 'string' || !/^0[0-7]{3}$/.test(value.mode)) return null;
  const projected = {
    present: true,
    uid: value.uid,
    gid: value.gid,
    mode: value.mode,
  };
  for (const field of ['file', 'directory', 'socket', 'symbolicLink']) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'boolean') return null;
      projected[field] = value[field];
    }
  }
  return Object.freeze(projected);
}

function boundedReason(value) {
  return typeof value === 'string' && /^[a-z0-9_]{1,120}$/.test(value) ? value : null;
}

function boundedPreviewDifferences(value, max = 40) {
  return Array.isArray(value)
    && value.length <= max
    && value.every((code) => boundedReason(code) !== null)
    ? Object.freeze([...value])
    : null;
}

function boundedPhpIdentity(value, expectedHome) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.satisfied !== 'boolean') return null;
  if (!value.satisfied) {
    const reason = boundedReason(value.reason);
    return reason ? Object.freeze({ satisfied: false, reason }) : null;
  }
  if (!Number.isSafeInteger(value.uid) || value.uid < 1
    || !Number.isSafeInteger(value.gid) || value.gid < 1
    || value.homeDirectory !== expectedHome) return null;
  const projected = {
    satisfied: true,
    uid: value.uid,
    gid: value.gid,
    homeDirectory: value.homeDirectory,
  };
  if (value.homeMode !== undefined) {
    if (typeof value.homeMode !== 'string' || !/^0[0-7]{3}$/.test(value.homeMode)) return null;
    projected.homeMode = value.homeMode;
  }
  return Object.freeze(projected);
}

function boundedPhpContainerPreview(value, scope) {
  const differences = boundedPreviewDifferences(value?.differences);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.adapter !== 'php-container'
    || typeof value.satisfied !== 'boolean' || !differences
    || !value.current || typeof value.current !== 'object' || Array.isArray(value.current)
    || !value.desired || typeof value.desired !== 'object' || Array.isArray(value.desired)
    || value.desired.websiteId !== scope.websiteId
    || value.desired.applicationId !== scope.applicationId
    || value.desired.releaseId !== scope.operationId
    || value.desired.unixUser !== scope.identity?.unixUser
    || value.desired.documentRoot !== path.posix.join(scope.identity?.paths?.runtime?.currentRelease ?? '', 'public')
    || value.desired.applicationRoot !== scope.identity?.paths?.runtime?.applicationRoot
    || value.desired.releasesDirectory !== scope.identity?.paths?.runtime?.releasesDirectory
    || value.desired.currentRelease !== scope.identity?.paths?.runtime?.currentRelease
    || value.desired.releaseDirectory !== path.posix.join(scope.identity?.paths?.runtime?.releasesDirectory ?? '', scope.operationId)
    || value.desired.releaseDocumentRoot !== path.posix.join(scope.identity?.paths?.runtime?.releasesDirectory ?? '', scope.operationId, 'public')
    || value.desired.controlDirectoryMode !== '0755'
    || value.desired.releaseDirectoryMode !== '0750') return null;

  const identity = boundedPhpIdentity(value.current.identity, scope.identity.paths.workspace.homeDirectory);
  const applicationRoot = boundedFsState(value.current.applicationRoot);
  const releasesDirectory = boundedFsState(value.current.releasesDirectory);
  const releaseDirectory = boundedFsState(value.current.releaseDirectory);
  const releaseDocumentRoot = boundedFsState(value.current.releaseDocumentRoot);
  const currentRelease = boundedFsState(value.current.currentRelease);
  if (!identity || !applicationRoot || !releasesDirectory || !releaseDirectory || !releaseDocumentRoot || !currentRelease) return null;
  const currentTarget = value.current.currentTarget === null ? null : boundedText(value.current.currentTarget);
  const currentTargetError = value.current.currentTargetError === null ? null : boundedReason(value.current.currentTargetError);
  if ((value.current.currentTarget !== null && currentTarget === null)
    || (value.current.currentTargetError !== null && currentTargetError === null)) return null;

  return Object.freeze({
    version: 1,
    adapter: 'php-container',
    satisfied: value.satisfied,
    current: Object.freeze({
      identity,
      applicationRoot,
      releasesDirectory,
      releaseDirectory,
      releaseDocumentRoot,
      currentRelease,
      currentTarget,
      currentTargetError,
    }),
    desired: Object.freeze({
      websiteId: scope.websiteId,
      applicationId: scope.applicationId,
      releaseId: scope.operationId,
      unixUser: scope.identity.unixUser,
      documentRoot: value.desired.documentRoot,
      applicationRoot: value.desired.applicationRoot,
      releasesDirectory: value.desired.releasesDirectory,
      currentRelease: value.desired.currentRelease,
      releaseDirectory: value.desired.releaseDirectory,
      releaseDocumentRoot: value.desired.releaseDocumentRoot,
      controlDirectoryMode: '0755',
      releaseDirectoryMode: '0750',
    }),
    differences,
  });
}

function boundedPhpFpmPreview(value, scope) {
  const differences = boundedPreviewDifferences(value?.differences);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.adapter !== 'php-fpm'
    || typeof value.satisfied !== 'boolean' || !differences
    || !value.current || typeof value.current !== 'object' || Array.isArray(value.current)
    || !value.desired || typeof value.desired !== 'object' || Array.isArray(value.desired)
    || value.desired.websiteId !== scope.websiteId
    || value.desired.applicationId !== scope.applicationId
    || value.desired.unixUser !== scope.identity?.unixUser
    || value.desired.homeDirectory !== scope.identity?.paths?.workspace?.homeDirectory
    || value.desired.documentRoot !== path.posix.join(scope.identity?.paths?.runtime?.currentRelease ?? '', 'public')
    || boundedText(value.desired.packageName, 80) === null
    || boundedText(value.desired.phpVersion, 40) === null
    || boundedText(value.desired.configPath) === null || !value.desired.configPath.startsWith('/')
    || boundedSha256(value.desired.configSha256) === undefined
    || value.desired.configMode !== '0600'
    || boundedText(value.desired.socketPath) === null || !value.desired.socketPath.startsWith('/')
    || value.desired.socketMode !== '0660'
    || boundedText(value.desired.serviceUnit, 160) === null) return null;

  const identity = boundedPhpIdentity(value.current.identity, scope.identity.paths.workspace.homeDirectory);
  const documentRoot = boundedFsState(value.current.documentRoot);
  const socket = boundedFsState(value.current.socket);
  if (!identity || !documentRoot || !socket) return null;

  const packageState = value.current.package;
  if (!packageState || typeof packageState !== 'object' || Array.isArray(packageState)
    || typeof packageState.installed !== 'boolean'
    || (packageState.version !== null && boundedText(packageState.version, 120) === null)) return null;

  const receipt = value.current.receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || (receipt.state !== null && !['prepared', 'active', 'compensated'].includes(receipt.state))
    || (receipt.mutated !== null && typeof receipt.mutated !== 'boolean')
    || boundedSha256(receipt.previousConfigSha256, { nullable: true }) === undefined
    || (receipt.error !== null && boundedReason(receipt.error) === null)) return null;

  const pool = value.current.pool;
  if (!pool || typeof pool !== 'object' || Array.isArray(pool) || typeof pool.present !== 'boolean'
    || boundedSha256(pool.sha256, { nullable: true }) === undefined
    || typeof pool.matchesDesired !== 'boolean'
    || (pool.readError !== null && boundedReason(pool.readError) === null)) return null;
  const poolState = boundedFsState(pool);
  if (!poolState) return null;
  if (value.current.configValid !== null && typeof value.current.configValid !== 'boolean') return null;
  if (typeof value.current.serviceActive !== 'boolean') return null;

  return Object.freeze({
    version: 1,
    adapter: 'php-fpm',
    satisfied: value.satisfied,
    current: Object.freeze({
      identity,
      documentRoot,
      package: Object.freeze({
        installed: packageState.installed,
        version: packageState.version,
      }),
      receipt: Object.freeze({
        state: receipt.state,
        mutated: receipt.mutated,
        previousConfigSha256: receipt.previousConfigSha256,
        error: receipt.error,
      }),
      pool: Object.freeze({
        ...poolState,
        sha256: pool.sha256,
        matchesDesired: pool.matchesDesired,
        readError: pool.readError,
      }),
      configValid: value.current.configValid,
      serviceActive: value.current.serviceActive,
      socket,
    }),
    desired: Object.freeze({
      websiteId: scope.websiteId,
      applicationId: scope.applicationId,
      unixUser: scope.identity.unixUser,
      homeDirectory: scope.identity.paths.workspace.homeDirectory,
      documentRoot: value.desired.documentRoot,
      packageName: value.desired.packageName,
      phpVersion: value.desired.phpVersion,
      configPath: value.desired.configPath,
      configSha256: value.desired.configSha256,
      configMode: '0600',
      socketPath: value.desired.socketPath,
      socketMode: '0660',
      serviceUnit: value.desired.serviceUnit,
    }),
    differences,
  });
}

function boundedPhpRuntimeMigrationPreview(value, scope) {
  const differences = boundedPreviewDifferences(value?.differences);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.adapter !== 'php-runtime'
    || typeof value.satisfied !== 'boolean' || !differences
    || !value.current || typeof value.current !== 'object' || Array.isArray(value.current)
    || !value.desired || typeof value.desired !== 'object' || Array.isArray(value.desired)
    || value.desired.websiteId !== scope.websiteId
    || value.desired.applicationId !== scope.applicationId
    || value.desired.unixUser !== scope.identity?.unixUser
    || value.desired.documentRoot !== path.posix.join(scope.identity?.paths?.runtime?.currentRelease ?? '', 'public')
    || value.desired.runtimeUmask !== '0027') return null;

  const container = boundedPhpContainerPreview(value.current.container, scope);
  const fpm = boundedPhpFpmPreview(value.current.fpm, scope);
  const umask = value.current.umask;
  if (!container || !fpm || !umask || typeof umask !== 'object' || Array.isArray(umask)
    || typeof umask.satisfied !== 'boolean') return null;
  let umaskProjection;
  if (umask.satisfied) {
    if (umask.umask !== '0027') return null;
    umaskProjection = Object.freeze({ satisfied: true, umask: '0027' });
  } else {
    const reason = boundedReason(umask.reason);
    if (!reason) return null;
    umaskProjection = Object.freeze({ satisfied: false, reason });
  }

  return Object.freeze({
    version: 1,
    adapter: 'php-runtime',
    satisfied: value.satisfied,
    current: Object.freeze({ container, fpm, umask: umaskProjection }),
    desired: Object.freeze({
      websiteId: scope.websiteId,
      applicationId: scope.applicationId,
      unixUser: scope.identity.unixUser,
      documentRoot: value.desired.documentRoot,
      runtimeUmask: '0027',
    }),
    differences,
  });
}

async function inspectPhpRuntimeMigrationPreview(handler, context, scope) {
  if (!handler || typeof handler.previewMigration !== 'function') return null;
  try {
    return boundedPhpRuntimeMigrationPreview(await handler.previewMigration(context), scope);
  } catch {
    return null;
  }
}

function boundedStaticPublishPreview(value, scope) {
  const differences = boundedPreviewDifferences(value?.differences);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.adapter !== 'static-publish-isolation'
    || typeof value.satisfied !== 'boolean' || !differences
    || !value.current || typeof value.current !== 'object' || Array.isArray(value.current)
    || !value.desired || typeof value.desired !== 'object' || Array.isArray(value.desired)
    || value.desired.websiteId !== scope.websiteId
    || value.desired.applicationId !== scope.applicationId
    || value.desired.unixUser !== scope.identity?.unixUser
    || value.desired.homeDirectory !== scope.identity?.paths?.workspace?.homeDirectory
    || value.desired.publishRoot !== scope.identity?.paths?.static?.publishRoot
    || value.desired.releasesRoot !== path.posix.join(scope.identity?.paths?.static?.publishRoot ?? '', 'releases')
    || value.desired.currentPath !== path.posix.join(scope.identity?.paths?.static?.publishRoot ?? '', 'current')
    || value.desired.controlDirectoryMode !== '0711'
    || value.desired.releaseDirectoryMode !== '0750'
    || value.desired.releaseFileMode !== '0640'
    || value.desired.nginxDirectoryAcl !== 'user:www-data:r-x'
    || value.desired.nginxFileAcl !== 'user:www-data:r--'
    || value.desired.aclPackage !== 'acl') return null;

  const identity = boundedPhpIdentity(value.current.identity, scope.identity.paths.workspace.homeDirectory);
  const publishRoot = boundedFsState(value.current.publishRoot);
  const releasesRoot = boundedFsState(value.current.releasesRoot);
  if (!identity || !publishRoot || !releasesRoot || typeof value.current.aclToolsAvailable !== 'boolean'
    || !Array.isArray(value.current.releases) || value.current.releases.length > 100) return null;

  const releases = [];
  for (const release of value.current.releases) {
    if (!release || typeof release !== 'object' || Array.isArray(release)
      || typeof release.releaseId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(release.releaseId)
      || typeof release.satisfied !== 'boolean'
      || (release.reason !== null && boundedReason(release.reason) === null)) return null;
    releases.push(Object.freeze({
      releaseId: release.releaseId.toLowerCase(),
      satisfied: release.satisfied,
      reason: release.reason,
    }));
  }

  const current = value.current.current;
  if (!current || typeof current !== 'object' || Array.isArray(current) || typeof current.present !== 'boolean') return null;
  let currentProjection;
  if (!current.present) {
    if (current.error !== undefined && boundedReason(current.error) === null) return null;
    currentProjection = Object.freeze({
      present: false,
      ...(current.error === undefined ? {} : { error: current.error }),
    });
  } else {
    if (typeof current.symbolicLink !== 'boolean'
      || !Number.isSafeInteger(current.uid) || current.uid < 0
      || !Number.isSafeInteger(current.gid) || current.gid < 0
      || boundedText(current.target, 512) === null) return null;
    currentProjection = Object.freeze({
      present: true,
      symbolicLink: current.symbolicLink,
      uid: current.uid,
      gid: current.gid,
      target: current.target,
    });
  }

  return Object.freeze({
    version: 1,
    adapter: 'static-publish-isolation',
    satisfied: value.satisfied,
    current: Object.freeze({
      identity,
      aclToolsAvailable: value.current.aclToolsAvailable,
      publishRoot,
      releasesRoot,
      releases: Object.freeze(releases),
      current: currentProjection,
    }),
    desired: Object.freeze({
      websiteId: scope.websiteId,
      applicationId: scope.applicationId,
      unixUser: scope.identity.unixUser,
      homeDirectory: scope.identity.paths.workspace.homeDirectory,
      publishRoot: value.desired.publishRoot,
      releasesRoot: value.desired.releasesRoot,
      currentPath: value.desired.currentPath,
      controlDirectoryMode: '0711',
      releaseDirectoryMode: '0750',
      releaseFileMode: '0640',
      nginxDirectoryAcl: 'user:www-data:r-x',
      nginxFileAcl: 'user:www-data:r--',
      aclPackage: 'acl',
    }),
    differences,
  });
}

function boundedStaticRuntimeState(value, scope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.adapter !== 'static'
    || value.applicationId !== scope.applicationId
    || typeof value.satisfied !== 'boolean') return null;
  const projected = {
    satisfied: value.satisfied,
    adapter: 'static',
    applicationId: scope.applicationId,
  };
  if (value.reason !== undefined) {
    const reason = boundedReason(value.reason);
    if (!reason) return null;
    projected.reason = reason;
  }
  if (value.releaseId !== undefined) {
    if (typeof value.releaseId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.releaseId)) return null;
    projected.releaseId = value.releaseId.toLowerCase();
  }
  if (value.deploymentId !== undefined) {
    if (typeof value.deploymentId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.deploymentId)) return null;
    projected.deploymentId = value.deploymentId.toLowerCase();
  }
  if (value.currentRelease !== undefined) {
    const expected = path.posix.join(scope.identity.paths.static.publishRoot, 'current');
    if (value.currentRelease !== expected) return null;
    projected.currentRelease = expected;
  }
  if (value.unixUser !== undefined) {
    if (value.unixUser !== scope.identity.unixUser) return null;
    projected.unixUser = value.unixUser;
  }
  if (value.homeDirectory !== undefined) {
    if (value.homeDirectory !== scope.identity.paths.workspace.homeDirectory) return null;
    projected.homeDirectory = value.homeDirectory;
  }
  return Object.freeze(projected);
}

function boundedStaticRuntimeMigrationPreview(value, scope) {
  const differences = boundedPreviewDifferences(value?.differences);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || value.adapter !== 'static-runtime'
    || typeof value.satisfied !== 'boolean' || !differences
    || !value.current || typeof value.current !== 'object' || Array.isArray(value.current)
    || !value.desired || typeof value.desired !== 'object' || Array.isArray(value.desired)
    || value.desired.websiteId !== scope.websiteId
    || value.desired.applicationId !== scope.applicationId
    || !['deploy', 'bind_existing', 'legacy_unresolved'].includes(value.desired.mode)
    || (value.desired.mode === 'deploy' && value.desired.deploymentId !== scope.operationId)
    || (value.desired.mode !== 'deploy' && value.desired.deploymentId !== null)) return null;

  const runtime = boundedStaticRuntimeState(value.current.runtime, scope);
  const isolation = boundedStaticPublishPreview(value.current.isolation, scope);
  if (!runtime || !isolation) return null;

  return Object.freeze({
    version: 1,
    adapter: 'static-runtime',
    satisfied: value.satisfied,
    current: Object.freeze({ runtime, isolation }),
    desired: Object.freeze({
      websiteId: scope.websiteId,
      applicationId: scope.applicationId,
      mode: value.desired.mode,
      deploymentId: value.desired.deploymentId,
    }),
    differences,
  });
}

async function inspectStaticRuntimeMigrationPreview(handler, context, scope) {
  if (!handler || typeof handler.previewMigration !== 'function') return null;
  try {
    return boundedStaticRuntimeMigrationPreview(await handler.previewMigration(context), scope);
  } catch {
    return null;
  }
}

function migrationChange({ id, action, current, desired, ownership = 'unverified', applyState = null }) {
  return Object.freeze({
    id,
    action,
    ownership,
    applyState: applyState ?? (ownership === 'operation_owned' ? 'requires_explicit_apply' : 'blocked'),
    current: Object.freeze({ ...current }),
    desired: Object.freeze({ ...desired }),
  });
}

function workspaceDirectories(result, identity) {
  if (result?.reason !== 'website_identity_workspace_missing' || !Array.isArray(result.missingWorkspaces)) return null;
  const definitions = Object.freeze({
    temporary: Object.freeze({ name: 'temporary', directory: identity.paths.workspace.temporaryDirectory, mode: '0700' }),
    logs: Object.freeze({ name: 'logs', directory: identity.paths.workspace.logDirectory, mode: '0750' }),
  });
  const names = [...new Set(result.missingWorkspaces)];
  if (names.length < 1 || names.some((name) => !definitions[name])) return null;
  return Object.freeze(names.map((name) => definitions[name]));
}

function handlerContext(operation, step) {
  return Object.freeze({
    operation,
    operationId: operation.operationId,
    websiteId: operation.websiteId,
    stepId: step.id,
    intent: step.intent,
    evidence: step.evidence,
    compensation: step.compensation,
  });
}

export function createWebsiteIsolationAuditService({
  websiteRegistry,
  applicationRegistry,
  provisioningRegistry = null,
  provisioningHandlers = null,
  workspaceMigrationAvailable = false,
} = {}) {
  if (!websiteRegistry || typeof websiteRegistry.getWebsite !== 'function'
    || !applicationRegistry || typeof applicationRegistry.getApplication !== 'function'
    || (provisioningRegistry !== null && typeof provisioningRegistry.getLatestForWebsite !== 'function')) {
    throw new WebsiteIsolationAuditError(
      'website_isolation_audit_dependencies_invalid',
      'Website isolation audit dependencies are unavailable',
      503,
    );
  }

  async function audit(websiteId) {
    const website = await websiteRegistry.getWebsite(websiteId);
    if (!website) throw new WebsiteIsolationAuditError('website_not_found', 'Website not found', 404);
    if (!HOSTED_RUNTIME_TYPES.has(website.runtimeType)) {
      return Object.freeze({
        version: 1,
        websiteId: website.id,
        runtimeType: website.runtimeType,
        applicable: false,
        status: 'not_applicable',
        migrationRequired: false,
        findings: Object.freeze([]),
        migration: null,
      });
    }
    if (!website.applicationId) {
      throw new WebsiteIsolationAuditError('website_isolation_application_missing', 'Hosted Website has no Application identity', 409);
    }

    const application = await applicationRegistry.getApplication(website.applicationId);
    if (!application) {
      throw new WebsiteIsolationAuditError('website_isolation_application_missing', 'Hosted Website Application does not exist', 409);
    }
    if (application.serverId !== website.serverId || application.type !== website.runtimeType) {
      throw new WebsiteIsolationAuditError('website_isolation_binding_drift', 'Website and Application runtime binding has drifted', 409);
    }

    const identity = createApplicationIdentity(application.id);
    const expectedRoot = expectedDocumentRoot(website.runtimeType, identity);
    const findings = [];
    const changes = [];
    if (website.unixUser !== identity.unixUser) {
      findings.push(finding(
        'website_isolation_unix_user_drift',
        'critical',
        'Website Unix user does not match the canonical Application identity.',
        'Review the existing account and create an explicit migration plan; do not rename or chown recursively automatically.',
      ));
      changes.push(migrationChange({
        id: 'website.unix_identity',
        action: 'adopt_canonical_unix_identity',
        ownership: 'legacy_review_required',
        current: { unixUser: website.unixUser },
        desired: { unixUser: identity.unixUser },
      }));
    }
    if (website.documentRoot !== expectedRoot) {
      findings.push(finding(
        'website_isolation_document_root_drift',
        'critical',
        'Website document root does not match the canonical runtime path contract.',
        'Inspect the existing release tree and plan an explicit cutover; do not move files automatically.',
      ));
      changes.push(migrationChange({
        id: 'website.document_root',
        action: 'adopt_canonical_document_root',
        ownership: 'legacy_review_required',
        current: { documentRoot: website.documentRoot },
        desired: { documentRoot: expectedRoot },
      }));
    }

    const operation = provisioningRegistry
      ? await provisioningRegistry.getLatestForWebsite(website.id)
      : null;
    const inspectedSteps = [];
    if (!operation) {
      findings.push(finding(
        'website_isolation_operation_missing',
        'action_required',
        'Website has no durable provisioning operation that proves isolation state.',
        'Create an explicit adoption/migration operation after reviewing current UID/GID, paths and runtime state.',
      ));
      changes.push(migrationChange({
        id: 'provisioning.operation',
        action: 'create_isolation_adoption_operation',
        ownership: 'adoption_review_required',
        current: { operationId: null },
        desired: { websiteId: website.id, stepIds: ISOLATION_STEPS[website.runtimeType] },
      }));
    } else {
      for (const stepId of ISOLATION_STEPS[website.runtimeType]) {
        const step = operation.steps.find((candidate) => candidate.id === stepId) ?? null;
        if (!step) {
          findings.push(finding(
            `website_isolation_${stepId}_missing`,
            'action_required',
            `Durable Website provisioning is missing the ${stepId} isolation step.`,
            'Preview and apply an explicit Website isolation migration; do not mutate unrelated files.',
          ));
          changes.push(migrationChange({
            id: `provisioning.${stepId}`,
            action: 'add_isolation_step',
            ownership: 'adoption_review_required',
            current: { operationId: operation.operationId, stepId, present: false },
            desired: { operationId: operation.operationId, stepId, present: true },
          }));
          continue;
        }
        const inspectionKind = stepId === 'runtime' && website.runtimeType === 'static'
          ? 'static_runtime'
          : step.kind;
        const handler = provisioningHandlers?.[inspectionKind] ?? null;
        if (!handler || typeof handler.inspect !== 'function') {
          inspectedSteps.push(Object.freeze({ stepId, kind: step.kind, satisfied: null, reason: 'inspect_unavailable' }));
          findings.push(finding(
            `website_isolation_${stepId}_inspect_unavailable`,
            'action_required',
            `Current host state for ${stepId} cannot be inspected through the configured runtime.`,
            'Restore the isolation inspector before migration or readiness decisions.',
          ));
          changes.push(migrationChange({
            id: `provisioning.${stepId}`,
            action: 'reconcile_isolation_step',
            current: {
              operationId: operation.operationId,
              stepId,
              stepKind: step.kind,
              stepState: step.state,
              intentSha256: valueDigest(step.intent),
              inspection: 'unavailable',
            },
            desired: { satisfied: true },
          }));
          continue;
        }
        try {
          const context = handlerContext(operation, step);
          const result = await handler.inspect(context);
          const satisfied = result?.satisfied === true;
          const missingWorkspaceDirectories = stepId === 'unix_identity'
            ? workspaceDirectories(result, identity)
            : null;
          const identityMigrationPreview = !satisfied && stepId === 'unix_identity' && !missingWorkspaceDirectories
            ? await inspectIdentityMigrationPreview(handler, context, identity)
            : null;
          const sftpMigrationPreview = !satisfied && stepId === 'sftp'
            ? await inspectSftpMigrationPreview(handler, context, {
              websiteId: website.id,
              applicationId: application.id,
              identity,
            })
            : null;
          const passengerMigrationPreview = !satisfied && stepId === 'runtime' && website.runtimeType === 'node'
            ? await inspectPassengerMigrationPreview(handler, context, {
              applicationId: application.id,
              identity,
            })
            : null;
          const staticRuntimeMigrationPreview = !satisfied && stepId === 'runtime' && website.runtimeType === 'static'
            ? await inspectStaticRuntimeMigrationPreview(handler, context, {
              websiteId: website.id,
              applicationId: application.id,
              operationId: operation.operationId,
              identity,
            })
            : null;
          const phpRuntimeMigrationPreview = !satisfied && stepId === 'php_runtime'
            ? await inspectPhpRuntimeMigrationPreview(handler, context, {
              websiteId: website.id,
              applicationId: application.id,
              operationId: operation.operationId,
              identity,
            })
            : null;
          inspectedSteps.push(Object.freeze({
            stepId,
            kind: step.kind,
            satisfied,
            reason: satisfied ? null : result?.reason ?? 'isolation_not_satisfied',
            ...(missingWorkspaceDirectories ? {
              missingWorkspaces: Object.freeze(missingWorkspaceDirectories.map((target) => target.name)),
            } : {}),
            ...(identityMigrationPreview ? { identityMigrationPreview } : {}),
            ...(sftpMigrationPreview ? { sftpMigrationPreview } : {}),
            ...(passengerMigrationPreview ? { passengerMigrationPreview } : {}),
            ...(staticRuntimeMigrationPreview ? { staticRuntimeMigrationPreview } : {}),
            ...(phpRuntimeMigrationPreview ? { phpRuntimeMigrationPreview } : {}),
          }));
          if (!satisfied) {
            findings.push(finding(
              `website_isolation_${stepId}_not_satisfied`,
              'action_required',
              `${stepId} host isolation is not currently satisfied.`,
              'Inspect the reported drift and use an explicit migration/retry path instead of recursive ownership repair.',
            ));
            changes.push(missingWorkspaceDirectories ? migrationChange({
              id: 'workspace.directories',
              action: 'create_workspace_directories',
              ownership: 'operation_receipt_planned',
              applyState: 'requires_explicit_apply',
              current: {
                operationId: operation.operationId,
                stepId,
                stepKind: step.kind,
                stepState: step.state,
                intentSha256: valueDigest(step.intent),
                directories: Object.freeze(missingWorkspaceDirectories.map((target) => Object.freeze({
                  name: target.name,
                  directory: target.directory,
                  present: false,
                }))),
              },
              desired: {
                directories: missingWorkspaceDirectories,
              },
            }) : migrationChange({
              id: `provisioning.${stepId}`,
              action: 'reconcile_isolation_step',
              ownership: 'operation_receipt_required',
              current: {
                operationId: operation.operationId,
                stepId,
                stepKind: step.kind,
                stepState: step.state,
                intentSha256: valueDigest(step.intent),
                inspection: result?.reason ?? 'isolation_not_satisfied',
                ...(identityMigrationPreview ? { identityMigrationPreview } : {}),
                ...(sftpMigrationPreview ? { sftpMigrationPreview } : {}),
                ...(passengerMigrationPreview ? { passengerMigrationPreview } : {}),
                ...(staticRuntimeMigrationPreview ? { staticRuntimeMigrationPreview } : {}),
                ...(phpRuntimeMigrationPreview ? { phpRuntimeMigrationPreview } : {}),
              },
              desired: { satisfied: true },
            }));
          }
        } catch (error) {
          const context = handlerContext(operation, step);
          const identityMigrationPreview = stepId === 'unix_identity'
            ? await inspectIdentityMigrationPreview(handler, context, identity)
            : null;
          const sftpMigrationPreview = stepId === 'sftp'
            ? await inspectSftpMigrationPreview(handler, context, {
              websiteId: website.id,
              applicationId: application.id,
              identity,
            })
            : null;
          const passengerMigrationPreview = stepId === 'runtime' && website.runtimeType === 'node'
            ? await inspectPassengerMigrationPreview(handler, context, {
              applicationId: application.id,
              identity,
            })
            : null;
          const staticRuntimeMigrationPreview = stepId === 'runtime' && website.runtimeType === 'static'
            ? await inspectStaticRuntimeMigrationPreview(handler, context, {
              websiteId: website.id,
              applicationId: application.id,
              operationId: operation.operationId,
              identity,
            })
            : null;
          const phpRuntimeMigrationPreview = stepId === 'php_runtime'
            ? await inspectPhpRuntimeMigrationPreview(handler, context, {
              websiteId: website.id,
              applicationId: application.id,
              operationId: operation.operationId,
              identity,
            })
            : null;
          inspectedSteps.push(Object.freeze({
            stepId,
            kind: step.kind,
            satisfied: false,
            reason: typeof error?.code === 'string' ? error.code : 'isolation_inspection_failed',
            ...(identityMigrationPreview ? { identityMigrationPreview } : {}),
            ...(sftpMigrationPreview ? { sftpMigrationPreview } : {}),
            ...(passengerMigrationPreview ? { passengerMigrationPreview } : {}),
            ...(staticRuntimeMigrationPreview ? { staticRuntimeMigrationPreview } : {}),
            ...(phpRuntimeMigrationPreview ? { phpRuntimeMigrationPreview } : {}),
          }));
          findings.push(finding(
            `website_isolation_${stepId}_drift`,
            'critical',
            `${stepId} inspection detected managed host drift.`,
            'Stop automatic migration and review the host evidence before changing ownership or routing.',
          ));
          changes.push(migrationChange({
            id: `provisioning.${stepId}`,
            action: 'reconcile_isolation_step',
            ownership: 'host_drift_review_required',
            current: {
              operationId: operation.operationId,
              stepId,
              stepKind: step.kind,
              stepState: step.state,
              intentSha256: valueDigest(step.intent),
              inspection: typeof error?.code === 'string' ? error.code : 'isolation_inspection_failed',
              ...(identityMigrationPreview ? { identityMigrationPreview } : {}),
              ...(sftpMigrationPreview ? { sftpMigrationPreview } : {}),
              ...(passengerMigrationPreview ? { passengerMigrationPreview } : {}),
              ...(staticRuntimeMigrationPreview ? { staticRuntimeMigrationPreview } : {}),
              ...(phpRuntimeMigrationPreview ? { phpRuntimeMigrationPreview } : {}),
            },
            desired: { satisfied: true },
          }));
        }
      }
    }

    const migrationRequired = findings.length > 0;
    const migrationCore = Object.freeze({
      version: 1,
      websiteId: website.id,
      websiteRevision: website.revision,
      applicationId: application.id,
      runtimeType: website.runtimeType,
      expected: Object.freeze({
        unixUser: identity.unixUser,
        homeDirectory: identity.paths.workspace.homeDirectory,
        documentRoot: expectedRoot,
        temporaryDirectory: identity.paths.workspace.temporaryDirectory,
        logDirectory: identity.paths.workspace.logDirectory,
      }),
      changes: Object.freeze(changes),
    });
    const previewDigest = migrationDigest(migrationCore);
    const applyAvailable = workspaceMigrationAvailable === true
      && changes.length === 1
      && changes[0].action === 'create_workspace_directories'
      && changes[0].applyState === 'requires_explicit_apply';

    return Object.freeze({
      ...migrationCore,
      applicable: true,
      status: migrationRequired ? 'migration_required' : 'isolated',
      migrationRequired,
      findings: Object.freeze(findings),
      inspectedSteps: Object.freeze(inspectedSteps),
      migration: migrationRequired ? Object.freeze({
        destructive: false,
        autoApply: false,
        applyAvailable,
        previewDigest,
        confirmation: `migrate-isolation:${website.id}:${website.revision}:${previewDigest}`,
        changes: Object.freeze(changes),
        warning: applyAvailable
          ? 'Apply creates only the listed operation-receipted workspace directories; it does not rename users, move files or change ownership recursively.'
          : 'Preview only. No ownership, filesystem or runtime mutation is performed by this audit.',
      }) : null,
    });
  }

  return Object.freeze({ audit });
}

export const websiteIsolationAuditInternals = Object.freeze({
  hostedRuntimeTypes: Object.freeze([...HOSTED_RUNTIME_TYPES]),
  isolationSteps: ISOLATION_STEPS,
  expectedDocumentRoot,
  migrationDigest,
  valueDigest,
  migrationChange,
  workspaceDirectories,
  boundedPathWithin,
  boundedIdentityMigrationPreview,
  inspectIdentityMigrationPreview,
  boundedSftpMigrationPreview,
  inspectSftpMigrationPreview,
  boundedPassengerMigrationPreview,
  inspectPassengerMigrationPreview,
  boundedFsState,
  boundedPhpContainerPreview,
  boundedPhpFpmPreview,
  boundedPhpRuntimeMigrationPreview,
  inspectPhpRuntimeMigrationPreview,
  boundedStaticPublishPreview,
  boundedStaticRuntimeState,
  boundedStaticRuntimeMigrationPreview,
  inspectStaticRuntimeMigrationPreview,
});
