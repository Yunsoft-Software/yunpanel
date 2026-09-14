import path from 'node:path';

const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const STARTUP_FILE = /^[A-Za-z0-9._/-]{1,240}$/;
const UNIX_IDENTITY = /^yunapp-[a-f0-9]{12}$/;

export class PassengerNginxTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PassengerNginxTemplateError';
    this.code = code;
  }
}

function absolutePath(value, field) {
  if (typeof value !== 'string' || !SAFE_ABSOLUTE_PATH.test(value)) {
    throw new PassengerNginxTemplateError('passenger_nginx_path_invalid', `${field} must be a safe absolute path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || value.includes('/../') || value.endsWith('/..')) {
    throw new PassengerNginxTemplateError('passenger_nginx_path_invalid', `${field} contains unsafe path segments`);
  }
  return value;
}

function startupFile(value) {
  if (typeof value !== 'string' || !STARTUP_FILE.test(value) || value.startsWith('/') || value.split('/').includes('..')) {
    throw new PassengerNginxTemplateError('passenger_startup_file_invalid', 'Passenger startup file must be a safe application-relative path');
  }
  return value;
}

function unixIdentity(value, field) {
  if (typeof value !== 'string' || !UNIX_IDENTITY.test(value)) {
    throw new PassengerNginxTemplateError('passenger_identity_invalid', `${field} must use a managed Website identity`);
  }
  return value;
}

export function renderPassengerNodeDirectives({
  appRoot,
  documentRoot,
  startupFile: rawStartupFile,
  nodeBinary = '/usr/bin/node',
  user,
  group = user,
  appEnv = 'production',
} = {}) {
  const safeAppRoot = absolutePath(appRoot, 'appRoot');
  const safeDocumentRoot = absolutePath(documentRoot, 'documentRoot');
  const relativeDocumentRoot = path.posix.relative(safeAppRoot, safeDocumentRoot);
  if (relativeDocumentRoot.startsWith('..') || path.posix.isAbsolute(relativeDocumentRoot)) {
    throw new PassengerNginxTemplateError('passenger_document_root_invalid', 'Passenger documentRoot must stay inside appRoot');
  }
  const safeStartupFile = startupFile(rawStartupFile);
  const safeNodeBinary = absolutePath(nodeBinary, 'nodeBinary');
  const safeUser = unixIdentity(user, 'user');
  const safeGroup = unixIdentity(group, 'group');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(appEnv)) {
    throw new PassengerNginxTemplateError('passenger_app_env_invalid', 'Passenger app environment is invalid');
  }

  return [
    `  root ${safeDocumentRoot};`,
    '  passenger_enabled on;',
    `  passenger_app_root ${safeAppRoot};`,
    '  passenger_app_type node;',
    `  passenger_startup_file ${safeStartupFile};`,
    `  passenger_nodejs ${safeNodeBinary};`,
    `  passenger_user ${safeUser};`,
    `  passenger_group ${safeGroup};`,
    `  passenger_app_env ${appEnv};`,
  ].join('\n');
}

export const passengerNginxTemplateInternals = Object.freeze({
  absolutePath,
  startupFile,
  unixIdentity,
});
