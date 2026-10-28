# EKL-02 — Eklenti kur/güncelle/kaldır ve paket bağımlılıkları
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-28 13:10 · Senaryo: `e2e/ozellik/ekl-02.spec.js` · Koşu: 5/5, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol 1: servis/eklenti kataloğu, paket bilgileri ve durum rozetleri | geçti | `/servers` UI tablosu, Nginx/Cron/MariaDB/Docker rozetleri |
| mutlu yol 2: API servis envanteri ve gerçek APT/dpkg paketleri | geçti | `dpkg-query` paket sürümleri & `systemctl` active & updates API |
| hatalı girdi ve güvenlik: geçersiz ID, eksik confirmation, geçersiz eylem | geçti | HTTP 400 (`unsupported_managed_service`/`action`) |
| eksiklik 1: Plesk Extensions Marketplace ve 3. parti eklenti (.zip) yokluğu | bilinen hata (test.fail) | `/api/panel/extensions` & `catalog` 404 |
| eksiklik 2: eklenti/servisi bağımlılıklarıyla tamamen kaldırma (purge) yokluğu | bilinen hata (test.fail) | `/api/panel/servers/:id/services/:id/uninstall` 404 |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk Extensions Marketplace ve harici eklenti (.zip/SDK) desteği yokluğu | — |
| NORMAL | Yönetilen servislerde bağımlılıkları temizleyerek tam kaldırma (uninstall) yokluğu | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/managed-service-snapshot.test.js` | GEÇERLİ | Servis kurulum ve kontrol durumlarının envantere uygulanması |
| `apps/api/test/system-package-flow.test.js` | GEÇERLİ | Sistem paket denetimi ve güncelleme iş kuyruğu |

## Panelde olmayan
- Plesk Extensions Marketplace / Catalog API ve harici uzantı (.zip/.tar) yükleme/yönetme motoru.
- Kurulu eklenti ve servisleri paket bağımlılıklarıyla sistemden tamamen kaldıran (purge/uninstall) mekanizma.

## Temizlenemeyen kaynaklar
—
