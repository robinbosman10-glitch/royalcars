import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDiscordService, planRoleChanges } from '../lib/discord.mjs';

const ID = { guild: '100000000000000001', bot: '100000000000000002', member: '100000000000000003', owner: '100000000000000004', high: '100000000000000005', low: '100000000000000006', base: '100000000000000007', unrelated: '100000000000000008', channel: '100000000000000009' };
const config = () => ({ ranks: [{ id: 'manager', name: 'Manager', roleId: ID.high, order: 0 }, { id: 'dealer', name: 'Cardealer', roleId: ID.low, order: 1 }], channels: { hire: ID.channel, demote: ID.channel, dismiss: ID.channel }, baseRoleIds: [ID.base], preserveRoleIds: [ID.unrelated], logSources: [] });

test('dismiss only removes configured personnel roles and preserves unrelated roles', () => {
  const result = planRoleChanges({ type: 'dismiss', roleIds: new Set([ID.high, ID.base, ID.unrelated]), settings: config() });
  assert.deepEqual(result.add, []);
  assert.deepEqual(new Set(result.remove), new Set([ID.high, ID.base]));
  assert.equal(result.target, null);
});

test('demotion enforces descending staff rank and keeps base roles', () => {
  const result = planRoleChanges({ type: 'demote', rankId: 'dealer', roleIds: new Set([ID.high, ID.base, ID.unrelated]), settings: config() });
  assert.deepEqual(result.add, [ID.low]);
  assert.deepEqual(result.remove, [ID.high]);
  assert.throws(() => planRoleChanges({ type: 'demote', rankId: 'manager', roleIds: new Set([ID.low]), settings: config() }), { code: 'INVALID_DEMOTION' });
  assert.throws(() => planRoleChanges({ type: 'demote', rankId: 'dealer', roleIds: new Set([ID.low]), settings: config() }), { code: 'INVALID_DEMOTION' });
});

test('hire refuses existing staff and conflicting preserved staff role configuration', () => {
  assert.throws(() => planRoleChanges({ type: 'hire', rankId: 'dealer', roleIds: new Set([ID.high]), settings: config() }), { code: 'ALREADY_STAFF' });
  const settings = config(); settings.preserveRoleIds.push(ID.low);
  assert.throws(() => planRoleChanges({ type: 'hire', rankId: 'dealer', roleIds: new Set(), settings }), { code: 'ROLE_CONFIG_CONFLICT' });
});

function fixture({ roleIds = [ID.high, ID.base, ID.unrelated], canSend = true, failRemove = null, ownerTarget = false } = {}) {
  const messages = new Map(); const mutations = []; const logs = [];
  const role = (id, position) => ({ id, position, name: id, managed: false, hexColor: '#ee0000' });
  const roleCache = new Map([[ID.high, role(ID.high, 20)], [ID.low, role(ID.low, 10)], [ID.base, role(ID.base, 5)], [ID.unrelated, role(ID.unrelated, 3)]]);
  const targetRoles = new Map(roleIds.map(id => [id, roleCache.get(id)]));
  const target = { id: ownerTarget ? ID.owner : ID.member, displayName: 'Voorbeeld', user: { bot: false, username: 'voorbeeld' }, manageable: true, joinedAt: new Date('2026-01-01'), displayAvatarURL: () => 'https://cdn.discordapp.com/example.png', roles: { cache: targetRoles, highest: { position: 20 }, add: async id => { mutations.push(['add', id]); targetRoles.set(id, roleCache.get(id)); }, remove: async id => { if (id === failRemove) throw Error('simulated'); mutations.push(['remove', id]); targetRoles.delete(id); } } };
  const me = { id: ID.bot, user: { bot: true }, permissions: { has: () => true }, roles: { highest: { comparePositionTo: other => 100 - other.position } } };
  const channel = { id: ID.channel, guildId: ID.guild, name: 'personeel', isTextBased: () => true, isThread: () => false, permissionsFor: () => ({ has: () => canSend }), messages: { fetch: async () => messages }, send: async payload => { const message = { id: String(messages.size + 1), author: { id: ID.bot }, embeds: payload.embeds }; messages.set(message.id, message); return message; } };
  const guild = { id: ID.guild, ownerId: '100000000000000099', name: 'Royal Cars Test', memberCount: 2, roles: { cache: roleCache, fetch: async () => roleCache }, channels: { cache: new Map([[ID.channel, channel]]), fetch: async id => id ? channel : new Map([[ID.channel, channel]]) }, members: { cache: new Map([[target.id, target], [me.id, me]]), me, fetch: async input => input ? target : new Map([[target.id, target], [me.id, me]]), fetchMe: async () => me } };
  target.guild = guild;
  const client = new EventEmitter(); Object.assign(client, { user: { id: ID.bot }, guilds: { fetch: async () => guild }, isReady: () => true, login: async () => {}, destroy: () => {} });
  const service = createDiscordService({ store: { getSettings: config, addLog: log => logs.push(log) }, env: { DISCORD_TOKEN: 'unit-test-token-not-real', DISCORD_GUILD_ID: ID.guild, OWNER_DISCORD_ID: ID.owner }, clientFactory: async () => client });
  return { service, targetRoles, mutations, messages, logs, client };
}

test('missing bot credentials keep service safely offline', async () => {
  const service = createDiscordService({ store: { getSettings: config }, env: {} });
  assert.equal((await service.start()).configured, false);
  await assert.rejects(service.getMembers(), { code: 'DISCORD_OFFLINE' });
});

test('action preflights announcement permissions before mutating roles', async () => {
  const { service, mutations } = fixture({ canSend: false }); await service.start();
  await assert.rejects(service.performAction({ type: 'demote', discordId: ID.member, rankId: 'dealer', actorId: ID.owner }), { code: 'CHANNEL_PERMISSIONS' });
  assert.deepEqual(mutations, []); await service.stop();
});

test('failed role removal rolls added roles back to original membership', async () => {
  const { service, targetRoles } = fixture({ failRemove: ID.high }); await service.start();
  await assert.rejects(service.performAction({ type: 'demote', discordId: ID.member, rankId: 'dealer', actorId: ID.owner }), { code: 'ROLE_UPDATE_FAILED' });
  assert.deepEqual(new Set(targetRoles.keys()), new Set([ID.high, ID.base, ID.unrelated])); await service.stop();
});

test('portal owner is protected from personnel changes', async () => {
  const { service, mutations } = fixture({ ownerTarget: true }); await service.start();
  await assert.rejects(service.performAction({ type: 'dismiss', discordId: ID.owner, actorId: ID.owner }), { code: 'PROTECTED_MEMBER' });
  assert.deepEqual(mutations, []); await service.stop();
});

test('successful demotion updates only configured role and notification retry deduplicates', async () => {
  const { service, targetRoles, messages } = fixture(); await service.start();
  const action = { type: 'demote', discordId: ID.member, rankId: 'dealer', actorId: ID.owner, actorName: 'Directie', reason: 'Test' };
  const result = await service.performAction(action);
  assert.equal(result.rankName, 'Cardealer');
  assert.deepEqual(new Set(targetRoles.keys()), new Set([ID.low, ID.base, ID.unrelated]));
  const operation = { ...action, ...result, id: 'operation-1', createdAt: new Date().toISOString() };
  const first = await service.notifyAction(operation); const second = await service.notifyAction(operation);
  assert.deepEqual(second, first); assert.equal(messages.size, 1);
  const roster = await service.getMembers(); assert.equal(roster.members[0].rank.name, 'Cardealer');
  await service.stop();
});
