# RUN-04 — MIME, index, hata sayfaları ve parola korumalı dizinler
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-27 15:52 · Senaryo: `e2e/ozellik/run-04.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: Başlangıç dosyaları ve özel 404 sayfası yapılandırma | Geçti | Nginx `index` ve `error_page 404` direktifleri, HTTP 200 öncelikli dosya ve HTTP 404 özel HTML yanıtı |
| Hatalı girdi: Index/hata sayfası çakışması ve geçersiz format | Geçti | UI hata uyarısı, `nginx -t` sözdizim geçerliliği ve yapılandırma bütünlüğü |
| Plesk eşdeğerlik eksiklikleri: Parola korumalı dizinler, MIME editörü | Bilinen hata (test.fail) | Plesk eşdeğeri dizin koruma, MIME eşleme ve autoindex UI'da yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk eşdeğeri Parola korumalı dizinler (Password-Protected Directories) arayüzü eksik | — |
| NORMAL | Plesk eşdeğeri özel MIME türleri yönetim editörü (MIME Types) eksik | — |
| NORMAL | Plesk eşdeğeri Directory Browsing (autoindex) açma/kapama seçeneği eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `packages/config-templates/test/nginx-protected-paths.test.js` | GEÇERLİ | Nginx map, auth_basic direktifi ve htpasswd izolasyonunu test ediyor |
| `packages/config-templates/test/nginx-file-settings.test.js` | GEÇERLİ | indexFiles ve errorPages şablon üretimini ve durum kodlarını test ediyor |
| `apps/api/test/protected-path-http.test.js` | GEÇERLİ | API PUT/GET/DELETE ve SHA-512 htpasswd yönetimini test ediyor |
| `apps/web/test/protected-paths-ui.test.js` | YÜZEYSEL | Yalnızca SSR HTML çıktı metnini kontrol ediyor |

## Panelde olmayan
- Plesk eşdeğeri Parola Korumalı Dizinler (Password-Protected Directories / HTTP Basic Auth) kullanıcı yönetim arayüzü
- Plesk eşdeğeri uzantı -> MIME türü eşleme editörü (MIME Types)
- Plesk eşdeğeri Directory Browsing / Autoindex (dizin listeleme) açma/kapatma seçeneği

## Temizlenemeyen kaynaklar
—
