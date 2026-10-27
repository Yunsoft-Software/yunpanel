# DKR-06 — Container yapılandırma yedeği ile volume verisi yedeğinin ayrımı
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-27 16:40 · Senaryo: `e2e/ozellik/dkr-06.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| Hatalı girdi: storage-backup API geçersiz sorgu parametrelerini reddeder ve olmayan projede 404 döner | Geçti | `GET /api/panel/docker/projects/e00.../storage-backup` 404; geçersiz UUID 400; `?unsupported=filter` 400 |
| Mutlu yol: Docker projesinde depolama manifesti ve volume veri katmanının incelenmesi | Geçti | UI `v1` / `Manifest'e dahil` / `Backup dışı`; host `docker volume inspect`, `docker exec` test verisi ve `curl` HTTP 200 |
| Plesk Docker eşdeğerliği: Container yapılandırma yedeği ile volume verisi yedeğinin ayrımı ve seçilebilirliği | Bilinen hata | Panelde Docker container config ve volume data ayrımı sunan yedekleme aracı yok (`test.fail`) |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Container config ve volume data ayrımı sunan yedekleme aracı eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/docker-storage-backup-http.test.js` | MOCK | Rota HTTP durum kodlarını sahte proje verisi üzerinden test eder |
| `apps/api/test/docker-storage-backup-view.test.js` | GEÇERLİ | Proje storage policy ve manifest view dönüşümünü birim seviyesinde test eder |
| `apps/api/test/docker-compose-backup-lock-wiring.test.js` | GEÇERLİ | Yedekleme kilit durumunda Compose operasyonlarının çatışma (409) kontrolü |

## Panelde olmayan
Plesk Docker eklentisinde konteyner yapılandırması (Compose YAML, port, env, etiketler) ile kalıcı veriler (volume data) bağımsız olarak yedeklenebilirken; YunPanel'de Docker depolama manifesti incelenebilmekte fakat konteyner yapılandırması ile volume verisini ayrı ayrı seçerek yedekleyen/geri yükleyen bağımsız bir Docker yedekleme aracı bulunmamaktadır.

## Temizlenemeyen kaynaklar
—
