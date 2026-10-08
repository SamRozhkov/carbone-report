import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** После стольких неверных попыток код сгорает и печатается новый (§26.4). */
export const MAX_ATTEMPTS = 5;

/** 12 символов base32 (60 бит) в виде XXXX-XXXX-XXXX. */
export function generateCode(rand: (n: number) => Buffer = randomBytes): string {
  const chars = [...rand(12)].map((b) => ALPHABET[b & 31]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export const normalizeCode = (input: string) => input.toUpperCase().replace(/[\s-]/g, '');

/** В state.json хранится только это значение. */
export const hashCode = (code: string) =>
  createHash('sha256').update(normalizeCode(code)).digest('hex');

export function codeMatches(input: string, hash: string): boolean {
  return timingSafeEqual(Buffer.from(hashCode(input), 'hex'), Buffer.from(hash, 'hex'));
}
