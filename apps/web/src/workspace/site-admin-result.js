const MESSAGES = Object.freeze({
  site_admin_conflict: 'Bu kullanıcı adı zaten kullanılıyor. Mevcut hesabı otomatik olarak siteye bağlamadık; kullanıcı yönetiminden kontrol edin.',
  site_admin_input_invalid: 'Yönetici hesabı bilgileri kabul edilmedi. Site kaydı korundu; kullanıcı yönetiminden hesabı kontrol edin.',
  site_admin_busy: 'Hesap oluşturma tamamlanamadı. Yeniden site oluşturmadan önce kullanıcı kayıtlarını kontrol edin.',
  site_admin_unavailable: 'Kullanıcı yönetimi bu istekte kullanılamadı. Site kaydı oluşturuldu ancak yönetici hesabı doğrulanmadı.',
  site_admin_actor_unavailable: 'Hesap işlemini yapan kullanıcı doğrulanamadı. Site ve kullanıcı kayıtlarını güncel oturumla kontrol edin.',
  site_admin_replay_requires_review: 'Mevcut site kaydı kullanıldı. Yönetici hesabı yeniden oluşturulmadı veya parolası değiştirilmedi; hesabın durumunu kontrol edin.',
  site_admin_result_unverified: 'Yönetici hesabının sonucu doğrulanamadı. Siteyi yeniden oluşturmayın; mevcut kullanıcıları ve site yetkilerini kontrol edin.',
});

export function siteAdminResult(value, { requested, websiteId }) {
  if (!requested) return Object.freeze({ status: 'not_requested', code: null });
  const valid = value && typeof value === 'object' && !Array.isArray(value) && value.websiteId === websiteId;
  if (valid && value.status === 'created' && value.code === null) return Object.freeze({ status: 'created', code: null });
  const code = valid && value.status === 'attention' && Object.hasOwn(MESSAGES, value.code)
    ? value.code : 'site_admin_result_unverified';
  // Never retain a raw server response or reuse another site's account result.
  return Object.freeze({ status: 'attention', code });
}
export function siteAdminMessage(value) {
  if (value?.status === 'created') return 'Yönetici hesabı oluşturuldu ve bu siteye bağlı olduğu doğrulandı. Gerçek giriş ve erişimi ayrıca kontrol edin.';
  return Object.hasOwn(MESSAGES, value?.code) ? MESSAGES[value.code] : MESSAGES.site_admin_result_unverified;
}
