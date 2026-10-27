import { MailTemplateError } from './mail.js';

// Outbound relay (Plesk "Smarthost"). Every value ends up in main.cf or in
// sasl_passwd, so each field is limited to a closed, whitespace-free set.
export const SMARTHOST_DIRECTORY = '/etc/postfix/yunpanel-smarthost';
export const SMARTHOST_SASL_PASSWD_PATH = `${SMARTHOST_DIRECTORY}/sasl_passwd`;
const FIELDS = ['host', 'port', 'username', 'password'];
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CREDENTIAL = /^[\x21-\x7e]{1,256}$/;

function invalid(message) {
  throw new MailTemplateError('invalid_smarthost', message);
}

export function normalizeSmarthost(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== FIELDS.length || Object.keys(value).some(key => !FIELDS.includes(key))) {
    invalid('Smarthost requires exactly host, port, username and password');
  }
  const host = typeof value.host === 'string' ? value.host.toLowerCase() : '';
  if (!HOSTNAME.test(host)) invalid('Smarthost host must be a public DNS name');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) invalid('Smarthost port is invalid');
  if (typeof value.username !== 'string' || !CREDENTIAL.test(value.username)) invalid('Smarthost username must be 1-256 visible ASCII characters');
  if (typeof value.password !== 'string' || !CREDENTIAL.test(value.password)) invalid('Smarthost password must be 1-256 visible ASCII characters');
  return Object.freeze({
    public: Object.freeze({ host, port: value.port, username: value.username }),
    password: value.password,
  });
}

export function renderSmarthost(value) {
  const { public: { host, port, username }, password } = normalizeSmarthost(value);
  const destination = `[${host}]:${port}`;
  return Object.freeze({
    postfixParameters: Object.freeze([
      Object.freeze({ name: 'relayhost', value: destination }),
      Object.freeze({ name: 'smtp_sasl_auth_enable', value: 'yes' }),
      Object.freeze({ name: 'smtp_sasl_password_maps', value: `hash:${SMARTHOST_SASL_PASSWD_PATH}` }),
      Object.freeze({ name: 'smtp_sasl_security_options', value: 'noanonymous' }),
      Object.freeze({ name: 'smtp_sasl_tls_security_options', value: 'noanonymous' }),
      // The credential must never cross an unencrypted connection.
      Object.freeze({ name: 'smtp_tls_security_level', value: 'encrypt' }),
      Object.freeze({ name: 'smtp_tls_wrappermode', value: port === 465 ? 'yes' : 'no' }),
    ]),
    saslPasswd: `${destination} ${username}:${password}\n`,
    sensitive: true,
  });
}

export const smarthostPolicy = Object.freeze({ fields: Object.freeze([...FIELDS]), managedParameters: Object.freeze([
  'relayhost', 'smtp_sasl_auth_enable', 'smtp_sasl_password_maps', 'smtp_sasl_security_options',
  'smtp_sasl_tls_security_options', 'smtp_tls_security_level', 'smtp_tls_wrappermode',
]) });
