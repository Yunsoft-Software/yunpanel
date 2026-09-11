import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(argon2);
const PREFIX = '$argon2id$v=19$m=65536,t=3,p=1$';
const HASH_PATTERN = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;
const MAX_ACTIVE_HASHES = 2;
let activeHashes = 0;

export class MailboxPasswordError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'MailboxPasswordError';
    this.code = code;
    this.status = status;
  }
}

function validatePassword(value) {
  if (typeof value !== 'string' || [...value].length < 12 || Buffer.byteLength(value) > 1_024) {
    throw new MailboxPasswordError('invalid_mailbox_password', 'Use at least 12 characters and no more than 1024 bytes');
  }
  return value;
}

function encode(value) {
  return value.toString('base64').replace(/=+$/, '');
}

function decode(value, expectedBytes) {
  const decoded = Buffer.from(`${value}${'='.repeat((4 - value.length % 4) % 4)}`, 'base64');
  return decoded.length === expectedBytes && encode(decoded) === value ? decoded : null;
}

function parseHash(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const match = value.match(HASH_PATTERN);
  if (!match) return null;
  const salt = decode(match[1], 16);
  const hash = decode(match[2], 32);
  return salt && hash ? Object.freeze({ salt, hash }) : null;
}

async function derivePassword(password, salt) {
  if (activeHashes >= MAX_ACTIVE_HASHES) {
    throw new MailboxPasswordError('mailbox_password_busy', 'Mailbox password service is busy; retry shortly', 503);
  }
  activeHashes += 1;
  try {
    return await derive('argon2id', {
      message: password,
      nonce: salt,
      parallelism: 1,
      tagLength: 32,
      memory: 65_536,
      passes: 3,
    });
  } finally {
    activeHashes -= 1;
  }
}

export async function hashMailboxPassword(password) {
  const validated = validatePassword(password);
  const salt = randomBytes(16);
  const hash = await derivePassword(validated, salt);
  return `${PREFIX}${encode(salt)}$${encode(hash)}`;
}

export async function verifyMailboxPassword(password, encoded) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1_024) return false;
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  const actual = await derivePassword(password, parsed.salt);
  return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
}

export const mailboxPasswordPolicy = Object.freeze({
  algorithm: 'argon2id',
  version: 19,
  memoryKib: 65_536,
  passes: 3,
  parallelism: 1,
  saltBytes: 16,
  hashBytes: 32,
  maxActiveHashes: MAX_ACTIVE_HASHES,
});

export const mailboxPasswordInternals = Object.freeze({ validatePassword, parseHash, encode, decode });
