# API-03 — CLI, olay handler'ları ve otomatik provisioning
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-28 13:25 · Senaryo: `e2e/ozellik/api-03.spec.js` · Koşu: 4/4, test.fail 2

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: Web sitesi oluştur, otomatik provisioning adımlarını doğrula | geçti | Unix kullanıcısı, docroot, vhost ve curl HTTP 200 |
| Hatalı girdi: Geçersiz provisioning ve yetkisiz işlem denetimi | geçti | 404/400 API cevapları ve form validasyon hatası |
| Parity gap: CLI ile provisioning araçları (plesk bin benzeri) | bilinen hata | Sunucuda yunpanel / plesk CLI komut satırı aracı yok |
| Parity gap: Olay tetikleyicileri (Event Handlers) | bilinen hata | Araçlar & Ayarlar altında Olay Tetikleyicisi UI/API yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk CLI benzeri provisioning CLI komutu bulunmuyor | — |
| NORMAL | Plesk Event Handlers (Olay Tetikleyicileri) mekanizması bulunmuyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| apps/api/test/website-provisioning-http.test.js | GEÇERLİ | Provisioning event ve step API durumlarını doğruluyor |
| apps/api/test/auth-cli.test.js | GEÇERLİ | Auth CLI komutlarını ve çıkış kodlarını test ediyor |
| apps/api/test/local-runtime-cli-entry.test.js | GEÇERLİ | Runtime CLI giriş noktası ve yetkilendirmeyi test ediyor |

## Panelde olmayan
Plesk Event Manager / Event Handlers arayüzü ve CLI üzerinden alan adı/site provisioning araçları (`plesk bin domain`).

## Temizlenemeyen kaynaklar
—
