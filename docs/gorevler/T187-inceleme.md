# T187 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T187 · Manuel test: EML-08 — SMTP/IMAP/POP3 ve TLS port politikası; kurulum bileşenine göre
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/EML-08.md`:
  - Satır sayısı kontrolü: 30 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve durumlar orkestra standartlarına uygun: 1 mutlu yol (geçti), 1 kurulum bileşeni/sınır durumu (geçti), 1 Plesk Parity kontrolü (bilinen hata / test.fail).
- `e2e/ozellik/eml-08.spec.js`:
  - **Sıfır mock ilkesi:** `page.route` veya sahte API/veri cevabı kesinlikle kullanılmamıştır.
  - **Fiziksel doğrulama:**
    1. UI üzerinde `Mail servis bağlantı ve port durumu` bölümü, IMAP (993, 143), SMTP (465, 587, 25) TLS modları ve protokol tablosundaki 5 aktif protokol (Dinliyor) doğrulandı.
    2. İstemci Bağlantı Ayarları modalında IMAP 993 ve SMTP 587 port yönergeleri doğrulandı.
    3. `ss -tulpn` ile Postfix (master) ve Dovecot servislerinin portları dinlediği doğrulandı.
    4. OpenSSL `s_client` ile 5 protokol portunda (25 STARTTLS, 587 STARTTLS, 465 SSL/TLS, 143 STARTTLS, 993 SSL/TLS) TLS v1.3 el sıkışması doğrulandı.
    5. Port 587 üzerinde STARTTLS öncesi düz metin `AUTH LOGIN` komutunun `530 5.7.0 Must issue a STARTTLS command first` ile engellendiği ve Dovecot'ta `disable_plaintext_auth = yes` olduğu SSH ile kanıtlandı.
    6. Kurulum bileşeni gereği `dovecot-pop3d` paketinin kurulu olmadığı, port 110/995 dinleyicisinin bulunmadığı ve TCP bağlantılarının `Connection Refused` döndürdüğü test edildi.
    7. API `/api/panel/servers/:serverId/mail/delivery-diagnostics` üzerinden 5 protokolün `satisfied: true` döndürdüğü ve geçersiz serverId sorgusunun 404 döndürdüğü doğrulandı.
    8. Plesk Mail Server Settings altında SMTP/IMAP/POP3 port özelleştirme ve TLS cipher politikası seçici arayüzü eksikliği `test.fail` ile belgelendi.
  - **Temizlik (afterAll):**
    - SQLite (`virtual_mailboxes`) ve JSON registry (`mailbox-registry.json`) üzerinde test öneki (`teml08-...`) temizliği yapıldı.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=1 npx playwright test e2e/ozellik/eml-08.spec.js --output test-results-agent1 --reporter=line`
  - Sonuç: **3 passed (37.4s)** (1 beklenen hata / test.fail, 2 başarılı gerçek akış).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrası SQLite ve dosya sisteminde artık kaynak kalmadığı doğrulandı (0 artık).

---

## 4. Karar Özeti

T187 görevi kapsamındaki EML-08 manuel test senaryosu ve raporu, projenin sıfır mock, fiziksel SSH doğrulaması, satır sayısı limitleri (30 <= 40) ve kaynak temizliği kurallarına eksiksiz uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
