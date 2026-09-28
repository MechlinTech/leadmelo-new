import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, hash: string) {
  const [salt, value] = hash.split(':');
  if (!salt || !value || value.length !== 128) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(value, 'hex'));
}
function encryptionKey() {
  const key = Buffer.from(process.env.DATA_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must encode 32 random bytes');
  return key;
}
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(x => x.toString('base64')).join('.');
}
export function decrypt(value: string) {
  const [iv, tag, encrypted] = value.split('.').map(x => Buffer.from(x, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}
