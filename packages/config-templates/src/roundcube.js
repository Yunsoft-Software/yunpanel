import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeDomainSet } from '@yunpanel/shared';

const DES_KEY_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;

export class RoundcubeTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoundcubeTemplateError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeHostname(value) {
  try { return normalizeDomainSet(value, []).primary; }
  catch { throw new RoundcubeTemplateError('invalid_roundcube_mail_hostname', 'Roundcube mail hostname is invalid'); }
}

function safeAbsolutePath(value, field) {
  if (typeof value !== 'string' || !SAFE_ABSOLUTE_PATH.test(value)
    || path.posix.normalize(value) !== value || value === '/' || value.includes('/../') || value.endsWith('/..')) {
    throw new RoundcubeTemplateError('invalid_roundcube_path', `${field} must be a safe absolute path`);
  }
  return value;
}

function phpString(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RoundcubeTemplateError('invalid_roundcube_string', 'Roundcube configuration string is invalid');
  }
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function sqliteDsn(databasePath) {
  const safePath = safeAbsolutePath(databasePath, 'databasePath');
  return `sqlite:///${safePath}`;
}

export const roundcubeTemplatePolicy = Object.freeze({
  configPath: '/etc/roundcube/config.inc.php',
  databasePath: '/var/lib/yunpanel/roundcube/roundcube.sqlite',
  databaseSchemaPath: '/usr/share/roundcube/SQL/sqlite.initial.sql',
  publicRoot: '/var/lib/roundcube/public_html',
  temporaryDirectory: '/var/lib/yunpanel/roundcube/tmp',
  configMode: 0o640,
  databaseMode: 0o660,
  privateDirectoryMode: 0o770,
  desKeyBytes: 18,
  desKeyCharacters: 24,
});

export function renderRoundcubeConfig({
  mailHostname,
  desKey,
  databasePath = roundcubeTemplatePolicy.databasePath,
  temporaryDirectory = roundcubeTemplatePolicy.temporaryDirectory,
  productName = 'YunPanel Webmail',
} = {}) {
  const host = safeHostname(mailHostname);
  if (typeof desKey !== 'string' || !DES_KEY_PATTERN.test(desKey)) {
    throw new RoundcubeTemplateError(
      'invalid_roundcube_des_key',
      'Roundcube encryption key must be a private 24-character base64url value',
    );
  }
  const database = safeAbsolutePath(databasePath, 'databasePath');
  const temp = safeAbsolutePath(temporaryDirectory, 'temporaryDirectory');
  if (typeof productName !== 'string' || productName.length < 1 || productName.length > 80
    || /[\u0000-\u001f\u007f]/.test(productName)) {
    throw new RoundcubeTemplateError('invalid_roundcube_product_name', 'Roundcube product name is invalid');
  }

  return `<?php\n$config = [];\n\n$config['db_dsnw'] = ${phpString(sqliteDsn(database))};\n$config['imap_host'] = ${phpString(`tls://${host}:143`)};\n$config['imap_conn_options'] = [\n    'ssl' => [\n        'verify_peer' => true,\n        'verify_peer_name' => true,\n        'allow_self_signed' => false,\n        'peer_name' => ${phpString(host)},\n    ],\n];\n$config['smtp_host'] = ${phpString(`tls://${host}:587`)};\n$config['smtp_user'] = '%u';\n$config['smtp_pass'] = '%p';\n$config['smtp_timeout'] = 15;\n$config['smtp_conn_options'] = [\n    'ssl' => [\n        'verify_peer' => true,\n        'verify_peer_name' => true,\n        'allow_self_signed' => false,\n        'peer_name' => ${phpString(host)},\n    ],\n];\n$config['des_key'] = ${phpString(desKey)};\n$config['product_name'] = ${phpString(productName)};\n$config['skin'] = 'elastic';\n$config['plugins'] = ['archive', 'zipdownload'];\n$config['enable_installer'] = false;\n$config['temp_dir'] = ${phpString(temp)};\n$config['log_driver'] = 'syslog';\n$config['smtp_log'] = false;\n$config['log_logins'] = false;\n$config['session_debug'] = false;\n$config['sql_debug'] = false;\n$config['imap_debug'] = false;\n$config['smtp_debug'] = false;\n`;
}

export function previewRoundcubeConfiguration(input) {
  const content = renderRoundcubeConfig(input);
  const mailHostname = safeHostname(input?.mailHostname);
  const databasePath = safeAbsolutePath(input?.databasePath ?? roundcubeTemplatePolicy.databasePath, 'databasePath');
  const temporaryDirectory = safeAbsolutePath(
    input?.temporaryDirectory ?? roundcubeTemplatePolicy.temporaryDirectory,
    'temporaryDirectory',
  );
  return Object.freeze({
    version: 1,
    sha256: sha256(content),
    artifact: Object.freeze({
      path: roundcubeTemplatePolicy.configPath,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
      sensitive: true,
      mode: roundcubeTemplatePolicy.configMode,
    }),
    mailHostname,
    databasePath,
    temporaryDirectory,
    databaseSchemaPath: roundcubeTemplatePolicy.databaseSchemaPath,
    publicRoot: roundcubeTemplatePolicy.publicRoot,
    requires: Object.freeze([
      'roundcube-core',
      'roundcube-sqlite3',
      'php-fpm',
      'mail-service-tls-identity',
    ]),
  });
}

export const roundcubeTemplateInternals = Object.freeze({
  safeHostname,
  safeAbsolutePath,
  phpString,
  sqliteDsn,
});