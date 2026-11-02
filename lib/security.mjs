import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const PERMISSIONS = ['dashboard', 'members', 'logs', 'hire', 'demote', 'dismiss'];
export const OWNER_PERMISSIONS = [...PERMISSIONS, 'accounts', 'settings'];
export const DISCORD_ID = /^\d{17,20}$/;
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function safeEqual(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || !a.length) return false; const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
export function csrfToken() { return randomBytes(32).toString('hex'); }
export function accessFor(id, store, ownerId) {
  if (!id) return null;
  if (DISCORD_ID.test(ownerId || '') && id === ownerId) return { isOwner: true, permissions: OWNER_PERMISSIONS, logSourceIds: ['*'] };
  const account = store.getAccount(id);
  return account?.active ? { isOwner: false, permissions: account.permissions.filter(permission => PERMISSIONS.includes(permission)), logSourceIds: account.logSourceIds, label: account.label } : null;
}
export function allowedLogSources(access) { return access.isOwner || access.logSourceIds.includes('*') ? null : ['portal', ...access.logSourceIds]; }
export function textValue(value, name, { max = 200, required = false } = {}) { if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new HttpError(400, `${name} ontbreekt of is ongeldig.`); return value.trim(); }
export function discordId(value, name = 'Discord-ID', optional = false) { if (optional && !value) return ''; if (typeof value !== 'string' || !DISCORD_ID.test(value)) throw new HttpError(400, `${name} moet uit 17 tot 20 cijfers bestaan.`); return value; }
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Ongeldige instellingen.');
  if (!Array.isArray(input.ranks) || input.ranks.length > 50) throw new HttpError(400, 'Maximaal 50 rangen toegestaan.');
  const ranks = input.ranks.map((rank, order) => ({ id: textValue(rank.id || rank.roleId, 'Rang-ID', { max: 80, required: true }), name: textValue(rank.name, 'Rangnaam', { max: 80, required: true }), roleId: discordId(rank.roleId || rank.id, 'Discord-rol-ID'), order }));
  if (new Set(ranks.map(rank => rank.id)).size !== ranks.length || new Set(ranks.map(rank => rank.roleId)).size !== ranks.length) throw new HttpError(400, 'Iedere rang en Discord-rol mag maar één keer voorkomen.');
  const channels = Object.fromEntries(['hire', 'demote', 'dismiss'].map(type => [type, discordId(input.channels?.[type], 'Kanaal-ID', true)]));
  const ids = (value, name) => { if (!Array.isArray(value) || value.length > 50) throw new HttpError(400, `${name} is ongeldig.`); return [...new Set(value.map(id => discordId(id, name)))]; };
  if (!Array.isArray(input.logSources) || input.logSources.length > 50) throw new HttpError(400, 'Maximaal 50 logbronnen toegestaan.');
  const logSources = input.logSources.map(source => ({ id: textValue(source.id || source.channelId, 'Logbron-ID', { max: 80, required: true }), name: textValue(source.name, 'Logbronnaam', { max: 80, required: true }), channelId: discordId(source.channelId, 'Logkanaal-ID'), enabled: source.enabled !== false }));
  if (new Set(logSources.map(source => source.id)).size !== logSources.length) throw new HttpError(400, 'Dubbele logbronnen zijn niet toegestaan.');
  if (logSources.some(source => source.id === 'portal')) throw new HttpError(400, 'De logbron-ID portal is gereserveerd.');
  const baseRoleIds = ids(input.baseRoleIds || [], 'Basisrol-ID');
  const preserveRoleIds = ids(input.preserveRoleIds || [], 'Bewaarrol-ID');
  const rankRoleIds = new Set(ranks.map(rank => rank.roleId));
  if (baseRoleIds.some(id => rankRoleIds.has(id))) throw new HttpError(400, 'Een rangrol mag niet ook als basisrol zijn ingesteld.');
  if (preserveRoleIds.some(id => rankRoleIds.has(id) || baseRoleIds.includes(id))) throw new HttpError(400, 'Een personeelsrol mag niet ook bij behouden rollen staan.');
  return { ranks, channels, baseRoleIds, preserveRoleIds, logSources };
}
export function validateAccount(input, ownerId) {
  const id = discordId(input.id || input.discordId);
  if (id === ownerId) throw new HttpError(400, 'Het Directie-account wordt via de hosting beheerd en kan niet worden aangepast.');
  if (!Array.isArray(input.permissions) || input.permissions.some(permission => !PERMISSIONS.includes(permission))) throw new HttpError(400, 'Ongeldige paginarechten.');
  const sources = input.logSourceIds || [];
  if (!Array.isArray(sources) || sources.length > 51 || sources.some(id => typeof id !== 'string' || id.length > 80)) throw new HttpError(400, 'Ongeldige logrechten.');
  return { id, label: textValue(input.label || '', 'Naamlabel', { max: 80 }), permissions: [...new Set(input.permissions)], logSourceIds: [...new Set(sources)], active: input.active !== false };
}
export function validateAction(input) {
  if (!['hire', 'demote', 'dismiss'].includes(input.type)) throw new HttpError(400, 'Ongeldige personeelsactie.');
  const rankId = input.rankId ? textValue(input.rankId, 'Rang-ID', { max: 80 }) : '';
  if (input.type !== 'dismiss' && !rankId) throw new HttpError(400, 'Kies een rang voor deze personeelsactie.');
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'Een geldige unieke actiecode is verplicht.');
  return { type: input.type, discordId: discordId(input.discordId), rankId, reason: textValue(input.reason, 'Reden', { max: 1000, required: true }), idempotencyKey: key };
}

export function createOperationRunner({ store, bot, onChange = () => {} }) {
  const active = new Set();
  return async function run(payload, actor) {
    const key = payload.idempotencyKey;
    const fingerprint = createHash('sha256').update(JSON.stringify({ type: payload.type, discordId: payload.discordId, rankId: payload.rankId, reason: payload.reason })).digest('hex');
    let operation = store.getOperation(actor.id, key);
    if (operation && operation.fingerprint !== fingerprint) throw new HttpError(409, 'Deze actiecode is al voor een andere wijziging gebruikt.');
    if (operation?.status === 'completed') return operation;
    if (active.has(`${actor.id}:${key}`)) throw new HttpError(409, 'Deze actie wordt al verwerkt. Wacht op het resultaat.');
    if (operation?.status === 'applying') throw new HttpError(409, 'De vorige poging is onderbroken. Controleer de Discord-rollen voordat je een nieuwe actie start.');
    if (operation?.status === 'failed') throw new HttpError(409, operation.error || 'Deze actie is mislukt. Start een nieuwe actie nadat je het probleem hebt opgelost.');
    operation ||= store.createOperation({ actorId: actor.id, key, fingerprint, payload: { ...payload, actorId: actor.id, actorName: actor.displayName || actor.username } });
    const lock = `${actor.id}:${key}`; active.add(lock);
    try {
      if (operation.status === 'pending') {
        operation = store.updateOperation(operation, { status: 'applying', error: null });
        let result;
        try {
          result = await bot.performAction({ ...payload, actorId: actor.id, actorName: actor.displayName || actor.username });
        } catch (error) {
          operation = store.updateOperation(operation, { status: 'failed', error: error.message || 'Discord-actie mislukt.' });
          store.addLog({ type: 'error', actorId: actor.id, actorName: actor.displayName || actor.username, targetId: payload.discordId, content: `Personeelsactie mislukt: ${operation.error}`, metadata: { operationId: operation.id } });
          throw new HttpError(error.status || 400, operation.error);
        }
        operation = store.updateOperation(operation, { status: 'role_applied', result, error: null });
        onChange();
      }
      const result = operation.result;
      store.addLog({ id: `operation:${operation.id}`, type: payload.type, actorId: actor.id, actorName: actor.displayName || actor.username, targetId: payload.discordId, targetName: result.targetName, content: `${({ hire: 'Aangenomen', demote: 'Gedemoveerd', dismiss: 'Ontslagen' })[payload.type]}: ${result.targetName || payload.discordId}. ${payload.reason}`, metadata: { operationId: operation.id, ...result } });
      try {
        const notification = await bot.notifyAction({ ...operation.payload, ...operation.result, id: operation.id, createdAt: operation.createdAt });
        operation = store.updateOperation(operation, { status: 'completed', result: { ...operation.result, notification }, error: null });
      } catch (error) {
        operation = store.updateOperation(operation, { status: 'notification_failed', error: 'Discord-rollen zijn bijgewerkt, maar het kanaalbericht is niet verzonden. Probeer dezelfde actie opnieuw om alleen het bericht te versturen.' });
      }
      onChange(); return operation;
    } finally { active.delete(lock); }
  };
}
