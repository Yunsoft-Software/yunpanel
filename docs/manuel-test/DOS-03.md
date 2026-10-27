# DOS-03 — Dosya/klasör oluşturma, yeniden adlandırma ve silme
Sonuç: ÇALIŞIYOR
Ajan: AGENT_4 · Tarih: 2026-10-27 11:15 · Senaryo: `e2e/ozellik/dos-03.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: dosya ve klasör oluşturma, yeniden adlandırma, silme ve fiziksel SSH doğrulaması | geçti | SSH `test -f` / `test -d` ile sunucuda varlık, yeniden adlandırma ve silinme kanıtlandı |
| hatalı girdi: geçersiz dosya adı, ayrılmış isimler ve path traversal denemeleri engellenir | geçti | UI buton devre dışı (disabled) ve backend API HTTP 400 Bad Request koruması |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/file-workspace-model.test.js` | GEÇERLİ | Dosya adı doğrulama, çakışma kontrolü ve bağıl yol güvenliği |
| `apps/api/test/site-file-worker.test.js` | GEÇERLİ | Dosya/klasör oluşturma, yeniden adlandırma, silme ve toplu silme |
| `apps/api/test/site-file-http.test.js` | GEÇERLİ | File Manager HTTP uç noktaları ve doğrulama denetimleri |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
