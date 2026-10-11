import { createHash } from 'node:crypto';
import { WebsitePhpToolsServiceError } from './website-php-tools-service.js';

const fail = (code, message, status = 409) => new WebsitePhpToolsServiceError(code, message, status);
const hash = content => createHash('sha256').update(content).digest('hex');
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_ENTRIES = 20000;

// Orchestration uses the existing site-user filesystem worker and WP-CLI.
// A clone writes only a separately authorized empty Website and empty DB.
export function createWordPressCloneService({ context, config, run, actor, siteFileManager,
  databaseBindingRegistry, databaseCredentialRegistry, databaseManager, healthInspector, siteMutationLock, jobRegistry } = {}) {
  async function manifest(websiteId) {
    const result = await siteFileManager.execute(websiteId, { operation: 'manifest', path: '', exclude: ['wp-config.php'] });
    if (!Array.isArray(result.entries) || result.entries.length > MAX_ENTRIES
      || result.entries.some(entry => !['file', 'directory'].includes(entry.type)
        || entry.type === 'file' && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE || !/^[a-f0-9]{64}$/.test(entry.sha256)))
      || result.entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) > MAX_BYTES) throw fail('wordpress_clone_files_limit', 'Klon dosya kapsamı doğrulanamadı', 413);
    return result.entries;
  }
  async function preview(websiteId, options, owner) {
    await actor(owner, websiteId); await actor(owner, options.targetWebsiteId);
    const source = await context(websiteId), target = await context(options.targetWebsiteId);
    if (source.website.id === target.website.id || source.application.id === target.application.id
      || source.unixUser === target.unixUser || source.website.serverId !== target.website.serverId) throw fail('wordpress_clone_target_invalid', 'Klon ayrı bir PHP sitesine ve Unix kullanıcısına kurulmalıdır');
    const saved = await config(source), destination = await config(target);
    if (!saved.present) throw fail('wordpress_not_configured', 'Kaynak WordPress yapılandırması bulunamadı');
    if (destination.present || destination.entries.length) throw fail('wordpress_clone_target_not_empty', 'Hedef site klasörü boş olmalıdır. Mevcut dosyalar üzerine yazılmaz.');
    if (options.scheme === 'https' && (target.domain.httpsMode !== 'managed' || !target.domain.certificateId)) throw fail('wordpress_https_unavailable', 'Hedef siteye önce SSL sertifikası bağlayın');
    const binding = await databaseBindingRegistry.getBinding(options.databaseBindingId);
    if (!binding || binding.websiteId !== target.website.id || binding.serverId !== source.website.serverId
      || binding.applicationId !== target.application.id || binding.unixUser !== target.unixUser || binding.databaseName === saved.binding.databaseName) throw fail('wordpress_database_scope_invalid', 'Klon veritabanı ayrı hedef siteye bağlı olmalıdır', 403);
    const credential = await databaseCredentialRegistry.getForBinding(binding.id);
    if (!credential || credential.username === saved.credential.username) throw fail('wordpress_database_user_missing', 'Hedef veritabanı kullanıcısını hazırlayın');
    if (typeof databaseManager?.inspectDatabaseTables !== 'function') throw fail('wordpress_clone_database_inspector_unavailable', 'Yerel veritabanı incelemesi kullanılamıyor', 503);
    const inventory = await databaseManager.inspectDatabaseTables(binding.databaseName);
    if (inventory.databaseName !== binding.databaseName || !Array.isArray(inventory.tables) || inventory.tables.length) throw fail('wordpress_clone_database_not_empty', 'Hedef veritabanı boş olmalıdır');
    const sourceTables = await databaseManager.inspectDatabaseTables(saved.binding.databaseName);
    if (sourceTables.databaseName !== saved.binding.databaseName) throw fail('wordpress_clone_tables_invalid', 'Kaynak veritabanı kimliği değişti');
    const tables = sourceTables.tables.filter(table => table.name.startsWith(saved.prefix));
    if (!tables.length || tables.some(table => table.type !== 'BASE TABLE' || table.name === `${saved.prefix}blogs`)) throw fail('wordpress_clone_tables_invalid', 'Kaynak WordPress tabloları doğrulanamadı');
    const sourceUrl = (await run(websiteId, 'option', ['get', 'siteurl'])).stdout.trim();
    let url;
    try { url = new URL(sourceUrl); } catch { throw fail('wordpress_url_unverified', 'Kaynak site adresi doğrulanamadı'); }
    if (!['http:', 'https:'].includes(url.protocol) || !source.domains.flatMap(domain => [domain.primaryDomain, ...(domain.aliases ?? [])]).includes(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) throw fail('wordpress_url_unverified', 'Klonlama kök dizine kurulmuş yerel WordPress gerektirir');
    const files = await manifest(websiteId);
    return { targetWebsiteId: target.website.id, targetApplicationId: target.application.id, targetUnixUser: target.unixUser,
      targetWebsiteRevision: target.website.revision, targetDomainId: target.domain.id, targetDomainRevision: target.domain.desiredRevision ?? 1,
      targetCertificateId: target.domain.certificateId ?? null, targetDomain: target.primaryDomain,
      bindingId: binding.id, bindingRevision: binding.revision, credentialId: credential.id, credentialRevision: credential.revision,
      prefix: saved.prefix, tables: tables.map(table => table.name).sort(), sourceUrl: sourceUrl.replace(/\/$/, ''), files,
      sourceConfigSha256: saved.configSha256 };
  }
  async function execute(websiteId, options, owner, plan, execution) {
    return siteMutationLock.withSiteLock({ websiteId: plan.targetWebsiteId, applicationId: plan.targetApplicationId }, async () => {
      const current = await preview(websiteId, options, owner);
      if (JSON.stringify(current) !== JSON.stringify(plan)) throw fail('wordpress_clone_preview_stale', 'Kaynak veya hedef değişti; klonlama durduruldu');
      const jobs = await jobRegistry.listJobs({ serverId: execution.serverId });
      if (jobs.some(job => job.id !== execution.jobId && ['queued', 'running'].includes(job.status)
        && (job.resourceId === plan.targetApplicationId || job.payload?.options?.targetWebsiteId === plan.targetWebsiteId))) throw fail('wordpress_job_conflict', 'Hedef sitede başka bir işlem var');
      async function authorize() { await actor(owner, websiteId); await actor(owner, plan.targetWebsiteId); }
      // SQL travels through bounded private memory, never a web-served dump or backup archive.
      await authorize();
      const exported = await run(websiteId, 'db', ['export', '-', `--tables=${plan.tables.join(',')}`, '--single-transaction', '--skip-lock-tables', '--skip-add-drop-table', '--skip-triggers', '--quiet']);
      const sql = exported.stdout;
      if (!sql?.trim() || Buffer.byteLength(sql) > 16 * 1024 * 1024 || sql.includes('\0')) throw fail('wordpress_clone_sql_invalid', 'Klon SQL aktarımı doğrulanamadı');
      let failurePhase = 'wordpress_clone_files_failed';
      try {
        for (const entry of plan.files) {
          await authorize();
          if (entry.type === 'directory') await siteFileManager.execute(plan.targetWebsiteId, { operation: 'mkdir', path: entry.path });
          else {
            const file = await siteFileManager.execute(websiteId, { operation: 'download', path: entry.path });
            if (hash(Buffer.from(file.content, 'base64')) !== entry.sha256) throw fail('wordpress_clone_source_changed', 'Kaynak dosya aktarım sırasında değişti');
            await siteFileManager.execute(plan.targetWebsiteId, { operation: 'upload', path: entry.path, content: file.content });
            const copied = await siteFileManager.execute(plan.targetWebsiteId, { operation: 'download', path: entry.path });
            if (hash(Buffer.from(copied.content, 'base64')) !== entry.sha256) throw fail('wordpress_clone_copy_unverified', 'Hedef dosyanın içeriği doğrulanamadı');
          }
        }
        await authorize();
        const binding = await databaseBindingRegistry.getBinding(plan.bindingId);
        const credential = await databaseCredentialRegistry.getForBinding(plan.bindingId);
        if (binding?.revision !== plan.bindingRevision || credential?.id !== plan.credentialId || credential?.revision !== plan.credentialRevision) throw fail('wordpress_clone_preview_stale', 'Hedef veritabanı erişimi değişti');
        failurePhase = 'wordpress_clone_database_failed';
        const secret = await databaseCredentialRegistry.materializeCredential(credential.id, { expectedRevision: credential.revision });
        await run(plan.targetWebsiteId, 'config', ['create', `--dbname=${binding.databaseName}`, `--dbuser=${credential.username}`, '--dbhost=localhost', `--dbprefix=${plan.prefix}`, '--prompt=dbpass'], secret.password + '\n');
        await authorize();
        await run(plan.targetWebsiteId, 'db', ['import', '-', '--quiet'], sql.endsWith('\n') ? sql : sql + '\n');
        const url = `${options.scheme}://${plan.targetDomain}`;
        await run(plan.targetWebsiteId, 'search-replace', [plan.sourceUrl, url, ...plan.tables, '--precise', '--skip-columns=guid', '--quiet']);
        for (const key of ['siteurl', 'home']) await run(plan.targetWebsiteId, 'option', ['update', key, url]);
        if (options.action === 'staging') {
          await run(plan.targetWebsiteId, 'option', ['update', 'blog_public', '0']);
          await run(plan.targetWebsiteId, 'config', ['set', 'WP_ENVIRONMENT_TYPE', 'staging']);
          await run(plan.targetWebsiteId, 'config', ['set', 'DISABLE_WP_CRON', 'true', '--raw']);
        }
        failurePhase = 'wordpress_clone_verification_failed';
        await run(plan.targetWebsiteId, 'core', ['is-installed']);
        await run(plan.targetWebsiteId, 'db', ['check']);
        const target = await context(plan.targetWebsiteId);
        const verified = await config(target);
        if (!verified.present || verified.binding.id !== plan.bindingId) throw fail('wordpress_clone_database_unverified', 'Hedef WordPress bağlantısı doğrulanamadı');
        for (const key of ['siteurl', 'home']) if ((await run(plan.targetWebsiteId, 'option', ['get', key])).stdout.trim().replace(/\/$/, '') !== url) throw fail('wordpress_clone_url_unverified', 'Hedef WordPress adresi doğrulanamadı');
        const health = await healthInspector.inspect({ primaryDomain: plan.targetDomain, healthPath: '/', timeoutSeconds: 30 });
        if (health?.satisfied !== true) throw fail('wordpress_clone_http_failed', 'Klonun HTTP yanıtı doğrulanamadı', 502);
        await authorize();
      } catch (error) {
        // Do not destroy partially imported data or replay the import after an
        // ambiguous interruption. The durable job preserves the exact target.
        throw fail(error instanceof WebsitePhpToolsServiceError ? error.code : failurePhase, 'Klon tamamlanamadı. Kaynak korunuyor; hedefteki kısmi dosya/veri ve aynı işlem kaydı incelenmelidir.', error.status ?? 502);
      }
    });
  }
  return { preview, execute };
}
