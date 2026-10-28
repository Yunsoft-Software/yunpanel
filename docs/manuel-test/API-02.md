# API-02 — XML API'deki kapsam için uyumluluk/eşdeğer işlem matrisi
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-28 13:00 · Senaryo: `e2e/ozellik/api-02.spec.js` · Koşu: 2/4 geçen, test.fail 2

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: Plesk XML API yetenek ve alan adı operasyonunun REST eşdeğeriyle yürütülmesi ve fiziksel doğrulaması | geçti | Capability API, Nginx vhost SSH kontrolü, port 80 HTTP yanıtı |
| hatalı girdi ve sınır durumu: REST API uç noktalarına XML paket gövdesi gönderildiğinde reddedilir | geçti | HTTP 415/400 ret, servis ve oturum kararlılığı |
| Plesk eksikliği: Plesk XML API agent endpoint (/enterprise/control/agent.php) bulunmuyor | bilinen hata | `test.fail` BULGU API-02-A (404 Not Found) |
| Plesk eksikliği: Plesk XML paketlerini REST çağrılarına dönüştüren otomatik XML-to-REST gateway bulunmuyor | bilinen hata | `test.fail` BULGU API-02-B (404 Not Found) |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk XML API agent endpoint (`/enterprise/control/agent.php`) ve XML RPC desteği yok | BULGU API-02-A |
| NORMAL | Plesk XML paketlerini REST çağrılarına dönüştüren otomatik XML-to-REST gateway katmanı bulunmuyor | BULGU API-02-B |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/test/par-04-non-reseller-capabilities.test.js` | GEÇERLİ | API-02 out_of_scope ve JSON REST standart kaydı doğrulandı |
| `apps/api/test/automation-http.test.js` | GEÇERLİ | REST otomasyon API ve kapsam izolasyonu doğrulandı |
| `apps/api/test/api-key-http.test.js` | GEÇERLİ | REST API anahtarı yaşam döngüsü doğrulandı |

## Panelde olmayan
- Klasik Plesk XML API agent endpoint'i (`/enterprise/control/agent.php`).
- Plesk XML paketlerini (`<packet>`) doğrudan kabul eden XML-RPC parser veya XML-to-REST adapter/gateway.

## Temizlenemeyen kaynaklar
—
