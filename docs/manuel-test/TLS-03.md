# TLS-03 — Sertifika/anahtar/chain yükleme, CSR ve envanter
Sonuç: KISMİ
Ajan: AGENT_2 · Tarih: 2026-10-28 11:58 · Senaryo: `e2e/ozellik/tls-03.spec.js` · Koşu: 3/6, test.fail 3

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: Özel SSL sertifikası yükleme, fiziksel dosya varlığı, API envanteri ve UI doğrulaması | geçti | SSH ile `/var/lib/yunpanel/control-plane/custom-certificates/<id>/{cert,fullchain,privkey}.pem` dosyaları, `/api/panel/certificates` envanteri ve `/websites/:id/ssl` kartı |
| hatalı girdi: Uyuşmayan özel anahtar ile özel sertifika yükleme 409 ile reddedilir | geçti | 409 Conflict `certificate_private_key_mismatch` |
| hatalı girdi: Alan adı uyuşmazlığı olan sertifika yükleme 409 ile reddedilir | geçti | 409 Conflict `certificate_domain_mismatch` |
| eksik özellik: Plesk SSL/TLS Certificates eşdeğeri CSR oluşturma sihirbazı | bilinen hata | Panelde ve API'de CSR (Certificate Signing Request) oluşturma formu ve uç noktası yok |
| eksik özellik: Plesk eşdeğeri arayüzden Özel Sertifika ve CA Chain yükleme formu | bilinen hata | Backend `custom-preview/custom` desteklerken frontend UI'da özel cert/key/chain yükleme formu yok |
| eksik özellik: Plesk eşdeğeri Alan adı veya Sunucu genelinde Sertifika Deposu ekranı | bilinen hata | Panel arayüzünde tüm sertifikaları listeleyen Plesk eşdeğeri Sertifika Deposu/Envanteri sayfası yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk SSL/TLS Certificates eşdeğeri CSR oluşturma sihirbazı panelde ve API'de eksik | — |
| NORMAL | Özel sertifika, özel anahtar ve CA Chain yükleme formu yalnızca API'de var, UI'da eksik | — |
| NORMAL | Sunucu veya alan adı genelinde sertifikaları listeleyen ve yöneten Sertifika Deposu UI eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/api/test/certificate-http.test.js` | GEÇERLİ | Custom preview/apply, idle lock, domain mismatch ve tenant RBAC birim testleri |
| `packages/host-runtime/test/certificate-material-manager.test.js` | GEÇERLİ | PEM doğrulama, anahtar eşleştirme ve dosya sistemi kurulum testleri |
| `e2e/ozellik/tls-04.spec.js` | GEÇERLİ | Panel/website/mail sertifika atama ve Nginx/Postfix TLS eşdeğerlik testi |

## Panelde olmayan
- Plesk SSL/TLS Certificates -> "Add SSL/TLS Certificate" altındaki CSR parametreleri sihirbazı (Country, State, Org, Email vs.).
- Web sitesi SSL ekranında dosya yükleme veya PEM yapıştırma (Certificate, Private Key, CA Certificate/Chain) arayüzü.
- Alan adı veya sunucu genelinde sertifikaları topluca listeleyen, durumlarını ve bitiş tarihlerini gösteren Sertifika Deposu sayfası.

## Temizlenemeyen kaynaklar
—
