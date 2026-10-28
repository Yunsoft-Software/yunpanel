# T174 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_3
- **İncelenen Görev:** T174 · Manuel test: DNS-05 — Zone transfer yetkileri ve secondary doğrulama
- **Yapan:** AGENT_4
- **Karar:** ONAY (ACCEPT)

---

## 1. Teslim Edilen İş ve Değişiklikler
- `e2e/ozellik/dns-05.spec.js`:
  - Panel üzerinden DNS ayarları (`/settings?section=dns`) ve "Secondary transfer targets" yapılandırması doğrulandı.
  - Fiziksel PowerDNS doğrulaması:
    - Yetkili loopback IP'si (`127.0.0.1`) üzerinden `dig @127.0.0.1 AXFR webrich.news` sorgusu ile tam zone transferinin (SOA, NS, A) başarıyla çalıştığı ve transfer çıktısının geçerliliği SSH ile teyit edildi.
    - Dış IP (`157.180.11.28`) üzerinden `dig @157.180.11.28 -b 157.180.11.28 AXFR webrich.news` sorgusunun `Transfer failed` ile engellendiği ve PowerDNS journal logunda `denied: client IP has no permission` kaydı oluşturduğu fiziksel kanıtla doğrulandı.
  - Secondary DNS uç noktası ve sınır durum testleri:
    - `/api/panel/domains/:domainId/dns/secondary` endpoint'i ve sağlık durumu doğrulandı.
    - Alt alan adında secondary DNS sorgulanmasının 409 `dns_secondary_root_domain_required` hatası döndürdüğü teyit edildi.
    - Geçersiz domain ID sorgusunda 404/400 dönüldüğü doğrulandı.
  - Plesk eşdeğerliği: Domain bazında "Zone Transfers" ACL ve Secondary/Slave Zone yönetim arayüzü eksikliği `test.fail` ile işaretlendi.
- `docs/manuel-test/DNS-05.md`: 26 satır (kural <= 40 satır) özet rapor oluşturuldu.
- `tasks/review/T174.md`: Teslim özeti ve test çıktıları güncellendi.

---

## 2. Doğrulama ve Bulgular

### A. Sıfır Mock ve Kural Kontrolleri
- `e2e/ozellik/dns-05.spec.js` içinde hiçbir `page.route`, mock data veya sahte yanıt kullanılmamıştır. Tamamen canlı `.28` test sunucusu ve gerçek PowerDNS servisi üzerinde test edilmiştir.
- `docs/manuel-test/DNS-05.md` satır sayısı 26'dır (40 satır sınırını aşmamaktadır).
- Test kalıcı artık bırakmamakta (0 artık ilkesi sağlanmıştır).

### B. Bağımsız Test Koşusu
- Kilit alındı: `python3 orkestra/locks.py acquire sunucu-28-3 AGENT_3`
- Playwright testi bizzat bağımsız olarak çalıştırıldı:
  `AGENT_N=3 npx playwright test e2e/ozellik/dns-05.spec.js`
  - Sonuç: 3 passed (1 test.fail), 34.3s.
- Kilit bırakıldı: `python3 orkestra/locks.py release sunucu-28-3 AGENT_3`
- Birim testleri doğrulandı:
  `node --test packages/config-templates/test/powerdns.test.js packages/host-runtime/test/dns-secondary-sync-inspector.test.js apps/api/test/dns-zone-secondary-status.test.js`
  - Sonuç: 13 pass, 0 fail.

### C. Kalite Kapıları
- `npm run lint`: Repository policy validation passed.
- `python3 orkestra/tasks.py lint`: lint OK.
- `python3 orkestra/orchestrator.py verify --quick`: Çalıştırıldı.

---

## 3. Karar Özeti
T174 görevi gereksinimleri eksiksiz karşılamaktadır. Gerçek ortamda PowerDNS zone transfer yetkileri (loopback izinli, dış IP engelli) ve Secondary DNS API/UI kontrolleri sıfır mock ilkesiyle doğrulanmıştır. Görev ONAYLANMIŞTIR (`accept`).
