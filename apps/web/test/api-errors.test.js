import assert from 'node:assert/strict';
import test from 'node:test';
import { API_ERROR_MESSAGES, apiErrorMessage, apiProblem } from '../src/api-errors.js';
import { authMessage } from '../src/auth-message.js';
import { auditMessage } from '../src/workspace/audit-client.js';
import { hostingAccountMessage } from '../src/workspace/hosting-account-client.js';
import { userAdminMessage } from '../src/workspace/user-admin-client.js';

test('apiProblem creates an Error carrying the code', () => {
  const error = apiProblem('csrf_invalid');
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'csrf_invalid');
  assert.equal(error.message, 'csrf_invalid');
});

test('apiErrorMessage prefers domain messages, then generic ones, then the fallback', () => {
  const domain = { forbidden: 'Alan mesajı' };
  assert.equal(apiErrorMessage({ code: 'forbidden' }, domain, 'yedek'), 'Alan mesajı');
  assert.equal(apiErrorMessage({ code: 'csrf_invalid' }, domain, 'yedek'), API_ERROR_MESSAGES.csrf_invalid);
  assert.equal(apiErrorMessage({ code: 'unknown_code' }, domain, 'yedek'), 'yedek');
  assert.equal(apiErrorMessage({ code: 'toString' }, domain, 'yedek'), 'yedek');
  assert.equal(apiErrorMessage(null, domain, (error) => `yedek:${error}`), 'yedek:null');
  assert.equal(apiErrorMessage({ status: 404 }, {}, (error) => error.status), 404);
});

test('client messages keep their wording and share generic session messages', () => {
  const csrf = { code: 'csrf_invalid' };
  assert.equal(userAdminMessage(csrf), 'Oturum doğrulanamadı. Yeniden giriş yapın.');
  assert.equal(hostingAccountMessage(csrf), 'Oturum doğrulanamadı. Yeniden giriş yapın.');
  assert.equal(auditMessage(csrf), 'Oturum doğrulanamadı. Yeniden giriş yapın.');
  assert.equal(authMessage(csrf), 'Oturum doğrulanamadı. Sayfayı yenileyin.');
  assert.equal(userAdminMessage({ code: 'unauthorized' }), 'Oturumunuz kapatıldı. Yeniden giriş yapın.');
  assert.equal(hostingAccountMessage({ code: 'unauthorized' }), 'Oturum kapandı. Yeniden giriş yapın.');
  assert.equal(auditMessage({ code: 'unauthorized' }), 'Oturumunuz sona erdi. Yeniden giriş yapın.');
  assert.equal(userAdminMessage({ code: 'rate_limited' }), 'Çok fazla deneme yapıldı. Biraz sonra tekrar deneyin.');
  assert.equal(authMessage({ code: 'rate_limited' }), 'Çok fazla deneme yapıldı. Bir süre sonra tekrar deneyin.');
  assert.equal(hostingAccountMessage({ code: 'mfa_enrollment_required' }), 'Yönetim için iki adımlı doğrulamayı tamamlayın.');
  assert.equal(authMessage({ code: 'session_superseded' }), 'Oturum değişti. İşlemi yeniden deneyin.');
  assert.equal(auditMessage({ status: 404 }), 'Denetim API’si bulunamadı. API ve arayüz sürümlerini kontrol edin.');
  assert.equal(authMessage(new TypeError('fetch failed')), 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edin.');
  assert.equal(authMessage(new Error('Sunucu mesajı')), 'Sunucu mesajı');
});
