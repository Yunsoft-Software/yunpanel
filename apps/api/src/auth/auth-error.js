import { timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  constructor(code, message, status = 400, retryAfter = null) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
