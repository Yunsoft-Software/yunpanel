# T813 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T813 · Doğrulama: site log testlerinin sabit tarihi son 24 saat aralığının dışında kalıyor
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Değişiklikler
- `apps/api/test/website-site-logs.test.js`:
  - Sabit tarih dizesi (`[27/Oct/2026:10:00:0${n} +0300]`) yerine dinamik UTC Nginx formatında log tarihi üreten `formatNginxAccessDate(date)` fonksiyonu eklendi.
  - `line(host, n, date)` log satırı üreteci, varsayılan olarak `Date.now() - (60_000 * n)` kullanarak son dakikalara ait dinamik zaman damgası oluşturacak şekilde güncellendi.
  - Test 1 (`a customer reads only the access log of their own site, never the server-wide nginx log`):
    - 48 saat öncesine ait log kaydı (`oldDate`) ve 1 dakika öncesine ait log kaydı (`recentDate`) oluşturuldu.
    - Varsayılan 24 saatlik aralıkta eski kaydın filtrelendiği ve sadece güncel kaydın döndüğü doğrulandı.
    - Açık `since` ve `until` parametreleriyle sorgulandığında 24 saatin dışındaki geçmiş kaydın da başarıyla erişilebildiği doğrulandı.
  - Test 2 (`the served hostname decides the file: a preferred www name reads www.<domain>.access.log`):
    - `since` ve `until` ISO aralığı ile log sorgusu yapılarak zaman kayması riskinden bağımsız kararlılık sağlandı.
- `tasks/review/T813.md`: Yapılan çalışmalar ve test kanıtları raporlandı.

---

## 2. Doğrulama ve Bulgular

### A. Sıfır Mock ve Test Bütünlüğü Kontrolü
- Yapılan değişikliklerde hiçbir mock, stub veya sahte yanıt/servis kullanılmamıştır.
- Gerçek geçici dizinler (`mkdtemp`), gerçek log dosyaları (`writeFile`) ve API test sunucusu (`f.get`) üzerinden uçtan uca doğrulanmıştır.
- Ürün kodundaki varsayılan 24 saatlik log penceresi gevşetilmemiş veya kaldırılmamıştır.

### B. Bağımsız Test Koşusu
- Test bizzat çalıştırıldı:
  `npm test --workspace @yunpanel/api apps/api/test/website-site-logs.test.js`
  - Sonuç: 5 passed, 0 failed (5.49s).

### C. Kalite Kapıları
- `python3 orkestra/tasks.py lint`: lint OK.
- `python3 orkestra/orchestrator.py verify --quick`: Doğrulandı.

---

## 3. Karar Özeti
T813 görevi, zaman kaymasından kaynaklı kırılganlığı ürünü bozmadan, test beklentisini gevşetmeden ve sıfır mock ilkesine sadık kalarak gidermiştir. Görev ONAYLANMIŞTIR (`accept`).
