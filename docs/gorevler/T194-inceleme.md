# T194 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T194 · Manuel test: SEC-02 — IP erişim kısıtları, brute-force koruması ve ban/unban
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/SEC-02.md`:
  - Satır sayısı kontrolü: 26 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular kurala uygun: Mutlu yol (Sunucuda cscli/fail2ban kurulu değil, IP ban motoru fiziksel olarak aktifleşemiyor; `test.fail` ile işaretli), Hatalı girdi (HTML5 required denetimi, arayüz hata kutusu, API 400 invalid_ip ve missing_ip; geçti), Fiziksel kanıt (test sunucusunda aktif crowdsec/fail2ban servisi yok; `test.fail` ile işaretli).
- `e2e/ozellik/sec-02.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek panel arayüzü (`/firewall`), gerçek backend REST API (`/api/panel/firewall/bans`), ve SSH ile test sunucusunda (`yunpanel-test`) gerçek servis durumları (`systemctl is-active crowdsec/fail2ban/crowdsec-firewall-bouncer`) ve `cscli` kontrolleri ile yazılmıştır. Sahte veri, mock veya stub kesinlikle yoktur.
  - **Fiziksel doğrulama:**
    1. UI üzerinde Güvenlik Duvarı sayfası ziyaret edilmiş, CrowdSec Tehdit ve Ban Yönetimi bölümü, form alanları ve tablo başlıkları denetlenmiştir.
    2. Canlı sunucuda `cscli` kurulu olmaması durumu `test.fail` ile belgelenmiştir.
    3. Hatalı girdi: Boş formda HTML5 required kontrolü, geçersiz IP (`999.999.999.999`) girişinde ekranda hata kutusu, API düzeyinde ise 400 `invalid_ip` ve 400 `missing_ip` durum kodları test edilip geçmiştir.
    4. Test sunucusunda SSH ile `crowdsec`, `crowdsec-firewall-bouncer` ve `fail2ban` servislerinin durumu fiziksel olarak denetlenmiş; eksiklik `test.fail` ile kanıtlanmıştır.
  - **Kaynak temizliği:**
    - RFC 5737 güvenli test IP'si (`198.51.100.7X`) kullanılmış ve `afterAll` hook'unda olası kararların temizliği sağlanmıştır (0 artık).

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=1 npx playwright test e2e/ozellik/sec-02.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 3 tests using 1 worker

    [1/3] …en CrowdSec ban yönetimi alanı görüntülenir ve ban/unban akışı doğrulanır
    [2/3] …n/unban › hatalı girdi: geçersiz IP formatı ve eksik parametre reddedilir
    [3/3] …sel kanıt: sistem güvenlik servisi ve brute-force bouncer durumu denetimi
      3 passed (32.5s)
    ```
  - Sonuç: **3 passed (32.5s)** (2 beklenen `test.fail` bulgusu ile tam uyumlu).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrasında sunucuda ve yerel depoda artık kaynak bırakılmamıştır (0 artık).

---

## 4. Karar Özeti

T194 görevi kapsamındaki SEC-02 test senaryosu ve raporu; sıfır mock, fiziksel SSH doğrulamaları, satır sayısı kuralı (26 <= 40) ve kalite gereksinimlerine tam olarak uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
