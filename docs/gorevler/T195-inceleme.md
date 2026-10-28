# T195 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T195 · Manuel test: SEC-03 — ModSecurity/WAF policy, ruleset ve domain istisnaları
- **Yapan:** AGENT_2
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/SEC-03.md`:
  - Satır sayısı kontrolü: 25 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular kurala uygun: Mutlu yol (Plesk eşdeğeri ModSecurity / WAF arayüzü ve `/api/panel/websites/:id/waf` uç noktası yok; `test.fail` ile işaretli), Hatalı girdi & koruma (geçersiz mod ve geçersiz kural ID formatı doğrulama eksikliği; `test.fail` ile işaretli), Fiziksel kanıt (test sunucusunda Nginx ModSecurity paketi ve `/etc/nginx/modsec/` kural dizini yok; `test.fail` ile işaretli).
- `e2e/ozellik/sec-03.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek panel arayüzü (`/websites/:id`), gerçek backend REST API (`/api/panel/websites/:id/waf`), ve SSH ile test sunucusunda (`yunpanel-test`) gerçek Nginx ModSecurity modülü/paket/dizin kontrolleri ile yazılmıştır. Sahte veri, mock veya stub kesinlikle yoktur.
  - **Fiziksel doğrulama:**
    1. UI üzerinde ilgili web sitesinin detay sayfası ziyaret edilmiş, Plesk eşdeğeri ModSecurity/WAF kartı/sekmesi denetlenmiştir.
    2. API (`/api/panel/websites/:id/waf`) sorgulanmış, rotanın mevcut olmadığı (404/405) ve arayüzde kartın bulunmadığı Plesk eşdeğerlik eksikliği olarak `test.fail` ile belgelenmiştir.
    3. Hatalı girdi & koruma: Geçersiz WAF modu (`invalid_mode_bypass`) ve geçersiz kural ID parametrelerinin reddi test edilmiş, API rotası yokluğu `test.fail` ile belgelenmiştir.
    4. Test sunucusunda SSH ile `libnginx-mod-http-modsecurity`, `nginx -V` modsecurity derleme/modül parametresi ve `/etc/nginx/modsec/` ya da `/etc/modsecurity/` kural dizinlerinin varlığı fiziksel olarak denetlenmiş; eksiklik `test.fail` ile kanıtlanmıştır.
  - **Kaynak temizliği:**
    - `afterAll` hook'unda test sırasında eklenebilecek geçici kayıtların temizliği için güvenli temizlik mekanizması eklenmiştir. Test salt okunur denetim yaptığı için sunucuda artık kaynak bırakılmamıştır (0 artık).

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=3 npx playwright test e2e/ozellik/sec-03.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 3 tests using 1 worker

    [1/3] …Security / WAF politikaları, kural setleri ve domain istisnaları yönetimi
    [2/3] …z WAF modu veya hatalı kural ID parametreleri reddedilir (400 validation)
    [3/3] … kanıt: test sunucusunda Nginx ModSecurity modülü ve kural dizini varlığı
      3 passed (23.9s)
    ```
  - Sonuç: **3 passed (23.9s)** (3 beklenen `test.fail` bulgusu ile tam uyumlu).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrasında sunucuda ve yerel depoda artık kaynak bırakılmamıştır (0 artık).

---

## 4. Karar Özeti

T195 görevi kapsamındaki SEC-03 test senaryosu ve raporu; sıfır mock, fiziksel SSH doğrulamaları, satır sayısı kuralı (25 <= 40) ve kalite gereksinimlerine tam olarak uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
