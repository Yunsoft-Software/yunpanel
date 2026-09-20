import { createHash } from 'node:crypto';

export const netdataTemplatePolicy = Object.freeze({
  configPath: '/etc/netdata/netdata.conf',
  configMode: 0o644,
  serviceUnit: 'netdata.service',
  bindAddress: '127.0.0.1',
  defaultPort: 19999,
  runAsUser: 'netdata',
});

export class NetdataTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NetdataTemplateError';
    this.code = code;
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function renderNetdataConfig({
  bindAddress = netdataTemplatePolicy.bindAddress,
  port = netdataTemplatePolicy.defaultPort,
  runAsUser = netdataTemplatePolicy.runAsUser,
} = {}) {
  if (typeof bindAddress !== 'string' || !['127.0.0.1', '::1'].includes(bindAddress)) {
    throw new NetdataTemplateError(
      'netdata_bind_address_unsafe',
      'Netdata must bind exclusively to a loopback address (127.0.0.1 or ::1)',
    );
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new NetdataTemplateError(
      'netdata_port_invalid',
      'Netdata port must be an integer between 1024 and 65535',
    );
  }
  if (typeof runAsUser !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAsUser)) {
    throw new NetdataTemplateError(
      'netdata_user_invalid',
      'Netdata user must be a valid system username',
    );
  }

  return [
    '# Managed by YunPanel. Manual edits are overwritten.',
    '[global]',
    `    run as user = ${runAsUser}`,
    '    history = 3996',
    '    memory mode = save',
    '',
    '[web]',
    `    bind to = ${bindAddress}`,
    `    default port = ${port}`,
    '    disconnect idle web clients after seconds = 3600',
    '    respect do not track policy = yes',
    '    web files owner = root',
    `    web files group = ${runAsUser}`,
    '',
  ].join('\n');
}

export function previewNetdataConfiguration(options = {}) {
  const content = renderNetdataConfig(options);
  const digest = sha256(content);
  return Object.freeze({
    version: 1,
    sha256: digest,
    artifact: Object.freeze({
      path: netdataTemplatePolicy.configPath,
      sha256: digest,
      bytes: Buffer.byteLength(content, 'utf8'),
      mode: netdataTemplatePolicy.configMode,
      sensitive: false,
    }),
  });
}
