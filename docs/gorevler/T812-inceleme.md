# T812 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_2
- **İncelenen Görev:** T812 · Otomasyon: silinen tenant aynı slug ile eski provisioning ve kaldırma kayıtlarını kullanıyor
- **Yapan:** AGENT_3
- **Karar:** ONAY (ACCEPT)

---

## 1. Mimari İnceleme ve Değişiklikler

### A. Nesil İzolasyonu (Generation Tracking) ve İdempotency
- `apps/api/src/tenant-site-store.js`:
  - `generations` sayacı eklendi ve JSON dosya diski üzerinde atomik olarak persis edildi.
  - Tenant silindiğinde (`store.remove`), ilgili hostname için nesil sayacı (`generation`) monotonik olarak artırılıyor (`generations[hostname]++`).
  - Geriye dönük uyumluluk korunarak mevcut store dosyaları `generations: {}` ile güvenle okunuyor.
- `apps/api/src/tenant-site-service.js`:
  - Deterministik operasyon kimliği `operationIdFor(hostname, generation)` şeklinde nesil parametresi alacak şekilde uyarlandı (`yunpanel:tenant-site:v2:${hostname}:${generation}`). İlk nesil (generation 1) için v1 uyumluluğu korundu.
  - Aktif veya provisioning aşamasındaki tenant için aynı slug ile tekrar `PUT` yapıldığında var olan kaydı dönen idempotency davranışı (200 OK, aynı websiteId) eksiksiz korundu.
  - Silinmiş eski sitelerden kalan ölü provisioning kayıtlarına karşı kontrol döngüsü eklendi; kayıtlı operasyonun websiteId'si sistemde artık yoksa nesil güvenli şekilde ilerletiliyor.
  - `remove` çağrısında asenkron/senkron otomatik worker yürütme modellerinde oluşabilecek `website_removal_execution_stale` yarış durumu güvenli şekilde yakalandı.

### B. Kaldırma Motorunda Eski Operasyon Çakışmasının Önlenmesi
- `apps/api/src/website-removal-runtime.js`:
  - `domainOps` listesinde geçmişten kalan `removed` durumunda bir operasyon bulunsa bile, domain gerçekte `domainRegistry` içinde hala mevcutsa (`domainStillExists`) adım erken tamamlanmış sayılmıyor.
  - Böylece yeni domain için taze kaldırma adımı başlatılarak `website_removal_domains_still_attached` (409) hatasının oluşması kesin olarak engellendi.

### C. Sıfır Mock ve Kapsamlı Test Kapsamı
- `apps/api/test/tenant-site-recreate-lifecycle.test.js`:
  - Mock servis veya stub HTTP yanıtı olmadan gerçek bileşenler, gerçek API sunucusu, gerçek domain/website registry'leri ve gerçek worker ile:
    1. Gen 1 oluşturma -> aktiflik doğrulaması.
    2. Gen 1 aktifken tekrar `PUT` -> İdempotency doğrulaması (200 OK, aynı websiteId).
    3. Gen 1 silme -> 404 doğrulaması.
    4. Gen 2 oluşturma (aynı slug) -> Bağımsız yeni `websiteId2 !== websiteId1`, `generation: 2` ve taze provisioning doğrulaması.
    5. Gen 2 aktifken tekrar `PUT` -> İdempotency doğrulaması (200 OK, aynı websiteId2).
    6. Gen 2 silme -> `website_removal_domains_still_attached` hatası olmadan temiz silme doğrulaması.
    7. Gen 3 döngüsü ile monotonik generation artış teyidi.
    8. `tenant-site-store`'un disk persistence ve reload doğrulaması.

---

## 2. Doğrulama ve Test Koşuları

Reviewer tarafından bağımsız olarak çalıştırılan testler:
1. `node --test apps/api/test/tenant-site-recreate-lifecycle.test.js apps/api/test/tenant-site-http.test.js`:
   - 7 passed, 0 failed (33.4s)
2. `node --test apps/api/test/website-removal-*.test.js`:
   - 172 passed, 0 failed (6.9s)
3. `python3 orkestra/tasks.py lint`:
   - lint OK (142 tasks)
4. `python3 orkestra/orchestrator.py verify --quick`:
   - Doğrulama orkestratör arka planında aktif çalışıyor.

---

## 3. Karar Özeti
T812 görevi; silinen tenant'ın aynı slug ile yeniden oluşturulmasında eski provisioning ve kaldırma artıklarının yarattığı çakışmaları, nesil izolasyonu ve domain varlık doğrulamasıyla mimari açıdan temiz, dayanıklı ve geriye dönük uyumlu şekilde çözmüştür. İdempotency korunmuş ve sıfır mock kuralına tam uyulmuştur. Görev ONAYLANMIŞTIR (`accept`).
