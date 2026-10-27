# DKR-01 — Registry/image arama, indirme ve image yönetimi
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-27 16:15 · Senaryo: `e2e/ozellik/dkr-01.spec.js` · Koşu: 3/4 geçti, test.fail 1

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: Docker Hub kataloğunda imaj arama ve kategori filtreleme | Geçti | DOM `.yp-docker-catalog-card` görünümü, `/api/panel/docker/catalog` JSON cevabı (200, redis öğesi) |
| Hatalı girdi: Registry credentials formunda geçersiz URL-formatlı host reddedilir | Geçti | Form içi hata uyarısı (`.ws-notice-warn`), tabloya geçersiz kayıt eklenmedi |
| Mutlu yol: Compose başlatma ile imaj indirme (pull) ve fiziksel docker images doğrulaması | Geçti | SSH `docker images` çıktısında `alpine:3.20`, `docker inspect` Image doğrulaması |
| Plesk eşdeğerlik kontrolü: Bağımsız yerel imaj yönetimi (Local Images listesi ve docker rmi) | Bilinen eksiklik (test.fail) | BULGU DKR-01: Bağımsız yerel imaj listeleme ve imaj silme ekranı bulunmuyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk eşdeğeri bağımsız Local Images listeleme ve tekil docker rmi arayüzü eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/docker-plesk-parity-and-subdomain-root.test.js` | GEÇERLİ | Plesk catalog search, YAML üretimi ve port proxy çözümünü test ediyor |
| `apps/api/test/easypanel-one-click-marketplace.test.js` | GEÇERLİ | 1-Click uygulama kataloğu, parametre ve secret üretimini test ediyor |
| `apps/api/test/docker-registry-credential-registry.test.js` | GEÇERLİ | Registry credential şifreleme ve URL host validasyonunu test ediyor |

## Panelde olmayan
Plesk Docker uzantısında yer alan bağımsız "Local Images" (yerel imajları boyut/tag ile listeleme), doğrudan `docker pull` ve tekil imaj silme (`docker rmi`) ekranı panelde bulunmaz; imajlar yalnızca Compose stack yaşam döngüsüyle dolaylı yönetilir.

## Temizlenemeyen kaynaklar
—
