import crypto from 'node:crypto';

export function hashPassword(pwd, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(String(pwd), salt, 64).toString('hex');
  return `scrypt$${salt}$${h}`;
}

export function verifyPassword(pwd, stored) {
  if (!stored) return false;
  const [algo, salt, h] = String(stored).split('$');
  if (algo !== 'scrypt' || !salt || !h) return false;
  const calc = crypto.scryptSync(String(pwd), salt, 64).toString('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const rand = (n = 6) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
export const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
export const shortCode = (len = 6) => {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
};
