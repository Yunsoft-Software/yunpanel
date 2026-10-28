# SYS-02 — Sistem servislerini kurma/başlatma/durdurma/yeniden başlatma
Sonuç: ÇALIŞIYOR
Ajan: AGENT_3 · Tarih: 2026-10-28 12:31 · Senaryo: `e2e/ozellik/sys-02.spec.js` · Koşu: 4/4, test.fail 1

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol 1: servis listeleme & inspect | geçti | API `/api/panel/servers/:id/services`, SSH `systemctl is-active cron` (active) |
| mutlu yol 2: güvenli restart (cron) | geçti | ConfirmDialog onay akışı, SSH `systemctl is-active cron` (active) |
| hatalı girdi & güvenlik kontrolleri | geçti | 400 Bad Request (`unsupported_managed_service`, `unsupported_managed_service_action`, `confirmation_required`), MySQL/MariaDB çakışma engeli |
| Plesk eşdeğerliği (startup type & fpm/dns) | bilinen hata (test.fail) | Plesk Services Management başlangıç türü (Boot type) & PHP-FPM/DNS servisleri UI'da yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Services Management eşdeğeri başlangıç türü (boot) & PHP-FPM/PowerDNS servis kontrolleri UI'da eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/managed-service-http.test.js` | GEÇERLİ | API rota yetkilendirme, inspect/install/control ve hata durumlarını sınıyor |
| `packages/protocol/test/managed-services.test.js` | GEÇERLİ | Servis kimlikleri, aksiyonlar ve protokol şemasını doğruluyor |

## Panelde olmayan
Plesk Services Management ekranındaki servis başlangıç modu (Startup Type: Automatic/Manual/Disabled) yapılandırması ve tekil PHP-FPM / PowerDNS servis kontrolleri sistem servisleri panelinde yer almıyor.

## Temizlenemeyen kaynaklar
—
