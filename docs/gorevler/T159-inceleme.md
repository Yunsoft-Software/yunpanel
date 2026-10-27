# T159 İnceleme Notu — DEV-02 Branch, deployment path, manuel/otomatik deployment

- **İnceleyen:** AGENT_1 (Bağımsız Denetçi / Reviewer)
- **Maker:** AGENT_4
- **Tarih:** 2026-10-27
- **Karar:** KABUL (ACCEPTED)

## 1. İnceleme Kriterleri & Kontroller
- **Satır Sayısı Kontrolü:** `docs/manuel-test/DEV-02.md` dosyası 31 satır (<= 40 satır kuralı sağlandı).
- **Sıfır Mock İlkesi:** `e2e/ozellik/dev-02.spec.js` içerisinde hiçbir mock/sahte veri (`page.route` vb.) kullanılmamış; test tamamen gerçek UI akışları ve backend API üzerinde koşmaktadır.
- **Fiziksel Doğrulama:** 
  - Git deposu (`https://github.com/heroku/node-js-getting-started.git`) ile site oluşturma,
  - Git / Yayın sekmesinde repo/dal bilgileri ve Manuel deploy butonu tetiklemesi,
  - Git Webhook Endpoint ve `refs/heads/main` tetikleyici bilgisi ile URL kopyalama butonu,
  - Doğrudan HTTP isteği (`checkDirectHttp` ile 157.180.11.28'e Host header gönderimi),
  - SSH üzerinden `/etc/nginx/sites-enabled/` vhost konfigürasyonunun fiziksel varlığı doğrulandı.
- **Hatalı Girdi / Sınır Senaryosu:** Boş repository alanı ile devam etme girişiminde tarayıcı native form validasyonu (`checkValidity() === false`) ve Adım 3'e geçiş engeli teyit edildi.
- **Plesk Eşdeğerlik Eksiklikleri:** Dal değiştirme (Switch Branch), dağıtım yolu düzenleme (Deployment Path editor) ve dağıtım modu seçimi (Deployment Mode toggle) arayüzde bulunmadığı için `test.fail` olarak doğru şekilde işaretlenmiş.
- **Temizlik (Sıfır Artık):** `test.afterAll` hook'unda oluşturulan site arayüzden ve SSH ile Nginx sites-enabled dizininden tamamen temizlendi. Test sonrası sunucuda hiçbir kalıntı bulunmadığı SSH komutuyla teyit edildi.

## 2. Test Kanıtı (AGENT_1 Bağımsız Koşusu)
```
$ AGENT_N=1 npx playwright test e2e/ozellik/dev-02.spec.js
Running 5 tests using 1 worker

  ✓  1 …erini doğrula, manuel deploy tetikle ve webhook arayüzünü incele (22.7s)
  ✓  2 …Form doğrulamasında boş GitHub repository ile ilerleme engellenir (4.9s)
  ✘  3 …irme (Switch Branch) ve depodaki dalları seçme arayüzü bulunmuyor (8.5s)
  ✘  4 …(Deployment Path / Target Directory) düzenleme arayüzü bulunmuyor (8.7s)
  ✘  5 …u (Otomatik vs Manuel Dağıtım / Webhook toggle) seçimi bulunmuyor (7.9s)
  5 passed (60.0s)
```

## 3. Kalite Kapıları
- `python3 orkestra/tasks.py lint`: OK (136 tasks)
- `npm run lint`: OK (Repository policy validation passed)
- Sıfır artık doğrulaması: SSH ile `ls -la /etc/nginx/sites-enabled/ | grep tdev02` çıktısı boş.

## Sonuç
T159 görevi gereksinimleri eksiksiz karşılamaktadır. Görev kabul edilmiş ve `done` durumuna geçirilmiştir.
