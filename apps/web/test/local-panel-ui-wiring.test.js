import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('management UI has one implicit local server and no server chooser', async () => {
  const sources = await Promise.all([
    '../src/workspace/NewWebsitePage.jsx',
    '../src/workspace/ApplicationsPage.jsx',
    '../src/workspace/DatabasesPage.jsx',
    '../src/workspace/OperationsPages.jsx',
    '../src/DomainManager.jsx',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const combined = sources.join('\n');
  assert.doesNotMatch(combined, /Sunucu seç|Tüm sunucular|Select server|serverId: ''/);
  assert.match(sources[2], /servers\.items\.length === 1 \? servers\.items\[0\] : null/);
  assert.match(sources[2], /canlı Unix socket envanteri/);
  assert.doesNotMatch(sources[2], /inspectDatabases|Sunucuyu tara/);
  assert.match(sources[3], /YunPanel yalnızca kurulu olduğu yerel sunucuyu yönetir/);
  assert.doesNotMatch(sources[3], /ServerManager|enrollment/);
  assert.match(sources[0], /\/sites\/create-preview/);
  assert.match(sources[0], /previewDigest: preview\.previewDigest/);
  assert.match(sources[0], /Yeni Node\.js 24 \/ Passenger uygulaması/);
  assert.match(sources[0], /Yeni PHP-FPM uygulaması/);
  assert.match(sources[0], /Mevcut Website’i paylaş \(shared-site\)/);
  assert.match(sources[0], /ConfirmDialog/);
  assert.match(sources[0], /Bağımsız www için bu Website’i oluşturduktan sonra/);
  assert.doesNotMatch(sources[0], /<option value="independent"/);
  assert.doesNotMatch(sources[0], /window\.prompt|window\.confirm|window\.alert/);
});

test('primary navigation exposes working modules instead of placeholder destinations', async () => {
  const [layout, uxModel, model, app, dockerPage, dockerLifecycle, dockerConfig, operations] = await Promise.all([
    readFile(new URL('../src/workspace/WorkspaceLayout.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/ui/ux-model.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/site-model.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/WorkspaceApp.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/DockerProjectsPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/DockerLifecyclePanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/DockerConfigPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/OperationsPages.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(layout, /navigationGroups/);
  assert.match(uxModel, /\['\/docker', 'Docker', 'box'\]/);
  assert.match(uxModel, /\['\/mail', 'Mail', 'mail'\]/);
  assert.doesNotMatch(uxModel, /\['\/audit', 'Denetim', 'shield'\]/);
  assert.match(operations, /LinkButton to="\/audit"/);
  assert.match(app, /path: 'docker', element: manage\(<DockerProjectsPage \/>\)/);
  assert.match(app, /path: 'docker\/:dockerProjectId', element: manage\(<DockerProjectsPage \/>\)/);
  assert.match(app, /path: 'mail', element: manage\(<MailDomainsPage \/>\)/);
  assert.match(app, /path: 'mail\/:mailDomainId', element: manage\(<MailDomainsPage \/>\)/);
  assert.match(dockerPage, /DockerProjectCreateDialog/);
  assert.match(dockerPage, /DockerConfigPanel/);
  assert.match(dockerPage, /DockerLifecyclePanel/);
  assert.match(dockerPage, /getDockerRuntime/);
  assert.match(dockerPage, /getDockerDiagnosis/);
  assert.match(dockerPage, /getDockerLogs/);
  assert.match(dockerPage, /getDockerHistory/);
  assert.match(dockerLifecycle, /previewDockerAction/);
  assert.match(dockerLifecycle, /applyDockerAction/);
  assert.match(dockerConfig, /updateDockerProject/);
  assert.match(dockerConfig, /replaceDockerEnvironment/);
  assert.match(dockerConfig, /setDockerCredential/);
  assert.match(dockerConfig, /validateSavedDockerProject/);
  assert.doesNotMatch(operations, /docker: \['Docker'/);
  assert.doesNotMatch(operations, /mail: \['Mail'/);
  // Mail and databases now have real site-contained surfaces. Keep only
  // unsupported placeholder tabs forbidden; never revert the working UI here.
  assert.doesNotMatch(model, /\['(?:cron|backups)'/);
  assert.match(model, /\['databases', 'Veritabanları'\]/);
  assert.match(model, /\['mail', 'E-posta'\]/);
  assert.match(model, /\['files', 'Dosyalar'\]/);
});

test('mail route exposes domain, mailbox, alias, configuration, DKIM, queue, logs and Roundcube controls', async () => {
  const [page, mailbox, aliases, config, dkim, operations, client, resources] = await Promise.all([
    readFile(new URL('../src/workspace/MailDomainsPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/MailboxesPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/MailAliasesPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/MailConfigurationPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/MailDkimDiagnosticsPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/MailOperationsPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/mail-operations-client.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/workspace-resources.js', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /MailDomainCreateDialog/);
  assert.match(page, /MailboxesPanel/);
  assert.match(page, /MailAliasesPanel/);
  assert.match(page, /MailConfigurationPanel/);
  assert.match(page, /MailDkimDiagnosticsPanel/);
  assert.match(page, /MailOperationsPanel/);
  assert.match(mailbox, /createMailbox/);
  assert.match(mailbox, /setMailboxQuota/);
  assert.match(mailbox, /setMailboxForwarding/);
  assert.doesNotMatch(mailbox, /deleteMailbox/);
  assert.match(aliases, /createMailAlias/);
  assert.match(aliases, /updateMailAlias/);
  assert.match(aliases, /deleteMailAlias/);
  assert.match(config, /previewMailConfiguration/);
  assert.match(config, /applyMailConfiguration/);
  assert.match(config, /observe\(job\)/);
  assert.match(dkim, /createMailDkim/);
  assert.match(dkim, /rotateMailDkim/);
  assert.match(dkim, /previewMailDkimApply/);
  assert.match(dkim, /applyMailDkim/);
  assert.match(dkim, /getMailDiagnostics/);
  assert.doesNotMatch(dkim, /deleteMailDkim/);
  assert.match(operations, /getRoundcubePreview/);
  assert.match(operations, /prepareRoundcube/);
  assert.match(operations, /applyRoundcube/);
  assert.match(operations, /getMailQueue/);
  assert.match(operations, /getMailServiceLogs/);
  assert.match(client, /\/roundcube\/config-preview/);
  assert.match(client, /\/mail\/queue/);
  assert.match(client, /\['postfix', 'dovecot', 'rspamd'\]/);
  assert.match(resources, /\/mail/);
  assert.match(resources, /enable\('domains', 'servers', 'jobs'\)/);
});

test('job UI exposes exact resource links, lifecycle stage, safe metadata and bounded deploy logs', async () => {
  const [table, drawer, presentation] = await Promise.all([
    readFile(new URL('../src/workspace/JobsTable.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/JobDrawer.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/job-presentation.js', import.meta.url), 'utf8'),
  ]);
  assert.match(table, /jobResourceTarget/);
  assert.match(table, /jobLifecycle/);
  assert.match(drawer, /safeJobResultMetadata/);
  assert.match(drawer, /job\.diagnosis/);
  assert.match(drawer, /\/jobs\/\$\{encodeURIComponent\(id\)\}\/logs\/deploy\?limit=50/);
  assert.match(drawer, /job\.error\.code/);
  assert.doesNotMatch(drawer, /JSON\.stringify\(job\.result\)|Object\.entries\(job\.result\)/);
  assert.match(presentation, /DEPLOY_LOG_OPERATIONS/);
  assert.match(presentation, /SAFE_RESULT_FIELDS/);
  assert.doesNotMatch(presentation, /privateKey|password|secret|authorization/i);
});

test('audit route uses the real owner-only history client instead of a placeholder', async () => {
  const [app, page, client, operations] = await Promise.all([
    readFile(new URL('../src/workspace/WorkspaceApp.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/AuditPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/audit-client.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/OperationsPages.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /path: 'audit', element: manage\(<AuditPage \/>\)/);
  assert.match(page, /createAuditClient/);
  assert.match(page, /type="datetime-local"/);
  assert.match(client, /`\/audit\?\$\{query\}`/);
  assert.doesNotMatch(operations, /audit: \['Denetim kayıtları'/);
});

test('legacy Domain repair and real site file manager replace terminal and file placeholders', async () => {
  const [detail, files, logs] = await Promise.all([
    readFile(new URL('../src/workspace/SiteDetailPage.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/FilesPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/LogsPanel.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(detail, /websites\/migration\/create-website/);
  assert.match(detail, /websites\/migration\/bind/);
  assert.match(detail, /websites\.items\.find/);
  assert.match(detail, /key === 'files'/);
  assert.match(detail, /key === 'terminal'/);
  assert.match(detail, /<FilesPanel serverId=\{domain\.serverId\} websiteId=\{domain\.websiteId\}/);
  assert.doesNotMatch(detail, /Site dosyalarını listeleme, yükleme ve düzenleme API’leri henüz uygulanmadı/);
  assert.match(files, /const base = `\/websites\/\$\{encodeURIComponent\(websiteId\)\}\/files`/);
  assert.match(files, /\$\{base\}\/text/);
  assert.match(files, /expectedSha256: current\.sha256/);
  assert.match(files, /method: 'DELETE'/);
  assert.doesNotMatch(files, /window\.prompt|window\.alert|innerHTML/);
  assert.match(detail, /<LogsPanel application=\{application\} domain=\{domain\} server=\{server\}/);
  assert.match(logs, /nginx-access/);
  assert.match(logs, /\/logs\/node/);
});
