// Shared Turkish messages for generic API error codes. Domain clients keep
// their own messages and pass them to apiErrorMessage; a domain message for
// the same code wins over the generic one.
export const API_ERROR_MESSAGES = Object.freeze({
  unauthorized: 'Oturumunuz sona erdi. Yeniden giriş yapın.',
  csrf_invalid: 'Oturum doğrulanamadı. Yeniden giriş yapın.',
  forbidden: 'Bu işlem için yetkiniz bulunmuyor.',
  rate_limited: 'Çok fazla deneme yapıldı. Biraz sonra tekrar deneyin.',
  session_superseded: 'Oturum değişti. İşlemi yeniden deneyin.',
  mfa_enrollment_required: 'Yönetim için iki adımlı doğrulamayı tamamlayın.',
});

export function apiProblem(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function apiErrorMessage(error, messages, fallback) {
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code && Object.hasOwn(messages, code)) return messages[code];
  if (code && Object.hasOwn(API_ERROR_MESSAGES, code)) return API_ERROR_MESSAGES[code];
  return typeof fallback === 'function' ? fallback(error) : fallback;
}
