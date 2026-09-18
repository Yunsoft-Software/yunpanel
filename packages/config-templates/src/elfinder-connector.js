import { createHash } from 'node:crypto';

const CONNECTOR_PATH = '/usr/share/yunpanel/elfinder/connector.php';
const VENDOR_ROOT = '/usr/share/yunpanel/elfinder/vendor/elfinder';
const AUTOLOAD_PATH = '/usr/share/yunpanel/elfinder/vendor/elfinder/php/autoload.php';
const CONNECTOR_MODE = 0o644;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function renderElFinderConnector() {
  return `<?php
declare(strict_types=1);

const YUNPANEL_ELFINDER_VENDOR_ROOT = '${VENDOR_ROOT}';
const YUNPANEL_ELFINDER_AUTOLOAD = '${AUTOLOAD_PATH}';

function yunpanel_elfinder_fail(int \$status): never
{
    http_response_code(\$status);
    header('Cache-Control: no-store');
    header('Pragma: no-cache');
    header('Referrer-Policy: no-referrer');
    header('X-Content-Type-Options: nosniff');
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Unable to open Website files.'], JSON_UNESCAPED_SLASHES);
    exit;
}

if (! in_array((\$_SERVER['REQUEST_METHOD'] ?? ''), ['GET', 'POST'], true)) {
    header('Allow: GET, POST');
    yunpanel_elfinder_fail(405);
}

foreach (['root', 'path', 'unixUser', 'websiteId', 'applicationId'] as \$forbiddenField) {
    if (array_key_exists(\$forbiddenField, \$_GET) || array_key_exists(\$forbiddenField, \$_POST)) {
        yunpanel_elfinder_fail(400);
    }
}

\$root = getenv('YUNPANEL_ELFINDER_ROOT');
\$websiteId = getenv('YUNPANEL_ELFINDER_WEBSITE_ID');
\$applicationId = getenv('YUNPANEL_ELFINDER_APPLICATION_ID');
\$unixUser = getenv('YUNPANEL_ELFINDER_UNIX_USER');

if (! is_string(\$root)
    || preg_match('/\\A\\/var\\/lib\\/yunpanel\\/data\\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\z/i', \$root) !== 1
    || ! is_string(\$websiteId)
    || preg_match('/\\A[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\z/i', \$websiteId) !== 1
    || ! is_string(\$applicationId)
    || preg_match('/\\A[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\z/i', \$applicationId) !== 1
    || ! is_string(\$unixUser)
    || preg_match('/\\Ayunapp-[a-f0-9]{12}\\z/', \$unixUser) !== 1) {
    yunpanel_elfinder_fail(503);
}

\$expectedRoot = '/var/lib/yunpanel/data/' . strtolower(\$applicationId);
if (\$root !== \$expectedRoot || ! is_dir(\$root) || is_link(\$root) || realpath(\$root) !== \$root) {
    yunpanel_elfinder_fail(409);
}

if (! function_exists('posix_geteuid') || ! function_exists('posix_getpwuid')) {
    yunpanel_elfinder_fail(503);
}
\$processUser = posix_getpwuid(posix_geteuid());
if (! is_array(\$processUser) || (\$processUser['name'] ?? null) !== \$unixUser) {
    yunpanel_elfinder_fail(403);
}

if (! is_file(YUNPANEL_ELFINDER_AUTOLOAD) || ! is_readable(YUNPANEL_ELFINDER_AUTOLOAD)) {
    yunpanel_elfinder_fail(503);
}
require YUNPANEL_ELFINDER_AUTOLOAD;

if (! class_exists('elFinder', false)
    || ! class_exists('elFinderConnector', false)
    || ! class_exists('elFinderVolumeLocalFileSystem', false)) {
    yunpanel_elfinder_fail(503);
}

elFinder::\$netDrivers = [];

header('Cache-Control: no-store');
header('Pragma: no-cache');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');

\$opts = [
    'debug' => false,
    'roots' => [[
        'driver' => 'LocalFileSystem',
        'path' => \$root . DIRECTORY_SEPARATOR,
        'URL' => '',
        'alias' => 'Website files',
        'followSymLinks' => false,
        'statOwner' => true,
        'uploadAllow' => ['all'],
        'uploadDeny' => [],
        'uploadOrder' => ['deny', 'allow'],
        'uploadMaxSize' => '128M',
        'uploadOverwrite' => true,
        'copyOverwrite' => true,
        'acceptedName' => '/\\A(?!\\.{1,2}\\z)[^\\/\\x00]+\\z/u',
        'disabled' => ['netmount', 'chmod'],
        'imgLib' => 'none',
        'tmbPath' => '',
        'maxArcFilesSize' => '1G',
    ]],
];

\$connector = new elFinderConnector(new elFinder(\$opts));
\$connector->run();
`;
}

export function previewElFinderConnector() {
  const content = renderElFinderConnector();
  const digest = sha256(content);
  return Object.freeze({
    version: 1,
    vendorRoot: VENDOR_ROOT,
    autoloadPath: AUTOLOAD_PATH,
    sha256: digest,
    artifact: Object.freeze({
      path: CONNECTOR_PATH,
      sha256: digest,
      bytes: Buffer.byteLength(content),
      sensitive: false,
      mode: CONNECTOR_MODE,
    }),
  });
}

export const elFinderConnectorTemplatePolicy = Object.freeze({
  connectorPath: CONNECTOR_PATH,
  vendorRoot: VENDOR_ROOT,
  autoloadPath: AUTOLOAD_PATH,
  connectorMode: CONNECTOR_MODE,
});

export const elFinderConnectorTemplateInternals = Object.freeze({ sha256 });
