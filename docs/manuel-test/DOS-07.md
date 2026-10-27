# DOS-07 — Arşiv oluşturma/açma ve güvenli overwrite
Sonuç: ÇALIŞIYOR
Ajan: AGENT_3 · Tarih: 2026-10-27 11:21 · Senaryo: `e2e/ozellik/dos-07.spec.js` · Koşu: 2/2, test.fail 0

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: dosya ve klasör seçip zip arşivi oluşturma, arşivi dizine açma, güvenli overwrite onayı ve fiziksel SSH doğrulaması | geçti | SSH ile `unzip -t` arşiv bütünlüğü (ZIP_VALID) ve açılan dosya içeriğinin üzerine yazılma doğrulaması (`cat`) |
| hatalı girdi: boş arşiv adı, geçersiz dosya adı ve geçersiz çıkartma hedefi (path traversal) reddedilir | geçti | UI buton disabled (`validFileName`), geçersiz hedefte `Hedef klasör yolu geçersiz` uyarısı |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| — | — | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/zip-util.test.js` | GEÇERLİ | PKZIP 2.0 arşivleme, çıkartma, CRC32 ve path traversal koruması |
| `apps/web/test/file-workspace-model.test.js` | GEÇERLİ | Arşiv uzantıları tespiti (`isArchiveFile`) ve hedef yol doğrulama (`validateDestinationPath`) |
| `apps/api/test/site-file-http.test.js` | GEÇERLİ | Dosya indirme (`download`), binary yükleme (`upload`) ve silme HTTP uç noktaları |

## Panelde olmayan
—

## Temizlenemeyen kaynaklar
—
