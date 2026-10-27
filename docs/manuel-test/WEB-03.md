# WEB-03 — Domain alias (ek alan adı; web/mail/DNS ve yönlendirme tercihleri)
Sonuç: ÇALIŞIYOR
Ajan: AGENT_2 · Tarih: 2026-10-27 10:50 · Senaryo: `e2e/ozellik/web-03.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: domain alias ekleme, yayına uygulama, fiziksel HTTP ve canonical yönlendirme | geçti | HTTP GET alias Host: 500 (statik vhost hazır, 301 değil); canonicalRedirect: true sonrası HTTP GET /sayfa-1: 301 Moved Permanently (`Location: http://<primary>/sayfa-1`) |
| Hatalı girdi: geçersiz sözdizimi ve mükerrer domain alias reddedilir | geçti | Protokol içeren girdide UI uyarısı "Yalnız alan adını girin"; ana alan adı mükerrerliğinde "Ana alan adı veya aynı ek alan adı ikinci kez eklenemez" doğrulandı |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/domain-alias-ui.test.js` | YÜZEYSEL | Kaynak regex/metin kontrolleri; gerçek DOM/API yok |
| `apps/api/test/domain-alias-lock-and-sync.test.js` | GEÇERLİ | Backend lock & revision sync mantığını doğrular (7/7 geçti) |
| `e2e/12-domain-operations.spec.js` | KIRMIZI | Eski tablo seçicileri yeni kart tasarımında başarısız |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
