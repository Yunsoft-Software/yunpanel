# DEV-04 — Laravel oluşturma, repository'den kurma ve mevcut app tarama
Sonuç: KISMİ
Ajan: AGENT_3 · Tarih: 2026-10-27 16:07 · Senaryo: `e2e/ozellik/dev-04.spec.js` · Koşu: 2/5 geçen, 3 test.fail

## Senaryolar
| Test adı | Sonuç (geçti/düştü/bilinen hata) | Fiziksel kanıt |
| mutlu yol: PHP/Laravel hazır ayarı ile site oluşturma, docroot ve Composer | geçti | Nginx conf fastcgi_pass, public/ docroot, HTTP 200/403 |
| hatalı girdi / API: desteksiz Laravel uç noktası ve form validasyonu | geçti | API 404, invalidAction 400, HTML5 form validasyonu |
| eksiklik: Install Laravel sihirbazı | bilinen hata (test.fail) | UI üzerinde Install Laravel / Laravel sekmesi yok |
| eksiklik: Git deposundan Laravel kurma (Deploy from Git) | bilinen hata (test.fail) | PHP sitelerinde Git dağıtım sekmesi / desteği yok |
| eksiklik: Mevcut Laravel app tarama ve bağlama (Scan / Attach) | bilinen hata (test.fail) | Dizin tarama ve Laravel bağlama butonu yok |

## Hatalar
| Sınıf | Başlık | Bulgu görevi |
| NORMAL | Plesk eşdeğeri hazır Laravel kurulum sihirbazı (Install Laravel) yok | — |
| NORMAL | Plesk eşdeğeri Git deposundan Laravel kurma (Deploy from Git) PHP sitelerinde yok | — |
| NORMAL | Plesk eşdeğeri mevcut Laravel uygulamasını tarama/bağlama (Scan/Attach) aracı yok | — |

## Mevcut testler
| Dosya | Sınıf | Not |
| `apps/web/test/jamstack-presets-and-git-dx.test.js` | GEÇERLİ | PHP/WordPress/Laravel hazır ayar etiketini doğrular |
| `apps/api/src/non-reseller-capabilities.js` | YÜZEYSEL | DEV-04 /framework/laravel partial capability beyanı |

## Panelde olmayan
Plesk Obsidian Laravel Toolkit eşdeğerliği: hazır Laravel kurulum sihirbazı (composer create-project, env/app key üretimi), Git deposundan Laravel kurma ve mevcut sitelerdeki Laravel uygulamalarını tarayıp bağlama (Scan / Attach).

## Temizlenemeyen kaynaklar
—
