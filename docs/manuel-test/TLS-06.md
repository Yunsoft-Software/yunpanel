# TLS-06 — Geçerlilik, gerçek sunulan sertifika, durum ve uyarılar
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-11-04 11:30 · Senaryo: `e2e/ozellik/tls-06.spec.js` · Koşu: 5/5 geçti (3 geçti, 2 test.fail)

## Senaryolar
| Test adı | Sonuç | Fiziksel kanıt |
|---|---|---|
| Mutlu yol: Web siteleri kart rozetleri, SSL sekmesi, Sistem Uyarıları ve canlı TLS doğrulaması | Geçti | Nginx :443 SNI TLSv1.3 el sıkışması (`tls.connect` & `openssl s_client`), SHA-256 fingerprint (`55:16:...`), API verify-tls `matches: true` |
| Hatalı girdi ve sınırlar: ACME e-posta doğrulama, canlı TLS uyuşmazlığı ve kısmi reload | Geçti | UI buton blokajı, 409 `http_domain_not_active`, 400 `invalid_certificate_request`, 409 `wildcard_not_supported`, `reason: "fingerprint_mismatch"`, reload partial |
| Güvenlik ve yetki: CSRF koruması, anonim erişim ve site_manager kiracı izolasyonu | Geçti | 403 `csrf_invalid`, 401 anonim GET, 401/403 anonim POST, site_manager Owner cert erişim engeli (403/404) |
| BULGU: /websites/:id/ssl sekmesinde canlı sunulan sertifika doğrulaması ve kimlik detayları | Bilinen hata | `test.fail` — SSL sekmesinde issuer, fingerprint256 ve canlı TLS doğrulama göstergesi eksik |
| BULGU: NotificationCenterDrawer kısmi servis reload durumunda sistem uyarısı üretmiyor | Bilinen hata | `test.fail` — `certificate_reload_partial` durumunda Sistem Uyarıları sekmesinde uyarı üretilmiyor |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
|---|---|---|
| NORMAL | /websites/:id/ssl sekmesinde canlı sunulan sertifika doğrulaması ve kimlik detayları (issuer, fingerprint) eksik | — |
| NORMAL | NotificationCenterDrawer kısmi servis reload (certificate_reload_partial) durumunda sistem uyarısı üretmiyor | — |

## Mevcut testler
| Dosya | Sınıf | Not |
|---|---|---|
| `apps/api/test/certificate-http.test.js` | GEÇERLİ | 7/7 geçti. verify-tls, reload-outcome, preview/import ve RBAC sınırlarını gerçek Express üzerinde ölçüyor |
| `apps/api/test/ssl-renewal.test.js` | GEÇERLİ | 92/92 geçti. compareTlsPresentation, reloadOutcome ve React yenileme durum makinesini doğruluyor |
| `e2e/07-ssl-certificates.spec.js` | KIRMIZI | Eski tablo seçicisi (`table.ws-table`) nedeniyle başarısız oluyor; canlı verify-tls kontrolü eksik |

## Panelde olmayan
- `/websites/:id/ssl` sekmesinde canlı sunulan sertifika (`verify-tls`) doğrulama göstergesi ve sertifika sağlayıcı/parmak izi detayları
- `NotificationCenterDrawer` içinde servis reload teşhis ve kısmi hata uyarıları

## Temizlenemeyen kaynaklar
— (Tüm `ttls06-a4-*` alan adları ve kullanıcıları afterAll içinde arayüzden ve API üzerinden sweep edilerek temizlendi, kanıtlandı)
