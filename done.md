# Tamamlanan Görevler

## 2026-09-28 — RS-02e: Bayi ve müşteri veri modelleri ile tenant sınırlarının yapılandırılması
- Bayi ve müşteri veri modelleri `@yunpanel/shared/src/tenant.js` içinde açıkça ayrıştırıldı, alt bayi engeli (`resellerId: null`) ve tek seviye hiyerarşi (`Owner → isteğe bağlı tek Reseller → Customer → Website`) tanımlandı.
- Tüm ilgili varlıkların (Website, Domain, Application, Database, MailDomain, Mailbox, Job) tenant sahiplik projeksiyonu ve erişim kuralları belirlendi; `websiteIds` kapsamı nesne web sitesi veya siteye bağlı varlık olduğunda hem müşteri hem bayi için zorunlu hale getirildi.
- `apps/api/src/tenant-boundary.js` yetki/middleware ve sınır ayrımı katmanı eklendi; doğrudan Owner varlıkları (`resellerId === null`) bayilere karşı fail-closed kapatıldı, müşteri rotalarında yetkisiz rollere 403 uygulandı, eksik `customerLookup` bağımlılığında fail-closed (503) koruması sağlandı, henüz `customerId` atanmamış legacy siteler için `site_manager` uyumluluğu korundu.
- `apps/web/test/server.test.js` elFinder gateway erişim iptali güvenlik testleri ('/api/elfinder-gateway-access' sorgusu ve websiteId doğrulaması) eksiksiz restore edildi; `@yunpanel/shared` ve `apps/api` test paketleri ile dokümantasyon güncellendi.
