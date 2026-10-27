# RUN-07 — Composer bağımlılık yönetimi
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-27 15:45 · Senaryo: `e2e/ozellik/run-07.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| hatalı girdi: geçersiz Composer komut parametreleri ve yetkisiz işlem reddedilir | geçti | API 400 ve 404 doğrulama yanıtı |
| mutlu yol: PHP sitesi oluşturma, UI Composer durumunun tespiti ve composer.json varlığının canlı algılanması | geçti | Nginx HTTP 301, SSH composer.json teyidi, UI'da composer.json Var ve Uygulama kökü durumu |
| Plesk eşdeğerliği: UI üzerinden Composer bağımlılık kurulumu (composer install/update) ve paket yönetimi | bilinen hata | test.fail: Panelde Composer install/update butonları, paket arama/kurma ve dahili editör eksik |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Panel UI üzerinde Composer install, update ve paket kurulumu düğmeleri bulunmuyor; paket yönetimi terminale bağımlı | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `packages/host-runtime/test/php-cli-tool-manager.test.js` | MOCK | Composer ikili tespiti, allowlist argüman denetimi ve runuser birim testleri |
| `apps/web/test/php-tools-client.test.js` | MOCK | Composer durum ve model doğrulama testleri |
| `apps/web/test/php-tools-wiring.test.js` | YÜZEYSEL | UI bileşen ve rota regex desen kontrolleri |

## Panelde olmayan
Plesk Composer Toolkit eşdeğeri "Composer Install", "Composer Update", "Paket Ekle (Require)", paket listeleme/kaldırma ve yerleşik composer.json düzenleme arayüzü; canlı sunucuda Composer CLI ikilisi önceden kurulu gelmemektedir.

## Temizlenemeyen kaynaklar
—
