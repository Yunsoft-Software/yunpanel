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
    mfa_invalid_code: 'Kod hatalı veya daha önce kullanılmış. Uygulamadaki sonraki kodu ya da kullanılmamış bir kurtarma kodunu girin.',
    mfa_challenge_expired: 'Doğrulama süresi veya deneme hakkı doldu. Yeniden giriş yapın.',
    mfa_enrollment_expired: 'Kurulumun süresi doldu veya başka bir oturumda başlatıldı. Kurulumu yeniden başlatın.',
    mfa_already_enabled: 'İki aşamalı doğrulama zaten açık.',
    mfa_key_unavailable: 'Sunucu MFA anahtarına erişilemiyor. Yöneticiniz şifreleme anahtarını veya yerel kurtarma prosedürünü kontrol etmeli.',
    invalid_secret_master_key: 'Sunucunun şifreleme anahtarı geçersiz. Yöneticiniz yapılandırmayı kontrol etmeli.',
  };
  return messages[error.code] ?? (error instanceof TypeError ? 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.' : error.message);
}
