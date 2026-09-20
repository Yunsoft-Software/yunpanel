# Domain & Website Suspend/Resume Lifecycle Gerçek Ortam Kabulü (2026-09-20)

Bu doküman, `.28` test sunucusunda (`157.180.11.28`, Ubuntu 24.04 LTS) Domain ve Website seviyesinde askıya alma (suspend) ve devam ettirme (resume) yaşam döngülerinin failure-injection ve gerçek Nginx yapılandırmalarıyla yapılan kabul testlerini belgeler.

---

## 1. Test Kapsamı ve Hedefler

- **Vhost Checksum Drift Reddi**:
  - Aktif Nginx vhost dosyasının SHA-256 sağlama toplamı staged checksum ile birebir eşleşmediğinde suspend işleminin fail-closed olarak engellenmesi (`domain_nginx_active_state_drift`, `readyToSuspend: false`, `confirmation: null`).
- **Domain Suspend & Root-Private Deactivation Receipt**:
  - `POST /api/domains/:domainId/suspend` çağrıldığında vhost'un `/etc/nginx/sites-enabled` altından kaldırılması ve `nginx -t` testinin başarıyla geçmesi.
  - Deaktivasyon makbuzunun `/var/lib/yunpanel/staging/nginx/deactivation/<configName>.<checksum>.json` konumunda root-private izinlerle (`0700` dizin, `0600` dosya, root:root) oluşturulması.
  - Domain durumunun `suspended` olması ve `suspendedChecksum` değerinin işlenmesi.
- **Bypass Koruması**:
  - Askıya alınmış domain üzerinde güncelleme (`update-preview`), stage veya aktivasyon denemelerinin HTTP 409 Conflict (`domain_suspended_update_blocked`) ile engellenmesi.
- **Yabancı Yapılandırma Koruması (Foreign Config Protection)**:
  - Domain askıdayken `/etc/nginx/sites-enabled` altına yabancı/harici bir vhost dosyası yerleştirildiğinde `resume` denemesinin fail-closed kalması (`status: "resume_failed"`, `code: "nginx_deactivation_rollback_drift"`) ve yabancı dosyanın ezilmesinin reddedilmesi.
  - Yabancı dosya temizlendikten sonra `resume-retry` ile güvenli devam ettirme.
- **Temiz Resume & Birebir Geri Yükleme**:
  - Resume sonrasında vhost dosyasının deactivation receipt içeriğinden birebir (byte-for-byte) geri yüklenmesi ve SHA-256 özetinin orijinal stagedChecksum ile tam eşleşmesi.
  - Domain durumunun tekrar `active` olması.
- **Website-Wide Suspend & Resume**:
  - `POST /api/websites/:websiteId/suspension/start` ile bağlı tüm domain rotalarının askıya alınması.
  - Website uygulama ve veri dizinlerinin (`/var/lib/yunpanel/apps/<applicationId>`) kesinlikle silinmeden korunması.
  - `POST /api/websites/:websiteId/suspension/resume` ile tüm rotaların başarıyla yeniden aktifleşmesi.
- **Servis Yeniden Başlatma & Kalıcılık (API Restart Persistence)**:
  - `systemctl restart yunpanel-api` sonrasında domain ve website durumunun sağlıklı ve `active` olarak korunması.

---

## 2. Yürütülen Test Adımları ve Doğrulama Kanıtları

Tüm adımlar `node /tmp/test-domain-and-website-suspension.mjs` otomasyonu ile `.28` test sunucusunda çalıştırılmış ve doğrulanmıştır:

```text
=== Starting Domain & Website Suspend/Resume Lifecycle Test ===
✔ Logged in successfully
✔ Target domain is active, stagedChecksum: 350095c66ed740eccfa053ec8f8ca2c2ccb9ede738d776ccd97ac21169ef7b6b

--- Part 1: Domain-Level Suspend/Resume Lifecycle ---

[Step 1] Verifying active vhost checksum drift blocks suspend...
✔ Vhost checksum drift cleanly blocked suspend: readyToSuspend=false, blockers=[domain_nginx_active_state_drift], confirmation=null

[Step 2] Requesting Suspend Preview with matching staged checksum...
✔ Suspend preview readyToSuspend=true, confirmation: suspend-domain:e63c3342-787d-5222-8b24-8db2de9834cc:3:350095c66ed740eccfa053ec8f8ca2c2ccb9ede738d776ccd97ac21169ef7b6b:fd92ec82e20c7d879eba719e742d33d5f80b21f022f88174000894f83d5c17e0

[Step 3] Executing Domain Suspend...
✔ Domain suspended successfully (operation id: 14b79af2-041b-401c-b4cf-b336e3cfa03e )

[Step 4] Verifying deactivation receipt permissions (0700/0600 root-private)...
✔ Deactivation receipt verified at /var/lib/yunpanel/staging/nginx/deactivation/yunpanel-webrich.news.conf.350095c66ed740eccfa053ec8f8ca2c2ccb9ede738d776ccd97ac21169ef7b6b.json with root-private permissions
✔ Vhost removed from sites-enabled and nginx -t verified

[Step 5] Verifying suspended Domain update bypass returns 409...
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
✔ Domain state in registry is 'suspended'
✔ Update preview bypass blocked with 409 (domain_suspended_update_blocked)

[Step 6] Testing Resume with foreign config in place (fail-closed)...
✔ Resume with foreign config failed closed (status: resume_failed, code: nginx_deactivation_rollback_drift, refused to overwrite)

[Step 7] Executing clean Domain Resume Retry...
✔ Domain resumed successfully (status: resumed)
✔ Restored vhost matches exact checksum and nginx -t passes
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
✔ Domain state returned to 'active'

--- Part 2: Website-Wide Suspend/Resume Lifecycle ---

[Step 8] Getting Website-wide suspension preview...
✔ Website suspension preview readyToSuspend=true, confirmation: start-website-suspend:2689cb56-55a4-50c0-a3a4-258c7f2d48dd:1:6ddc06e509b7a16afc3f732b9b405e5f0f13df0153d95bf565f87126de918d40

[Step 9] Executing Website-wide Suspend...
✔ Website-wide suspension succeeded (status: suspended)
✔ Website application/data directory preserved untouched at /var/lib/yunpanel/apps/a5e1f251-4594-5996-b402-47a2ad7f55a0

[Step 10] Executing Website-wide Resume...
✔ Website-wide resume succeeded (status: resumed)
✔ Vhost restored and nginx -t passes after website resume

[Step 11] Testing API Restart & State Persistence...
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
✔ Logged in successfully
✔ Domain remains active and healthy after API restart

========================================================
🎉 ALL DOMAIN & WEBSITE SUSPEND/RESUME TESTS PASSED!
========================================================
```

---

## 3. Sonuç

- `todo.md` kapsamındaki:
  - Gerçek Ubuntu/Nginx üzerinde Domain suspend/resume lifecycle'ı failure-injection ile doğrulandı.
  - Deaktivasyon makbuzu root-private (`0700/0600`) olarak korundu.
  - Foreign config üzerine yazma engellendi ve exact typed retry ile devam ettirildi.
  - Askıya alınmış domain'de update bypass'larının 409 ile engellendiği doğrulandı.
  - Website-wide suspend/resume ile veri/uygulama dizinleri korunarak erişim durdurma semantiği kanıtlandı.
