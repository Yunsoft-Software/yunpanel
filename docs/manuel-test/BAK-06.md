# BAK-06 — Seçici geri yükleme, indir/yükle ve parola koruması
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-27 13:17 · Senaryo: `e2e/ozellik/bak-06.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: parola korumalı repo oluşturma, UI üzerinden seçici geri yükleme başlatma, progress takibi ve fiziksel restore kanıtı | geçti | Operation API `selective: true`, `include` dizinleri, otomatik `pre-restore` güvenlik snapshot'ı ve sitenin HTTP 200 dönmesi |
| hatalı girdi: parolasız repo oluşturma ve seçici geri yüklemede tüm kapsamın kaldırılması reddedilir | geçti | HTTP 400 (`restic_password_invalid`), UI'da boş kapsam hata uyarısı ve onay formunun engellenmesi, API traversal reddi |
| Plesk eşdeğerliği: UI üzerinde yedek arşivi indir/yükle (download/upload) butonu | bilinen hata (`test.fail`) | Plesk Backup Manager'daki .tar/.zip yedek arşivini indirme ve dışarıdan arşiv yükleme özelliği YunPanel'de yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Backup Manager'daki yerel bilgisayara yedek arşivi indirme / dışarıdan arşiv yükleme (download/upload) eksik | — |
| NORMAL | UI'da seçici geri yükleme boş bırakıldığında `siteBackupErrorMessage` genel fallback metnine düşüyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/website-restore-selection.test.js` | GEÇERLİ | Seçici geri yükleme kökleri ve traversal filtreleme |
| `apps/api/test/website-restore-service.test.js` | GEÇERLİ | Pre-restore snapshot, sağlık kontrolü ve otomatik rollback |
| `apps/api/test/website-restore-http.test.js` | GEÇERLİ | Restore preview ve queue uç noktaları yetki/şema doğrulaması |

## Panelde olmayan
Plesk'te yer alan yedek arşivini (.tar/.zip) yerel bilgisayara indirme ("Download") ve bilgisayardan yükleme ("Upload") özellikleri; YunPanel tüm yedekleri doğrudan Restic reposunda blok/chunk olarak depolar.

## Temizlenemeyen kaynaklar
—
