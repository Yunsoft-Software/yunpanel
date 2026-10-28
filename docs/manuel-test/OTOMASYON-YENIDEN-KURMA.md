# T818 — Aynı slug ile gerçek HTTPS yeniden kurma kabulü

Sonuç: GEÇTİ · CODEX · 2026-10-28 · Yalnız izinli `.28` test hedefi.

| Kontrol | Gerçek kanıt |
| --- | --- |
| Onaylı aktarım | Yalnız dört API dosyası; eski/yeni SHA-256 ve Node sözdizimi kontrolü; `yunpanel-api` restart sonrası aktif; paket kurulumu yok |
| Kaynak kapsamı | T812 `bf2d4c25`: store/service/management/removal; service ayrıca önceki `5dae3a98` kurulum durum korumasını içerir |
| Tekrar koşu | `YUNPANEL_TENANT_E2E_SLUG=ypt-recreate-mvs1ofek node e2e/otomasyon/tenant-e2e.mjs`, aynı slug ile iki kez; gerçek `127.0.0.1:32050` upstream |
| Sonuç | İlk koşu 20/20, ikinci 19/19; iki çıkış 0. İlk koşunun üst domain oluşturma kontrolü ek olarak sayılır |
| HTTPS ve tarayıcı | İki nesilde doğrulanan TLS, Let's Encrypt issuer, HTTP 200 ve Chromium'da `YUNPANEL_AUTOMATION_E2E_32050` gerçek içeriği |
| Durumlar | İki nesilde bakım 503, arşiv 302 + doğru hedef, tekrar aktif 200; Chromium 503 ve aktif içerik kontrolleri |
| Silme | Her döngüde normal kaldırma motoru, `removed`, tenant GET 404 ve tenant HTTPS yayınının sona ermesi |
| Kimlik kanıtı | Gerçek kalıcı `tenant-sites.json` yalnız bu hostname için okunup aşağıdaki üç kimlik karşılaştırıldı; nesil 1 → 2 |
| Anahtarlar | Her koşunun anahtarı iptal edildi; revoked key 401; iki iptal kaydı panelden doğrulandı |
| Parent temizliği | `157-180-11-28.sslip.io` bu koşuda oluşturuldu; normal stage/activate/preview/remove/continue akışı sonrası GET 404 |
| Fiziksel temizlik | Python kapalı, 32050 dinlemiyor, test `/tmp` dizini ve tenant/parent Nginx dosyaları yok; tenant store kaydı yok, sonraki nesil 3 |
| Sertifika saklama | İki kayıt `retired`; ortak ACME materyali mevcut 30 günlük saklama politikasıyla korunur; aktif test sertifika kaydı yok |
| Servis/kilitler | `nginx -t` başarılı; API aktif; `sunucu-28-1` ve `sunucu-28-genel` bırakıldı |
| Yerel regresyon | Tenant HTTP/recreate/store ve removal cleanup dosyalarında 22 geçti, 0 düştü/atlandı |
| Toplu doğrulama | `python3 orkestra/orchestrator.py verify --quick`: ok; lint/npm test geçti, yeni bulgu veya yeniden açılan görev yok |

| Kimlik | Nesil 1 | Nesil 2 |
| --- | --- | --- |
| Website | `7049dd93-dcff-5550-baf9-1769abe2fbc7` | `331faf6b-31e9-59e6-b460-a9724e755a73` |
| Domain | `b92f0105-ecc2-50ca-9fb4-f54ffcc2ffe4` | `8fe46ce0-7018-5636-bc6a-5fee52b9264a` |
| Provisioning | `55ca3f2e-2b0f-4b21-a39e-f1ba94426e58` | `07258d2c-e10b-48da-bba2-8c469c85023c` |

Kimlik gözlemcisi gerçek fetch yanıtlarını değiştirmeden ve gizli alan kaydetmeden ölçtü; hiçbir sahte servis/yanıt kullanılmadı. Yerel fixture'daki taklit adaptörler bu canlı testin parçası değildir. Ham gizli veri içermeyen kanıtlar `.local/automation-recreate-deployment/` altında tutulur. Bu sonuç bütün panelin tam dalga kabulü değildir; push ve `.44` erişimi yapılmadı.
