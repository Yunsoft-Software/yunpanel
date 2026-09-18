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
  handoffPath: '/tools/elfinder/__yunpanel/handoff',
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
  <style>
    html,body,#elfinder{height:100%;margin:0}
    body{overflow:hidden;background:#fff}
    #yunpanel-elfinder-error{display:none;padding:16px;font:14px system-ui,sans-serif}
  </style>
</head>
<body>
  <div id="elfinder" aria-label="Website file manager"></div>
  <div id="yunpanel-elfinder-error" role="alert"></div>
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
  const handoffMatch = window.location.hash.match(/^#handoff=([A-Za-z0-9_-]{43})$/);
  const capability = handoffMatch?.[1] ?? null;

  function fail(message) {
    if (mount) mount.style.display = 'none';
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.style.display = 'block';
    }
  }

  function loadStyle(href) {
    return new Promise((resolve, reject) => {
      const element = document.createElement('link');
      element.rel = 'stylesheet';
      element.href = href;
      element.onload = () => resolve();
      element.onerror = () => reject(new Error('asset failed'));
      document.head.appendChild(element);
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const element = document.createElement('script');
      element.src = src;
      element.async = false;
      element.onload = () => resolve();
      element.onerror = () => reject(new Error('asset failed'));
      document.head.appendChild(element);
    });
  }

  async function loadApplicationAssets() {
    await Promise.all([
      loadStyle('${p.jqueryUiCssPath}'),
      loadStyle('${p.elFinderCssPath}')
    ]);
    await loadScript('${p.jqueryPath}');
    await loadScript('${p.jqueryUiScriptPath}');
    await loadScript('${p.elFinderScriptPath}');
  }

  function start() {
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
              errorBox.textContent = 'A file operation failed. Reopen Website Files from YunPanel.';
            }
          });
        }
      });
    } catch {
      fail('File manager could not be started.');
    }
  }

  if (!capability) {
    fail('Open Website Files from YunPanel.');
    return;
  }

  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  fetch('${p.handoffPath}', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability })
  }).then(async (response) => {
    if (response.status !== 204) throw new Error('handoff rejected');
    await loadApplicationAssets();
    start();
  }).catch(() => {
    fail('Website Files session could not be started. Reopen it from YunPanel.');
  });
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
    handoffPath: elFinderClientTemplatePolicy.handoffPath,
    artifacts: Object.freeze([
      preview(index, elFinderClientTemplatePolicy.indexPath),
      preview(client, elFinderClientTemplatePolicy.clientPath),
    ]),
  });
}

export const elFinderClientTemplateInternals = Object.freeze({ sha256 });
