# Mail Discovery (Autodiscover & Autoconfig) Live Acceptance (.28 Test Sunucusu)

- **Tarih**: 2026-09-21
- **Hedef Sunucu**: `157.180.11.28` (hostname: `test`, `YUNPANEL_LOCAL_SERVER_ID: 99bc760a-d508-4ae6-92be-efdedee9658d`)
- **İlgili Görev**: `T-MAIL` — HTTPS Autodiscover ve Autoconfig Uç Noktaları ve DNS Discovery Doğrulaması
- **Test Scripti**: `.local/verify-mail-discovery-live-acceptance.mjs`

---

## 1. Kapsam ve Doğrulanan Güvenlik Kontratları

1. **HTTPS Autoconfig Endpoint'leri**:
   - `GET https://mailtest.webrich.news/mail/config-v1.1.xml?emailaddress=test@mailtest.webrich.news` sorgulandı; geçerli Mozilla/Thunderbird `clientConfig` XML'i (sürüm 1.1) döndüğü doğrulandı:
     - Gelen sunucu (IMAP): `cryptoraichu.website`, port `143`, `STARTTLS`, kullanıcı adı `test@mailtest.webrich.news`.
     - Giden sunucu (SMTP): `cryptoraichu.website`, port `587`, `STARTTLS`, kullanıcı adı `test@mailtest.webrich.news`.
   - `GET https://mailtest.webrich.news/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=test@mailtest.webrich.news` sorgulandı; aynı geçerli `clientConfig` XML'inin döndüğü teyit edildi.

2. **HTTPS Autodiscover Endpoint'i**:
   - `POST https://mailtest.webrich.news/autodiscover/autodiscover.xml` adresine standart Microsoft Outlook XML isteği iletildi; geçerli Autodiscover yanıtı döndüğü doğrulandı:
     - Hesap türü: `email`.
     - Protokoller: IMAP (`cryptoraichu.website:143`, TLS, LoginName `test@mailtest.webrich.news`) ve SMTP (`cryptoraichu.website:587`, TLS, LoginName `test@mailtest.webrich.news`).

3. **Failure Injection ve Fail-Closed Davranış**:
   - `/autodiscover/autodiscover.xml` adresine GET yapıldığında 405 Method Not Allowed döndü.
   - Bozuk/geçersiz XML gövdesi iletildiğinde 400 Bad Request döndü.
   - `/mail/config-v1.1.xml` adresine `emailaddress` parametresi verilmediğinde 400 Bad Request döndü.

4. **PowerDNS Discovery Kayıtları**:
   - `mailtest.webrich.news` yetkili alan adı bölgesi kontrol edildi; istemci keşif SRV kayıtlarının (`_imap._tcp.mailtest.webrich.news 300 IN SRV 0 1 143 cryptoraichu.website.`, `_submission._tcp.mailtest.webrich.news 300 IN SRV 0 1 587 cryptoraichu.website.`), MX (`10 cryptoraichu.website.`), SPF (`v=spf1 mx -all`), DMARC (`v=DMARC1; p=none`) ve DKIM kayıtlarının kaynak etiketli (`source: 'mail'`) ve eksiksiz mevcut olduğu doğrulandı.

5. **Soket İzolasyonu ve İzinler**:
   - `/run/yunpanel-mail-discovery/discovery.sock` Unix domain soketi `root:www-data` sahipliğinde `0660` moduyla ve dizini `0750` moduyla izole çalışmaktadır.
