import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const elFinderClientTemplatePolicy = Object.freeze({
  indexPath: '/usr/share/yunpanel/elfinder/index.html',
  clientPath: '/usr/share/yunpanel/elfinder/yunpanel-client.js',
  mode: 0o644,
  gatewayBasePath: '/tools/elfinder/',
  connectorPath: '/tools/elfinder/connector.php',
  jqueryPath: '/tools/elfinder/assets/jquery/jquery.min.js',
  jqueryUiScriptPath: '/tools/elfinder/assets/jquery-ui/jquery-ui.min.js',
  jqueryUiCssPath: '/tools/elfinder/assets/jquery-ui/jquery-ui.min.css',
  elFinderScriptPath: '/tools/elfinder/vendor/js/elfinder.min.js',
  elFinderCssPath: '/tools/elfinder/vendor/css/elfinder.min.css',
});

export function renderElFinderClientIndex() {
  const p = elFinderClientTemplatePolicy;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=2">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>YunPanel Files</title>
  <link rel="stylesheet" href="${p.jqueryUiCssPath}">
  <link rel="stylesheet" href="${p.elFinderCssPath}">
  <style>
    html,body,#elfinder{height:100%;margin:0}
    body{overflow:hidden;background:#fff}
    #yunpanel-elfinder-error{display:none;padding:16px;font:14px system-ui,sans-serif}
  </style>
</head>
<body>
  <div id="elfinder" aria-label="Website file manager"></div>
  <div id="yunpanel-elfinder-error" role="alert"></div>
  <script src="${p.jqueryPath}"></script>
  <script src="${p.jqueryUiScriptPath}"></script>
  <script src="${p.elFinderScriptPath}"></script>
  <script src="${p.gatewayBasePath}yunpanel-client.js"></script>
</body>
</html>
`;
}

export function renderElFinderClientScript() {
  const p = elFinderClientTemplatePolicy;
  return `(() => {
  'use strict';

  const errorBox = document.getElementById('yunpanel-elfinder-error');
  const mount = document.getElementById('elfinder');

  function fail(message) {
    if (mount) mount.style.display = 'none';
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.style.display = 'block';
    }
  }

  if (!window.jQuery || !window.jQuery.ui || typeof window.jQuery.fn?.elfinder !== 'function') {
    fail('File manager assets could not be loaded.');
    return;
  }

  try {
    window.jQuery(mount).elfinder({
      url: '${p.connectorPath}',
      lang: 'en',
      height: '100%',
      resizable: false,
      rememberLastDir: false,
      useBrowserHistory: false,
      requestType: 'post',
      commands: [
        'open', 'reload', 'home', 'up', 'back', 'forward',
        'getfile', 'quicklook', 'download', 'rm', 'duplicate', 'rename',
        'mkdir', 'mkfile', 'upload', 'copy', 'cut', 'paste', 'edit',
        'extract', 'archive', 'search', 'view', 'sort', 'help'
      ],
      commandsOptions: {
        quicklook: {
          sharecadMimes: [],
          googleDocsMimes: [],
          officeOnlineMimes: []
        },
        edit: {
          extraOptions: {
            creativeCloudApiKey: '',
            managerUrl: ''
          }
        }
      },
      bootCallback(fm) {
        fm.bind('error', () => {
          if (errorBox) {
            errorBox.textContent = 'A file operation failed. Refresh the view and inspect the panel status.';
          }
        });
      }
    });
  } catch {
    fail('File manager could not be started.');
  }
})();
`;
}

function preview(content, path) {
  const digest = sha256(content);
  return Object.freeze({
    path,
    sha256: digest,
    bytes: Buffer.byteLength(content),
    mode: elFinderClientTemplatePolicy.mode,
    sensitive: false,
  });
}

export function previewElFinderClient() {
  const index = renderElFinderClientIndex();
  const client = renderElFinderClientScript();
  return Object.freeze({
    version: 1,
    gatewayBasePath: elFinderClientTemplatePolicy.gatewayBasePath,
    connectorPath: elFinderClientTemplatePolicy.connectorPath,
    artifacts: Object.freeze([
      preview(index, elFinderClientTemplatePolicy.indexPath),
      preview(client, elFinderClientTemplatePolicy.clientPath),
    ]),
  });
}

export const elFinderClientTemplateInternals = Object.freeze({ sha256 });
