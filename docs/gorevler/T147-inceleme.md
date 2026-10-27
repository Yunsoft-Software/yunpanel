# T147 İnceleme Notu — DOS-04: Tekli/çoklu dosya ve klasör yükleme; sürükle/bırak

- **Görevi Yapan:** AGENT_2
- **İnceleyen:** AGENT_1
- **Tarih:** 2026-10-27
- **Karar:** ONAY (Kabul Edildi)

---

## 1. Görev Özeti ve İnceleme Kapsamı
T147 görevi kapsamında Plesk dosya yöneticisi eşdeğerliğindeki **DOS-04 (Tekli/çoklu dosya ve klasör yükleme; sürükle/bırak)** özelliği incelenmiştir.
İnceleme; `e2e/ozellik/dos-04.spec.js` Playwright senaryosunun doğruluğunu, `docs/manuel-test/DOS-04.md` raporunu, mock/sahte veri bulunmamasını, fiziksel doğrulamaları ve temizlik adımlarını kapsamaktadır.

---

## 2. Doğrulama Bulguları

### A. Senaryo ve Test Kalitesi (`e2e/ozellik/dos-04.spec.js`)
- **Sıfır Mock / Sahte Veri:** `page.route`, mock backend veya stub yanıt kullanılmamıştır; tüm testler doğrudan çalışan panele ve gerçek API uç noktalarına karşı çalışmaktadır.
- **Mutlu Yol Senaryosu:**
  - Tekli dosya yükleme (input file chooser, modal etkileşimi, yükleme başlatma ve listede görüntülenme).
  - Çoklu dosya yükleme (aynı anda 2 dosyanın seçilip yüklenmesi).
  - Sürükle ve bırak (Drag and drop) yükleme (`DataTransfer` ve `drop` event simülasyonu ile modal tetikleme).
- **Fiziksel Doğrulama:**
  - Yüklenen her bir dosya (tekli, çoklu 1, çoklu 2, sürükle/bırak) `/api/panel/websites/:id/files/download` API uç noktasından indirilerek içeriklerinin tam eşleştiği teyit edilmiştir.
- **Hatalı Girdi ve Güvenlik Denetimleri:**
  - 16 MB yükleme sınırını aşan dosya (16 MB + 1 KB) yükleme girişimi test edilmiş; arayüzde hata mesajı alındığı, dosyanın yüklenmediği ve sunucuda oluşmadığı (400/404) doğrulanmıştır.
  - Path traversal (`../../`), null byte (`evil%00.txt`) ve hatalı Content-Type (415) kontrolleri test edilmiştir.
- **Panelde Olmayan / Eksik Özellik:**
  - Klasör yükleme (`webkitdirectory`) desteğinin panelde bulunmadığı doğrulanmıştır.
- **Temizlik (`afterAll`):**
  - Test sırasında yüklenen tüm dosyalar `createdFiles` Set'inde toplanmış ve `afterAll` hook'unda panel DELETE API'si üzerinden fiziksel olarak silinerek temizlenmiştir.

### B. Manuel Test Raporu (`docs/manuel-test/DOS-04.md`)
- `docs/manuel-test/YONTEM.md` şablonuna birebir uygundur.
- 27 satırdan oluşmaktadır (kural: ≤40 satır).
- Sonuç durumu: KISMİ (doğrudan klasör yükleme bulunmadığı için raporda doğru şekilde KISMİ olarak sınıflandırılmıştır).
- Senaryolar, hatalar, mevcut testler, panelde olmayan ve temizlenemeyen kaynaklar tabloları eksiksizdir.

### C. Orkestra Kontrolleri
- `python3 orkestra/tasks.py lint`: Başarılı (131 tasks, lint OK).
- `python3 orkestra/orchestrator.py verify --quick`: Başarılı (`doğrulama: ok; yeniden açılan: -; bulgu: -`).

---

## 3. Sonuç
T147 görevi kabul kriterlerini tam olarak karşılamaktadır. Görev onaylanmış ve `tasks/done/T147.md` durumuna geçirilmiştir.
