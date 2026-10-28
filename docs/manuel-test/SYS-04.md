# SYS-04 — Sistem/PHP/panel güncellemeleri ve bileşen yönetimi
Sonuç: ÇALIŞIYOR
Ajan: AGENT_2 · Tarih: 2026-10-28 12:33 · Senaryo: `e2e/ozellik/sys-04.spec.js` · Koşu: 4/4, test.fail 2

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: Panel sürüm denetimi, kurulu PHP ve güncelleme sorgusu | geçti | UI `YunPanel 0.3.0-2026102702 is current`, SSH `apt-cache policy yunpanel` (0.3.0), SSH `php -v` (PHP 8.3.6), `systemctl is-active php8.3-fpm` (active), SSH `apt list --upgradable` |
| Hatalı girdi: Geçersiz onay kodu ile yükseltme reddi ve 400 denetimi | geçti | HTTP 400 (`upgrade_confirmation_required`), boş body 400, geçersiz sunucu ID 404 |
| Plesk Parity: Sistem güncellemeleri arayüzü (Plesk System Updates) | bilinen hata (test.fail) | Plesk System Updates eşdeğeri tüm OS paketlerini (APT) listeleme ve otomatik güncelleme politikası UI'da yok |
| Plesk Parity: Sunucu geneli bileşen ekleme/kaldırma (Add/Remove Components) | bilinen hata (test.fail) | Plesk Updates and Upgrades eşdeğeri sunucu geneli çoklu PHP sürümlerini ve modülleri kurma/kaldırma arayüzü yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk System Updates eşdeğeri tüm OS paketlerini (APT) listeleme ve otomatik güncelleme politikası UI'da yok | — |
| NORMAL | Plesk Updates and Upgrades eşdeğeri sunucu geneli çoklu PHP ve bileşen ekleme/kaldırma ekranı yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `packages/host-runtime/test/system-package-manager.test.js` | GEÇERLİ | APT paket denetimi, servis restart zamanlama ve upgrade mantığını sınıyor |
| `apps/api/test/local-host-operations.test.js` | GEÇERLİ | `system.packages.inspect` ve `system.upgrade` operasyonlarını sınıyor |

## Panelde olmayan
Plesk System Updates (tüm OS paketlerinin seçmeli güncellenmesi ve otomatik güvenlik güncelleme takvimi) ve sunucu geneli bileşen ekleme/kaldırma (Add/Remove Components) arayüzü.

## Temizlenemeyen kaynaklar
—
