import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { OPERATIONS } from '@yunpanel/protocol';
import { WebsitePhpToolsServiceError } from './website-php-tools-service.js';
import { createWordPressCloneService } from './wordpress-clone-service.js';
import { jobPublicView } from './job-registry.js';
import { createWebsiteHttpHealthInspector } from '@yunpanel/host-runtime/website-http-health-inspector';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ACTIONS = new Set(['install', 'clone', 'staging', 'remove', 'password', 'core.update', 'plugin.install', 'plugin.update', 'plugin.activate', 'plugin.deactivate', 'plugin.remove', 'theme.install', 'theme.update', 'theme.activate', 'theme.remove']);
const PACKAGE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const USER = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,59}$/;
const CORE_FILES = new Set(['index.php', 'license.txt', 'readme.html', 'wp-activate.php', 'wp-blog-header.php', 'wp-comments-post.php', 'wp-config-sample.php', 'wp-config.php', 'wp-cron.php', 'wp-links-opml.php', 'wp-load.php', 'wp-login.php', 'wp-mail.php', 'wp-settings.php', 'wp-signup.php', 'wp-trackback.php', 'xmlrpc.php', 'wp-admin', 'wp-includes', 'wp-content']);
const fail = (code, message, status = 409) => new WebsitePhpToolsServiceError(code, message, status);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function configurationCode(source) {
  let output = '', quote = null, comment = null;
  for (let index = 0; index < source.length; index++) {
    const char = source[index], next = source[index + 1];
    if (comment === 'line') { if (char === '\n') { comment = null; output += '\n'; } continue; }
    if (comment === 'block') { if (char === '*' && next === '/') { comment = null; index++; } continue; }
    if (quote) {
      output += char;
      if (char === '\\') { output += next ?? ''; index++; } else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '*') { comment = 'block'; output += ' '; index++; continue; }
    if (char === '#' || (char === '/' && next === '/')) { comment = 'line'; output += ' '; if (char === '/') index++; continue; }
    if (char === "'" || char === '"') quote = char;
    output += char;
  }
  if (quote || comment === 'block') throw fail('wordpress_config_dynamic', 'WordPress yapılandırması güvenli biçimde okunamadı');
  return output;
}

export function normalizeWordPressActionOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !ACTIONS.has(input.action)) throw fail('wordpress_action_invalid', 'WordPress işlemi geçersiz', 400);
  const action = input.action;
  const fields = action === 'install' ? ['action', 'databaseBindingId', 'title', 'adminUser', 'adminEmail', 'locale', 'scheme']
    : ['clone', 'staging'].includes(action) ? ['action', 'targetWebsiteId', 'databaseBindingId', 'scheme'] : action === 'password' ? ['action', 'username'] : action.startsWith('plugin.') || action.startsWith('theme.') ? ['action', 'package'] : ['action'];
  if (Object.keys(input).length !== fields.length || Object.keys(input).some(key => !fields.includes(key))) throw fail('wordpress_action_invalid', 'WordPress işlem alanları geçersiz', 400);
  if (action === 'install' && (!UUID.test(input.databaseBindingId ?? '') || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120
    || /[\u0000-\u001f\u007f]/u.test(input.title) || !USER.test(input.adminUser ?? '')
    || typeof input.adminEmail !== 'string' || input.adminEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.adminEmail)
    || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(input.locale ?? '') || !['http', 'https'].includes(input.scheme))) throw fail('wordpress_install_input_invalid', 'WordPress kurulum bilgilerini kontrol edin', 400);
  if (['clone', 'staging'].includes(action) && (!UUID.test(input.targetWebsiteId ?? '') || !UUID.test(input.databaseBindingId ?? '') || !['http', 'https'].includes(input.scheme))) throw fail('wordpress_clone_input_invalid', 'Klon hedefi ve veritabanı geçersiz', 400);
  if (action === 'password' && !USER.test(input.username ?? '')) throw fail('wordpress_user_invalid', 'WordPress yöneticisi geçersiz', 400);
  if (Object.hasOwn(input, 'package') && !PACKAGE.test(input.package ?? '')) throw fail('wordpress_package_invalid', 'WordPress.org eklenti veya tema adı geçersiz', 400);
  return Object.fromEntries(fields.map(field => [field, field === 'title' ? input[field].trim() : input[field]]));
}

export function createWordPressToolkitService({ tools, jobRegistry, authorizeActor, siteMutationLock, siteFileManager,
  domainRegistry,
  databaseBindingRegistry, databaseCredentialRegistry, secretStore, databaseManager = null,
  resticRepositoryRegistry, websiteBackupService, websiteRestoreService,
  healthInspector = createWebsiteHttpHealthInspector(),
  realpathFn = realpath,
} = {}) {
  if (![tools?.resolveWebsitePhpContext, tools?.runWpCli, jobRegistry?.enqueue, authorizeActor, siteMutationLock?.withSiteLock, siteFileManager?.execute, domainRegistry?.listDomains].every(value => typeof value === 'function')) throw new TypeError('WordPress Toolkit native dependencies are required');
  async function context(websiteId) {
    const current = await tools.resolveWebsitePhpContext(websiteId);
    const root = await realpathFn(current.website.documentRoot ?? current.cwd);
    if (root !== await realpathFn(current.cwd)) throw fail('wordpress_document_root_mismatch', 'WordPress dizini site köküyle eşleşmiyor');
    const domains = (await domainRegistry.listDomains({ serverId: current.website.serverId })).filter(domain => domain.websiteId === current.website.id && domain.serverId === current.website.serverId);
    const preferred = domains.filter(domain => domain.primaryDomain === current.website.name);
    const domain = preferred.length === 1 ? preferred[0] : domains.length === 1 ? domains[0] : null;
    if (!domain || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(domain.primaryDomain ?? '')) throw fail('wordpress_domain_unverified', 'WordPress için sitenin ana alan adı doğrulanamadı');
    const relativeRoot = domain.nginxSettings?.documentRoot ?? null;
    if (relativeRoot) {
      if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(relativeRoot)
        || await realpathFn(`${current.cwd}/${relativeRoot}`) !== `${root}/${relativeRoot}`) throw fail('wordpress_document_root_mismatch', 'WordPress dizini site kökünün güvenli alt klasörü olmalıdır');
    }
    return { ...current, relativeRoot, primaryDomain: domain.nginxSettings?.preferredDomain ?? domain.primaryDomain, domain, domains };

  }
  const files = { execute: async (websiteId, operation) => {
    const current = await context(websiteId);
    return siteFileManager.execute(websiteId, { ...operation, path: current.relativeRoot ? [current.relativeRoot, operation.path].filter(Boolean).join('/') : operation.path });
  } };
  async function config(current) {
    const listing = await files.execute(current.website.id, { operation: 'list', path: '' });
    const entry = listing.entries.find(item => item.name === 'wp-config.php');
    if (!entry) return { present: false, entries: listing.entries };
    if (entry.type !== 'file') throw fail('wordpress_config_unsafe', 'WordPress yapılandırması güvenli bir dosya değil');
    const file = await files.execute(current.website.id, { operation: 'read_text', path: 'wp-config.php' });
    const text = typeof file.content === 'string' ? configurationCode(file.content) : null;
    if (typeof text !== 'string') throw fail('wordpress_config_unavailable', 'WordPress yapılandırması okunamadı', 503);
    const values = {};
    for (const key of ['DB_HOST', 'DB_NAME', 'DB_USER']) {
      const matches = [...text.matchAll(new RegExp(`define\\s*\\(\\s*['"]${key}['"]\\s*,\\s*(['"])([^'"\\r\\n]+)\\1\\s*\\)`, 'gi'))];
      if (matches.length !== 1) throw fail('wordpress_config_dynamic', 'Dinamik veritabanı ayarı otomatik yönetim için doğrulanamadı');
      values[key] = matches[0][2];
    }
    if (!['localhost', '127.0.0.1', 'localhost:3306', '127.0.0.1:3306'].includes(values.DB_HOST)) throw fail('wordpress_database_host_forbidden', 'WordPress yönetimi yalnız bu sunucudaki site veritabanını kullanabilir', 403);
    const binding = await databaseBindingRegistry.getByDatabase({ serverId: current.website.serverId, databaseName: values.DB_NAME });
    if (!binding || binding.websiteId !== current.website.id || binding.applicationId !== current.application.id || binding.unixUser !== current.unixUser) throw fail('wordpress_database_scope_invalid', 'WordPress veritabanı bu siteye bağlı değil', 403);
    const credential = await databaseCredentialRegistry.getForBinding(binding.id);
    if (!credential || credential.username !== values.DB_USER) throw fail('wordpress_database_user_mismatch', 'WordPress bağlantısı site veritabanı kullanıcısıyla eşleşmiyor');
    const prefix = text.match(/\$table_prefix\s*=\s*(['"])([A-Za-z0-9_]{1,40})\1\s*;/)?.[2];
    if (!prefix) throw fail('wordpress_table_prefix_invalid', 'WordPress tablo kapsamı doğrulanamadı');
    return { present: true, binding, credential, prefix, entries: listing.entries, configSha256: file.sha256 ?? digest(text) };
  }
  async function run(websiteId, command, args, input = null) {
    const current = await context(websiteId);
    const result = await tools.runWpCli(websiteId, { relativeDirectory: current.relativeRoot, command, args: [...args, '--skip-plugins', '--skip-themes', '--skip-packages'], input, timeout: 300_000 });
    if (result?.success !== true || result.exitCode !== 0) {
      const phases = { 'core.download': 'wordpress_download_failed', 'config.create': 'wordpress_configuration_failed',
        'db.check': 'wordpress_database_check_failed', 'core.install': 'wordpress_install_failed',
        'core.verify-checksums': 'wordpress_core_verification_failed', 'eval': 'wordpress_password_verification_failed' };
      throw fail(phases[command === 'eval' ? 'eval' : `${command}.${args[0]}`] ?? 'wordpress_cli_failed', 'WordPress işlemi tamamlanamadı; önceki durum ve işlem kaydı korunuyor', 502);
    }
    return result;
  }
  async function status(websiteId) {
    const current = await context(websiteId);
    const saved = await config(current); // Verify local DB scope before booting WordPress.
    const state = saved.present ? await tools.getWpCliStatus(websiteId, { relativeDirectory: current.relativeRoot }) : { ...await tools.getWpCliAvailability(), installed: false, plugins: [], themes: [], checks: { installation: 'absent', plugins: 'not_checked', themes: 'not_checked' } };
    let administrators = [];
    let loginUrl = null;
    if (state.installed) {
      const result = await run(websiteId, 'user', ['list', '--role=administrator', '--fields=user_login', '--format=json']);
      try { administrators = JSON.parse(result.stdout).map(item => item.user_login).filter(value => USER.test(value)); }
      catch { throw fail('wordpress_users_unverified', 'Yönetici listesi doğrulanamadı', 502); }
      const siteUrl = await run(websiteId, 'option', ['get', 'siteurl']);
      try {
        const url = new URL(siteUrl.stdout.trim());
        const names = new Set(current.domains.flatMap(domain => [domain.primaryDomain, ...(domain.aliases ?? [])]));
        if (!['http:', 'https:'].includes(url.protocol) || !names.has(url.hostname) || url.username || url.password || url.port || url.search || url.hash) throw new Error('Site URL mismatch');
        url.pathname = url.pathname.replace(/\/$/, '') + '/wp-login.php'; loginUrl = url.href;
      } catch { throw fail('wordpress_url_unverified', 'WordPress yönetici adresi bu sitenin alan adlarıyla eşleşmiyor'); }
    }
    const bindings = await databaseBindingRegistry.listBindings({ serverId: current.website.serverId, websiteId });
    return { ...state, websiteId, websiteRevision: current.website.revision, primaryDomain: current.primaryDomain, loginUrl,
      suggestedScheme: current.domain.httpsMode === 'managed' && current.domain.certificateId ? 'https' : 'http',
      cloneAvailable: typeof databaseManager?.inspectDatabaseTables === 'function', administrators, databases: bindings.map(binding => ({ id: binding.id, name: binding.databaseName })),
      loginPath: '/wp-login.php', inspectedAt: new Date().toISOString() };
  }
  const clones = createWordPressCloneService({ context, config, run, actor, siteFileManager: files, databaseBindingRegistry, databaseCredentialRegistry, databaseManager, healthInspector, siteMutationLock, jobRegistry });
  async function preview(websiteId, input, owner = null) {
    const options = normalizeWordPressActionOptions(input);
    const current = await context(websiteId), saved = await config(current);
    if (options.action === 'install') {
      if (options.scheme === 'https' && (current.domain.httpsMode !== 'managed' || !current.domain.certificateId)) throw fail('wordpress_https_unavailable', 'HTTPS kurulumu için önce bu siteye geçerli bir SSL sertifikası bağlayın');
      if (saved.present || saved.entries.some(item => ['wp-load.php', 'wp-admin', 'wp-includes'].includes(item.name))) throw fail('wordpress_already_present', 'Bu dizinde WordPress dosyaları var; kurulum üzerine yazılmaz');
      const binding = await databaseBindingRegistry.getBinding(options.databaseBindingId);
      if (!binding || binding.websiteId !== websiteId || binding.applicationId !== current.application.id || binding.unixUser !== current.unixUser) throw fail('wordpress_database_scope_invalid', 'Kurulum veritabanı bu siteye bağlı değil', 403);
      if (!await databaseCredentialRegistry.getForBinding(binding.id)) throw fail('wordpress_database_user_missing', 'Önce site veritabanı kullanıcısını hazırlayın');
    } else if (!saved.present) throw fail('wordpress_not_configured', 'Bu sitede yönetilecek WordPress kurulumu bulunamadı');
    const clone = ['clone', 'staging'].includes(options.action) ? await clones.preview(websiteId, options, owner) : null;
    const replacementDigests = {};
    if (options.action === 'install') {
      for (const entry of saved.entries.filter(item => CORE_FILES.has(item.name))) {
        if (entry.type !== 'file') throw fail('wordpress_install_existing_directory', 'Bu dizinde mevcut WordPress içeriği var; kurulum üzerine yazılmaz');
        const file = await files.execute(websiteId, { operation: 'read_text', path: entry.name });
        replacementDigests[entry.name] = file.sha256 ?? digest(file.content);
      }
    }
    const core = { websiteId, serverId: current.website.serverId, applicationId: current.application.id, unixUser: current.unixUser,
      domainId: current.domain.id, primaryDomain: current.primaryDomain, domainRevision: current.domain.desiredRevision ?? 1,
      certificateId: current.domain.certificateId ?? null,
      websiteRevision: current.website.revision, options, configPresent: saved.present, configSha256: saved.configSha256 ?? null,
      fileNames: saved.entries.map(item => item.name).sort(), replacementDigests, ...(clone ? { clone } : {}), databaseBindingId: saved.binding?.id ?? options.databaseBindingId ?? null };
    const previewDigest = digest(core);
    return { ...core, previewDigest, confirmation: options.action === 'remove' ? `WordPress ${current.primaryDomain}` : `wordpress:${websiteId}:${previewDigest}`,
      impact: clone ? `WordPress ${clone.targetDomain} sitesinin boş klasörüne ve ayrı veritabanına kopyalanır. Kaynak dosyaları değiştirilmez. Staging seçimi arama motoru indekslemesini ve WP cron çalışmasını kapatır; özel erişim koruması ayrıca yapılandırılır.` : options.action === 'install' ? 'WordPress dosyaları ve ana sayfa oluşturulur. Mevcut ana sayfa işlem öncesi doğrulanmış yedeğe alınır.' : options.action === 'remove' ? 'WordPress dosyaları ve bu kuruluma ait tablolar kaldırılır. Önce doğrulanmış bir site yedeği alınır.' : 'İşlem öncesinde site yedeklenir; sonuç aynı ekranda doğrulanır.' };
  }
  async function actor(input, websiteId) {
    const live = await authorizeActor(input, websiteId);
    if (!live || ['sessionId', 'userId', 'role'].some(key => live[key] !== input?.[key])) throw fail('wordpress_actor_forbidden', 'Site erişimi değişti', 403);
    return live;
  }
  async function queue(websiteId, input, owner) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !UUID.test(input.requestId ?? '')
      || Object.keys(input).some(key => !['requestId', 'options', 'expectedWebsiteRevision', 'previewDigest', 'confirmation', 'password'].includes(key))) throw fail('wordpress_request_invalid', 'İşlem bilgileri geçersiz', 400);
    await actor(owner, websiteId);
    const earlier = await jobRegistry.getJobForIdempotencyKey(`wordpress:${input.requestId}`);
    if (earlier) {
      const current = await context(websiteId);
      if (earlier.payload?.websiteId !== websiteId || earlier.resourceId !== current.application.id || earlier.serverId !== current.website.serverId
        || earlier.payload.actionId !== 'wp.toolkit' || JSON.stringify(earlier.payload.options) !== JSON.stringify(normalizeWordPressActionOptions(input.options))) throw fail('wordpress_request_conflict', 'İşlem kimliği farklı bir isteğe ait');
      return { job: jobPublicView(earlier) };
    }
    const desired = await preview(websiteId, input.options, owner);
    if (desired.websiteRevision !== input.expectedWebsiteRevision || desired.previewDigest !== input.previewDigest || desired.confirmation !== input.confirmation) throw fail('wordpress_preview_stale', 'Site değişti; işlemi yeniden kontrol edin');
    await actor(owner, websiteId);
    return siteMutationLock.withSiteLock({ applicationId: desired.applicationId, websiteId }, async () => {
      const locked = await preview(websiteId, input.options, owner);
      if (locked.previewDigest !== desired.previewDigest) throw fail('wordpress_preview_stale', 'Site değişti; işlemi yeniden kontrol edin');
      await actor(owner, websiteId);
      const needsSecret = ['install', 'password'].includes(desired.options.action);
      const secretRef = needsSecret ? input.requestId : null;
      const payload = { websiteId, applicationId: desired.applicationId, unixUser: desired.unixUser, expectedWebsiteRevision: desired.websiteRevision,
        actorSessionId: owner.sessionId, actorUserId: owner.userId, actorRole: owner.role,
        actionId: 'wp.toolkit', previewDigest: desired.previewDigest, confirmation: `php-tool:${websiteId}:wp.toolkit:${desired.previewDigest}`,
        options: desired.options, secretRef };
      const request = { serverId: desired.serverId, type: OPERATIONS.WEBSITE_PHP_ACTION, operation: OPERATIONS.WEBSITE_PHP_ACTION,
        resourceType: 'application', resourceId: desired.applicationId, payload, idempotencyKey: `wordpress:${input.requestId}` };
      const existing = typeof jobRegistry.findIdempotentJob === 'function' ? await jobRegistry.findIdempotentJob(request) : null;
      if (existing) return { job: jobPublicView(existing) };
      const jobs = await jobRegistry.listJobs({ serverId: desired.serverId, resourceType: 'application', resourceId: desired.applicationId });
      if (jobs.some(job => ['queued', 'running'].includes(job.status))) throw fail('wordpress_job_conflict', 'Bu sitede devam eden bir işlem var');
      if (needsSecret) {
        if (!secretStore) throw fail('wordpress_secret_store_unavailable', 'Kurulum parolası güvenli depoya kaydedilemiyor', 503);
        if (typeof input.password !== 'string' || input.password.length < 16 || input.password.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.password)) throw fail('wordpress_password_invalid', 'Parola 16–128 karakter olmalıdır', 400);
        const purpose = desired.options.action === 'install' ? 'wordpress.install' : 'wordpress.password';
        try { await secretStore.put({ id: secretRef, websiteId, purpose, value: input.password }); }
        catch (error) {
          if (error.code !== 'operation_secret_exists') throw error;
          const prior = Buffer.from(await secretStore.read({ id: secretRef, websiteId, purpose })), next = Buffer.from(input.password);
          if (prior.length !== next.length || !timingSafeEqual(prior, next)) throw fail('wordpress_request_conflict', 'Aynı işlem kimliği farklı bir parola için kullanılamaz');
        }
      }
      try { return { job: jobPublicView(await jobRegistry.enqueue(request)) }; }
      catch (error) {
        // A failed response does not prove that a durable enqueue failed to commit.
        // Preserve the encrypted reference for a retry of this exact request.
        throw error;
      }
    });
  }
  async function repository(current) {
    const name = `website-${current.website.id}`;
    const existing = (await resticRepositoryRegistry.listRepositories({ serverId: current.website.serverId })).find(repo => repo.name === name);
    const repo = existing ?? await resticRepositoryRegistry.createRepository({ serverId: current.website.serverId, name, password: randomBytes(32).toString('base64url'), retentionPolicy: { keepLast: 7 } });
    if (repo.status !== 'ready') await resticRepositoryRegistry.initResticRepository(repo.id);
    return repo.id;
  }
  async function execute(payload, execution) {
    const owner = { sessionId: payload.actorSessionId, userId: payload.actorUserId, role: payload.actorRole };
    const current = await context(payload.websiteId);
    if (current.website.serverId !== execution.serverId || current.application.id !== execution.resourceId || execution.resourceType !== 'application'
      || current.unixUser !== payload.unixUser || current.website.revision !== payload.expectedWebsiteRevision) throw fail('wordpress_execution_scope_invalid', 'WordPress işi siteyle eşleşmiyor');
    await actor(owner, payload.websiteId);
    const desired = await preview(payload.websiteId, payload.options, owner);
    if (desired.previewDigest !== payload.previewDigest) throw fail('wordpress_preview_stale', 'Site değişti; işlem durduruldu');
    if (desired.clone) {
      await clones.execute(payload.websiteId, desired.options, owner, desired.clone, execution);
      return { version: 1, websiteId: payload.websiteId, applicationId: payload.applicationId, unixUser: payload.unixUser,
        actionId: 'wp.toolkit', websiteRevision: payload.expectedWebsiteRevision, previewDigest: payload.previewDigest, completed: true, sideEffects: true };
    }
    const repoId = await repository(current);
    const before = await websiteBackupService.previewBackup({ websiteId: payload.websiteId, repositoryId: repoId, executionJobId: execution.jobId });
    const snapshot = await websiteBackupService.executeBackup({ websiteId: payload.websiteId, repositoryId: repoId,
      expectedPreviewDigest: before.backupSetDigest, confirmation: before.confirmation, tags: ['before-wordpress'], executionJobId: execution.jobId, operationId: execution.jobId });
    let changed = false;
    async function verifyPassword(username, password) {
      const code = '$u = get_user_by("login", ' + JSON.stringify(username) + '); if (!$u || !wp_check_password(rtrim(stream_get_contents(STDIN), "\\r\\n"), $u->user_pass, $u->ID)) { WP_CLI::error("Password verification failed"); } WP_CLI::success("verified");';
      const check = await run(payload.websiteId, 'eval', [code], password + '\n');
      if (!check.stdout.includes('verified')) throw fail('wordpress_password_unverified', 'WordPress parolası doğrulanamadı', 502);
    }
    try {
      await actor(owner, payload.websiteId);
      const options = desired.options;
      const password = payload.secretRef ? await secretStore.read({ id: payload.secretRef, websiteId: payload.websiteId,
        purpose: options.action === 'install' ? 'wordpress.install' : 'wordpress.password' }) : null;
      changed = true;
      if (options.action === 'install') {
        const binding = await databaseBindingRegistry.getBinding(options.databaseBindingId);
        const credential = await databaseCredentialRegistry.getForBinding(binding.id);
        const secret = await databaseCredentialRegistry.materializeCredential(credential.id, { expectedRevision: credential.revision });
        await run(payload.websiteId, 'core', ['download', 'https://wordpress.org/latest.zip', '--force', `--locale=${options.locale}`]);
        await run(payload.websiteId, 'config', ['create', `--dbname=${binding.databaseName}`, `--dbuser=${credential.username}`, '--dbhost=localhost',
          `--dbprefix=yp${payload.websiteId.replaceAll('-', '').slice(0, 12)}_`, '--prompt=dbpass'], secret.password + '\n');
        await config(current);
        await run(payload.websiteId, 'db', ['check']);
        if (options.scheme === 'https' && (current.domain.httpsMode !== 'managed' || !current.domain.certificateId)) throw fail('wordpress_https_unavailable', 'HTTPS kurulumu için önce bu siteye geçerli bir SSL sertifikası bağlayın');
        await run(payload.websiteId, 'core', ['install', `--url=${options.scheme}://${current.primaryDomain}`, `--title=${options.title}`,
          `--admin_user=${options.adminUser}`, `--admin_email=${options.adminEmail}`, `--locale=${options.locale}`, '--prompt=admin_password', '--skip-email'], password + '\n');
        await run(payload.websiteId, 'core', ['is-installed']);
        await run(payload.websiteId, 'core', ['verify-checksums']);
        await verifyPassword(options.adminUser, password);
      } else if (options.action === 'password') {
        const admins = await status(payload.websiteId);
        if (!admins.administrators.includes(options.username)) throw fail('wordpress_admin_not_found', 'Yönetici hesabı bulunamadı', 404);
        await run(payload.websiteId, 'user', ['update', options.username, '--prompt=user_pass', '--skip-email'], password + '\n');
        await verifyPassword(options.username, password);
      } else if (options.action === 'core.update') {
        await run(payload.websiteId, 'core', ['update']); await run(payload.websiteId, 'core', ['update-db']); await run(payload.websiteId, 'core', ['verify-checksums']);
      } else if (options.action === 'remove') {
        const saved = await config(current);
        const tableOutput = await run(payload.websiteId, 'db', ['tables', '--all-tables-with-prefix', '--format=csv']);
        const tables = tableOutput.stdout.trim().split(',').filter(Boolean);
        if (!tables.length || tables.some(table => !/^[A-Za-z0-9_]{1,64}$/.test(table) || !table.startsWith(saved.prefix))) throw fail('wordpress_remove_tables_unverified', 'Kaldırılacak WordPress tabloları doğrulanamadı');
        await run(payload.websiteId, 'db', ['query', 'DROP TABLE ' + tables.map(table => '`' + table + '`').join(',') + ';']);
        // `db tables` loads WordPress and refuses an empty installation. A query
        // runs after wp-config, before WordPress loads, using the same site user.
        const remaining = await run(payload.websiteId, 'db', ['query',
          `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND LEFT(table_name,${saved.prefix.length})='${saved.prefix}';`, '--skip-column-names', '--silent']);
        if (remaining.stdout.trim() !== '0') throw fail('wordpress_remove_tables_unverified', 'WordPress tablolarının kaldırıldığı doğrulanamadı');
        for (const entry of saved.entries.filter(item => CORE_FILES.has(item.name))) {
          const removed = await files.execute(payload.websiteId, { operation: 'delete', path: entry.name });
          if (!removed.deleted) throw fail('wordpress_remove_files_unverified', 'WordPress dosyası kaldırılamadı');
        }
        if ((await config(current)).present) throw fail('wordpress_remove_unverified', 'WordPress yapılandırması kaldırılmadı');
      } else {
        const [command, requested] = options.action.split('.');
        const verb = requested === 'remove' ? 'delete' : requested;
        if (command === 'plugin' && requested === 'remove') {
          const inventory = JSON.parse((await run(payload.websiteId, command, ['list', '--format=json'])).stdout);
          if (inventory.find(item => item.name === options.package)?.status === 'active') await run(payload.websiteId, command, ['deactivate', options.package]);
        }
        await run(payload.websiteId, command, [verb, options.package]);
        const verify = await run(payload.websiteId, command, ['list', '--format=json']);
        const items = JSON.parse(verify.stdout), item = items.find(entry => entry.name === options.package);
        if ((requested === 'remove' && item) || (requested !== 'remove' && !item)
          || (requested === 'activate' && item.status !== 'active') || (requested === 'deactivate' && item.status !== 'inactive')
          || (requested === 'update' && item.update === 'available')) throw fail('wordpress_package_unverified', 'Eklenti veya tema sonucu doğrulanamadı', 502);
      }
      if (!['remove', 'password'].includes(options.action)) {
        let health;
        try { health = await healthInspector.inspect({ primaryDomain: current.primaryDomain, healthPath: '/', timeoutSeconds: 30 }); }
        catch { health = null; }
        if (health?.satisfied !== true) throw fail('wordpress_http_health_failed', 'WordPress işlemi sonrası site yanıt vermedi; önceki yedek geri yükleniyor', 502);
      }
      await actor(owner, payload.websiteId);
      return { version: 1, websiteId: payload.websiteId, applicationId: payload.applicationId, unixUser: payload.unixUser,
        actionId: 'wp.toolkit', websiteRevision: payload.expectedWebsiteRevision, previewDigest: payload.previewDigest, completed: true, sideEffects: true };
    } catch (error) {
      if (changed) {
        try {
          if (desired.options.action === 'install') {
            const listing = await files.execute(payload.websiteId, { operation: 'list', path: '' });
            for (const entry of listing.entries.filter(item => CORE_FILES.has(item.name) && !desired.fileNames.includes(item.name))) await files.execute(payload.websiteId, { operation: 'delete', path: entry.name });
          }
          const rollback = await websiteRestoreService.previewRestore({ websiteId: payload.websiteId, repositoryId: repoId, snapshotId: snapshot.snapshot.snapshotId,
            include: ['paths', 'databases'], executionJobId: execution.jobId, healthPath: '/' });
          const result = await websiteRestoreService.executeRestore({ websiteId: payload.websiteId, repositoryId: repoId, snapshotId: snapshot.snapshot.snapshotId,
            expectedPreviewDigest: rollback.previewDigest, confirmation: rollback.confirmation, include: ['paths', 'databases'], executionJobId: execution.jobId, operationId: execution.jobId, healthPath: '/' });
          if (result.status !== 'succeeded') throw new Error('Rollback was not verified');
        } catch { throw fail('wordpress_rollback_failed', 'WordPress işlemi kesildi; önceki site yedeğinden geri alma kontrol edilmeli', 503); }
      }
      throw error;
    }
  }
  async function releaseSecret(payload) {
    if (payload.secretRef) await secretStore.remove({ id: payload.secretRef, websiteId: payload.websiteId,
      purpose: payload.options.action === 'install' ? 'wordpress.install' : 'wordpress.password' });
  }
  async function getRequest(websiteId, requestId, owner) {
    if (!UUID.test(requestId ?? '')) throw fail('wordpress_request_invalid', 'İşlem kimliği geçersiz', 400);
    await actor(owner, websiteId);
    const current = await context(websiteId);
    const job = await jobRegistry.getJobForIdempotencyKey(`wordpress:${requestId}`);
    if (!job || job.payload?.websiteId !== websiteId || job.resourceId !== current.application.id || job.serverId !== current.website.serverId
      || job.operation !== OPERATIONS.WEBSITE_PHP_ACTION || job.payload.actionId !== 'wp.toolkit') throw fail('wordpress_request_not_found', 'WordPress işlemi bulunamadı', 404);
    return jobPublicView(job);
  }
  return Object.freeze({ status, preview, queue, execute, releaseSecret, getRequest });
}
