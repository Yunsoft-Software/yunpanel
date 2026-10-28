# T182 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T182 · Manuel test: EML-03 — Otomatik yanıt/tatil mesajları
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/EML-03.md`:
  - Satır sayısı kontrolü: 26 satır (kural: <= 40 satır).
  - Tablo formatı ve durumlar standartlara uygun: 1 mutlu yol (geçti), 1 hatalı girdi/sınır durumu (geçti), 1 Plesk Parity kontrolü (bilinen hata / test.fail).
- `e2e/ozellik/eml-03.spec.js`:
  - **Sıfır mock ilkesi:** `page.route` veya sahte API/veri cevabı kesinlikle kullanılmamıştır.
  - **Fiziksel doğrulama:**
    1. Dovecot LMTP Sieve eklentisinin aktifliği (`dovecot -n | grep -i "sieve"`) ve Postfix/Dovecot servislerinin canlı durumu SSH üzerinden doğrulandı.
    2. Mailbox kota/yönlendirme UI akışı ve mevcut posta kutusu detayları canlı web arayüzünde doğrulandı.
    3. Henüz mevcut olmayan `/api/mailboxes/:id/autoresponder` uç noktası için GET ve POST 404 kontrolleri ile fiziksel sunucuda registry dosyasının (`mailbox-autoresponder-registry.json`) bulunmadığı kanıtlandı.
    4. Plesk eşdeğeri Otomatik Yanıtlayıcı (Autoresponder / Out of Office / Vacation) UI eksikliği `test.fail` ile belgelendi.
  - **Temizlik (afterAll):**
    - SQLite (`virtual_mailboxes`) ve JSON registry (`mailbox-registry.json`) üzerinde yalnızca test ön eki (`teml03-...`) ile üretilen kayıtlar hedeflenerek 0 artık ilkesiyle temizlendi.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Eşzamanlı test kilidi alındı: `python3 orkestra/locks.py acquire sunucu-28-1 AGENT_1`
- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=1 npx playwright test e2e/ozellik/eml-03.spec.js`
  - Sonuç: **3 passed (23.5s)** (1 beklenen hata / test.fail, 2 başarılı gerçek akış).
- Kilit serbest bırakıldı: `python3 orkestra/locks.py release sunucu-28-1 AGENT_1`

---

## 3. Kalite Kapıları

- `python3 orkestra/tasks.py lint`: 143 tasks, lint OK.
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`

---

## 4. Karar Özeti

T182 görevi kapsamındaki EML-03 manuel test senaryosu ve raporu, projenin sıfır mock, fiziksel doğrulama, satır sayısı ve kaynak temizliği kurallarına eksiksiz uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
