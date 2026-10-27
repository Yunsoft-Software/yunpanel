# DOS-09 — Dosya adı/içerik araması, gizli dosyalar, izinler
Sonuç: KISMİ
Ajan: AGENT_4 · Tarih: 2026-10-27 15:37 · Senaryo: `e2e/ozellik/dos-09.spec.js` · Koşu: 3/3, test.fail 1

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| --- | --- | --- |
| mutlu yol: dosya adı araması, gizli dosyalar görünürlüğü, chmod izinlerini değiştirme ve sunucuda stat/ls doğrulaması | geçti | UI izin güncellemesi (0640 -> 0644) sonrası sunucuda SSH `stat -c '%a'` çıktısının `644` olduğunun doğrulanması |
| hatalı girdi ve sınır senaryoları: world-writable engeli, geçersiz chmod ve yetkisiz izin istekleri reddedilir | geçti | UI world-write checkbox'ın kilitli olması; API 400 `site_file_mode_unsafe`, `site_file_mode_invalid`, `site_file_path_invalid` yanıtları; sunucuda dosyanın güvenli 640 modunda kalması |
| içerik araması: Plesk eşdeğeri dosya içerik araması (content search / full-text) | bilinen hata (test.fail) | Panel dosya arama motorunun yalnızca dosya adı filtrelemesi yapması, dosya içi metin eşleşmesiyle dosyayı bulamaması |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| --- | --- | --- |
| NORMAL | Plesk eşdeğeri dosya içerik araması (full-text content search) panelde bulunmuyor; arama yalnızca dosya adıyla sınırlı | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| --- | --- | --- |
| `apps/web/test/file-workspace-model.test.js` | GEÇERLİ | Arama filtreleme, gizli dosya görünürlüğü, izin parse/format ve safe chmod kontrolleri |
| `apps/api/test/site-file-http.test.js` | GEÇERLİ | İzin uç noktaları, yetkilendirme, geçersiz format ve yetkisiz erişim kontrolleri |
| `apps/api/test/site-file-worker.test.js` | GEÇERLİ | Fiziksel dosya chmod, world-writable ve path traversal güvenlik engelleri |

## Panelde olmayan
Dosya içerik araması (Plesk eşdeğeri recursive content/grep search); arama kutusu yalnızca geçerli dizindeki dosya adlarını filtreler.

## Temizlenemeyen kaynaklar
—
