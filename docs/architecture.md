# YunPanel — Mimari özeti

9 Ekim 2026. Plesk Obsidian ekran/iş akışı/özellik eşdeğerliği; mevcut altyapı üzerinde. Açık uygulama [plan](../plan.md), gerçek durum [audit](audit-2026-10-09.md), kabul [todo](../todo.md).

- React + JavaScript/JSX, React Router, ortak PanelKit/tasarım tokenları. TypeScript, paralel UI veya browser prompt/alert yok.
- Node >=24.11.1, npm >=11; mevcut native Node backend ve adapterlar. Repodaki Directus/YunCMS seçimi talimat olmadan değiştirilmez; bu incelemede YunPanel'in kendi backend'i esas alındı.
- Production entry apps/api/src/index.js. Tek yerel host: YUNPANEL_LOCAL_SERVER_ID + OS hostname eşleşmesi zorunlu; global remote server seçimi normal ürün değildir. Eski agent transport production'da kapalı; rollback kabulünden önce kalan dosyalar kör silinmez.
- Root yetki authenticated backend'dedir; frontend ve hosted workload'a verilmez. Dedicated Website Unix user/group, private runtime/tmp/log/release/document root, cron/SFTP/dosya/terminal kapsamı korunur.
- Website kalıcı site kaynağı; Domain hostname/routing; Application runtime. Üç kimlik birbirinin yerine kullanılmaz. UI Domain rotasını açık resolver ile Website/Application'a taşır; data bağı hostname tahmininden kurulmaz.
- Owner → isteğe bağlı tek Reseller → Customer → Website. Reseller yalnız doğrudan müşterileri ve siteleri; customer yalnız atanmış Website. Mevcut site_manager grant'leri ve site yöneticisi ilişkileri korunur. Paket/abonelik zorunlu önkoşul değildir; tam Plesk uzun vadeli kapsamında ayrıca vardır.
- Authentication/hosting hesapları SQLite; diğer birçok registry JSON + process lock. Aynı process testinin geçmesi disk/crash/çok-process transaction kabulü değildir. Auth/session/CSRF, canlı RBAC/WS/gateway reauthorization, secret masking korunur.
- Host motorları: Nginx, Passenger (yeni Node varsayılanı), PHP-FPM, Python venv/Gunicorn-Uvicorn, Docker/Compose. Direct-systemd compatibility kabul edilmiş migration'a kadar kalır.
- Araçlar: mevcut Files/elFinder, ttyd, phpMyAdmin, Roundcube, PowerDNS, Certbot/Cloudflare, Postfix/Dovecot/Rspamd, Netdata/GoAccess/CrowdSec, restic/rclone. Çalışan motorlar UX için yeniden yazılmaz; kabulden önce fallback kaldırılmaz.
- Mutation: server-side input/RBAC → mevcut state preview → açık eylem/confirmation → resource lock → durable operation/job → host apply/configtest → health/evidence → registry reconcile → UI sonucu. Kuyruğa almak veya metadata kaydetmek fiziksel başarı değildir.
- Durable işlerde actor/site/session bağlamı her mutation sınırında yeniden yetkilendirilir. Idempotency, bounded retry/backoff, receipt, restart inspect/reconcile ve rollback bulunmalıdır. Unknown POST cevabı ikinci POST ile telafi edilmez.
- Provisioning: Unix/site/runtime/Nginx, seçilen DNS/mail/DB/SFTP/SSL adımları health-gated; partial/error görünür. SFTP provisioning adımı ancak key desired state root-owned dosyaya reconcile edilip exact Website evidence doğrulanınca kapanır.
- Mail domain, DNS hosting ve web hostname ayrı lifecycle. Web/webmail/panel/mail service certificate amaçları ayrı; secret ve kaynak kimliği korunur. Yerel DNS kaydı dış registrar delegation kanıtı değildir.
- Silme/restore: etki ve hedef açık, dependency/ownership/receipt preflight, protected backup, typed destructive confirmation. Metadata silinmesi Unix/runtime/mail/DB cleanup kanıtı değildir; sibling kaynaklar korunur.
- Ubuntu ilk hedef; Windows/IIS/.NET/MSSQL/NTFS ayrı native adapter/kurulum/test hattı. Fail-closed unsupported sınıfı geliştirilmiş Windows desteği sayılmaz.

9 Ekim audit'inde üretim ile 847 kaynak dosyası eşleşti. Bununla birlikte SSL unchanged sonucu, DB oluştur/bağla/erişim akışı, PHP production wiring, araç deep linkleri ve backup recovery açık bulundu. Sözleşme/katalog/test sayısı bunların kullanıcı kabulünü kapatmaz.
