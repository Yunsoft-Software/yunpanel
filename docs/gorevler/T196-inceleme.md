# T196 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T196 · Manuel test: SYS-01 — IP havuzu, IPv4/IPv6, shared/dedicated ve remap
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/SYS-01.md`:
  - Satır sayısı kontrolü: 27 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular kurala uygun: Mutlu yol (SSH `ip -br a` ile `ens18` ve `157.180.11.28` host tespiti, `/api/panel/servers` ve sunucu detay API'sinde network envanteri tam eşleşmesi), Hatalı girdi & koruma (geçersiz sunucu ID için 404 `local_server_required`, geçersiz IP için 400 `invalid_dns_identity`, yetkisiz istek için 401 koruması), Plesk eşdeğerlik eksikliği (Tools & Settings -> "IP Addresses" arayüzü, Shared/Dedicated IP türü ve IP remap aracı eksikliği; `test.fail` ile işaretli).
- `e2e/ozellik/sys-01.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek panel arayüzü (`/settings?section=dns`, `/tools-settings`), gerçek backend REST API (`/api/panel/servers`, `/api/panel/servers/:id/dns/identity/preview`) ve SSH ile test sunucusunda (`yunpanel-test`) `ip -br a` host ağ kontrolleri ile yazılmıştır. Sahte veri, mock veya stub kesinlikle yoktur.
  - **Fiziksel doğrulama:**
    1. SSH üzerinden host ağ arayüzleri ve atanan IP adresleri tespit edilmiştir.
    2. API'den dönen sunucu network envanterinde IPv4 ve IPv6 adreslerinin fiziksel arayüzle birebir eşleştiği kanıtlanmıştır.
    3. Hatalı girdi ve yetkisiz erişim kontrolleri (400, 401, 404) doğrulanmıştır.
    4. Plesk IP Addresses havuzu ve remap aracı eksikliği `test.fail` ile belgelenmiştir.
  - **Kaynak temizliği:**
    - Test salt okunur durum sorgulamaları ve validasyonlar yürüttüğü için sunucuda hiçbir geçici kaynak oluşturulmamış ve bırakılmamıştır (0 artık).

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=1 npx playwright test e2e/ozellik/sys-01.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 3 tests using 1 worker

    [1/3] …fiziksel ağ arayüzleri ve IPv4/IPv6 adreslerinin tespiti ve API envanteri
    [2/3] …i: geçersiz sunucu ID veya geçersiz IP adresi ile ağ parametresi kontrolü
    [3/3] …sikliği: IP havuzu yönetimi (Shared/Dedicated IP atama ve IP remap aracı)
      3 passed (18.2s)
    ```
  - Sonuç: **3 passed (18.2s)** (1 beklenen `test.fail` Plesk eşdeğerlik bulgusu ile tam uyumlu).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrasında sunucuda ve yerel depoda artık kaynak bırakılmamıştır (0 artık).

---

## 4. Karar Özeti

T196 görevi kapsamındaki SYS-01 test senaryosu ve raporu; sıfır mock, fiziksel SSH doğrulamaları, satır sayısı kuralı (27 <= 40) ve kalite gereksinimlerine tam olarak uymaktadır. Görev ONAYLANMIŞTIR (`accept`).
