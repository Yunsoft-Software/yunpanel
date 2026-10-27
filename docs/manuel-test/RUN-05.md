# RUN-05 — Node.js sürümü, app root, startup dosyası ve environment
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-27 11:51 · Senaryo: `e2e/ozellik/run-05.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| hatalı girdi: geçersiz başlangıç dosyası (path traversal / geçersiz karakterler) reddedilir | geçti | Doğrulama hatası (`ws-notice-error`) |
| mutlu yol: Plesk RUN-05 Node.js sürümü, app root, startup dosyası ve ortam değişkenleri | geçti | Nginx vhost port/HTTP yanıtı (>0), gizli `••••••••` ve düz metin değişkenler |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Sitede Node.js sürümü ve startup dosyası düzenleme arayüzü eksik (salt okunur) | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `packages/shared/test/node-application.test.js` | GEÇERLİ | Node runtime konfigürasyon, port ve startup normalizasyon birim testleri |
| `apps/web/test/application-form.test.js` | GEÇERLİ | Node uygulama form doğrulama testleri |
| `apps/api/test/application-configuration-http.test.js` | GEÇERLİ | Node konfigürasyon önizleme ve güncelleme API testleri |

## Panelde olmayan
- Plesk eşdeğeri Node.js sürüm (Node 20/22/24) seçici arayüzü (varsayılan Node 24 sabit).
- Site detayında Node.js sürümü, App Root ve Startup Dosyası değiştirme formu (salt-okunur).
- Git reposu olmadan yerel dizinden/dosyadan Node.js çalıştırma (yalnızca Git tabanlı `new_node`).

## Temizlenemeyen kaynaklar
—
