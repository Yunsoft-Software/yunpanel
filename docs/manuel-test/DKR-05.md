# DKR-05 — Compose stack oluşturma/yükleme/güncelleme/up/stop/down
Sonuç: ÇALIŞIYOR
Ajan: AGENT_2 · Tarih: 2026-10-27 14:06 · Senaryo: `e2e/ozellik/dkr-05.spec.js` · Koşu: 2/2 geçti, test.fail 0

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| Hatalı girdi: geçersiz compose YAML sözdizimi doğrulamada reddedilir | Geçti | Modal içinde `.ws-notice-warn` hata bildirimi gösterildi |
| Mutlu yol: compose stack dosyası yükleme, oluşturma, up, güncelleme, stop ve down yaşam döngüsü | Geçti | `docker compose ps` Up, `curl` 18xxx HTTP 200, YAML revizyon artışı, Stop Exited, Down absent |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/docker-compose-http.test.js` | MOCK | HTTP rotalarını in-memory fixture ile test eder; host ve docker bağlantısı yok |
| `packages/host-runtime/test/docker-compose-manager.test.js` | MOCK | Compose komut haritalaması ve çalışma dizinlerini stub'lar üzerinden doğrular |
| `e2e/ozellik/dkr-02.spec.js` | GEÇERLİ | Tekil container lifecycle'ını test eder; dosya yükleme, stack güncelleme ve çoklu servis yok |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
