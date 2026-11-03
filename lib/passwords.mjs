import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './security.mjs';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const DUMMY_HASH = `scrypt$32768$8$3$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(64).toString('base64url')}`;

export function validateUsername(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{3,32}$/.test(value.trim())) throw new HttpError(400, 'Gebruik een gebruikersnaam van 3 tot 32 letters, cijfers, punten, streepjes of underscores.');
  return value.trim();
}
export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw new HttpError(400, 'Gebruik een wachtwoord van minimaal 12 en maximaal 128 tekens.');
  return value;
}
export function isPasswordHash(value) { return typeof value === 'string' && /^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/.test(value); }
export async function hashPassword(value) {
  validatePassword(value);
  const salt = randomBytes(16);
  const key = await derive(value, salt, 64, options);
  return `scrypt$32768$8$3$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(value, encoded) {
  const valid = isPasswordHash(encoded);
  const parts = (valid ? encoded : DUMMY_HASH).split('$');
  const input = typeof value === 'string' && value.length <= 128 ? value : '';
  const key = await derive(input, Buffer.from(parts[4], 'base64url'), 64, options);
  return valid && timingSafeEqual(key, Buffer.from(parts[5], 'base64url'));
}
export function bootstrapOwner(store, env) {
  if (!/^\d{17,20}$/.test(env.OWNER_DISCORD_ID || '')) return;
  if (store.getCredential(env.OWNER_DISCORD_ID)) {
    applyOwnerRecovery(store, env.OWNER_DISCORD_ID, env.OWNER_LOGIN_RESET_PASSWORD_HASH);
    return;
  }
  if (!isPasswordHash(env.OWNER_LOGIN_PASSWORD_HASH) || !env.OWNER_LOGIN_USERNAME) return;
  store.setCredential({ id: env.OWNER_DISCORD_ID, username: validateUsername(env.OWNER_LOGIN_USERNAME), passwordHash: env.OWNER_LOGIN_PASSWORD_HASH, mustChangePassword: true });
}

function applyOwnerRecovery(store, ownerId, passwordHash) {
  if (!isPasswordHash(passwordHash)) return;

  const receipt = createHash('sha256').update(ownerId).update(':').update(passwordHash).digest('hex');
  store.db.exec('BEGIN IMMEDIATE');
  let owner;
  try {
    store.db.exec('CREATE TABLE IF NOT EXISTS owner_recovery_receipts (receipt TEXT PRIMARY KEY)');
    const result = store.db.prepare('INSERT OR IGNORE INTO owner_recovery_receipts (receipt) VALUES (?)').run(receipt);
    if (result.changes === 1) {
      owner = store.getCredential(ownerId);
      if (!owner) throw new Error('Directie-account ontbreekt.');
      store.setCredential({ ...owner, passwordHash, mustChangePassword: true });
    }
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }

  if (owner) console.info('Directie-herstel voltooid voor ' + JSON.stringify(owner.username));
}
