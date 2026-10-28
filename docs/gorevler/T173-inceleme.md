# T173 İnceleme Notu — Manuel test: DNS-04 — DNSSEC anahtar/DS/rollover ve güvenli kapatma

- **İnceleyen:** AGENT_4 (Bağımsız Denetçi)
- **Geliştirici (Maker):** AGENT_3
- **Tarih:** 2026-10-28
- **Karar:** KABUL (ACCEPTED)

---

## 1. Kod ve Kapsam İncelemesi
- **Satır Sayısı Kontrolü:** `docs/manuel-test/DNS-04.md` dosyası 26 satırdır (<= 40 kuralı sağlandı).
- **Sıfır Mock İlkesi:** `e2e/ozellik/dns-04.spec.js` içerisinde `page.route`, sahte yanıt veya taklit veri kullanılmadığı, tamamen gerçek tarayıcı ve sunucu ortamında çalıştığı doğrulandı.
- **Fiziksel Doğrulama:**
  - DNSSEC imzalama, KSK/ZSK üretimi arayüzde ve PowerDNS'te (`pdnsutil show-zone`, `dig @127.0.0.1 DNSKEY`) doğrulandı.
  - Registrar DS formatı (`<Key Tag> <Algorithm> <Digest Type> <Digest>`) regex ile teyit edildi.
  - Güvenli kapatma (Unsign zone) akışı arayüz onay modalı üzerinden işletilip PowerDNS'te zone'un unsigned olduğu doğrulandı.
  - Subdomain izolasyonu (DNSSEC kartı gösterilmemesi ve API 409 reddi) kontrol edildi.
  - Plesk eşdeğeri UI rollover eksikliği `test.fail` olarak doğru şekilde raporlandı.
- **Sıfır Artık / Temizlik:** `beforeAll` ve `afterAll` hook'larında DNSSEC'in devredışı bırakılması, operasyon kayıtlarının sıfırlanması ve servis yeniden başlatılması ile sunucuda artık bırakılmadığı teyit edildi.

---

## 2. Doğrulama ve Test Kanıtı
Kilit alınarak (`python3 orkestra/locks.py acquire sunucu-28-4 AGENT_4`) test bizzat koşturuldu:
```bash
AGENT_N=4 npx playwright test e2e/ozellik/dns-04.spec.js
```

Çıktı özeti:
```
Running 3 tests using 1 worker

     1 …i, fiziksel PowerDNS/DNSKEY doğrulaması ve güvenli kapatma (Unsign zone)
No keys for zone 'webrich.news'.
  ✓  1 …sel PowerDNS/DNSKEY doğrulaması ve güvenli kapatma (Unsign zone) (18.4s)
     2 …omain) bağımsız DNSSEC paneli sunulmaz ve API seviyesinde 409 reddedilir
  ✓  2 …bağımsız DNSSEC paneli sunulmaz ve API seviyesinde 409 reddedilir (4.8s)
     3 …(Key Rollover): UI üzerinden KSK/ZSK rollover başlatma yeteneği kontrolü
  ✘  3 …lover): UI üzerinden KSK/ZSK rollover başlatma yeteneği kontrolü (12.6s)
  3 passed (40.1s)
```

Kalite kapıları:
- `python3 orkestra/tasks.py lint`: OK (140 tasks, lint OK)
- `npm run lint`: Repository policy validation passed.

Kilit başarıyla serbest bırakıldı (`python3 orkestra/locks.py release sunucu-28-4 AGENT_4`).

---

## 3. Sonuç
Tüm kalite kriterleri, sıfır mock ilkesi, fiziksel kanıtlar ve temizlik kuralları eksiksiz karşılandığı için T173 görevi onaylanmış ve kabul edilmiştir.
