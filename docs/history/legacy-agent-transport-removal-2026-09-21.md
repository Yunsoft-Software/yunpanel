# Eski Agent Taşıma Katmanı, Paket ve Servis Birimlerinin Kaldırılması ve Canlı Doğrulama

**Tarih**: 2026-09-21  
**Sunucu**: `.28` (`157.180.11.28`, test host)  
**Kapsam**: `plan.md` P2 — "Agentless local backend acceptance sonrası retained legacy agent transport/package/state kaldır."

---

## 1. Amaç ve Kapsam

Agentsiz yerel yönetim mimarisine (`local-runtime`) geçiş tamamlandıktan sonra, eski mimariden kalan ve artık kullanılmayan bileşenlerin güvenli şekilde temizlenmesi:
1. `apps/agent` paket çalışma alanının (workspace) ve kaynak kodlarının depodan kaldırılması.
2. `packaging/systemd/yun-agent.service` systemd servis biriminin ve ilgili paketleme betiklerindeki `apps/agent` referanslarının kaldırılması.
3. `apps/api/src/core-app.js` ve `apps/api/src/auth-http.js` üzerindeki eski HTTP agent rotalarının (`heartbeat`, `commands/next`, `deployment-credential`, `applications/:id/environment`, `commands/:id/result`) ve agent auth istisnalarının emekliye ayrılması.
4. Tüm test paketlerinin güncellenerek monorepo genelinde (`npm run check`) %100 başarıyla geçmesi.
5. `.28` test sunucusuna dağıtılması, `yun-agent.service` servisinin durdurulup maskelenmesi/kaldırılması, `/usr/lib/yunpanel/apps/agent` dizininin temizlenmesi ve `yunpanel-api` servisinin yerel çalışma zamanının doğrulanması.

---

## 2. Yapılan Değişiklikler

### A. Depo ve Paket Temizliği
- `apps/agent` dizini tamamen kaldırıldı (`git rm -r apps/agent`).
- `package.json` içerisinden `dev:agent` betiği ve çalışma alanı (workspace) referansı kaldırıldı.
- `package-lock.json` güncellendi (`@yunpanel/agent` kaldırıldı).
- `.env.example` içerisinden `YUN_AGENT_*` yapılandırma değişkenleri temizlendi.
- `scripts/build-deb.sh` dosyasında paket kopyalama hedefi `apps/api apps/web` olarak güncellendi.
- `packaging/debian/control` içerisinden `apps/agent` açıklaması ve `yun-agent` servis referansı kaldırıldı.
- `packaging/debian/postinst` servis yönetiminde `yun-agent.service` durdurulup, devre dışı bırakılıp maskelendi.
- `packaging/systemd/yun-agent.service` dosyası depodan kaldırıldı.

### B. Core API ve Güvenlik Katmanı
- `apps/api/src/auth-http.js`: `AGENT_ROUTES = Object.freeze([])` olarak ayarlandı; `isAgentRoute()` her zaman `false` dönecek şekilde kısıtlandı.
- `apps/api/src/core-app.js`: Eski agent HTTP endpoints (`POST /api/servers/:serverId/heartbeat`, `GET .../commands/next`, `GET .../deployment-credential`, `GET .../applications/:id/environment`, `POST .../commands/:id/result`) kaldırıldı; yetkisiz erişimler 401, yetkili bilinmeyen rota istekleri standart 404 döndürür hale getirildi.
- Test yardımcısı `apps/api/test/helpers/job-completion-fixture.js` oluşturularak in-process yerel mutasyon/reconciliation testleri standartlaştırıldı.
- İlgili tüm testler (`api.test.js`, `auth-http.test.js`, `local-panel-scope-http.test.js`, `retired-agent-url-config.test.js`, `domain-job-flow-v2.test.js`, `certificate-job-flow.test.js`, `application-*-flow.test.js`, `node-*-flow.test.js` vb.) yeni agentsiz sözleşmeye uyarlandı.

---

## 3. Canlı Sunucu Doğrulama Adımları ve Çıktıları (`.28`)

> **Güvenlik Doğrulaması:** IP adresi `.44` ile biten Plesk sunucusuna kesinlikle dokunulmamış; tüm işlemler repo dışı `.local/test-server.env` ile tanımlı `.28` (`157.180.11.28`) test sunucusu üzerinde yürütülmüştür.

### A. Dosya ve Servis Temizliği
- `/usr/lib/yunpanel/apps/agent` dizini fiziksel olarak silindi.
- `yun-agent.service` durduruldu, disable edildi, maskelendi ve `/lib/systemd/system/yun-agent.service` birim dosyası kaldırıldı.
- `systemctl daemon-reload` ve `systemctl reset-failed` çalıştırıldı.

### B. `yunpanel-api` Servis Yeniden Başlatma ve Sağlık Kontrolü
```bash
systemctl restart yunpanel-api.service
systemctl is-active yunpanel-api.service
# active
```

### C. Yerel Çalışma Zamanı Doğrulaması (`validate`)
```bash
node /usr/lib/yunpanel/scripts/local-runtime.mjs validate 99bc760a-d508-4ae6-92be-efdedee9658d
```
Çıktı:
```
validation=passed
server=99bc760a-d508-4ae6-92be-efdedee9658d
hostname=test
executionMode=local
connectivity=online
lastSeenAt=2026-09-20T23:05:55.506Z
localRuntimeVersion=0.3.0
apiState=active
agentState=inactive
apiHealth=true
apiHealthStatus=200
activeJobs=0
recoveryJobs=0
inventoryPresent=true
servicesPresent=true
```

### D. Emekliye Ayrılan Rota Güvenlik Kontrolü
Eski public agent rotalarına anonim çağrılar `401 Unauthorized` yanıtı vermektedir:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3001/api/servers/99bc760a-d508-4ae6-92be-efdedee9658d/heartbeat
# 401
curl -s -o /dev/null -w "%{http_code}\n" -X GET http://127.0.0.1:3001/api/servers/99bc760a-d508-4ae6-92be-efdedee9658d/commands/next
# 401
curl -s http://127.0.0.1:3001/api/health
# {"status":"ok"}
```

---

## 4. Sonuç
Eski `@yunpanel/agent` paketi, servis birimi ve HTTP taşıma rotaları depodan ve test sunucusundan tamamen temizlenmiştir. Tüm yerel testler (`npm run check`) ve canlı `.28` test sunucusu doğrulamaları başarıyla geçmiştir.
