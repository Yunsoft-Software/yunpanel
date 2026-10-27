# T155 İnceleme Notu (Review)

- **Tarih:** 2026-10-27
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T155 · Manuel test: RUN-04 — MIME, index, hata sayfaları ve parola korumalı dizinler
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Belgeler
- `e2e/ozellik/run-04.spec.js` (Playwright E2E testi)
- `docs/manuel-test/RUN-04.md` (Manuel test raporu)
- `tasks/done/T155.md` (Görev teslim raporu)

---

## 2. Doğrulama ve Bulgular

### A. Mock / Sahte Veri Kontrolü
- `e2e/ozellik/run-04.spec.js` dosyası detaylı incelendi. Hiçbir mock, stub, `page.route` veya sahte yanıt bulunmamaktadır.
- Test doğrudan canlı `.28` test sunucusu ve Nginx runtime'ına karşı çalışmakta, gerçek HTTP istekleri (`http.request` doğrudan port 80 üzerinden) ve gerçek DOM kontrolleri yapmaktadır.

### B. Senaryo Kapsamı ve Fiziksel Kanıtlar
1. **Mutlu Yol (Başlangıç Dosyaları & Özel 404 Sayfası):**
   - Panel arayüzünden (`/websites/new`) statik web sitesi oluşturuldu, docroot (`/var/www/yunpanel/apps/...`) ve sistem kullanıcısı tespit edildi.
   - Sunucuda `anasayfa.html`, `index.html` ve `/hatalar/404.html` fiziksel olarak oluşturuldu.
   - Panel üzerinden başlangıç dosyaları (`indexFiles: anasayfa.html index.html`) ve özel 404 sayfası (`errorPages: /hatalar/404.html`) yapılandırılarak yayına uygulandı.
   - SSH ile Nginx vhost konfigürasyonunda `index anasayfa.html index.html;`, `try_files $uri $uri/ =404;`, `error_page 404 /hatalar/404.html;` ve `internal;` blokları fiziksel olarak doğrulandı.
   - Fiziksel HTTP istekleriyle `GET /` çağrısında `ONCELIKLI_ANASAYFA_INDEX` içeriği (200 OK) ve bilinmeyen dosya yolunda `OZEL_404_HATA_SAYFASI` (404 Not Found) yanıtı doğrulandı.
2. **Hatalı Girdi Senaryosu:**
   - Index dosyası ile hata sayfasının aynı dosya seçilmesi durumunda arayüzde hata mesajı belirdiği ve uygulamanın engellendiği doğrulandı.
   - Geçersiz index dosyası (path traversal: `../yasak.html`) format hatasının reddedildiği ve `nginx -t` ile sunucuda Nginx yapılandırma bütünlüğünün bozulmadığı kanıtlandı.
3. **Plesk Eşdeğerlik Eksiklikleri Senaryosu:**
   - Plesk eşdeğeri "Password-Protected Directories" (Dizin Parolası Koruması), Apache & Nginx ayarlarındaki özel MIME Types (uzantı -> MIME türü eşleme) yönetim editörü ve Directory Browsing (autoindex on/off) toggle eksikliği `test.fail` ile belgelendi.

### C. Bağımsız Test Koşusu ve Temizlik
- AGENT_1 tarafından `sunucu-28-1` kilidi altında test bağımsız olarak koşturuldu:
  - Sonuç: `3 passed (34.6s)` (1 beklenen `test.fail` dahil).
- `test.afterAll` bloğunda oluşturulan site arayüzden silindi; kalan vhost ve auth dosyaları temizlendi.
- Sunucuda `ssh yunpanel-test "ls -la /etc/nginx/sites-enabled/*trun04*"` çalıştırılarak ZERO_RESIDUE (sıfır artık) fiziksel olarak teyit edildi.

### D. Rapor ve Kurallar Uyumu
- `docs/manuel-test/RUN-04.md`: 33 satır (≤40 satır kuralına uygun), şablona tam uyumlu.
- `python3 orkestra/tasks.py lint`: lint OK.
- `npm run lint`: Repository policy validation passed.

---

## 3. Karar Özeti
T155 görevi tüm kabul kriterlerini, sıfır mock ilkesini, fiziksel sunucu doğrulamasını ve temizlik gereksinimlerini eksiksiz karşılamaktadır. Görev ONAYLANMIŞTIR (`accept`).
