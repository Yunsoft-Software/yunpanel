# T811 İnceleme Notu (Review)

- **Tarih:** 2026-10-28
- **İnceleyen:** AGENT_4
- **İncelenen Görev:** T811 · KRİTİK: DEV-06 test temizliği başka sitelerin cron dosyalarını siliyor
- **Yapan:** AGENT_1
- **Karar:** ONAY (ACCEPT)

---

## 1. İncelenen Değişiklikler ve Güvenlik Denetimi
- `e2e/ozellik/dev-06.spec.js`:
  - `afterAll` hook'unda yer alan tehlikeli ve genel wildcard silme komutu (`rm -f /etc/cron.d/yunpanel-*`) tamamen kaldırıldı. Bu komut, sunucudaki tüm diğer sitelerin yönetilen cron dosyalarını silme riski taşımaktaydı.
  - Temizlik mekanizması `createdTaskIds` kümesi üzerinden `/etc/cron.d/yunpanel-${taskId}` şeklinde yalnızca testin ürettiği spesifik görev kimliklerine bağlandı.
  - Olası bir kesinti durumunda fallback temizlik deseni, yalnızca test alan adını içeren dosyalarla (`grep -l "${siteDomain}" /etc/cron.d/yunpanel-*`) sınırlandırıldı; genel wildcard (`*`) hiçbir koşulda tek başına çalıştırılmamaktadır.
  - Test senaryosuna iki ayrı test kaynağı izolasyon kontrolü eklendi:
    1. UI üzerinden Laravel Schedule Worker (`mainTaskId`) eklendi ve SSH ile `/etc/cron.d/yunpanel-${mainTaskId}` dosyasının oluştuğu doğrulandı.
    2. API üzerinden ikinci bir zamanlanmış görev (`companionTaskId`) eklendi ve `/etc/cron.d/yunpanel-${companionTaskId}` dosyasının oluştuğu SSH ile teyit edildi.
    3. İlk görev arayüzden onaylanarak silindi.
    4. Fiziksel dosya kontrolüyle yalnız ilk görevin dosyasının kaldırıldığı (`NOT_FOUND`), buna karşın ikinci görevin cron dosyasının (`EXISTS`) ve API registry kaydının (`hostFileExists: true`) eksiksiz korunduğu kanıtlandı.
    5. İkinci görev de API üzerinden silinerek sunucuda 0 artık bırakıldı.
- `docs/otomasyon-api.md`:
  - "Kalan işler" bölümündeki 2. madde "Test temizliği riski", çözüldü olarak güncellendi.
- `tasks/review/T811.md`:
  - Maker teslim notu eksiksiz dolduruldu.

---

## 2. Doğrulama ve Bulgular

### A. Wildcard ve Yıkıcı Komut Kontrolü
- Kod tabanı ve test akışları incelendi; genel yıkıcı komut (`rm -f /etc/cron.d/yunpanel-*`) bulunmadığı teyit edildi.
- Test çalıştırması sırasında sunucuda genel silme komutları kesinlikle çalıştırılmadı.

### B. Bağımsız Test Koşusu (Reviewer Koşusu)
- Eşzamanlı test kilidi alındı: `python3 orkestra/locks.py acquire sunucu-28-4 AGENT_4`
- Test bağımsız olarak gerçek tarayıcı ve .28 sunucusunda çalıştırıldı:
  `AGENT_N=4 npx playwright test e2e/ozellik/dev-06.spec.js`
  - Sonuç: **5 passed (1.4m)** (Sıfır mock, gerçek API + SSH).
- Kilit serbest bırakıldı: `python3 orkestra/locks.py release sunucu-28-4 AGENT_4`

### C. Kalite Kapıları
- `python3 orkestra/tasks.py lint`: 143 tasks, lint OK.
- `python3 orkestra/orchestrator.py verify --quick`: `doğrulama: ok; yeniden açılan: -; bulgu: -`

---

## 3. Karar Özeti
T811 görevi, DEV-06 E2E testindeki kritik cron silme riskini ortadan kaldırmış, temizliği yalnız bu teste ait spesifik görev kimlikleriyle sınırlandırmış ve iki görevli izolasyon kanıtını başarıyla sağlamıştır. Görev ONAYLANMIŞTIR (`accept`).
