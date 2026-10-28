# SYS-03 — Hostname, saat/saat dilimi ve sistem ayarları
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-28 12:32 · Senaryo: `e2e/ozellik/sys-03.spec.js` · Koşu: 5/5, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
|---|---|---|
| Mutlu yol: Hostname ve sistem ayarları | geçti | API `/api/panel/settings` 200, UI `/servers` render |
| Hatalı girdi: Geçersiz formatlar | geçti | 400 invalid_acme_email, invalid_default_runtime |
| Fiziksel kanıt: SSH & API tutarlılığı | geçti | SSH `hostname` ('test') ve `timedatectl` eşleşti |
| Parity: Sistem saati, TZ ve NTP | bilinen hata (test.fail) | Plesk "System Time" ve NTP arayüzü eksik |
| Parity: Sunucu Hostname değiştirme | bilinen hata (test.fail) | Plesk "Server Settings" FQDN değiştirme eksik |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | Plesk Sistem Saati, Saat Dilimi ve NTP eksikliği | — |
| NORMAL | Plesk Sunucu Hostname (FQDN) değiştirme eksikliği | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `apps/api/test/panel-settings-http.test.js` | GEÇERLİ | Panel ayarları GET/PATCH birim testleri |
| `apps/web/test/settings-diagnostics-visual-alignment.test.js` | GEÇERLİ | UI tanı ve yazılım bilgileri DOM kontrolü |

## Panelde olmayan
- Plesk "System Time" eşdeğeri Sistem saati ve tarihi gösterimi, Saat Dilimi (Time Zone) değiştirme ve otomatik NTP zaman senkronizasyonu yapılandırması.
- Plesk "Server Settings" eşdeğeri Sunucu Hostname (FQDN) güncelleme arayüzü ve API desteği (mevcut panelde hostname salt okunurdur).

## Temizlenemeyen kaynaklar
—
