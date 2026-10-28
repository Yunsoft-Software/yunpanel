# MIG-06 — Panel güncellemesi/OS migration/rollback ve kurtarma
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-28 13:40 · Senaryo: `e2e/ozellik/mig-06.spec.js` · Koşu: 6/6, test.fail 4

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: panel paket denetimi, işletim sistemi durumu ve servis doğrulaması | geçti | Ubuntu 24.04, active yunpanel-api servisi, 202 kabul, succeeded job |
| hatalı girdi ve yetkisiz erişim: eksik onay, geçersiz sunucu ve oturumsuz istek | geçti | HTTP 400 (upgrade_confirmation_required), HTTP 404 (server_not_found), HTTP 401/403 |
| eksiklik 1: OS Migration / dist-upgrade otomatikleştirme API ve motoru yokluğu | bilinen hata (test.fail) | POST `/api/panel/servers/:id/system/dist-upgrade` 404 dönüyor |
| eksiklik 2: Panel versiyon geri alma (Rollback / Downgrade) API rotası yokluğu | bilinen hata (test.fail) | POST `/api/panel/servers/:id/system/rollback` 404 dönüyor |
| eksiklik 3: Kapsamlı sistem ve panel kurtarma / self-repair API rotası yokluğu | bilinen hata (test.fail) | POST `/api/panel/servers/:id/system/repair` 404 dönüyor |
| eksiklik 4: Ön yüzde OS migration, dist-upgrade ve rollback/kurtarma kontrolleri yokluğu | bilinen hata (test.fail) | Arayüzde OS dist-upgrade, panel rollback ve repair butonları bulunmuyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Canlı işletim sistemi yükseltme ve dist-upgrade (Plesk dist-upgrader) rotası yok | — |
| NORMAL | Panel güncellemesi sonrası önceki sürüme geri alma (Rollback/Downgrade) rotası yok | — |
| NORMAL | Sistem, servis ve veritabanı bileşenlerini onaran self-repair rotası yok | — |
| NORMAL | Arayüzde dist-upgrade, versiyon rollback ve self-repair kontrolleri yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/configured-local-system-upgrade-receipt.test.js` | GEÇERLİ | Sistem yükseltme makbuzu yazma ve private mode saklama testi |
| `packages/host-runtime/test/os-platform-multi-distro.test.js` | GEÇERLİ | Ubuntu/Debian/RHEL/AlmaLinux/Rocky platform tespiti ve paket adapterleri |
| `apps/api/test/job-running-system-upgrade-recovery-durable.test.js` | GEÇERLİ | Yarım kalan yükseltme işlerinin durable recovery mekanizması |

## Panelde olmayan
- Canlı işletim sistemi yükseltme (Ubuntu 20->22->24 dist-upgrade) API ve iş motoru.
- Panel güncellemesi başarısızlığında veya istendiğinde çalışan versiyon geri alma (Rollback) API rotası.
- Plesk repair all eşdeğeri tüm servisleri (web, mail, dns, db) tarayıp onaran self-repair aracı.
- Ön yüzde OS migration, versiyon rollback ve kurtarma yönetim bileşenleri.

## Temizlenemeyen kaynaklar
—
