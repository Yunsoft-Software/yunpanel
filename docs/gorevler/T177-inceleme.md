# T177 İnceleme Raporu — Manuel test: TLS-03 — Sertifika/anahtar/chain yükleme, CSR ve envanter

İnceleyen: AGENT_3 (Reviewer)  
Tarih: 2026-10-28 12:08  
Yapan: AGENT_2  
Sonuç: KABUL  

---

## 1. İnceleme Özeti
- `tasks/review/T177.md`, `docs/manuel-test/TLS-03.md` ve `e2e/ozellik/tls-03.spec.js` dosyaları detaylı şekilde incelendi.
- `docs/manuel-test/TLS-03.md` satır sayısı kontrol edildi: **35 satır** (<= 40 kuralına tam uyumlu).
- `e2e/ozellik/tls-03.spec.js` senaryosunun test temizleme (afterAll) bloğu sertifika ve Nginx konfigürasyon kayıtlarını tam temizleyecek şekilde pekiştirildi.
- Test sunucusunda (`AGENT_N=3`) çalıştırıldı:
  `AGENT_N=3 npx playwright test e2e/ozellik/tls-03.spec.js --reporter=line`
  Sonuç: **6 passed (1.4m)** (3 geçti, 3 bilinen Plesk eşdeğerlik eksikliği beklenen şekilde `test.fail` ile raporlandı).
- Test sonrası sunucuda kaynak temizliği denetlendi:
  - Aktif alan adları: 0
  - Aktif sertifikalar: 0
  - Kalan Nginx conf dosyası: 0
  - Kalan özel sertifika dizini: 0
- `npm run lint` çalıştırıldı: **Repository policy validation passed.**

## 2. Test Çıktısı
```
Running 6 tests using 1 worker

[1/6] …tifikası yükleme, fiziksel dosya varlığı, API envanteri ve UI doğrulaması
[2/6] …rdi: Uyuşmayan özel anahtar ile özel sertifika yükleme 409 ile reddedilir
[3/6] …alı girdi: Alan adı uyuşmazlığı olan sertifika yükleme 409 ile reddedilir
[4/6] …ksik özellik: Plesk SSL/TLS Certificates eşdeğeri CSR oluşturma sihirbazı
[5/6] …zellik: Plesk eşdeğeri arayüzden Özel Sertifika ve CA Chain yükleme formu
[6/6] …ik: Plesk eşdeğeri Alan adı veya Sunucu genelinde Sertifika Deposu ekranı
  6 passed (1.4m)
```

## 3. Karar
Maker != Reviewer kuralına uygun olarak AGENT_3 tarafından incelenmiş, fiziksel kanıtlar ve 0-artık ilkeleri doğrulanmış olup T177 görevi **KABUL** edilmiştir.
