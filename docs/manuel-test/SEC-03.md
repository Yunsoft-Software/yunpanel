# SEC-03 — ModSecurity/WAF policy, ruleset ve domain istisnaları
Sonuç: ÇALIŞMIYOR
Ajan: AGENT_2 · Tarih: 2026-10-28 12:25 · Senaryo: `e2e/ozellik/sec-03.spec.js` · Koşu: 3/3, test.fail 3

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: Plesk eşdeğeri ModSecurity / WAF politikaları, kural setleri ve domain istisnaları yönetimi | bilinen hata (test.fail) | Sitede WAF kartı/sekmesi yok; `/api/panel/websites/:id/waf` 404/405 |
| hatalı girdi: geçersiz WAF modu veya hatalı kural ID parametreleri reddedilir (400 validation) | bilinen hata (test.fail) | WAF API endpoint'i bulunmadığından 400 validation yerine 404/405 |
| fiziksel kanıt: test sunucusunda Nginx ModSecurity modülü ve kural dizini varlığı | bilinen hata (test.fail) | `yunpanel-test`'te `libnginx-mod-http-modsecurity` ve `/etc/nginx/modsec/` yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk Web Application Firewall (ModSecurity) eşdeğeri UI, API ve sunucu modülü uygulanmamış | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/api/src/non-reseller-capabilities.js` | YÜZEYSEL | SEC-03 yetenek tablosunda 'partial' olarak kayıtlı ancak rotası yok |
| `apps/api/src/domain-nginx-settings.js` | GEÇERLİ | Yalnız temel Nginx ayarlarını (gzip, clientMaxBodySize, cache) yansıtıyor |
| `e2e/ozellik/sec-01.spec.js` | GEÇERLİ | Port ve firewall yönetimi (WAF dışı L3/L4 ağ katmanı) |

## Panelde olmayan
Plesk Tools & Settings ve domain Web Application Firewall (ModSecurity): WAF modu (On, DetectionOnly, Off), kural seti seçimi (OWASP CRS, Comodo), hazır ön ayarlar (Fast, Balanced, Thorough), kural istisnaları / ID whitelist (rule exclusions).

## Temizlenemeyen kaynaklar
—
