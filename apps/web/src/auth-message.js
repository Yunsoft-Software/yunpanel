export function authMessage(error) {
  const messages = {
    invalid_credentials: 'Kullanıcı adı, parola veya kurulum anahtarı geçersiz.',
    rate_limited: 'Çok fazla deneme yapıldı. Bir süre sonra tekrar deneyin.',
    auth_busy: 'Giriş hizmeti meşgul. Tekrar deneyin.',
    invalid_password: 'Parolanız en az 12 karakter olmalıdır.',
    already_configured: 'İlk kurulum tamamlanmış. Sayfayı yenileyip giriş yapın.',
    origin_forbidden: 'Panel adresi sunucu ayarıyla eşleşmiyor. Yöneticiniz public origin ayarını kontrol etmeli.',
    csrf_invalid: 'Oturum doğrulanamadı. Sayfayı yenileyin.',
    session_superseded: 'Oturum değişti. İşlemi yeniden deneyin.',
    invalid_secret_master_key: 'Sunucunun şifreleme anahtarı geçersiz. Yöneticiniz yapılandırmayı kontrol etmeli.',
    mfa_invalid_code: 'Kod geçersiz veya kullanılmış. Yeni uygulama kodunu bekleyin ya da kullanılmamış kurtarma kodunu girin.',
    mfa_challenge_expired: 'Doğrulama süresi doldu. Kullanıcı adı ve parolanızla yeniden başlayın.',
    mfa_enrollment_expired: 'Kurulum süresi doldu veya başka oturumda yenilendi. Kurulumu yeniden başlatın.',
    mfa_key_unavailable: 'Sunucudaki MFA şifreleme anahtarı kullanılamıyor. Yöneticiniz anahtar veya yerel kurtarma ayarını kontrol etmeli.',
    mfa_already_enabled: 'Hesabınızda doğrulayıcı zaten etkin. Durumu yenileyin.',
    smtp_unavailable: 'E-posta servisi şu anda kullanılamıyor. Parola sıfırlama e-postası gönderilemiyor.',
    mail_delivery_failed: 'E-posta teslim edilemedi. Sunucu e-posta ayarlarını kontrol edin.',
    invalid_reset_token: 'Geçersiz veya süresi dolmuş parola sıfırlama bağlantısı.',
    reset_token_expired: 'Parola sıfırlama bağlantısının süresi dolmuş. Lütfen yeniden talep edin.',
    invalid_email: 'Geçerli bir e-posta adresi girin.',
    email_in_use: 'Bu e-posta adresi başka bir hesap tarafından kullanılıyor.',
    invalid_identifier: 'Kullanıcı adı veya kurtarma e-postası girin.',
  };
  return messages[error?.code] ?? (error instanceof TypeError ? 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.' : error?.message ?? 'İşlem tamamlanamadı.');
}
