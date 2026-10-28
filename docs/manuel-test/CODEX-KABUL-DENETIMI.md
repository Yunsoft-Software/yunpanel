# CODEX — 28 Ekim 2026 kabul denetimi (T817)

| Denetim | Kanıt / sonuç |
| --- | --- |
| Rapor kapsamı | 124 özellik raporu; özet tablosunda 124 satır ve 124 benzersiz ID; eksik/fazla ID yok |
| Özellik durumları | 26 ÇALIŞIYOR + 93 KISMİ + 1 SORUNLU + 4 ÇALIŞMIYOR = 124; tarihsel rapor durumlarıdır |
| API-01 sayımı | Raporda ürün hatası yok; açıklama satırının hata sayılması düzeltildi: NORMAL 1 → 0 |
| Bulgu toplamları | Özet tablosu: 6 tarihsel KRİTİK satır, 237 NORMAL/KOZMETİK satır; tekilleştirilmiş açık hata sayısı değildir |
| Tema yüzdeleri | Satır-tema eşleştirmesi olmadığı için dayanağı bulunmayan yaklaşık yüzdeler kaldırıldı |
| Test sınıfları | 763 rapor girdisinin kategorileri toplamı tutarlı; benzersiz dosya sayısı veya her testin bağımsız yeniden sınıflandırılması değildir |
| Yerel tekrar | `node --test --test-timeout=120000 apps/api/test/website-site-logs.test.js apps/api/test/tenant-site-recreate-lifecycle.test.js apps/api/test/website-php-tool-action-lock.test.js`: 9 geçti, 0 düştü/atlandı |
| Toplu doğrulama | `python3 orkestra/orchestrator.py verify --quick`: ok; lint ve npm test geçti, yeni bulgu/yeniden açılan görev yok. Tam canlı Playwright dalga kabulü değildir |
| T812/T815 kanıt sınırı | Yeniden oluşturma fixture'ında Nginx `execFn`, kimlik, domain kaldırma ve temizlik taklit; HTTPS kapalı. Geçen sonuç canlı host/ACME kabulünü kanıtlamaz |
| Açık kabul | Aynı slug ile gerçek oluştur/HTTPS/sil/404/yeniden oluştur/yeni kimlikler/HTTPS/sil/404; ayrıntı `docs/otomasyon-api.md` Kalan işler 1 |
| Önceki canlı kanıt | Otomasyonun 19/19 koşusu benzersiz tenant ile yapıldı; aynı slug yeniden kurmayı kapsamıyor |

Uygulama kaynakları ve kabul edilmiş görev geçmişi değiştirilmedi. Bu denetimde canlı sunucuya erişilmedi. `test.fail` ile beklenen düşüşler, eksik ürün işlevinin çalıştığı anlamına gelmez.
