# RUN-06 — Node paket kurulumu, script, restart ve loglar
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-27 12:40 · Senaryo: `e2e/ozellik/run-06.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| hatalı girdi: geçersiz repo ve process API eylemi reddedilir | geçti | Form validasyon bildirimi ve API 400/404 hata kodu |
| mutlu yol: Node paket kurulumu, restart ve canlı loglar | geçti | Nginx vhost passenger on, host node_modules, log paneli ve indirme linki |
| Plesk eşdeğerliği: NPM paket kurma ve script çalıştırma kontrolleri | bilinen hata | test.fail: Panelde bağımsız NPM install ve Run Script butonları eksik |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Panel UI'da bağımsız NPM paket kurma ve Run Script düğmeleri yok (yalnız Git deploy ve terminalde var) | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `packages/host-runtime/test/website-node-release-manager.test.js` | GEÇERLİ | Node release yönetimi, rollback ve switchRetainedRelease testleri |
| `apps/web/test/logs-panel-site.test.js` | GEÇERLİ | Site log paneli, kaynak seçici (Node.js/Nginx) ve indirme linki UI testi |
| `apps/api/test/node-restart-flow.test.js` | GEÇERLİ | Node restart akışı, yetkilendirme ve servis sağlık doğrulaması |

## Panelde olmayan
Plesk Node.js yönetim ekranındaki bağımsız "NPM Install <paket>" ve package.json scriptlerini arayüzden tek tıkla çalıştıran "Run Script" butonları.

## Temizlenemeyen kaynaklar
—
