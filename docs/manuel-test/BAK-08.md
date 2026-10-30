# BAK-08 — Gerçek kurtarma, hata bildirimi ve yedek sahipliği
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-30 15:10 · Senaryo: `e2e/ozellik/bak-08.spec.js` · Koşu: 4/4, test.fail 1 (iki kez art arda geçti)

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| mutlu yol: Gerçek yedek alma, UI üzerinden seçici kurtarma başlatma, fiziksel pre_restore snapshot ve HTTP 200 doğrulaması | geçti | Restic pre_restore snapshot oluştu, operation status: succeeded, canlı site HTTP 200 |
| hatalı girdi: Geri yüklemede yanlış onay metni butonu kilitler, API geçersiz istekleri reddeder | geçti | UI'da buton disabled kaldı, API'de geçersiz include (400) ve geçersiz snapshotId (400/404) |
| yetki ve sahiplik: Siteler arası izolasyon, sahiplik etiketi koruması ve site_manager sınırları | geçti | Yabancı sitede snapshot listelenmedi, yabancı restore preview 404, tag manipülasyonu 400 backup_tag_reserved, site_manager UI mutasyonları gizlendi ve API 403 |
| Plesk eşdeğerliği ve bilinen hata: Panelde Restic depo oluşturma UI ekranı eksikliği (T802) | bilinen hata (test.fail) | UI üzerinde yeni Restic deposu tanımlama/başlatma butonu veya modalı yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| KRİTİK | Panelde Restic yedek deposu oluşturma / başlatma UI arayüzü yok | T802 |
| NORMAL | Otomatik geri alma (rolled_back) sonrasında özet kartı ve snapshot tablosu otomatik yenilenmiyor | T802 |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `e2e/ozellik/bak-08.spec.js` | GEÇERLİ | Gerçek UI geri yükleme, pre_restore snapshot, izolasyon ve rol sınırlarını gerçek hostta doğrular |
| `apps/api/test/website-backup-set.test.js` | GEÇERLİ | Sahiplik etiketlerini (`website:<id>`), izin verilen yolları ve digest bütünlüğünü gerçek nesnelerle doğrular |
| `apps/api/test/website-restore-selection.test.js` | GEÇERLİ | Path kaçışı, yabancı path reddi ve seçici geri yükleme kapsamını doğrular |

## Panelde olmayan
Restic depo oluşturma/başlatma UI ekranı (`POST /api/panel/backups/repositories` yalnızca API'de var); UI'da tekil snapshot silme ve yedek arşivi indir/yükle arayüzü yok.

## Temizlenemeyen kaynaklar
— (Tüm `tbak08-*` depoları ve geçici kullanıcılar silindi; API kontrolünde kalan kaynak: 0)
