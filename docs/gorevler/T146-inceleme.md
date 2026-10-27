# T146 İnceleme Notu — DOS-03: Dosya/klasör oluşturma, yeniden adlandırma ve silme

- **Görevi Yapan:** AGENT_4
- **İnceleyen:** AGENT_1
- **Tarih:** 2026-10-27
- **Karar:** ONAY (Kabul Edildi)

---

## 1. Görev Özeti ve İnceleme Kapsamı
T146 görevi kapsamında Plesk dosya yöneticisi eşdeğerliğindeki **DOS-03 (Dosya/klasör oluşturma, yeniden adlandırma ve silme)** özelliği incelenmiştir.
İnceleme; `e2e/ozellik/dos-03.spec.js` Playwright senaryosunun doğruluğunu, `docs/manuel-test/DOS-03.md` raporunu, mock/sahte veri bulunmamasını, sunucu üzerindeki fiziksel SSH doğrulamalarını ve temizlik adımlarını kapsamaktadır.

---

## 2. Doğrulama Bulguları

### A. Senaryo ve Test Kalitesi (`e2e/ozellik/dos-03.spec.js`)
- **Sıfır Mock / Sahte Veri:** `page.route`, mock backend veya stub yanıt kullanılmamıştır; tüm testler doğrudan çalışan panele ve gerçek API uç noktalarına karşı çalışmaktadır.
- **Mutlu Yol Senaryosu:**
  - Dosya oluşturma (UI modalından dosya adı girilerek oluşturma ve listede teyit).
  - Klasör oluşturma (UI modalından klasör adı girilerek oluşturma ve listede teyit).
  - Dosya yeniden adlandırma (Dosya işlemleri menüsü -> Yeniden adlandır modalı -> yeni dosya adı -> eski ismin kalkıp yeni ismin belirmesi).
  - Klasör yeniden adlandırma (Klasör işlemleri menüsü -> Yeniden adlandır modalı -> yeni klasör adı -> eski ismin kalkıp yeni ismin belirmesi).
  - Dosya silme (İşlemler menüsü -> Sil onay modalı -> doğrulama adı girişi -> listeden kalkması).
  - Klasör silme (İşlemler menüsü -> Sil onay modalı -> doğrulama adı girişi -> listeden kalkması).
- **Fiziksel Doğrulama (SSH):**
  - Dosya oluşturulduktan sonra SSH üzerinden `test -f` ile sunucuda varlığı kanıtlanmıştır.
  - Klasör oluşturulduktan sonra SSH üzerinden `test -d` ile sunucuda varlığı kanıtlanmıştır.
  - Yeniden adlandırma sonrasında SSH ile eski isimlerin silindiği, yeni isimlerin sunucuda oluştuğu teyit edilmiştir.
  - Silme işlemleri sonrasında SSH ile dosyaların/klasörlerin sunucudan kalıcı olarak kaldırıldığı teyit edilmiştir.
- **Hatalı Girdi ve Güvenlik Denetimleri:**
  - Boş isim, path traversal (`../traversal.txt`), ters slash (`\`) ve ayrılmış dosya isimleri (`.` ve `..`) girildiğinde UI butonlarının devre dışı (disabled) kaldığı doğrulanmıştır.
  - Backend API seviyesinde doğrudan path traversal içeren dosya/klasör oluşturma (`../../../etc/...`), traversal ile yeniden adlandırma ve geçersiz onay koduyla silme denemelerinin fail-closed olarak HTTP 400 Bad Request döndürdüğü teyit edilmiştir.
- **Temizlik (`afterAll`):**
  - `afterAll` hook'unda hem panel DELETE API'si üzerinden hem de SSH üzerinden geçici test kalıntıları temizlenmektedir.

### B. Manuel Test Raporu (`docs/manuel-test/DOS-03.md`)
- `docs/manuel-test/YONTEM.md` şablonuna tam uyumludur.
- 27 satırdan oluşmaktadır (kural: ≤40 satır).
- Sonuç durumu: ÇALIŞIYOR.
- Senaryolar, hatalar, mevcut testler, panelde olmayan ve temizlenemeyen kaynaklar tabloları eksiksiz doldurulmuştur.

### C. Orkestra Kontrolleri
- `python3 orkestra/tasks.py lint`: Başarılı (131 tasks, lint OK).
- `python3 orkestra/orchestrator.py verify --quick`: Başarılı (`doğrulama: ok; yeniden açılan: -; bulgu: -`).

---

## 3. Sonuç
T146 görevi kabul kriterlerini eksiksiz karşılamaktadır. Görev onaylanmış ve `tasks/done/T146.md` durumuna geçirilmiştir.
