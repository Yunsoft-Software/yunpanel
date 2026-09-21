# YunPanel — Gerçek Ortam / Kabul TODO

Bu dosyada yalnız kaynak testleriyle güvenilir biçimde tamamlanamayacak gerçek Ubuntu, package, browser, DNS/provider, mail delivery, storage ve rollback kabulleri tutulur. Kod işleri `plan.md`, hedef mimari `docs/architecture.md`, bağlayıcı kurallar `agents.md` içindedir.

IP adresi `.44` ile biten Plesk sunucusu kesinlikle kapsam dışıdır. Bütün SSH/package/deploy testleri yalnız repo dışı `.local/test-server.env` içindeki açık YunPanel test sunucusunda, hedef adresin `.44` olmadığı doğrulandıktan sonra yapılır. Secret/parola/cookie/MFA/private key ekran görüntüsü, rapor, log veya repoya yazılmaz.

## T-TOOLS — P0 ttyd, elFinder, phpMyAdmin/pgAdmin gateway

- [ ] PostgreSQL/pgAdmin açıldığında aynı Website role/scope, gateway auth ve çapraz-site reddi gerçek PostgreSQL ile doğrulansın.

## T-DOCKER-PYTHON-MIGRATION — P2

- [ ] Portainer adapter'ı açılırsa yalnız authenticated Owner gateway'i, local endpoint ve secret-safe session ile erişilsin; direct port public olmasın.

## T-AI — AI yönetim katmanı gerçek provider/host kabulü

- [ ] Repo dışında saklanan gerçek provider credential'larıyla en az iki provider adapter'ında tool-call, streaming, timeout, rate-limit ve provider-error roundtrip doğrulansın; credential plaintext frontend response, conversation persistence, generic job/audit/log veya ekran görüntüsüne düşmesin.
- [ ] Yalnız açık YunPanel test hostunda (`.44` kesinlikle hariç) gerçek Owner session üzerinden read diagnostics ve reversible write doğrulansın; AI write işlemleri mevcut durable job/resource-lock/idempotency/recovery/audit yollarını kullanmalı, ikinci root transport veya raw shell oluşturmamalı.
- [ ] AI tarafından tetiklenen en az bir durable mutation host mutation sınırında process/API kill veya timeout ile kesilsin; restart mevcut root-private operation evidence'ından inspect-first reconcile etsin, duplicate side-effect üretmesin. State drift/restart sonrası eski AI preview/confirmation fail-closed kalmalı.
- [ ] Prompt-injection kabulü gerçek modelle doğrulansın: untrusted log/domain/mail/application içeriği yeni tool ekleyememeli, policy override edememeli, credential reference/plaintext sızdıramamalı ve raw shell/filesystem escape üretememeli; modele yalnız bounded available + policy-allowed tool şemaları görünmeli.
- [ ] Gerçek Chromium/Firefox Owner UI'da global/contextual AI, streaming cancel/reconnect, confirmation card, uzun durable job progress/recovery ve destructive restore için güncel exact confirmation akışları doğrulansın.

## T-UI — Son kabul

- [ ] Günlük navigasyonda uygulamalar yalnız ait oldukları Website altında görünsün; global Application ekranı yalnız Owner tanılama envanteri olsun.
- [ ] Website tabs runtime/capability'ye göre Hosting, Deploy, DNS, SSL, Mail/Webmail, Databases/phpMyAdmin, Files/elFinder, Logs/GoAccess, Terminal/ttyd, Backup, Cron ve Settings'i gerçek çalışır durumla göstersin.
- [ ] Gerçek Chromium/Firefox, mobil viewport, klavye ve ekran okuyucu ile deep-link/reload/back-forward, loading/error/missing dependency, modal confirmation ve uzun job progress davranışı doğrulansın.

## Yayın kuralı

Repoda adapter veya test bulunması canlı kabul anlamına gelmez. İlgili bölümün gerçek Ubuntu/package/browser/DNS/mail/storage/rollback kanıtı tamamlanmadan capability production-ready gösterilmez. GitHub Actions kullanılmaz.
