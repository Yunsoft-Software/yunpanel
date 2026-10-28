# EKL-01 — Uygulama kurucu/katalog; site ve DB kurulum bütünlüğü
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-28 12:52 · Senaryo: `e2e/ozellik/ekl-01.spec.js` · Koşu: 5/5, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: market arayüzü, filtreler, şablon kartları ve önizleme | geçti | `/api/panel/docker/one-click-apps` & `prepare` API 200 |
| fiziksel kanıt: sunucu katalog kodları ve compose çıktısı | geçti | `docker-plesk-catalog.js` & 14+ şablon & EKL-01 yetenek kaydı |
| hatalı girdi: geçersiz ID, eksik parametre ve port hataları | geçti | HTTP 400 (`invalid_template_id`/`invalid_outer_port`), 404 |
| eksiklik: Application Vault / APS lisans ve sürüm seçici yokluğu | bilinen hata (test.fail) | `/api/panel/applications/vault` 404 |
| eksiklik: yetenek kaydındaki `/api/applications/catalog` rotası | bilinen hata (test.fail) | `/api/panel/applications/catalog` 404 |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk APS Vault ticari lisans ve sürüm seçici yokluğu | — |
| NORMAL | non-reseller listesindeki `/api/applications/catalog` 404 | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/easypanel-one-click-marketplace.test.js` | GEÇERLİ | 1-Click apps listeleme, secret üretimi, prepare birim testleri |
| `apps/api/test/scenarios-docker-oneclick-os-matrix.test.js` | GEÇERLİ | Docker Hub ve katalog arama rotaları |

## Panelde olmayan
- Plesk Application Vault / APS Katalogu: kurulum öncesi sürüm seçimi (v5/v6), ticari uygulama lisansı yönetimi ve otomatik güncelleme motoru.
- WordPress harici CMS (Joomla, Drupal vb.) için yerel vhost dizinine PHP ve MySQL DB otomatik kurulumu (yalnız Docker compose destekli).

## Temizlenemeyen kaynaklar
—
