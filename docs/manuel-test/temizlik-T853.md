# T853 — .28 Test Kalıntısı Temizliği: tweb01–tweb08
Tarih: 2026-11-04 · Yuva: AGENT_2 · Sunucu: .28 (sunucu-28-3)

## 1. Sayımlar ve Sonuç
- Başlangıç: 249 toplam alan adı (45 tweb01–tweb08, 204 ilgisiz)
- Bitiş: 180 toplam alan adı (10 tweb01–tweb08, 170 ilgisiz)
- Sonuç: 35 tweb alan adı başarıyla silindi, 10 alan adı atlandı.
- İlgisiz alan adları T853 tarafından kesinlikle korunmuştur; genel sayıdaki düşüş eşzamanlı koşan T854 (trun01–trun08) ve T847 görevlerinden kaynaklanmaktadır.

## 2. Parti Özeti (10'arlık gruplar)
- Parti 1: 10 işlendi, 3 silindi, 7 atlandı
- Parti 2: 10 işlendi, 7 silindi, 3 atlandı
- Parti 3: 10 işlendi, 10 silindi, 0 atlandı
- Parti 4: 10 işlendi, 10 silindi, 0 atlandı
- Parti 5: 1 işlendi, 1 silindi, 0 atlandı
- Ek (İlk adım): 4 tweb alan adı tekli doğrulama partisinde silindi (tweb01-a3-php, tweb01-a3-shared, tweb02-a2).

## 3. Atlanan / Kalan Kayıtlar (Hata Kodlarıyla)
- Kod `file_cleanup_preflight_failed` / `unix_cleanup_evidence_unavailable` (10 alan adı):
  tweb03-a2-mvqcltvb, tweb05-a3-mvqcnvz0, tweb05-a3-mvqd1jks, tweb02-a1-mvqd5yso,
  tweb05-a3-mvqd6hnf, tweb05-a3-mvqda9xy, tweb03-a2-mvqdkq6b, tweb03-a2-mvqdxvit,
  tweb05-a3-mvqgze7j, tweb02-a1-mvqh49x9.
- Bu hata 3+ kez tekrar ettiği için G3 kuralına uygun olarak T861 bulgusu açıldı ve atlandı.
- Gruptan geriye yalnızca bu bilinen takılma kalmıştır.

## 4. Salt Okunur Başlangıç Envanteri
- İncelenen alan adı sayısı: 45
- Durum dağılımı: draft, active, suspended
- Web sitesi bağı: 45/45 (tümü Website kaynağına bağlı)
- E-posta bağı: 0/45 (hiçbirinde posta alanı bulunmuyor)
