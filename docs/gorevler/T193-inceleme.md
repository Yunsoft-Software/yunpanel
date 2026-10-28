# T193 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_1
- **İncelenen Görev:** T193 · Manuel test: SEC-01 — Firewall aç/kapat, kurallar, portlar ve güvenli geri dönüş
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Uyumluluk Denetimi

- `docs/manuel-test/SEC-01.md`:
  - Satır sayısı kontrolü: 25 satır (kural: <= 40 satır; tam uyumlu).
  - Tablo formatı ve bulgular eksiksiz: Mutlu yol (status, ports, SSH 22, port ekleme/silme, preview impact & candidateSha256, nftables/ufw kanıtı), Hatalı girdi ve güvenlik kısıtları (400 invalid_port, 400 invalid_cidr, lockout_risk_detected, unauthorized_test_target), UI bulgusu (`firewall-client.js` `/api/panel/` öneki eksikliği; `test.fail` ile işaretli).
- `e2e/ozellik/sec-01.spec.js`:
  - **Sıfır mock ilkesi:** Gerçek panel web arayüzü, gerçek backend REST API (`/api/panel/firewall/*`), canlı test sunucusu (`yunpanel-test`) ve fiziksel nftables / UFW kurallarıyla doğrulanmıştır. Mock/stub veri kullanılmamıştır.
  - **Fiziksel doğrulama:**
    1. UI üzerinde `FirewallPage` bileşeni, başlık, durum ve servis profili kartları DOM seviyesinde doğrulanmıştır.
    2. API (`/api/panel/firewall/status` ve `/api/panel/firewall/ports`) üzerinden sistem durumu ve SSH (port 22 TCP) kuralının aktifliği doğrulanmıştır.
    3. Zararsız dinamik test portu (49200-49600) eklenmiş, güvenli önizleme (`/api/panel/firewall/preview`) ile etki analizi ve candidateSha256 nesneleri doğrulanmış, eklenen kural başarıyla silinmiştir.
    4. Sunucu üzerinde fiziksel nftables kural zinciri (`sudo nft list ruleset | grep -c "chain"`) ve UFW durumu (`sudo ufw status`) SSH ile kanıtlanmıştır.
    5. Hatalı girdi ve güvenlik sınırları: 400 `invalid_port` (99999), 400 `invalid_cidr`, pasif profilde mail portu ekleme engeli (`service_profile_inactive`), SSH portunu silme koruması (`lockout_risk_detected`), yetkisiz Plesk (.44) hedefinde tarama engeli (`unauthorized_test_target`) başarıyla test edilmiştir.
    6. UI Bulgu Tespiti: `firewall-client.js` API yollarında `/api/panel/` önekinin eksik olması nedeniyle web reverse proxy'nin 404 dönmesi `test.fail` ile raporlanmıştır.
  - **Kaynak temizliği:**
    - `afterAll` hook'unda eklenmiş olabilecek test port kuralı temizlenmiş; sunucu üzerinde yapılan nftables taramasında hiçbir artık test portu kalmadığı doğrulanmıştır.

---

## 2. Bağımsız Test Koşusu (Reviewer Koşusu)

- Test bağımsız olarak gerçek `.28` test sunucusunda çalıştırıldı:
  `AGENT_N=1 npx playwright test e2e/ozellik/sec-01.spec.js --reporter=line`
  - Çıktı:
    ```
    Running 3 tests using 1 worker

    [1/3] … UI Görünümü ve Arayüz Yükleme: FirewallPage bileşeni ve API entegrasyonu
    [2/3] …steleme, zararsız özel test port kuralı ekleme/silme ve rollback önizleme
    [3/3] …rt, geçersiz CIDR, yetkisiz tarama, profil koruması ve SSH kilit koruması
      3 passed (26.0s)
    ```
  - Sonuç: **3 passed (26.0s)** (1 beklenen `test.fail` UI bulgusu, 2 başarılı akış).

---

## 3. Kalite Kapıları ve Kaynak Kontrolü

- `npm run lint`: Repository policy validation passed.
- Kaynak kontrolü: Test sonrasında sunucuda ve yerel depoda artık kaynak kalmamıştır (0 artık).

---

## 4. Karar Özeti

T193 görevi kapsamındaki SEC-01 test senaryosu ve raporu; sıfır mock ilkesine, gerçek sunucu ve nftables/ufw doğrulamalarına, satır sayısı kuralına (25 <= 40) ve kalite standartlarına tam uyumludur. Görev ONAYLANMIŞTIR (`accept`).
