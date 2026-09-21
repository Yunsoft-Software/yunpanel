# Yerli İzolasyonlu Dosya Yöneticisi ve Otomatik Webmail Entegrasyonu Canlı Kabulü — 21 Eylül 2026

**Tarih**: 21 Eylül 2026  
**Hedef Sunucu**: `157.180.11.28` (`server.cryptoraichu.website`, Ubuntu 24.04 LTS, Node.js `v24.20.0`)  
**Kapsam**: P0.11 — Otomatik Webmail Entegrasyonu & P0.12 — Yerli İzolasyonlu Dosya Yöneticisi (File Manager)

---

## 1. Amaç ve Çözülen Sorunlar

1. **Otomatik Webmail (`webmail.<domain>`) Açılmama ve Roundcube error_reporting Sorunu (P0.11)**:
   - **Kök Neden**: Web arayüzündeki yeni site oluşturma formu (`new-website-form.js`), backend'e `/sites/create-preview` çağrısı yaparken `mail` nesnesini göndermiyordu. Backend `site-create-base.js` ise gönderilmeyen `mail` parametresini varsayılan olarak `{ mode: 'none' }` kabul ettiği için `site-create-mail-provisioning.js` adımları (Roundcube Nginx mapping, DNS A kaydı, TLS sertifikası) hiç tetiklenmiyordu. Ayrıca PHP-FPM pool şablonunda `php_admin_value[error_reporting]` kullanılması, Roundcube'un çalışma zamanında çağırdığı `ini_set('error_reporting', 30711)` çağrısını engelleyerek `ERROR: Wrong 'error_reporting' option value` hatasına yol açıyordu.
   - **Çözüm**: `NewWebsitePage.jsx` ve `new-website-form.js` güncellenerek ana domainler için varsayılan `mail: { mode: 'local' }`, otomatik adım tamamlama (`autoAdvanceWebsiteProvisioning`) ve kullanıcı onay seçeneği eklendi. `roundcube-fpm.js` şablonundan `php_admin_value[error_reporting]` kaldırılarak Roundcube'un hata raporlama seviyesini kendisinin yönetmesi sağlandı. `SiteResourcesPanel.jsx` içine doğrudan `https://webmail.<domain>` erişim bağlantıları entegre edildi.
2. **elFinder Kaldırılması ve Yerli Dosya Yöneticisi (P0.12)**:
   - **Kök Neden**: `elFinder`'ın PHP-FPM bağımlılığı, iframe içi oturum köprüsü ve hantal kullanıcı arayüzü kullanıcı deneyimini olumsuz etkiliyordu. Ayrıca dosya işçisi kök dizin `/` isteklerini ve baştaki slash'leri reddediyor, API servisinin `UMask=0077` kuralı nedeniyle oluşturulan dosyalar `0600` izniyle oluşturulup Nginx (`www-data`) tarafından 403 Forbidden ile dönüyordu.
   - **Çözüm**: `elFinder` tamamen kaldırıldı; yerine doğrudan sitenin Linux kullanıcısı (`website.unixUser`) ve `website.documentRoot` sınırları içerisinde izole çalışan yüksek performanslı yerli bir dosya yöneticisi mimarisi uygulandı. Kök dizin `/` güvenli biçimde normalize edildi ve dosya/dizin oluşturma izinleri kanonik `0640`/`0750` yapılarak Nginx web erişimi garanti altına alındı.

---

## 2. Gerçekleştirilen Mimari ve Kod Değişiklikleri

### A. Backend İzolasyon ve Dosya Servisi
- `apps/api/src/site-file-worker.js`:
  - Worker subprocess mimarisi (`runuser -u <website.unixUser>`).
  - İzin verilen kök dizin regex kontrolü (`ROOT_PATTERN`: `/var/www/yunpanel/apps/<uuid>` veya `/var/lib/yunpanel/apps/<uuid>`).
  - Path traversal koruması (`..`, mutlak yollar, sembolik bağ kaçışları engellendi).
  - Desteklenen operasyonlar:
    - `list`: Dizin içeriği, boyut, izin modu (`0644`/`0755`), değiştirilme tarihi.
    - `create_file`: 0644 izinli yeni boş dosya oluşturma.
    - `mkdir`: 0755 izinli yeni klasör açma.
    - `read_text` & `write_text`: UTF-8 güvenli metin okuma ve `expectedSha256` ile eşzamanlı çakışma (optimistic concurrency lock) koruması.
    - `upload` & `download`: Base64/octet-stream ikili dosya transferi.
    - `delete`: `delete:<websiteId>:<path>` onayıyla tekil dosya/klasör silme.
    - `batch_delete`: `batch-delete:<websiteId>` onayıyla tek seferde 200 ögeye kadar toplu silme.
- `apps/api/src/site-file-manager.js`:
  - `static`, `node`, `php`, `python` runtime desteği ve Linux hesabı doğrulama.
  - Uygulama bazında concurrency lock (`locked(applicationId, ...)`).
- `apps/api/src/site-file-http.js`:
  - `/api/websites/:websiteId/files*` REST uç noktaları (`requirePanelRouteAccess` guard ile authenticated Owner ve site_manager erişimi).
- `apps/api/src/app.js` & `apps/api/src/index.js`:
  - `siteFileManager` servisinin başlatılması ve rota katmanına bağlanması.

### B. Frontend Modern React Dosya Yöneticisi
- `apps/web/src/workspace/FilesPanel.jsx`:
  - `elFinder` bağımlılıkları ve iframe tamamen temizlendi.
  - **İşlem Çubuğu (Toolbar)**: "+ Yeni Dosya", "+ Yeni Klasör", "Dosya Yükle", "Seçilenleri Sil (X)", "Yenile".
  - **Navigasyon**: Tıklanabilir breadcrumb dizin çubuğu ve "Üst Klasör" butonu.
  - **Çoklu Seçim (Checkbox)**: Tablo başlığında tümünü seç/bırak ve her satırda bağımsız seçim kutuları.
  - **Toplu Silme**: Birden fazla öge seçildiğinde beliren tehlike butonu ve typed confirm modalı.
  - **Dahili Kod/Metin Editörü**: Monospace fontlu, SHA-256 bütünlük doğrulamalı düzenleyici modalı.
  - **Yükleme/İndirme**: Çoklu dosya yükleme ve tarayıcıdan doğrudan güvenli indirme bağlantısı.
- `apps/web/src/workspace/provisioning-client.js`:
  - `autoAdvanceWebsiteProvisioning`: Site oluşturulduğunda sonraki 21 provisioning adımını otomatik olarak arka arkaya yürüten, ağ kopmalarına karşı 3 denemeli ve tekil hata durumunda otomatik retry yapan istemci motoru.
- `apps/web/src/api.js`:
  - `uploadSiteFile` binary upload istemcisi.
- `apps/web/src/workspace/PanelKit.jsx`:
  - Feather uyumlu `folder`, `trash`, `upload`, `download` SVG ikonları.

---

## 3. Test ve Doğrulama Sonuçları

1. **Birim ve Entegrasyon Testleri**:
   - `apps/api/test/site-file-worker.test.js`: 5/5 test geçti (kök slash `/` ve baştaki slash normalizasyonu dahil).
   - `apps/api/test/site-file-http.test.js`: 5/5 test geçti.
   - `apps/web/test/new-website-form.test.js`: 8/8 test geçti.
   - `apps/web/test/elfinder-ui-wiring.test.js`: 2/2 test geçti.
   - Tüm repo (`npm test`): 3400+ test, %100 yeşil.
2. **Repository Lint Doğrulaması**:
   - `node scripts/validate-repository.mjs`: Başarılı.
3. **Canlı Sunucu Doğrulaması (`157.180.11.28`)**:
   - `https://webrich.news` silinip sıfırdan oluşturuldu; 21 adım otomatik tamamlandı (Unix user, workspace, PHP runtime, DNS, Nginx, SSL, Mail config, DKIM, Webmail SSL, Roundcube mapping).
   - Roundcube `error_reporting` hatası çözüldü; `https://webmail.webrich.news` 200 OK ve Roundcube giriş formu başarıyla yüklendi.
   - Oluşturulan `contact@webrich.news` hesabı ile Roundcube oturumu açıldı; Dovecot `passdb auth succeeded` ve Webmail posta kutusu yönlendirmesi (`/?_task=mail`) doğrulandı.
   - Dosya Yöneticisi üzerinden oluşturulan dosyalar `0640` izinleriyle yazıldı ve `https://webrich.news/test.html` üzerinden 200 OK ile görüntülendi (Nginx 403 engeli kalktı).
4. **Playwright Uçtan Uca (E2E) Canlı Tarayıcı Testleri**:
   - `npx playwright test`:
     - Test 1 (Owner giriş & navigasyon): Geçti (2.6s)
     - Test 2 (Plesk sekmeleri, SSL & yerli terminal): Geçti (2.0s)
     - Test 3 (Scoped site_manager rolü & izolasyon): Geçti (6.6s)
     - Test 4 (Yerli Dosya Yöneticisi & Webmail doğrulama): Geçti (2.9s)
     - **Sonuç**: `4 passed (15.6s)`.
