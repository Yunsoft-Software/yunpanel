import { isInfrastructureDatabase } from '@yunpanel/shared';
import { requirePanelRouteAccess } from './panel-http-guard.js';
import { databaseCredentialRegistryInternals } from './database-credential-registry.js';
import { jobPublicView } from './job-registry.js';

const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const route = (action) => async (request, response, next) => { try { await action(request, response); } catch (error) { next(error); } };

export function mountDatabaseSetupRoutes(app, {
  registry, websiteRegistry, databaseBindingRegistry, databaseCredentialRegistry,
  databaseCredentialApplyService, databaseInventoryProvider, siteMutationLock, auditStore, authorizeActor = null,
} = {}) {
  const base = '/api/servers/:serverId/websites/:websiteId/databases';
  async function target(request) {
    const server = await registry.getServer(request.params.serverId);
    const website = await websiteRegistry.getWebsite(request.params.websiteId);
    if (!server || !website || website.serverId !== server.id || !website.applicationId) throw fail('website_not_found', 'Site bulunamadı', 404);
    if (!request.auth?.id || !request.auth.user?.id) throw fail('unauthorized', 'Oturum gerekli', 401);
    if (request.auth.user.role !== 'owner' && !request.auth.user.websiteIds?.includes(website.id)) throw fail('forbidden', 'Bu siteye erişim izniniz yok', 403);
    if (authorizeActor && !await authorizeActor({ sessionId: request.auth.id, userId: request.auth.user.id, role: request.auth.user.role }, website.id)) throw fail('forbidden', 'Site erişimi değişti', 403);
    return { server, website };
  }

  app.post(base, requirePanelRouteAccess, route(async (request, response) => {
    const { server, website } = await target(request);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['databaseName', 'mode', 'password', 'expectedWebsiteRevision'].includes(key))
      || typeof body.databaseName !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(body.databaseName)
      || isInfrastructureDatabase(body.databaseName) || !['create', 'bind', 'continue'].includes(body.mode)
      || (body.password != null && (typeof body.password !== 'string' || !/^[A-Za-z0-9_!@#%^*+=.:,-]{16,128}$/.test(body.password)))) throw fail('database_setup_input_invalid', 'Veritabanı adı veya parola geçersiz', 400);
    if (typeof siteMutationLock?.withApplicationLock !== 'function') throw fail('database_setup_unavailable', 'Veritabanı kurulum servisi hazır değil', 503);
    const result = await siteMutationLock.withApplicationLock(website.applicationId, async () => {
      const current = await websiteRegistry.getWebsite(website.id);
      if (current?.revision !== body.expectedWebsiteRevision || current.applicationId !== website.applicationId) throw fail('website_revision_conflict', 'Site değişti. Listeyi yenileyin.');
      const inventory = await databaseInventoryProvider(server.id);
      if (!Array.isArray(inventory?.databases)) throw fail('database_inventory_unavailable', 'Veritabanı listesi doğrulanamadı', 503);
      const exists = inventory.databases.some((entry) => entry.name?.toLowerCase() === body.databaseName.toLowerCase());
      if (body.mode === 'bind' && !exists) throw fail('database_not_found', 'Veritabanı bulunamadı', 404);
      let binding = await databaseBindingRegistry.getByDatabase({ serverId: server.id, databaseName: body.databaseName });
      if (body.mode === 'create' && exists && !binding) throw fail('database_exists', 'Bu adla veritabanı var. Mevcut veritabanını bağlayın.');
      if (binding && (binding.websiteId !== website.id || binding.applicationId !== website.applicationId)) throw fail('database_already_bound', 'Veritabanı başka bir siteye bağlı');
      if (exists && !binding && request.auth.user.role !== 'owner') throw fail('database_binding_owner_required', 'Mevcut veritabanının ilk site atamasını yönetici yapmalıdır', 403);
      if (body.mode === 'continue' && !binding) throw fail('database_setup_not_found', 'Devam edilecek kurulum bulunamadı', 404);
      binding ??= await databaseBindingRegistry.bindDatabase({ serverId: server.id, websiteId: website.id, applicationId: website.applicationId,
        databaseName: body.databaseName, confirmation: `bind-database:${server.id}:${body.databaseName}:${website.id}` });
      let credential = await databaseCredentialRegistry.getForBinding(binding.id);
      if (credential && body.password != null) throw fail('database_password_already_configured', 'Mevcut kullanıcı parolası ayrı parola değiştirme işlemiyle düzenlenir');
      credential ??= await databaseCredentialRegistry.createCredential({ databaseBindingId: binding.id,
        initialPassword: body.password ?? null, confirmation: `create-database-credential:${binding.id}:${databaseCredentialRegistryInternals.usernameFor(binding.id)}` });
      const queued = await databaseCredentialApplyService.resumeApply(credential.id, {
        createDatabase: !exists,
        authorization: { actorId: request.auth.user.id, userId: request.auth.user.id, sessionId: request.auth.id,
          role: request.auth.user.role, websiteId: website.id },
      });
      return { binding, credential, job: jobPublicView(queued.job) };
    });
    response.set('Cache-Control', 'no-store'); response.status(202).json({ data: result });
  }));

  app.post(`${base}/:bindingId/connection`, requirePanelRouteAccess, route(async (request, response) => {
    const { website } = await target(request);
    if (!request.body || Object.keys(request.body).length !== 1 || typeof request.body.revealPassword !== 'boolean') throw fail('database_connection_input_invalid', 'Bağlantı isteği geçersiz', 400);
    const binding = await databaseBindingRegistry.getBinding(request.params.bindingId);
    if (!binding || binding.websiteId !== website.id || binding.serverId !== website.serverId
      || binding.applicationId !== website.applicationId || binding.unixUser !== website.unixUser) throw fail('database_binding_not_found', 'Veritabanı bağı bulunamadı', 404);
    const credential = await databaseCredentialRegistry.getForBinding(binding.id);
    if (!credential) throw fail('database_credential_not_found', 'Veritabanı kullanıcısı oluşturulmamış', 404);
    const data = { databaseName: binding.databaseName, username: credential.username, host: 'localhost', port: 3306, password: null };
    if (request.body.revealPassword) {
      if (typeof auditStore?.record !== 'function') throw fail('database_secret_audit_unavailable', 'Parola erişimi kaydedilemedi', 503);
      await auditStore.record({ actorId: request.auth.user.id, action: 'database.credential.reveal', resourceType: 'website', resourceId: website.id, outcome: 'accepted' });
      const secret = await databaseCredentialRegistry.materializeCredential(credential.id, { expectedRevision: credential.revision });
      if (typeof authorizeActor !== 'function' || !await authorizeActor({ sessionId: request.auth.id, userId: request.auth.user.id, role: request.auth.user.role }, website.id)) throw fail('forbidden', 'Parolaya erişim yetkisi değişti', 403);
      data.password = secret.password;
    }
    response.set('Cache-Control', 'no-store'); response.json({ data });
  }));
}
