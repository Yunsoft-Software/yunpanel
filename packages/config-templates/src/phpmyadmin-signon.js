import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export class PhpMyAdminSignonTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhpMyAdminSignonTemplateError';
    this.code = code;
  }
}

export const phpMyAdminSignonTemplatePolicy = Object.freeze({
  configPath: '/etc/phpmyadmin/conf.d/zz-yunpanel.php',
  bridgePath: '/usr/lib/yunpanel/phpmyadmin/signon.php',
  bridgeDirectory: '/usr/lib/yunpanel/phpmyadmin',
  handoffSocketPath: '/run/yunpanel-phpmyadmin/handoff.sock',
  signonSession: 'YunPanelPhpMyAdminSignon',
  internalSignonPath: '/__yunpanel/signon',
  gatewayBasePath: '/tools/phpmyadmin/',
  configMode: 0o640,
  bridgeMode: 0o640,
});

export function renderPhpMyAdminSignonConfig() {
  const policy = phpMyAdminSignonTemplatePolicy;
  return `<?php
declare(strict_types=1);

if (! isset($cfg) || ! is_array($cfg) || ! isset($i) || ! is_int($i) || $i < 1) {
    throw new RuntimeException('YunPanel phpMyAdmin signon configuration requires a server definition.');
}

$yunpanelHost = $_SERVER['HTTP_HOST'] ?? '';
if (! is_string($yunpanelHost)
    || preg_match('/\\A(?:[A-Za-z0-9.-]+|\\[[0-9A-Fa-f:]+\\])(?::[0-9]{1,5})?\\z/', $yunpanelHost) !== 1) {
    $yunpanelHost = 'yunpanel.invalid';
}

$cfg['Servers'][$i]['auth_type'] = 'signon';
$cfg['Servers'][$i]['host'] = 'localhost';
$cfg['Servers'][$i]['AllowRoot'] = false;
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['Servers'][$i]['hide_connection_errors'] = true;
$cfg['Servers'][$i]['SignonSession'] = '${policy.signonSession}';
$cfg['Servers'][$i]['SignonCookieParams'] = [
    'lifetime' => 0,
    'path' => '${policy.gatewayBasePath}',
    'domain' => '',
    'secure' => true,
    'httponly' => true,
];
$cfg['Servers'][$i]['SignonURL'] = 'https://' . $yunpanelHost . '${policy.gatewayBasePath}__yunpanel/signon';
`;
}

export function renderPhpMyAdminSignonBridge() {
  const policy = phpMyAdminSignonTemplatePolicy;
  return `<?php
declare(strict_types=1);

const YUNPANEL_HANDOFF_SOCKET = '${policy.handoffSocketPath}';
const YUNPANEL_SIGNON_SESSION = '${policy.signonSession}';
const YUNPANEL_GATEWAY_BASE = '${policy.gatewayBasePath}';
const YUNPANEL_MAX_HANDOFF_RESPONSE = 16384;

function yunpanel_fail(int $status): never
{
    http_response_code($status);
    header('Cache-Control: no-store');
    header('Pragma: no-cache');
    header('Referrer-Policy: no-referrer');
    header('X-Content-Type-Options: nosniff');
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Unable to start phpMyAdmin session.';
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    yunpanel_fail(405);
}

$capability = $_POST['capability'] ?? null;
if (! is_string($capability) || preg_match('/\\A[A-Za-z0-9_-]{43}\\z/', $capability) !== 1
    || count($_POST) !== 1) {
    yunpanel_fail(400);
}

$socket = @stream_socket_client(
    'unix://' . YUNPANEL_HANDOFF_SOCKET,
    $errorCode,
    $errorMessage,
    1.0,
    STREAM_CLIENT_CONNECT
);
if (! is_resource($socket)) {
    yunpanel_fail(503);
}
stream_set_timeout($socket, 2);

$body = json_encode(['capability' => $capability], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
$request = "POST /consume HTTP/1.1\\r\\n"
    . "Host: localhost\\r\\n"
    . "Content-Type: application/json\\r\\n"
    . 'Content-Length: ' . strlen($body) . "\\r\\n"
    . "Connection: close\\r\\n\\r\\n"
    . $body;
unset($capability, $body);

$written = 0;
$requestLength = strlen($request);
while ($written < $requestLength) {
    $result = @fwrite($socket, substr($request, $written));
    if ($result === false || $result === 0) {
        fclose($socket);
        yunpanel_fail(503);
    }
    $written += $result;
}
unset($request);

$response = '';
while (! feof($socket) && strlen($response) <= YUNPANEL_MAX_HANDOFF_RESPONSE) {
    $chunk = @fread($socket, 4096);
    if ($chunk === false) {
        fclose($socket);
        yunpanel_fail(503);
    }
    $response .= $chunk;
}
$metadata = stream_get_meta_data($socket);
fclose($socket);
if (($metadata['timed_out'] ?? false) === true || strlen($response) > YUNPANEL_MAX_HANDOFF_RESPONSE) {
    yunpanel_fail(503);
}

$separator = strpos($response, "\\r\\n\\r\\n");
if ($separator === false) {
    yunpanel_fail(503);
}
$headers = substr($response, 0, $separator);
$responseBody = substr($response, $separator + 4);
unset($response);
if (preg_match('/\\AHTTP\\/1\\.[01] 200(?: |\\r\\n)/', $headers) !== 1) {
    yunpanel_fail(401);
}
unset($headers);

try {
    $decoded = json_decode($responseBody, true, 16, JSON_THROW_ON_ERROR);
} catch (JsonException) {
    yunpanel_fail(503);
}
unset($responseBody);
$data = $decoded['data'] ?? null;
if (! is_array($decoded) || count($decoded) !== 1 || ! is_array($data)
    || count($data) !== 7
    || ($data['version'] ?? null) !== 1
    || ($data['protocol'] ?? null) !== 'yunpanel-phpmyadmin-signon-v1'
    || ! is_string($data['databaseName'] ?? null)
    || preg_match('/\\A[A-Za-z0-9_]{1,64}\\z/', $data['databaseName']) !== 1
    || ! is_string($data['username'] ?? null)
    || preg_match('/\\Aydb_[a-f0-9]{24}\\z/', $data['username']) !== 1
    || ! is_string($data['password'] ?? null) || $data['password'] === '' || strlen($data['password']) > 1024
    || ($data['host'] ?? null) !== 'localhost'
    || ! is_int($data['expiresAt'] ?? null)
    || $data['expiresAt'] <= (int) floor(microtime(true) * 1000)) {
    yunpanel_fail(503);
}

ini_set('session.use_cookies', '1');
ini_set('session.use_only_cookies', '1');
ini_set('session.use_strict_mode', '1');
session_name(YUNPANEL_SIGNON_SESSION);
session_set_cookie_params([
    'lifetime' => 0,
    'path' => YUNPANEL_GATEWAY_BASE,
    'domain' => '',
    'secure' => true,
    'httponly' => true,
    'samesite' => 'Strict',
]);
if (! @session_start()) {
    yunpanel_fail(503);
}
if (! @session_regenerate_id(true)) {
    session_destroy();
    yunpanel_fail(503);
}

$_SESSION = [];
$_SESSION['PMA_single_signon_user'] = $data['username'];
$_SESSION['PMA_single_signon_password'] = $data['password'];
$_SESSION['PMA_single_signon_host'] = 'localhost';
$_SESSION['PMA_single_signon_HMAC_secret'] = bin2hex(random_bytes(32));
$_SESSION['PMA_single_signon_cfgupdate'] = [
    'only_db' => str_replace(['\\\\', '_', '%'], ['\\\\\\\\', '\\_', '\\%'], $data['databaseName']),
    'hide_connection_errors' => true,
    'AllowRoot' => false,
    'AllowNoPassword' => false,
];
unset($data, $decoded);
if (! @session_write_close()) {
    yunpanel_fail(503);
}

header('Cache-Control: no-store');
header('Pragma: no-cache');
header('Referrer-Policy: no-referrer');
header('Location: ' . YUNPANEL_GATEWAY_BASE, true, 303);
exit;
`;
}

function preview(content, path, mode) {
  const digest = sha256(content);
  return Object.freeze({
    version: 1,
    sha256: digest,
    artifact: Object.freeze({
      path,
      sha256: digest,
      bytes: Buffer.byteLength(content),
      sensitive: false,
      mode,
    }),
  });
}

export function previewPhpMyAdminSignonConfig() {
  return Object.freeze({
    ...preview(
      renderPhpMyAdminSignonConfig(),
      phpMyAdminSignonTemplatePolicy.configPath,
      phpMyAdminSignonTemplatePolicy.configMode,
    ),
    signonSession: phpMyAdminSignonTemplatePolicy.signonSession,
    gatewayBasePath: phpMyAdminSignonTemplatePolicy.gatewayBasePath,
  });
}

export function previewPhpMyAdminSignonBridge() {
  return Object.freeze({
    ...preview(
      renderPhpMyAdminSignonBridge(),
      phpMyAdminSignonTemplatePolicy.bridgePath,
      phpMyAdminSignonTemplatePolicy.bridgeMode,
    ),
    handoffSocketPath: phpMyAdminSignonTemplatePolicy.handoffSocketPath,
    signonSession: phpMyAdminSignonTemplatePolicy.signonSession,
    internalSignonPath: phpMyAdminSignonTemplatePolicy.internalSignonPath,
    gatewayBasePath: phpMyAdminSignonTemplatePolicy.gatewayBasePath,
  });
}

export const phpMyAdminSignonTemplateInternals = Object.freeze({ sha256 });
