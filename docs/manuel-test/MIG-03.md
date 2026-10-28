# MIG-03 — Site/mail/DB/DNS/SSL/kullanıcı verisi ve IP eşleme
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-28 13:30 · Senaryo: `e2e/ozellik/mig-03.spec.js` · Koşu: 5/5, test.fail 3

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Site, mail, DB, DNS ve SSL bileşen verilerinin ayrıştırılması ve eşlenmesi | geçti | HTTP 200, preview digest SHA-256 ve SSH disk kontrolü (0 artık) |
| hatalı girdi ve güvenlik: .44 yasaklı sunucu denetimi, geçersiz yük ve yetkisiz erişim | geçti | HTTP 403 (forbidden server), HTTP 400 (no websites), HTTP 401/403 |
| eksiklik 1: IP eşleme tablosu (ipMapping) ve DNS A / listen IP dönüşüm yokluğu | bilinen hata (test.fail) | preview.ipMappings tanımsız, DNS A kaydında eski IP sabit kalıyor |
| eksiklik 2: Sistem Unix kullanıcısı (systemUser) ve FTP kullanıcı verisi eşleme yokluğu | bilinen hata (test.fail) | website.systemUser ve website.ftpUsers ayrıştırıcı tarafından yoksayılıyor |
| eksiklik 3: Seçici bileşen filtreleme ve çakışma durumunda DB yeniden adlandırma yokluğu | bilinen hata (test.fail) | selectedComponents ve dbMapping parametreleri desteklenmiyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Migrator IP eşleme (IP remapping table) ve DNS A / web listen IP dönüştürücüsü bulunmuyor | — |
| NORMAL | Kaynak verisindeki sistem Unix kullanıcısı (systemUser) ve FTP hesapları hedef sisteme eşlenmiyor | — |
| NORMAL | İçe aktarmada seçici bileşen filtreleme (selective components) ve çakışma çözme eşlemesi bulunmuyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/plesk-importer.test.js` | GEÇERLİ | Çevrimdışı dışa aktarma JSON ayrıştırıcı, normalizasyon ve .44 güvenlik engeli |
| `apps/api/test/plesk-importer-http.test.js` | GEÇERLİ | `/api/importer/plesk/preview` rotası ve RBAC erişim denetimleri |

## Panelde olmayan
- Plesk Migrator IP eşleme tablosu (IP remapping) ve DNS A kayıtları ile vhost dinleme IP'lerinin otomatik dönüştürülmesi.
- Sistem Unix kullanıcısı (systemUser) ve FTP kullanıcı hesaplarının ayrıştırılması ve hedef Linux ortamına eşlenmesi.
- Seçici bileşen aktarımı (selective component migration) ve çakışma durumunda veritabanı/kullanıcı yeniden adlandırma eşlemesi.

## Temizlenemeyen kaynaklar
—
