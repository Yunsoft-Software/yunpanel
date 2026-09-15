import path from 'node:path';
import { nodeApplicationUser } from './systemd.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SftpTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SftpTemplateError';
    this.code = code;
  }
}

function applicationIdentity(applicationId, unixUser) {
  if (typeof applicationId !== 'string' || !UUID_PATTERN.test(applicationId)) {
    throw new SftpTemplateError('sftp_application_invalid', 'SFTP Application identity is invalid');
  }
  const normalized = applicationId.toLowerCase();
  const expectedUser = nodeApplicationUser(normalized);
  if (unixUser !== expectedUser) {
    throw new SftpTemplateError('sftp_identity_mismatch', 'SFTP Unix user does not match the Application identity');
  }
  return Object.freeze({ applicationId: normalized, unixUser: expectedUser });
}

export const sftpTemplatePolicy = Object.freeze({
  dataRoot: '/var/lib/yunpanel/data',
  chrootRoot: '/var/lib/yunpanel/sftp-chroots',
  sshdDropInRoot: '/etc/ssh/sshd_config.d',
  systemdRoot: '/etc/systemd/system',
  sshServiceUnit: 'ssh.service',
  umask: '0027',
});

export function sftpSitePaths({ applicationId, unixUser } = {}) {
  const identity = applicationIdentity(applicationId, unixUser);
  const sourceDirectory = path.posix.join(sftpTemplatePolicy.dataRoot, identity.applicationId);
  const chrootDirectory = path.posix.join(sftpTemplatePolicy.chrootRoot, identity.applicationId);
  const mountDirectory = path.posix.join(chrootDirectory, 'site');
  return Object.freeze({
    ...identity,
    sourceDirectory,
    chrootDirectory,
    mountDirectory,
    sshdConfigPath: path.posix.join(sftpTemplatePolicy.sshdDropInRoot, `90-yunpanel-sftp-${identity.unixUser}.conf`),
  });
}

export function renderWebsiteSftpMatch(input = {}) {
  const paths = sftpSitePaths(input);
  return `Match User ${paths.unixUser}\n  ChrootDirectory ${paths.chrootDirectory}\n  ForceCommand internal-sftp -d /site -u ${sftpTemplatePolicy.umask}\n  PubkeyAuthentication yes\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n  PermitTTY no\n  X11Forwarding no\n  AllowTcpForwarding no\n  AllowAgentForwarding no\n`;
}

export function renderWebsiteSftpMountUnit(input = {}) {
  const paths = sftpSitePaths(input);
  return `[Unit]\nDescription=YunPanel SFTP bind mount for ${paths.unixUser}\nAfter=local-fs.target\nBefore=${sftpTemplatePolicy.sshServiceUnit}\n\n[Mount]\nWhat=${paths.sourceDirectory}\nWhere=${paths.mountDirectory}\nType=none\nOptions=bind,nosuid,nodev,noexec\n\n[Install]\nWantedBy=multi-user.target\n`;
}

export const sftpTemplateInternals = Object.freeze({ applicationIdentity });
