# Domain ve Website sözleşmesi

Website identity is independent from hostname/domain IDs. Website kalıcı UUID ile runtime/Application/Docker/document-root/Unix-user sahipliğini taşır; Domain hostname ve explicit websiteId/parentDomainId ilişkisini taşır. Aynı sunucu/port/root tahmini kalıcı ilişki değildir.

- Parent/child aynı server; dot-boundary hostname doğrulama, missing/cycle/duplicate fail-closed. Alias ayrı Website yapılmaz.
- Bir Application sessizce birden çok Website'ye bağlanmaz; dedicated user/root drift startup'ta engeldir. Proxy için var olmayan Unix kullanıcı uydurulmaz.
- Legacy unbound Domain yalnız exact Website ve preview/migration kurallarıyla bağlanır. General rebind/move açık impact, backup ve rollback ister; hostname/certificate/user/desired-applied revisions korunur.
- Site create preview/apply aynı input ve digest'i kullanır. Metadata hazır site kanıtı değildir. Customer/reseller kapsamı tüm kaynaklarda backend'de uygulanır.
- Domain gibi davranan websiteId route parametresi yeni resolver görevinde düzeltilecek; veri kimlikleri yeniden atanmayacak. [Analiz](audit-2026-10-09.md), [UI](../ui-plan.md), [mimari](architecture.md).
