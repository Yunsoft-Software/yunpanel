# QA ve doğrulama bulguları (T800–T999)

> `orkestra/orchestrator.py finding` ve QA ajanları yazar. Elle düzenlenebilir; kimlikler sabit kalır.

### T800 · KRİTİK TLS-01: core-app.js sertifika yenileme ve sonuç uçlarında kiracı (tenant) izolasyonu eksik
- **Bağımlı:** —
- **Dosyalar:** `apps/api/src/core-app.js`, `apps/api/src/certificate-http.js`, `apps/api/test/ssl-renewal-wiring.test.js`
- **Kaynak:** QA · 2026-10-26 20:23
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Tekrar üretme: 1) Owner hesabıyla bir alan adına (ör. ttls01-a2.webrich.news) SSL sertifikası (certId: 89da9d5b-c2f3-4414-bf5b-5e895749137c) al. 2) Hiçbir web sitesi olmayan farklı bir Customer hesabıyla (ttls01-a2-cust) giriş yap. 3) POST /api/panel/certificates/89da9d5b-c2f3-4414-bf5b-5e895749137c/renew ({dryRun: true}) ve GET /api/panel/certificates/89da9d5b-c2f3-4414-bf5b-5e895749137c/renewal-outcome?jobId=<jobId> isteklerini gönder. Beklenen: Başka kiracıya ait sertifika için 403/404 dönmeli (certificate-http.js satır 187-231 canAccessCertificate kontrolü gibi). Gerçek: apps/api/src/core-app.js satır 1138-1205 içindeki /api/certificates/:id/renew, /renewal-outcome ve /reload-outcome rotaları certificate-http.js rotalarını gölgelemekte ve yalnızca domains.write/domains.read rol iznine bakıp canAccessDomain(req, domain) kontrolü yapmamaktadır. Customer hesabı 202 Accepted ile Owner sertifikasında yenileme işi (jobId: 487a3e84-f87d-4fcf-808b-707d565032bd) başlatabilmiş ve 200 OK ile yabancı sertifika detaylarını okuyabilmiştir.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T801 · KRİTİK TLS-01: SSL sertifikası bulunan web siteleri certificates_present engeli yüzünden silinemiyor
- **Bağımlı:** —
- **Dosyalar:** `apps/api/src/website-removal-plan.js`, `apps/api/test/website-removal.test.js`
- **Kaynak:** QA · 2026-10-26 20:23
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    Tekrar üretme: 1) Bir web sitesi oluştur (ttls01-a2.webrich.news) ve /websites/:id/ssl sekmesinden ücretsiz Let's Encrypt sertifikası al. 2) /websites/:id/settings sekmesine gidip 'Siteyi sil' bölümünü incele veya POST /api/panel/websites/:websiteId/removal-preview çağrısı yap. Beklenen: Ekrandaki etki tablosunda 'SSL/TLS sertifikası: Bağlı sertifikalar emekliye ayrılır (retire)' yazdığı ve domain-removal-plan.js içinde certificates_present orchestratable olduğu gibi, site silme önizlemesi readyToStart: true dönmeli ve site silinebilmeli. Gerçek: apps/api/src/website-removal-plan.js satır 268-282 içindeki ORCHESTRATABLE_WEBSITE_IMPACT_BLOCKERS listesinde 'certificates_present' bulunmadığı için hardBlockers: ['certificates_present'] ve readyToStart: false dönmekte, 'Silme işlemi için gerekli güvenlik kontrolü tamamlanmadı: certificates_present' uyarısıyla silme butonu gizlenmektedir.

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.

### T802 · --title
- **Bağımlı:** —
- **Dosyalar:** `--group`, `Grup 13 · Yedek ve kurtarma`, `--files`, `apps/web/src/workspace/SiteBackupPanel.jsx apps/web/src/workspace/site-backup-client.js apps/api/src/backup-repository-http.js apps/api/src/website-hosting-backup-adapter.js`, `--notes`, `1) Sunucuda varsayılan Restic deposu bulunmadığında SiteBackupPanel 'Yedek deposu yok' gösterip Yedek Al ve Plan butonlarını kilitlemekte; ancak POST /api/panel/backups/repositories uç noktasını çağıran hiçbir UI ekranı/modalı bulunmadığından Owner tarayıcıdan yedek deposu başlatamamaktadır. Ayrıca DELETE /api/panel/backups/repositories/:id fiziksel /var/lib/yunpanel/backups/restic/repos/<id> dizinini temizlememektedir. 2) SiteBackupPanel.jsx:170 yalnız status==='succeeded' olduğunda load({refresh:true}) çağırdığından, sağlık kontrolü hatasıyla otomatik geri alınan (rolled_back) geri yüklemelerden sonra özet kartındaki 'Son geri yükleme sonucu' ve yeni oluşan 'pre_restore' snapshot tablosu yenilenmemektedir. 3) Taslak (draft) sitede nginx config henüz yokken backup preview başarılı dönüp işlem prepare adımında ENOENT ile düşmektedir. 4) SiteBackupPanel.jsx içinde AGENTS.md Madde 6'ya aykırı '(Rollback)', '(rclone)', '(health_check_failed)' parantez içi ifadeleri bulunmaktadır.`
- **Kaynak:** QA · 2026-10-26 20:33
- **İş:** Önce tekrar üret ve otomatik teste çevir, sonra düzelt. Kayıt:

    BAK-08: Panelde Restic yedek deposu oluşturma ekranı yok ve geri alma sonrası UI durumu yenilenmiyor

- **Kabul:** Hata tekrar üretilmiyor; `orkestra/orchestrator.py verify --quick` geçiyor.
