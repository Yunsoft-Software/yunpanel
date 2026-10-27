# DKR-03 — Port, environment, volume ve restart politikası
Sonuç: ÇALIŞIYOR
Ajan: AGENT_3 · Tarih: 2026-10-27 16:25 · Senaryo: `e2e/ozellik/dkr-03.spec.js` · Koşu: 2/2 geçti, test.fail 0

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| Hatalı girdi: geçersiz environment formatı reddedilir | Geçti | Modal içinde `.ws-notice-error` / `[role="alert"]` hata uyarısı, geçersiz YAML reddi |
| Mutlu yol: port, environment, volume ve restart politikası ile container yönetimi ve fiziksel denetim | Geçti | UI desired/storage tablosu; `docker inspect` (Ports, Env, Mounts, RestartPolicy:unless-stopped), `curl` 18xxx HTTP 200, volume disk dosyası, dynamic env update, remove |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `e2e/10-docker-compose.spec.js` | KISMİ | Proje oluşturma ve preview testi yapıyor, derin port/env/vol/restart fiziksel denetimi yok |
| `packages/host-runtime/test/docker-compose-manager.test.js` | GEÇERLİ | Birim seviyesinde docker compose komut oluşturma ve bayrak eşlemesini test ediyor |
| `apps/web/test/docker-compose-model.test.js` | GEÇERLİ | Frontend environment satır formatı (`KEY=value`) ayrıştırma ve doğrulama birim testi |

## Panelde olmayan
Plesk'te port/env/volume/restart için ayrı GUI form satırı ekleme butonları bulunurken; YunPanel'de bu ayarlar Compose YAML editörü ve şifreli Compose Environment paneli üzerinden yönetilmektedir.

## Temizlenemeyen kaynaklar
—
