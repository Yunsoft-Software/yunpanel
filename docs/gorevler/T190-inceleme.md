# T190 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T190 · Manuel test: EML-11 — Mail servisi sertifikası ve hostname/SNI davranışı
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/EML-11.md`:
  - Satır sayısı kontrolü: 30 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular kurala uygun: Mutlu yol (GET /api/panel/mail-service-identity 200 + OpenSSL port 465 & 993 CN=mail.webrich.news), Hatalı girdi & koruma (PUT 404, 409, 400), Plesk Parity eksikliği (Postfix `tls_server_sni_maps` ve Dovecot `local_name` SNI haritaları yok; `test.fail` ile işaretli).
- `e2e/ozellik/eml-11.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek panel arayüzü, gerçek backend REST API, fiziksel Postfix/Dovecot konfigürasyonları ve gerçek OpenSSL TLS el sıkışmaları (port 465 SMTP, port 993 IMAPS) ile doğrulanmıştır. Sahte veri veya stub kesinlikle yoktur.
  - **Fiziksel doğrulama:**
    1. UI üzerinde ilgili alan adının SSL sertifikası görünümü ve sertifika bilgileri doğrulanmıştır.
    2. API (`/api/panel/mail-service-identity`) üzerinden hostname (`mail.webrich.news`), `ready: true` ve `blockers: []` doğrulanmıştır.
    3. SSH üzerinden Postfix (`postconf smtpd_tls_cert_file smtpd_tls_key_file myhostname`) ve Dovecot (`/etc/dovecot/conf.d/99-yunpanel-mail.conf`) sertifika parametreleri kontrol edilmiştir.
    4. Fiziksel OpenSSL ile port 465 ve port 993 TLS el sıkışması yapılarak `CN = mail.webrich.news` ve `Let's Encrypt` sertifikası kanıtlanmıştır.
    5. Hatalı girdi & koruma: 404 domain_not_found, 409 mail_service_identity_revision_conflict ve 400 bad input test edilmiştir.
    6. Plesk Parity: Çoklu domain Mail SNI (Postfix `tls_server_sni_maps` ve Dovecot `local_name`) eksikliği `test.fail` ile belgelenmiştir.
  - **Kaynak temizliği:**
    - Salt-okunur durum tespiti ve mevcut sertifika doğrulaması yapıldığı için sunucuda geçici test kaynağı oluşturulmamıştır.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=1 npx playwright test e2e/ozellik/eml-11.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 3 tests using 1 worker

    [1/3] …ix ve Dovecot TLS yapılandırması ve fiziksel SMTP/IMAP TLS el sıkışmaları
    [2/3] …oruma: geçersiz kimlik, uyuşmayan domain ve revizyon çakışması reddedilir
    [3/3] …ika haritası (Postfix tls_server_sni_maps & Dovecot local_name) eksikliği
      3 passed (21.6s)
    ```
  - Sonuç: **3 passed (21.6s)** (1 beklenen `test.fail` bulgusu, 2 başarılı fiziksel akış).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrasında sunucuda ve yerel depoda artık kaynak bırakılmamıştır (0 artık).

---

## 4. Karar Özeti

T190 görevi kapsamındaki EML-11 test senaryosu ve raporu; sıfır mock, fiziksel OpenSSL ve SSH doğrulamaları, satır sayısı kuralı (30 <= 40) ve kalite gereksinimlerine tam olarak uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
