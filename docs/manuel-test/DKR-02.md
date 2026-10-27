# DKR-02 — Container oluşturma, başlatma, durdurma, yeniden oluşturma/silme
Sonuç: ÇALIŞIYOR
Ajan: AGENT_4 · Tarih: 2026-10-27 13:55 · Senaryo: `e2e/ozellik/dkr-02.spec.js` · Koşu: 2/2 geçti, test.fail 0

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| Hatalı girdi: geçersiz compose YAML dokümanı reddedilir | Geçti | Modal içi uyarı (`.ws-notice-warn`), form submit engellendi |
| Mutlu yol: container CRUD ve lifecycle döngüsü | Geçti | `docker ps` Up, `curl` Nginx 200, `docker inspect` Running:true, `docker ps -a` Exited/absent |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `e2e/10-docker-compose.spec.js` | KISMİ | Proje oluşturma ve preview testi yapıyor, gerçek lifecycle ve docker ps kanıtı yok |
| `packages/host-runtime/test/docker-compose-manager.test.js` | GEÇERLİ | Birim seviyesinde docker CLI argümanları ve execute mantığı test ediliyor |
| `apps/api/test/local-docker-compose-operation.test.js` | GEÇERLİ | Birim seviyesinde işlem onay fişi ve bundle doğrulamasını test ediyor |

## Panelde olmayan
Plesk'te bulunan doğrudan tekil container üzerinde "Recreate (yeniden oluştur)" butonu ayrı bir aksiyon olarak yer almaz, yerine restart veya compose güncelleme kullanılır.

## Temizlenemeyen kaynaklar
—
