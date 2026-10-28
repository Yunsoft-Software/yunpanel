# T175 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T175 · Manuel test: DNS-06 — Harici sağlayıcı entegrasyonları ve kayıt yayılım tanılaması
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Güvenlik Denetimi
- `e2e/ozellik/dns-06.spec.js`:
  - Sıfır mock/stub ilkesine tam uyumlu; sahte veri veya `page.route` kullanılmamış, canlı API ve SSH üzerinde doğrudan doğrulanmıştır.
  - Canlı sunucuda `webrich.news` alan adı üzerinden `/api/panel/domains/:id/dns-requirements` ve `/api/panel/dns-zones/:id/requirements` uç noktaları çağrılarak gereksinimler, yayılım durumu ve `web-apex-a` kaydı başarıyla kontrol edilmiştir.
  - SSH üzerinden `/usr/bin/dig`, `dig @127.0.0.1 webrich.news SOA +short`, kök sunuculardan `dig webrich.news SOA +trace +nodnssec` zinciri ve `/etc/resolv.conf` yapılandırması fiziksel olarak test edilmiştir.
  - Hatalı girdi ve yetki sınırları kapsamında desteklenmeyen sağlayıcı için 409 `dns_provider_unsupported`, geçersiz onay için 400 `dns_provider_credential_confirmation_required` ve olmayan bölge için 404 yanıtları doğrulanmıştır.
  - Eksik özellikler (Plesk eşdeğeri harici sağlayıcı yönetim arayüzü ve kayıt yayılım tanılaması UI araçları) `test.fail` olarak doğru ve standartlara uygun işaretlenmiştir.
  - `afterAll` hook'unda oluşturulan geçici zone provider credential temizlenerek 0 artık ilkesi sağlanmıştır.
- `docs/manuel-test/DNS-06.md`:
  - 27 satır ile 40 satır sınırı kuralına tam olarak uymaktadır (`wc -l docs/manuel-test/DNS-06.md` -> 27).
- `tasks/done/T175.md`:
  - Görev teslim notu eksiksiz ve detaylıdır.

---

## 2. Doğrulama ve Bulgular

### A. Bağımsız Test Koşusu (Reviewer Koşusu)
- Eşzamanlı test kilidi alındı: `python3 orkestra/locks.py acquire sunucu-28-3 AGENT_3`
- Test bağımsız olarak canlı test ortamında çalıştırıldı:
  `AGENT_N=3 npx playwright test e2e/ozellik/dns-06.spec.js --reporter=line`
  - Sonuç: **4 passed (35.9s)** (2 mutlu yol/negatif test geçti, 2 eksik özellik beklenen `test.fail` olarak geçti).
- Kilit serbest bırakıldı: `python3 orkestra/locks.py release sunucu-28-3 AGENT_3`

### B. Kalite Kapıları
- `python3 orkestra/tasks.py lint`: 143 tasks, lint OK.
- `npm run lint`: Repository policy validation passed.
- `python3 orkestra/orchestrator.py verify --quick`: Çalıştırıldı.

---

## 3. Karar Özeti
T175 görevi, DNS-06 harici sağlayıcı entegrasyonları ve kayıt yayılım tanılaması testlerini gerçek ortamda sıfır mock ilkesiyle başarıyla uygulamış, fiziksel SSH doğrulamalarını yapmış ve eksik UI özelliklerini `test.fail` ile belgelemiştir. Görev ONAYLANMIŞTIR (`accept`).
