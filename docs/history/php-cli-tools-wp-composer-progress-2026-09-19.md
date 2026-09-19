# WP-CLI ve Composer Site-User Bounded Command Adapter İlerlemesi (2026-09-19)

Bu belge, P1.4 kapsamındaki WP-CLI ve Composer CLI araçlarının site kullanıcısı bağlamında, root yetkisi olmadan, bounded komut adapter'ları ve authenticated HTTP API üzerinden yürütülmesi geliştirmelerini belgeler.

## Yapılan İşler

1. **Host Runtime Bounded Command Manager (`packages/host-runtime/src/php-cli-tool-manager.js`)**:
   - `createPhpCliToolManager`:
     - Tool Inspection: `/usr/local/bin/wp`, `/usr/bin/wp`, `/usr/local/bin/composer`, `/usr/bin/composer` yollarını tarar ve versiyon çıktısını parse eder.
     - Target Context Resolution: Website `unixUser` (`yunapp-*`), canonical `current` veya `current/public` dizinini doğrular. Root UID (`0`) veya root kullanıcısı ile çalıştırma girişimlerini kesinlikle reddeder (`php_cli_root_forbidden`, 403).
     - Bounded Allowlist:
       - WP-CLI: `core`, `plugin`, `theme`, `cache`, `transient`, `db`, `option`, `cron`, `user`, `post`, `eval`, `config` komutları. `--allow-root` argümanı ve control karakterler kesinlikle yasaklanmıştır.
       - Composer: `validate`, `install`, `update`, `dump-autoload`, `dumpautoload`, `show`, `audit`, `outdated`, `licenses`, `diagnose`, `clear-cache`, `require`, `remove` komutları.
     - Process Execution: `runuser -u <user> -- <binary> <args>` ile komutları Website kullanıcısı altında, izole HOME ve çevre değişkenleriyle çalıştırır.
   - `packages/host-runtime/src/index.js` üzerinden export edildi.
   - `packages/host-runtime/test/php-cli-tool-manager.test.js` ile 8 birim test yazıldı ve geçti.

2. **Website PHP Tools Service (`apps/api/src/website-php-tools-service.js`)**:
   - `createWebsitePhpToolsService`:
     - `resolveWebsitePhpContext`: Website ve Application'ın runtime adapter'ının `php-fpm` olduğunu doğrular; aksi halde 409 (`website_runtime_not_php`) döner.
     - `getWpCliStatus(websiteId)`: WP-CLI kurulu mu, WordPress kurulu mu (`wp core is-installed`), sürüm, eklenti ve tema listesini döner.
     - `runWpCli(websiteId, { command, args, timeout })`: Bounded WP-CLI komutunu çalıştırır.
     - `getComposerStatus(websiteId)`: Composer yüklü mü, `composer.json` ve `composer.lock` var mı, validate durumu nedir döner.
     - `runComposer(websiteId, { command, args, timeout })`: Bounded Composer komutunu çalıştırır.
   - `apps/api/test/website-php-tools-service.test.js` ile 5 test yazıldı ve geçti.

3. **Authenticated HTTP API Routes (`apps/api/src/website-php-tools-http.js`)**:
   - `GET /api/websites/:websiteId/wp-cli/status`
   - `POST /api/websites/:websiteId/wp-cli/run`
   - `GET /api/websites/:websiteId/composer/status`
   - `POST /api/websites/:websiteId/composer/run`
   - `requirePanelRouteAccess({ minRole: 'operator' })` guard'ı ile korunur.
   - `apps/api/test/website-php-tools-http.test.js` ile 5 test yazıldı ve geçti.

4. **Production App & Index Wiring (`apps/api/src/app.js`, `apps/api/src/index.js`)**:
   - `createApp` ve `index.js` üretim başlatmasına bağlandı.
   - Error handler'a `WebsitePhpToolsServiceError` ve `PhpCliToolError` eklendi.

5. **Doğrulama**:
   - Node 24 (`source ~/.nvm/nvm.sh && nvm use 24`) ile `npm run check` başarıyla tamamlandı.
