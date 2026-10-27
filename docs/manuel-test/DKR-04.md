# DKR-04 — Domain reverse-proxy bağlantısı ve container log/terminal
Sonuç: KISMİ
Ajan: AGENT_1 · Tarih: 2026-10-27 14:06 · Senaryo: `e2e/ozellik/dkr-04.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| Mutlu yol: container ve subdomain reverse-proxy | geçti | Nginx `proxy_pass` direktifi, canlı HTTP 200 yanıtı, UI log paneli |
| Hatalı girdi: geçersiz port ve hedef çakışması | geçti | HTML5 port kısıtı, 409 çakışma engeli |
| Eksik özellik: container terminal (Plesk parity) | bilinen eksiklik (test.fail) | Docker detayında web terminal / console bileşeni yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Container web terminali / shell konsolu eksik | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `e2e/ozellik/dkr-02.spec.js` | GEÇERLİ | Container yaşam döngüsü doğrulaması |
| `apps/api/test/docker-plesk-parity-and-subdomain-root.test.js` | GEÇERLİ | Proxy kuralı ve domain hedefi çözümü |
| `apps/web/test/docker-compose-config.test.js` | GEÇERLİ | UI port ve proxy eşleme etiketleri |

## Panelde olmayan
Plesk eşdeğeri container terminal / interaktif web shell (`docker exec` konsolu).

## Temizlenemeyen kaynaklar
—
