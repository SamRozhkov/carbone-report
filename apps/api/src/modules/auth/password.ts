import argon2 from 'argon2';

export const hashPassword = (p: string) => argon2.hash(p, { type: argon2.argon2id });

export async function verifyPassword(hash: string, p: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, p);
  } catch {
    return false;
  }
}

// Хеш для выравнивания времени ответа при несуществующем логине.
export const DUMMY_HASH_PROMISE = hashPassword('dummy-password-for-timing');
