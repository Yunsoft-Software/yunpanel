# BAK-08 — Gerçek kurtarma, hata bildirimi ve yedek sahipliği

**Durum:** SORUNLU
**Tarih:** 26-10-2026
**Ajan:** AGENT_1
**Grup:** Grup 13 · Yedek ve kurtarma
**Parity:** Kritik açık

## Sonuç

`SORUNLU` — Arka uçta gerçek Restic yedekleme (`website:<id>` sahiplik etiketli snapshot), geri yükleme öncesi otomatik `pre-restore` snapshot alma, seçici/tam geri yükleme, Nginx HTTP sağlık kontrolü (`127.0.0.1:80`) başarısız olduğunda otomatik geri alma (`rolled_back` / `health_check_failed`), siteler arası (`cross-site`) snapshot/geri yükleme izolasyonu ve `site_manager` rol izolasyonu uçtan uca çalışmaktadır. Ancak panel arayüzünde **Restic yedek deposu oluşturma/başlatma ekranı bulunmadığından** (`POST /api/panel/backups/repositories` yalnızca API'de var), sunucuda depo yokken son kullanıcı tarayıcıdan yedekleme akışını başlatamamaktadır; ayrıca otomatik geri alma (`rolled_back`) sonrasında özet kartı ve snapshot tablosu otomatik yenilenmemekte, taslak (`draft`) sitede yedekleme `prepare` adımında `ENOENT` ile düşmekte ve arayüzde `AGENTS.md` Madde 6'ya aykırı parantez içi İngilizce/ham hata kodları (`(Rollback)`, `(rclone)`, `(health_check_failed)`) gösterilmektedir. Kritik bulgu için `T802` açılmıştır.

## Özet

`.28` test sunucusunda izole test kaynakları (`tbak08-a1.webrich.news`, `tbak08-a1-repo`, `tbak08-a1-mgr`) oluşturularak gerçek Chromium tarayıcı oturumu, arka uç API ve sunucu dosya sistemi üzerinde 9 kapsamlı senaryo koşturulmuştur:

1. **Varsayılan Boş Depo Durumu ve UI Eksikliği:** `.28` üzerinde varsayılan Restic deposu sayısı `0` olarak gözlemlendi (`GET /api/panel/backups/repositories` → `[]`). `Web Siteleri → tbak08-a1.webrich.news → Yedekleme ve Geri Yükleme` ekranı `"Yedek deposu yok — Bu sunucu için henüz yapılandırılmış bir Restic deposu bulunmuyor."` mesajını gösterdi ve `Yedek Al` ile `Plan ve Zamanlama` butonlarını kilitledi. Ön yüzde (`apps/web/src/`) yeni Restic deposu oluşturacak hiçbir ekran veya modal bulunmadığı tespit edildi.
2. **Gerçek Yedek Alma ve Sahiplik Etiketleri:** Test için yerel Restic deposu (`tbak08-a1-repo`, `id: 9305bf71-1d69-4fcc-a352-9090b6289f55`) başlatıldı, siteye `index.html` ve `kanit.txt` (`VERI-SURUM-1-TBAK08-A1`) yüklendi ve arayüzden `Yedek Al → Yedeği Başlat` tıklandı. İşlem `Başarılı` durumuna ulaştı; Restic deposunda `9b7de43d` (`9b7de43db91545d7bca12e6745aeedd1f34ff669840828287a9cc9431f81fd32`) kimlikli gerçek snapshot oluştuğu ve `website:7fffed9f-72cd-5169-a76a-99d06ac81dfb`, `domain:tbak08-a1.webrich.news`, `server:46efce06-9472-4f81-ba39-e249c2010610`, `runtime:static` sahiplik etiketleriyle imzalandığı doğrulandı.
3. **Seçici Geri Yükleme ve `pre-restore` Snapshot Kanıtı:** Canlı sitedeki `kanit.txt` dosyası `BOZULMUS-SURUM-2-TBAK08-A1` olarak değiştirildi (`curl -H "Host: tbak08-a1.webrich.news" http://127.0.0.1/kanit.txt` → `BOZULMUS-SURUM-2-TBAK08-A1`). Ardından arayüzden `9b7de43d` yedeği için `Geri Yükle → Seçici Geri Yükleme` seçilip onay metni (`tbak08-a1.webrich.news geri yükle`) girilerek işlem başlatıldı. Sistem önce `06d78fe5` (`pre_restore`) yedeğini aldı, dosyaları geri yükledi ve canlı HTTP yanıtının tekrar `VERI-SURUM-1-TBAK08-A1` (`HTTP 200`) olduğu fiziksel olarak doğrulandı.
4. **Sağlık Kontrolü Başarısızlığında Otomatik Geri Alma (`Rollback`) ve Hata Bildirimi:** `index.html` dosya izni `0600` yapılarak Nginx'in `HTTP 403 Forbidden` döndürdüğü bozuk durum yedeklendi (`3e812d65`). Ardından canlı site sağlıklı duruma (`index.html` `0644` → `HTTP 200`, `kanit.txt` → `KORUNAN-CANLI-VERI-ROLLBACK-ONCESI`) getirildi ve arayüzden bozuk yedek (`3e812d65`) geri yüklendi. Geri yükleme sonrasında `nginx-http-health` denetleyicisi `127.0.0.1:80` üzerinde 61 deneme boyunca `HTTP 403` (`website_health_status_unhealthy`) tespit etti; sistem `3bda4641` kimlikli `pre_restore` yedeğini kullanarak siteyi otomatik olarak önceki sağlıklı haline geri aldı (`status: 'rolled_back'`, `rollbackReason: 'health_check_failed'`). Canlı sitede `kanit.txt` içeriğinin `KORUNAN-CANLI-VERI-ROLLBACK-ONCESI` ve `/` yanıtının `HTTP 200` olarak korunduğu doğrulandı.
5. **Yedek Sahipliği ve Rol İzolasyonu:** Başka bir siteye (`webrich.news`, `websiteId: 7fe9a711-a5b0-550e-a5e5-49fee4c66a73`) geçildiğinde aynı `tbak08-a1-repo` deposunda `tbak08-a1.webrich.news` snapshot'larının görünmediği (`Bu site için yedek yok`, snapshot sayısı `0`) ve API üzerinden yabancı snapshot ile geri yükleme önizlemesi istendiğinde `HTTP 404 snapshot_not_found` döndüğü doğrulandı. `POST /api/panel/websites/:id/backup-operations` çağrısında başka sitenin `website:<id>` etiketi enjekte edilmek istendiğinde `HTTP 400 backup_tag_reserved` ile reddedildi. `site_manager` (`tbak08-a1-mgr`) rolüyle giriş yapıldığında yalnızca kendi sitesinin yedek özetini salt okunur görebildiği, mutasyon butonlarının (`Yedek Al`, `Geri Yükle`, `Plan ve Zamanlama`, `Sağlık Denetimi`) gizlendiği ve yabancı siteye/global depolara erişimin `HTTP 403` (`site_scope_forbidden`) ile engellendiği kanıtlandı.

## Senaryolar

### S1: Varsayılan boş depo durumu ve Restic depo başlatma UI kontrolü
- **UI Yolu:** `Web Siteleri → tbak08-a1.webrich.news → Yedekleme ve Geri Yükleme` (`/websites/780830e7-c951-580e-815c-0ce6059966e5/backup`)
- **Eylem:** Sunucuda henüz Restic deposu yokken (`GET /api/panel/backups/repositories` → `[]`) yedekleme sekmesi açıldı ve panelde depo ekleme ekranı arandı.
- **UI Tepkisi:** `"Yedek deposu yok — Bu sunucu için henüz yapılandırılmış bir Restic deposu bulunmuyor."` boş durum bileşeni gösterildi; `Yedek Al` (`disabled: true`) ve `Plan ve Zamanlama` (`disabled: true`) butonları devre dışı bırakıldı (`02-empty-repo-state.png`). Ancak panelde Restic deposu oluşturacak hiçbir buton veya ayar sayfası bulunamadı.
- **Fiziksel Doğrulama:** `apps/web/src/` genelinde `/backups/repositories` için `POST` çağrısı yapan hiçbir bileşen olmadığı doğrulandı. Testin devamı için Owner oturumundan `POST /api/panel/backups/repositories` (`name: "tbak08-a1-repo"`, `backend: "local"`, `initialize: true`) çağrılarak `/var/lib/yunpanel/backups/restic/repos/9305bf71-1d69-4fcc-a352-9090b6289f55` deposu başlatıldı (`HTTP 201`, `status: "ready"`).
- **Sonuç:** `SORUNLU` (Arka uç depo başlatma çalışıyor; ön yüzde depo oluşturma ekranı eksik — `T802`).

### S2: Taslak (`draft`) durumundaki sitede yedekleme başlatma (`ENOENT` hatası)
- **UI Yolu:** `Web Siteleri → tbak08-a1.webrich.news → Yedekleme ve Geri Yükleme → Yedek Al → Yedeği Başlat`
- **Eylem:** Site oluşturma sihirbazında `nginx` ve `domain_activation` adımları henüz tamamlanmamışken (`state: "draft"`) `Yedek Al` modalı açılıp `Yedeği Başlat` tıklandı.
- **UI Tepkisi:** Önizleme modalı hata vermeden `"Bu sitenin dosyaları ve 0 veritabanı seçilen depoya yedeklenir"` mesajını gösterdi (`04-backup-preview-modal.png`). İşlem başlatıldığında `Yedekleme işlemi` kartı `prepare` adımında `Başarısız` (`"İşlem tamamlanamadı; kayıtlı hata ve geri alma durumunu kontrol edin"`) durumuna düştü.
- **Fiziksel Doğrulama:** `/var/lib/yunpanel/control-plane/website-backup-operations.json` (`operationId: c2503036-d2b3-4a44-b809-966c39eb2f53`) ve `job-registry.json` (`jobId: 024b1dc5-425b-4a82-9608-f9e1b7fb944e`) incelendiğinde, `website-hosting-backup-adapter.js:42` satırının henüz oluşturulmamış `/etc/nginx/sites-enabled/tbak08-a1.webrich.news.conf` dosyasında `lstat` çağırması nedeniyle işin 13 ms içinde `ENOENT` (`"A required host file or executable was not found."`) ile düştüğü doğrulandı.
- **Sonuç:** `SORUNLU` (Önizleme `draft` siteyi engellemiyor ve hata mesajı gerçek nedeni gizliyor).

### S3: Aktif sitede gerçek yedek alma ve Restic snapshot / sahiplik etiketi doğrulaması
- **UI Yolu:** `Web Siteleri → tbak08-a1.webrich.news → Yedekleme ve Geri Yükleme → Yedek Al → Yedeği Başlat`
- **Eylem:** Site kurulum adımları tamamlanıp (`state: "active"`) `index.html` ve `kanit.txt` (`VERI-SURUM-1-TBAK08-A1`) yüklendikten sonra `Yedek Al → Yedeği Başlat` tıklandı.
- **UI Tepkisi:** `Yedekleme işlemi` kartı `Başarılı — İşlem doğrulanarak tamamlandı` durumuna geçti; `tbak08-a1-repo` tablosunda `9b7de43d` (`• Site yedeği`, `• Geçerli`, `26.10.2026 20:02`) satırı ve `Geri Yükle` aksiyonu listelendi (`05-backup-succeeded.png`).
- **Fiziksel Doğrulama:** `GET /api/panel/backups/repositories/9305bf71-1d69-4fcc-a352-9090b6289f55/snapshots` yanıtında `9b7de43db91545d7bca12e6745aeedd1f34ff669840828287a9cc9431f81fd32` snapshot'ının `["backup-set:62718c28...", "domain:tbak08-a1.webrich.news", "operation:c21c2d9f-e289-477e-bf41-b979c1b49b47", "runtime:static", "server:46efce06-9472-4f81-ba39-e249c2010610", "website:7fffed9f-72cd-5169-a76a-99d06ac81dfb"]` etiketleriyle ve `["/var/lib/yunpanel/backups/resources/website/7fffed9f-72cd-5169-a76a-99d06ac81dfb", "/var/lib/yunpanel/data/5a4196d2-d5bd-55b7-8df9-5a41d60b6e22", "/var/www/yunpanel/apps/5a4196d2-d5bd-55b7-8df9-5a41d60b6e22"]` yollarıyla oluşturulduğu doğrulandı.
- **Sonuç:** `GEÇTİ`.

### S4: Geri yükleme modalında hatalı onay metni ve kapsam doğrulaması
- **UI Yolu:** `Web Siteleri → tbak08-a1.webrich.news → Yedekleme ve Geri Yükleme → Geri Yükle (9b7de43d)`
- **Eylem:** Geri yükleme modalında `Seçici Geri Yükleme` açıldı; kapsam kutuları değiştirilirken önizleme (`Geri yükleme önizlemesi ve sağlık kontrolleri hazırlanıyor...`) çalıştı ve onay kutusuna yanlış metin (`yanlis-onay-metni`) yazıldı.
- **UI Tepkisi:** Onay metni tam olarak `tbak08-a1.webrich.news geri yükle` ile eşleşmediği sürece `Seçici Geri Yüklemeyi Başlat` butonunun `disabled: true` kaldığı doğrulandı (`07-restore-wrong-confirm.png`). Ayrıca her kapsam kutusu değişiminde `restorePreview` çağrısı `<fieldset>` bileşenini geçici olarak kilitlediği için çoklu kutu seçimini hızlı değiştiren kullanıcıların yeniden önizleme tamamlanana kadar beklemek zorunda kaldığı gözlemlendi (`06-restore-empty-selection-error.png`).
- **Fiziksel Doğrulama:** Yanlış onay metniyle arka uca hiçbir `POST /backup-operations` isteği gönderilmediği doğrulandı. Arka uçta boş `include` dizisiyle seçici geri yükleme denendiğinde `400 restore_selection_invalid` döndüğü doğrulandı.
- **Sonuç:** `GEÇTİ`.

### S5: Dosya bozulması sonrası gerçek seçici geri yükleme ve `pre-restore` güvenlik yedeği
- **UI Yolu:** `Web Siteleri → tbak08-a1.webrich.news → Yedekleme ve Geri Yükleme → Geri Yükle (9b7de43d) → Seçici Geri Yüklemeyi Başlat`
- **Eylem:** Canlı sitedeki `kanit.txt` dosyası `BOZULMUS-SURUM-2-TBAK08-A1` ile ezildi (`curl -s -H "Host: tbak08-a1.webrich.news" http://127.0.0.1/kanit.txt` → `BOZULMUS-SURUM-2-TBAK08-A1`). Ardından `9b7de43d` snapshot'ı üzerinde `Seçici Geri Yükleme` seçilip `tbak08-a1.webrich.news geri yükle` onay metni girildi (`08-restore-modal-confirmed.png`) ve işlem başlatıldı.
- **UI Tepkisi:** `Geri yükleme işlemi` kartı `Başarılı — İşlem doğrulanarak tamamlandı` mesajını gösterdi; özet kartında `Son geri yükleme sonucu: Başarılı (Seçici) · 26.10.2026 20:02` güncellendi ve snapshot tablosuna otomatik oluşturulan `06d78fe5` (`• Geri yükleme öncesi`, `• Geçerli`) yedeği eklendi (`09-restore-succeeded.png`).
- **Fiziksel Doğrulama:** Sunucu üzerinde `curl -s -w "\nHTTP_CODE:%{http_code}" -H "Host: tbak08-a1.webrich.news" http://127.0.0.1/kanit.txt` çıktısının tekrar `VERI-SURUM-1-TBAK08-A1` (`HTTP_CODE:200`) olduğu ve `restoreOutcome` kaydında `status: "succeeded"`, `preRestoreSnapshotId: "06d78fe572f78eaa7a68c4040083975eec2e7e825015390cd3ea49b21fb7f8e2"`, `healthCheck: { satisfied: true, statusCode: 200, route: "127.0.0.1:80" }` yer aldığı doğrulandı.
- **Sonuç:** `GEÇTİ`.

### S6: Sağlık kontrolü (`403 Forbidden`) başarısızlığında otomatik geri alma (`Rollback`) ve hata bildirimi
- **UI Yolu:** `Web Siteleri → tbak08-a1.webrich.news → Yedekleme ve Geri Yükleme → Geri Yükle (3e812d65) → Geri Yüklemeyi Başlat`
- **Eylem:** Sitenin `index.html` izni `0600` yapılarak Nginx'in `/` adresinde `HTTP 403` döndürdüğü durum yedeklendi (`3e812d65`). Ardından canlı sitede `index.html` izni `0644` (`HTTP 200`) yapılıp `kanit.txt` içeriği `KORUNAN-CANLI-VERI-ROLLBACK-ONCESI` olarak güncellendi. Sonrasında arayüzden bozuk `3e812d65` yedeği için tam geri yükleme başlatıldı.
- **UI Tepkisi:** Geri yükleme uygulandıktan sonra sağlık kontrolü ~30 saniye boyunca `HTTP 403` aldı ve otomatik geri alma çalıştı. `Geri yükleme işlemi` kartında turuncu `• Geri Alındı (Rollback)` rozeti, `"Sağlık kontrolü başarısız; önceki durum geri alındı"` metni ve `"Otomatik Geri Alma: Sağlık kontrolü başarısız olduğu için site önceki haline geri alındı (health_check_failed)."` uyarısı gösterildi (`10-restore-rolled-back.png`). **Ancak** işlem bittiğinde üstteki `Son geri yükleme sonucu` alanı eski `Başarılı (Seçici) · 26.10.2026 20:02` değerinde takılı kaldı ve yeni `pre_restore` snapshot'ı (`3bda4641`) tabloya yansımadı.
- **Fiziksel Doğrulama:** `curl -s -w "\nHTTP_CODE:%{http_code}" -H "Host: tbak08-a1.webrich.news" http://127.0.0.1/kanit.txt` yanıtının `KORUNAN-CANLI-VERI-ROLLBACK-ONCESI` (`HTTP_CODE:200`) ve `/` yanıtının `HTTP 200` olduğu; API `restoreOutcome` alanında `status: "rolled_back"`, `rollbackReason: "health_check_failed"`, `preRestoreSnapshotId: "3bda4641240c71e32434b5f1cd8c1179e478d444c686e836adf08aa403c69485"`, `healthCheck: { satisfied: false, reason: "website_health_status_unhealthy", statusCode: 403, attempts: 61 }` kaydedildiği doğrulandı.
- **Sonuç:** `SORUNLU` (Fiziksel otomatik geri alma kusursuz çalışıyor; ancak `SiteBackupPanel.jsx:170` `rolled_back` sonrasında listeyi yenilemiyor ve uyarı metninde parantez içi ham kod `(health_check_failed)` / `(Rollback)` bulunuyor).

### S7: Depo sağlık denetimi (`Sağlık Denetimi`)
- **UI Yolu:** `Web Siteleri → tbak08-a1.webrich.news → Yedekleme ve Geri Yükleme → tbak08-a1-repo → Sağlık Denetimi`
- **Eylem:** Depo kartındaki `Sağlık Denetimi` butonuna tıklandı.
- **UI Tepkisi:** `Depo denetimi` kartı `• Başarılı — İşlem doğrulanarak tamamlandı` durumuna ulaştı; `Son depo kontrolü` alanı `26.10.2026 20:04` olarak güncellendi ve bu yenilemeyle birlikte önceki adımda oluşan `3bda4641` (`• Geri yükleme öncesi`) yedeği ile `Son geri yükleme sonucu: Geri alındı (Rollback)` bilgisi görünür hale geldi (`11-repo-health-check.png`).
- **Fiziksel Doğrulama:** Arka uçta `restic check` işleminin `9305bf71-1d69-4fcc-a352-9090b6289f55` deposu üzerinde hatasız tamamlandığı doğrulandı.
- **Sonuç:** `GEÇTİ`.

### S8: Yedek sahipliği ve siteler arası (`cross-site`) izolasyon
- **UI Yolu:** `Web Siteleri → webrich.news → Yedekleme ve Geri Yükleme` (`/websites/09efa3a3-81ed-5764-b925-3a6770516a6f/backup`)
- **Eylem:** Sunucudaki mevcut başka bir site (`webrich.news`, `websiteId: 7fe9a711-a5b0-550e-a5e5-49fee4c66a73`) altında yedekleme sekmesi açıldı; ayrıca API üzerinden yabancı sahiplik etiketi (`website:7fe9a711-...`) enjeksiyonu ve yabancı snapshot (`9b7de43d`) ile geri yükleme önizlemesi denendi.
- **UI Tepkisi:** `webrich.news` yedekleme ekranında `tbak08-a1-repo` deposu altında `tbak08-a1.webrich.news` sitesine ait hiçbir snapshot listelenmedi; `"Bu site için yedek yok — Bu depoda bu Website etiketiyle eşleşen snapshot bulunamadı."` mesajı gösterildi (`12-other-site-ownership-isolation.png`).
- **Fiziksel Doğrulama:**
  - `POST /api/panel/websites/7fffed9f-72cd-5169-a76a-99d06ac81dfb/backup-operations` içine `tags: ["website:7fe9a711-a5b0-550e-a5e5-49fee4c66a73"]` gönderildiğinde `HTTP 400` (`code: "backup_tag_reserved"`, `"Yedek sahiplik etiketleri değiştirilemez"`) döndü.
  - `POST /api/panel/websites/7fe9a711-a5b0-550e-a5e5-49fee4c66a73/restore/preview` içine `tbak08-a1.webrich.news` snapshot kimliği gönderildiğinde `HTTP 404` (`code: "snapshot_not_found"`, `"Snapshot not found for website in this repository"`) döndü.
- **Sonuç:** `GEÇTİ`.

### S9: `site_manager` rol izolasyonu ve hassas veri maskeleme
- **UI Yolu:** `tbak08-a1-mgr` (`site_manager`) oturumu → `Web Siteleri → tbak08-a1.webrich.news → Yedekleme ve Geri Yükleme`
- **Eylem:** Yalnızca `tbak08-a1.webrich.news` sitesine yetkili `tbak08-a1-mgr` kullanıcısıyla ayrı bir tarayıcı bağlamında giriş yapılarak yedekleme ekranı ve API sınırları test edildi.
- **UI Tepkisi:** `"Bu ekranda yalnız bu sitenin yedeklerini görebilirsiniz. Yeni yedek ve geri yükleme için yöneticinize başvurun."` bildirimi gösterildi (`13-site-manager-backup-view.png`); `Yedek Al`, `Geri Yükle`, `Plan ve Zamanlama` ve `Sağlık Denetimi` butonlarının hiçbiri render edilmedi (`hasBackupButton: false`, `hasRestoreButton: false`, `hasPlanButton: false`, `hasHealthCheckButton: false`).
- **Fiziksel Doğrulama:**
  - `GET /api/panel/websites/7fffed9f-72cd-5169-a76a-99d06ac81dfb/backups` → `HTTP 200` döndü ve yanıtta fiziksel dosya yolları (`/var/lib/yunpanel`, `targetPaths`, `"target"`) veya depo parolası sızmadığı (`ownBackupsLeaksTargetOrSecret: false`) doğrulandı.
  - `GET /api/panel/websites/7fe9a711-a5b0-550e-a5e5-49fee4c66a73/backups` (yetkisiz yabancı site) → `HTTP 403` (`code: "site_scope_forbidden"`).
  - `GET /api/panel/backups/repositories` (global depo envanteri) → `HTTP 403`.
  - `POST /api/panel/websites/7fffed9f-72cd-5169-a76a-99d06ac81dfb/backup-operations` (yedek alma girişimi) → `HTTP 403`.
- **Sonuç:** `GEÇTİ`.

## Hatalar

### H1: Panelde Restic yedek deposu oluşturma / başlatma arayüzü yok ve depo silme fiziksel dizini temizlemiyor
- **Önem:** `KRİTİK` (Bulgu görevi: `T802`)
- **Tekrar Adımı:**
  1. Henüz Restic deposu tanımlanmamış sunucuda `Web Siteleri → <site> → Yedekleme ve Geri Yükleme` sekmesini veya `Araçlar ve Ayarlar` menüsünü açın.
  2. Yeni bir yerel Restic yedek deposu oluşturmak / başlatmak için buton veya form arayın.
- **Beklenen:** Owner kullanıcısının panel arayüzünden yerel Restic deposu oluşturup başlatabilmesi (`POST /api/panel/backups/repositories`) ve depo silindiğinde (`DELETE /api/panel/backups/repositories/:id`) isteğe bağlı/onaylı olarak fiziksel depo dizininin de temizlenmesi.
- **Gerçekleşen:** Ön yüzde `POST /api/panel/backups/repositories` uç noktasını çağıran hiçbir ekran, modal veya buton bulunmamaktadır; kullanıcı `"Yedek deposu yok"` ekranında kilitli kalmaktadır (`Yedek Al` ve `Plan ve Zamanlama` devre dışı). Ayrıca `DELETE /api/panel/backups/repositories/:id` yalnızca `restic-repositories.json` kaydını silmekte, `/var/lib/yunpanel/backups/restic/repos/<id>` altındaki fiziksel Restic verisini diskte bırakmaktadır.
- **Kök Neden:** `apps/api/src/backup-repository-http.js:56-77` üzerinde depo oluşturma/başlatma/silme API uç noktaları yazılmış ancak `apps/web/src/workspace/SiteBackupPanel.jsx` ve `apps/web/src/workspace/site-backup-client.js` içinde yalnız okuma/tetikleme bağlanmış, depo yönetim UI bileşeni hiç eklenmemiştir.

### H2: Otomatik geri alma (`rolled_back`) veya başarısız işlem (`failed`) sonrasında yedekleme özeti ve snapshot tablosu yenilenmiyor
- **Önem:** `NORMAL` (Bulgu görevi: `T802` kapsamına dahil edildi)
- **Tekrar Adımı:**
  1. Sağlık kontrolünden geçemeyecek bir snapshot'ı (`HTTP 403` döndüren `index.html`) arayüzden `Geri Yükle` ile başlatın.
  2. İşlem `Geri Alındı (Rollback)` durumuna ulaştığında üstteki `Yedekleme ve Geri Yükleme` özet kartındaki `Son geri yükleme sonucu` satırını ve alttaki snapshot tablosunu kontrol edin.
- **Beklenen:** İşlem `rolled_back` veya `failed` olarak tamamlandığında da `load({ refresh: true })` çağrılarak `Son geri yükleme sonucu` alanının ve geri yükleme öncesinde otomatik alınan `pre_restore` snapshot'ının anında güncellenmesi.
- **Gerçekleşen:** `Son geri yükleme sonucu` bir önceki başarılı işlemin değerini (`Başarılı (Seçici)`) göstermeye devam etmekte ve yeni oluşturulan `pre_restore` (`3bda4641`) snapshot'ı kullanıcı elle `Yedekleri yenile` veya `Sağlık Denetimi` yapana kadar tabloda görünmemektedir (`10-restore-rolled-back.png` vs `11-repo-health-check.png`).
- **Kök Neden:** `apps/web/src/workspace/SiteBackupPanel.jsx:169-171` satırlarında yoklama tamamlandığında yalnızca `if (next.status === 'succeeded') void load({ refresh: true });` koşulu çalıştırılmaktadır.

### H3: Kurulumu tamamlanmamış (`draft`) sitede yedekleme önizlemesi başarılı dönüp işlem `prepare` adımında `ENOENT` ile düşüyor
- **Önem:** `NORMAL` (Bulgu görevi: `T802` kapsamına dahil edildi)
- **Tekrar Adımı:**
  1. Henüz Nginx yapılandırması uygulanmamış (`state: 'draft'`) bir sitede `Yedekleme ve Geri Yükleme → Yedek Al` butonuna tıklayın.
  2. Önizleme modalında `Yedeği Başlat` butonuna basın.
- **Beklenen:** Henüz aktif Nginx/yayın kurulumu tamamlanmamış (`draft`) sitede yedekleme önizlemesinin kullanıcıya açık bir önkoşul uyarısı vermesi veya eksik Nginx dosyasını güvenli şekilde ele alması.
- **Gerçekleşen:** Önizleme başarılı dönmekte, ancak işlem başladığında `prepare` adımında 13 ms içinde `ENOENT` ile başarısız olmakta ve kullanıcıya `"İşlem tamamlanamadı; kayıtlı hata ve geri alma durumunu kontrol edin"` genel hatası gösterilmektedir.
- **Kök Neden:** `apps/api/src/website-hosting-backup-adapter.js:42` (`const metadata = await lstat(entry.configPath)`) `/etc/nginx/sites-enabled/<domain>.conf` dosyasının varlığını önizleme aşamasında doğrulamadan yedekleme sırasında doğrudan `lstat` ile okumaktadır.

### H4: `SiteBackupPanel.jsx` içinde `AGENTS.md` Madde 6'ya aykırı parantez içi İngilizce terim ve ham hata kodu kullanımı
- **Önem:** `NORMAL` (Kozmetik / Kural İhlali — `T802` kapsamına dahil edildi)
- **Tekrar Adımı:**
  1. `Yedekleme ve Geri Yükleme` sekmesini, `Geri Yükle` modalını ve otomatik geri alma (`rolled_back`) bildirimini görüntüleyin.
- **Beklenen:** `AGENTS.md` (24 Ekim 2026 Madde 6) uyarınca arayüzde parantez içi İngilizce buzzword (`(Rollback)`, `(rclone)`) veya ham değişken/durum kodu (`(health_check_failed)`) kullanılmaması.
- **Gerçekleşen:** Arayüzde `Geri Alındı (Rollback)`, `Geri alındı (Rollback)`, `Uzak depo (rclone)`, `Seçici Geri Yükleme (Kapsamı Özelleştir)` ve `Sağlık kontrolü başarısız olduğu için site önceki haline geri alındı (health_check_failed).` metinleri yer almaktadır.
- **Kök Neden:** `apps/web/src/workspace/SiteBackupPanel.jsx:29, 250, 297, 396`.

## Mevcut testler

Grup 13 / `BAK-08` ile ilişkili mevcut 24 birim/entegrasyon test dosyası (`144` testin tamamı geçti) ve 2 canlı denetim (`live-audit`) spec dosyası incelenmiş ve aşağıdaki gibi sınıflandırılmıştır:

| Test Dosyası | Sonuç | Sınıf | Not |
|---|---|---|---|
| `apps/api/test/website-backup-set.test.js` | 8/8 geçti | `GEÇERLİ` | `createWebsiteBackupSetProvider` ve `normalizeWebsiteBackupSet` ile sahiplik etiketlerini (`website:<id>`), izin verilen yolları ve digest bütünlüğünü gerçek nesnelerle doğrular. |
| `apps/api/test/website-restore-selection.test.js` | 5/5 geçti | `GEÇERLİ` | `resolveWebsiteRestoreSelection` ve `assertWebsiteSnapshotContent` ile symlink kaçışı, yabancı path reddi ve seçici geri yükleme kapsamını doğrular. |
| `apps/api/test/backup-operation-registry.test.js` | 5/5 geçti | `GEÇERLİ` | Gerçek geçici dosya sistemi (`0600` izinli JSON) üzerinde işlem kaydı, yeniden başlatma kurtarması (`restart recovery`) ve kurcalama tespitini doğrular. |
| `packages/host-runtime/test/website-restore-receipt.test.js` | 3/3 geçti | `GEÇERLİ` | Gerçek dosya sistemi üzerinde `0600` izinli geri yükleme makbuzu (`receipt`), idempotency ve çakışma davranışını doğrular. |
| `apps/web/test/site-backup-model.test.js` | 3/3 geçti | `GEÇERLİ` | `siteBackupBrowser` ve `resolveSiteBackupAccess` doğrulama mantığını test eder. |
| `apps/api/test/website-backup-scope-source.test.js` | 2/2 geçti | `YÜZEYSEL` | `readFile` + regex ile kaynak kodda metin araması yapar (`AGENTS.md` Madde 9'a göre tek başına test kabul edilmez). |
| `apps/web/test/site-backup-wiring.test.js` | 3/3 geçti | `YÜZEYSEL` | `fs.readFileSync` ile JSX kaynak dosyalarında string kontrolü yapar. |
| `apps/api/test/website-backup-operation-service.test.js` | 9/9 geçti | `MOCK` | `websiteBackupService`, `websiteRestoreService`, `resticManager` ve `receiptStore` tamamen sahte (stub) fonksiyonlarla simüle edilmiştir. |
| `apps/api/test/website-restore-service.test.js` | 9/9 geçti | `MOCK` | `resticManager`, `healthInspector` ve `receiptStore` stub olarak enjekte edilmiştir. |
| `apps/api/test/website-restore-http.test.js` | 4/4 geçti | `MOCK` | `mockPreview` ve sahte `websiteRestoreService` kullanır. |
| `apps/api/test/website-backup-http.test.js` | 8/8 geçti | `MOCK` | `mockBackupSet` ve `mockPreview` ile yalnız HTTP katmanını test eder. |
| `apps/api/test/website-backup-service.test.js` | 16/16 geçti | `MOCK` | `runCommand`, `mkdirFn`, `writeFileFn`, `readFileFn`, `rmFn` ve `resticManager` stub'lanmıştır. |
| `apps/api/test/website-backup-acceptance.test.js` | 12/12 geçti | `MOCK` | Express + `createSiteResourceBoundary` RBAC gerçek olmakla birlikte Restic ve yedekleme servisleri in-memory sahte nesnelerdir. |
| `apps/api/test/website-backup-browser.test.js` | 3/3 geçti | `MOCK` | Kayıt defterleri ve Restic yöneticisi stub'lanmıştır. |
| `apps/api/test/website-database-backup-adapter.test.js` | 2/2 geçti | `MOCK` | `databaseManager` (`dumpToFile` / `restoreFromFile`) stub'lanmıştır. |
| `apps/api/test/website-dns-backup-adapter.test.js` | 7/7 geçti | `MOCK` | Şifreleme codec'i ve geçici dosyalar gerçek, ancak PowerDNS `zoneManager` stub'lanmıştır. |
| `apps/api/test/website-environment-backup-adapter.test.js` | 3/3 geçti | `MOCK` | `ApplicationEnvironmentRegistry` ve codec gerçek, ancak `runtimeManager` ve `healthInspector` stub'lanmıştır. |
| `apps/api/test/website-hosting-backup-adapter.test.js` | 3/3 geçti | `MOCK` | Geçici dizinde Nginx config üretimi gerçek, ancak `nginx -t` / `systemctl reload` (`execFn`) stub'lanmıştır. |
| `apps/api/test/website-mail-backup-adapter.test.js` | 8/8 geçti | `MOCK` | SQLite `DatabaseSync` ve `MailboxRegistry` gerçek, ancak `dataBackupFactory` / `dataRestoreFactory` stub'lanmıştır. |
| `apps/api/test/website-mail-backup-guard.test.js` | 3/3 geçti | `MOCK` | `jobRegistry` stub'lanmıştır. |
| `apps/api/test/backup-execution-crash-windows.test.js` | 1/1 geçti | `MOCK` | Yürütücüler (executors) stub'lanmıştır. |
| `apps/api/test/backup-production-runtime.test.js` | 3/3 geçti | `MOCK` | Kayıt defterleri stub'lanmıştır. |
| `apps/web/test/site-backup-acceptance.test.js` | 6/6 geçti | `MOCK` | `mockRequest` ile istemci durum geçişlerini simüle eder; gerçek DOM/tarayıcı veya gerçek API kullanmaz. |
| `packages/host-runtime/test/restic-manager.test.js` | 11/11 geçti | `MOCK` | `createMockRunner` ile `/usr/bin/restic` çağrı argümanlarını simüle eder. |
| `e2e/live-audit/06-host-lifecycle.spec.js` | Harici manifest bağımlı | `GEÇERLİ` (Koşullu) | Gerçek Playwright + `.28` üzerinde çalışır ancak `.local/acceptance-candidate/host-control.py` ve harici live-audit manifesti gerektirir. |
| `e2e/live-audit/16-native-hosting-dns-restore.spec.js` | Harici manifest bağımlı | `GEÇERLİ` (Koşullu) | Gerçek Restic geri yükleme ve geri alma testi içerir ancak harici live-audit manifesti olmadan tek başına çalışmaz. |

## Panelde olmayan / bulunamayan

1. **Restic Yedek Deposu Oluşturma / Başlatma / Silme Arayüzü Yok:** Arka uçta `GET/POST/DELETE /api/panel/backups/repositories` ve `POST /api/panel/backups/repositories/:id/init` uç noktaları (`apps/api/src/backup-repository-http.js`) mevcut olmasına rağmen, panel arayüzünde (`Araçlar ve Ayarlar` veya `Yedekleme ve Geri Yükleme`) yeni Restic deposu tanımlayacak veya başlatacak hiçbir ekran/modal bulunmamaktadır.
2. **Uzak Depo (`rclone`) Ekleme / Yapılandırma Arayüzü Yok:** `Plan ve Zamanlama` modalında `"Uzak depo (rclone)"` seçim kutusu bulunmakta ancak sunucuya yeni bir `rclone` uzak hedefi (`POST /api/panel/backups/rclone/remotes`) ekleyecek arayüz bulunmamaktadır.
3. **Tekil Snapshot Silme veya Yedek Arşivi İndirme/Yükleme Arayüzü Yok:** Snapshot tablosunda yalnızca `Geri Yükle` butonu yer almakta; tekil bir snapshot'ı silme veya Plesk benzeri taşınabilir yedek arşivi indirme/yükleme seçeneği bulunmamaktadır.

## Oluşturulan ve temizlenen kaynaklar

Test sırasında `.28` üzerinde oluşturulan tüm kaynaklar, `AGENTS.md` (11 Ekim 2026 yedek kuralı) ve `HAZIRLIK.md` kurallarına uygun olarak test sonunda tamamen silinmiş ve temizliği hem API hem dosya sistemi üzerinden doğrulanmıştır:

| Kaynak Türü | Kimlik / Ad | Oluşturma Yöntemi | Temizleme Yöntemi | Doğrulama Kanıtı |
|---|---|---|---|---|
| Web Sitesi ve Alan Adı | `tbak08-a1.webrich.news` (`websiteId: 7fffed9f-72cd-5169-a76a-99d06ac81dfb`, `domainId: 780830e7-c951-580e-815c-0ce6059966e5`) | UI (`/websites/new` sihirbazı) | PowerDNS alt zone temizliği + UI (`/websites/:domainId/settings → Siteyi sil…`) | `14-cleanup-completed.png` (`Site silindi · 5/5 adım`), `GET /api/panel/domains` ve `GET /api/panel/websites` içinde `false` (mevcut 8 site korundu). |
| Restic Yedek Deposu ve Snapshot'lar (`9b7de43d`, `06d78fe5`, `3e812d65`, `3bda4641`) | `tbak08-a1-repo` (`id: 9305bf71-1d69-4fcc-a352-9090b6289f55`) | `POST /api/panel/backups/repositories` + UI (`Yedek Al` / `Geri Yükle`) | `DELETE /api/panel/backups/repositories/9305bf71-1d69-4fcc-a352-9090b6289f55` + fiziksel `/var/lib/yunpanel/backups/restic/repos/9305bf71-...` ve `/var/lib/yunpanel/backups/resources/website/7fffed9f-...` temizliği | `GET /api/panel/backups/repositories` → `[]` (`0` depo); `/var/lib/yunpanel/backups/restic/repos/` ve `/var/lib/yunpanel/backups/resources/website/` altında test dizini kalmadı. |
| Panel Kullanıcısı (`site_manager`) | `tbak08-a1-mgr` | `POST /api/panel/users` | `PATCH /api/panel/users/:id` (`websiteIds: []`) + `DELETE /api/panel/users/:id` | `GET /api/panel/users` içinde `userStillExists: false` (mevcut 4 kullanıcı korundu). |
