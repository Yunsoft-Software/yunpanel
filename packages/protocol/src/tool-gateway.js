const SAFE_ID = /^[a-z][a-z0-9_-]{1,31}$/;
const SAFE_AUDIENCE = /^[a-z][a-z0-9._-]{1,63}$/;
const SAFE_HTTP_PATH = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_SOCKET_PATH = /^\/[A-Za-z0-9._/-]+\.sock$/;
const SAFE_SOCKET_ROOT = /^\/[A-Za-z0-9._/-]+$/;
const ACCESS_MODES = new Set(['owner', 'session']);

function descriptor(value) {
  const targetCount = Number(value?.socketPath !== undefined)
    + Number(value?.socketRoot !== undefined)
    + Number(value?.loopbackPort !== undefined);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !SAFE_ID.test(value.id ?? '')
    || !SAFE_AUDIENCE.test(value.audience ?? '')
    || !SAFE_HTTP_PATH.test(value.publicPrefix ?? '')
    || value.publicPrefix.endsWith('/')
    || !SAFE_HTTP_PATH.test(value.accessPath ?? '')
    || !ACCESS_MODES.has(value.accessMode)
    || targetCount !== 1
    || (value.socketPath !== undefined && !SAFE_SOCKET_PATH.test(value.socketPath))
    || (value.socketRoot !== undefined && (!SAFE_SOCKET_ROOT.test(value.socketRoot)
      || value.socketRoot === '/' || value.socketRoot.endsWith('/')))
    || (value.loopbackPort !== undefined && (!Number.isInteger(value.loopbackPort)
      || value.loopbackPort < 1024 || value.loopbackPort > 65535))) {
    throw new TypeError('Integrated tool gateway descriptor is invalid');
  }
  return Object.freeze({
    id: value.id,
    audience: value.audience,
    publicPrefix: value.publicPrefix,
    accessPath: value.accessPath,
    accessMode: value.accessMode,
    socketPath: value.socketPath ?? null,
    socketRoot: value.socketRoot ?? null,
    loopbackPort: value.loopbackPort ?? null,
  });
}

export const INTEGRATED_TOOL_GATEWAYS = Object.freeze({
  phpmyadmin: descriptor({
    id: 'phpmyadmin',
    audience: 'phpmyadmin',
    publicPrefix: '/tools/phpmyadmin',
    accessPath: '/api/phpmyadmin-gateway-access',
    accessMode: 'owner',
    socketPath: '/run/yunpanel/phpmyadmin-http.sock',
  }),
  elfinder: descriptor({
    id: 'elfinder',
    audience: 'elfinder',
    publicPrefix: '/tools/elfinder',
    accessPath: '/api/elfinder-gateway-access',
    accessMode: 'owner',
    socketPath: '/run/yunpanel/elfinder-http.sock',
  }),
  ttyd: descriptor({
    id: 'ttyd',
    audience: 'terminal',
    publicPrefix: '/tools/ttyd',
    accessPath: '/api/ttyd-gateway-access',
    accessMode: 'session',
    socketRoot: '/run/yunpanel/ttyd',
  }),
  netdata: descriptor({
    id: 'netdata',
    audience: 'netdata',
    publicPrefix: '/tools/netdata',
    accessPath: '/api/netdata-gateway-access',
    accessMode: 'owner',
    loopbackPort: 19999,
  }),
  goaccess: descriptor({
    id: 'goaccess',
    audience: 'goaccess',
    publicPrefix: '/tools/goaccess',
    accessPath: '/api/goaccess-gateway-access',
    accessMode: 'owner',
    socketRoot: '/run/yunpanel/goaccess',
  }),
});

const BY_ACCESS_PATH = new Map(
  Object.values(INTEGRATED_TOOL_GATEWAYS).map((value) => [value.accessPath, value]),
);

export function integratedToolGateway(id) {
  const value = INTEGRATED_TOOL_GATEWAYS[id];
  if (!value) throw new TypeError('Unknown integrated tool gateway');
  return value;
}

export function managementToolGatewayForAccessPath(pathname) {
  return BY_ACCESS_PATH.get(pathname) ?? null;
}

export function isManagementToolGatewayAccessPath(pathname) {
  return BY_ACCESS_PATH.has(pathname);
}

export const integratedToolGatewayInternals = Object.freeze({
  descriptor,
  safeId: SAFE_ID,
  safeAudience: SAFE_AUDIENCE,
  safeHttpPath: SAFE_HTTP_PATH,
  safeSocketPath: SAFE_SOCKET_PATH,
  safeSocketRoot: SAFE_SOCKET_ROOT,
  accessModes: Object.freeze([...ACCESS_MODES]),
});
