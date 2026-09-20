# Node.js Passenger Varsayılanı ve Direct-Systemd Migration Uyumluluğu İlerlemesi

**Tarih**: 2026-09-21  
**Kapsam**: `plan.md` P2 — "Passenger acceptance sonrası direct-systemd yalnız legacy migration adapter'ı olarak kalsın; migration sonunda kaldır."

---

## 1. Amaç ve Mimari Hedef

YunPanel mimari sözleşmesi (`AGENTS.md` ve `docs/architecture.md`) gereğince:
- Yeni Node.js Website'lerinin varsayılan ve birinci sınıf çalışma ortamı Phusion Passenger'dır (`passenger_user/group` kullanıcı ve dosya izolasyonu, Unix soketi, port ayırmama).
- Eski doğrudan systemd (`direct-systemd`) modeli artık varsayılan çalışma biçimi değildir; yalnızca önceki sürümlerden gelen uygulamaların kesintisiz çalışması ve Passenger'a taşınabilmesi (`app.node.passenger-migrate`) için bir geriye dönük uyumluluk / geçiş adaptörüdür.
- Passenger canlı kabulü (`docs/history/passenger-migration-live-acceptance-2026-09-20.md`) tamamlandıktan sonra, `direct-systemd` yeni uygulama oluşturma varsayılanı olmaktan çıkarılmış ve taşınan uygulamaların durum kayıtları (`application-registry.json`) Passenger hedefine senkronize edilmiştir.

---

## 2. Uygulanan Değişiklikler

### A. `apps/api/src/application-registry.js`
1. **Passenger Varsayılanı**:
   - `normalizeRuntimeAdapter(value = 'passenger')`: Parametre verilmediğinde varsayılan değer `passenger` oldu.
   - `normalizeNodeConfig({ ..., runtimeAdapter })`: `runtimeAdapter` belirtilmediğinde, `runtime?.port` varsa (eski test ve doğrudan systemd yapılandırmaları için) `direct-systemd` olarak çıkarsandı; aksi durumda varsayılan olarak `passenger` atandı.
   - `createNodeApplication`: `runtimeAdapter` varsayılanı doğrudan `passenger` yapılandırmasına bağlandı.
   - `hydrateApplication`: Diskten okunan kayıtlar için `application.runtimeAdapter` eksikse, `runtime.port` varlığına göre `direct-systemd` veya `passenger` olarak güvenli normalizasyon yapıldı; `runtimeAdapter === 'passenger'` durumunda geçmiş sürümlere ait `runtime.port` değerleri temizlendi.
2. **`markPassengerMigrated` Metodu**:
   - Passenger geçişi tamamlandığında veya uzlaştırıldığında çağrılan atomik güncelleme metodu eklendi.
   - `application.runtimeAdapter = 'passenger'` olarak güncellenir.
   - `application.serviceName = null`, `application.servicePort = null`, `application.proxyTarget = null` alanları sıfırlanır.
   - `application.runtime`, `application.activeRuntime` ve `application.releases` içerisindeki eski `port` verileri temizlenerek Passenger sözleşmesiyle (`port` bulunmaması zorunluluğu) tam uyumlu hale getirilir.
   - Değişiklikler diske kalıcı olarak yazılır (`await persist()`).

### B. `apps/api/src/application-passenger-migration-reconciliation.js`
- `reconcileApplicationPassengerMigration`: Passenger geçiş işi (`app.node.passenger-migrate`) başarılı olduğunda, `runtimeBindingRegistry` kaydının etkinleştirilmesine paralel olarak `applicationRegistry.markPassengerMigrated` metodu çağrıldı.
- Böylece hem runtime binding hem de control plane uygulama kaydı (`application-registry.json`) tekil otorite altında Passenger durumuna taşındı.

### C. Test Kapsamı ve Doğrulama
- `apps/api/test/application-registry.test.js`:
  - `createNodeApplication defaults to passenger runtimeAdapter when port is omitted` testi eklendi.
  - `markPassengerMigrated transitions direct-systemd application to passenger and clears legacy systemd fields` testi eklendi.
- `apps/api/test/application-passenger-migration-reconciliation.test.js`:
  - Geçiş uzlaştırması sırasında `markPassengerMigrated` çağrısının yapıldığı doğrulandı.
- Tüm testler Node 24 (`v24.21.0`) altında çalıştırıldı: 2,958 test geçti, 0 hata.

### D. Canlı Test Sunucusu (`.28`) Doğrulaması
- Güncellenen kodlar test sunucusuna aktarıldı.
- Daha önce Passenger'a taşınmış olan duman testi uygulaması (`30b4bec9-f640-4a47-bf33-47a386c09b42`, `yunpanel-node-smoke.test`):
  - `application-registry.json` içinde `runtimeAdapter: "passenger"`, `servicePort: null`, `proxyTarget: null` olarak doğrulandı.
  - `yunpanel-api` servisi yeniden başlatıldı; `npm run local-runtime -- validate 99bc760a-d508-4ae6-92be-efdedee9658d` ile doğrulama eksiksiz geçti (`apiState=active`, `agentState=inactive`, `apiHealth=true`).
  - `yunpanel-node-smoke.test` Nginx ve Passenger üzerinden HTTP 200 yanıtı vermeye devam etti; `passenger-status` çıktısında uygulamanın sağlıklı ve aktif olduğu teyit edildi.
