# YunPanel — Gerçek Ortam / Kabul TODO

Bu dosyada yalnız kaynak testleriyle güvenilir biçimde tamamlanamayacak gerçek Ubuntu, package, browser, DNS/provider, mail delivery, storage ve rollback kabulleri tutulur. Kod işleri `plan.md`, hedef mimari `docs/architecture.md`, bağlayıcı kurallar `agents.md` içindedir.

IP adresi `.44` ile biten Plesk sunucusu kesinlikle kapsam dışıdır. Bütün SSH/package/deploy testleri yalnız repo dışı `.local/test-server.env` içindeki açık YunPanel test sunucusunda, hedef adresin `.44` olmadığı doğrulandıktan sonra yapılır. Secret/parola/cookie/MFA/private key ekran görüntüsü, rapor, log veya repoya yazılmaz.

## T-TOOLS — P0 ttyd, elFinder, phpMyAdmin/pgAdmin gateway

- [ ] PostgreSQL/pgAdmin açıldığında aynı Website role/scope, gateway auth ve çapraz-site reddi gerçek PostgreSQL ile doğrulansın.

## T-DOCKER-PYTHON-MIGRATION — P2

- [ ] Portainer adapter'ı açılırsa yalnız authenticated Owner gateway'i, local endpoint ve secret-safe session ile erişilsin; direct port public olmasın.

## T-UI — Son kabul

- [ ] Günlük navigasyonda uygulamalar yalnız ait oldukları Website altında görünsün; global Application ekranı yalnız Owner tanılama envanteri olsun.
- [ ] Website tabs runtime/capability'ye göre Hosting, Deploy, DNS, SSL, Mail/Webmail, Databases/phpMyAdmin, Files/elFinder, Logs/GoAccess, Terminal/ttyd, Backup, Cron ve Settings'i gerçek çalışır durumla göstersin.
- [ ] Gerçek Chromium/Firefox, mobil viewport, klavye ve ekran okuyucu ile deep-link/reload/back-forward, loading/error/missing dependency, modal confirmation ve uzun job progress davranışı doğrulansın.

## Yayın kuralı

Repoda adapter veya test bulunması canlı kabul anlamına gelmez. İlgili bölümün gerçek Ubuntu/package/browser/DNS/mail/storage/rollback kanıtı tamamlanmadan capability production-ready gösterilmez. GitHub Actions kullanılmaz.
