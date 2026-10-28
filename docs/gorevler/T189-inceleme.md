# T189 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T189 · Manuel test: EML-10 — Giden posta limitleri, kuyruk ve teslimat tanılama
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/EML-10.md`:
  - Satır sayısı kontrolü: 31 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular kurala uygun: 2 başarılı senaryo (mutlu yol, hatalı girdi), 2 beklenen eksiklik/hata (BULGU EML-10-A, BULGU EML-10-B; test.fail).
- `e2e/ozellik/eml-10.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek veritabanı, gerçek panel arayüzü ve gerçek API/SSH servisleri üzerinde çalışmaktadır; sahte veri veya mock bulunmamaktadır.
  - **Fiziksel doğrulama:**
    1. UI üzerinde Teslimat Takibi, Postfix Mail Queue, Servis Logları, Servis Teslimat Doğrulama Testi ve Mail Servis Bağlantı panelleri test edilmiştir.
    2. SSH üzerinden `postqueue -p` çıktısı fiziksel olarak kontrol edilmiştir.
    3. API uç noktaları (`/api/panel/mail-domains/:id/queue`, `/api/panel/mail-domains/:id/delivery-logs`, `/api/panel/mail-domains/:id/delivery-tracking`) gerçek verilerle doğrulanmıştır.
    4. Sınır aşımı (limit > 200, geçersiz ISO, 100+ karakter ara) ve olmayan domain (404) senaryoları doğrulanmıştır.
    5. journalctl `--since` ve `--cursor` çakışması (BULGU EML-10-A) ve Plesk Outbound Mail Control / Flush-Delete queue eksikliği (BULGU EML-10-B) `test.fail` ile belgelenmiştir.
  - **Temizlik (afterAll):**
    - SQLite (`virtual_mailboxes`) ve JSON registry (`mailbox-registry.json`) üzerinde test öneki (`teml10-...`) temizliği eksiksiz yapılmıştır.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=3 npx playwright test e2e/ozellik/eml-10.spec.js --reporter=line`
  - Sonuç: **4 passed (25.7s)** (2 test.fail beklenen bulgu, 2 başarılı gerçek akış).
  - Kararlılık teyidi: Test ardışık olarak ikinci kez koşturuldu: **4 passed (50.0s)**.

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrasında sunucu üzerinde (`virtual-mail.sqlite3` ve `mailbox-registry.json`) artık test kaydı kalmadığı doğrulandı (0 artık).

---

## 4. Karar Özeti

T189 görevi kapsamındaki EML-10 test senaryosu ve raporu, projenin sıfır mock, fiziksel SSH doğrulaması, satır sayısı limitleri (31 <= 40) ve kaynak temizliği kurallarına eksiksiz uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
