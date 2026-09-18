const SAFE_ID = /^[a-z][a-z0-9_-]{1,31}$/;
const SAFE_AUDIENCE = /^[a-z][a-z0-9._-]{1,63}$/;
const SAFE_HTTP_PATH = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_SOCKET_PATH = /^\/[A-Za-z0-9._/-]+\.sock$/;

function descriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !SAFE_ID.test(value.id ?? '')
    || !SAFE_AUDIENCE.test(value.audience ?? '')
    || !SAFE_HTTP_PATH.test(value.publicPrefix ?? '')
    || value.publicPrefix.endsWith('/')
    || !SAFE_HTTP_PATH.test(value.accessPath ?? '')
    || !SAFE_SOCKET_PATH.test(value.socketPath ?? '')) {
    throw new TypeError('Integrated tool gateway descriptor is invalid');
  }
  return Object.freeze({
    id: value.id,
    audience: value.audience,
    publicPrefix: value.publicPrefix,
    accessPath: value.accessPath,
    socketPath: value.socketPath,
  });
}

export const INTEGRATED_TOOL_GATEWAYS = Object.freeze({
  phpmyadmin: descriptor({
    id: 'phpmyadmin',
    audience: 'phpmyadmin',
    publicPrefix: '/tools/phpmyadmin',
    accessPath: '/api/phpmyadmin-gateway-access',
    socketPath: '/run/yunpanel/phpmyadmin-http.sock',
  }),
  elfinder: descriptor({
    id: 'elfinder',
    audience: 'elfinder',
    publicPrefix: '/tools/elfinder',
    accessPath: '/api/elfinder-gateway-access',
    socketPath: '/run/yunpanel/elfinder-http.sock',
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
});
