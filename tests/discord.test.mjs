import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDiscordService, planRoleChanges } from '../lib/discord.mjs';

const ID = { guild: '100000000000000001', bot: '100000000000000002', member: '100000000000000003', owner: '100000000000000004', high: '100000000000000005', low: '100000000000000006', base: '100000000000000007', unrelated: '100000000000000008', channel: '100000000000000009', promoteChannel: '100000000000000012', actor: '100000000000000013' };
const config = () => ({ ranks: [{ id: 'manager', name: 'Manager', roleId: ID.high, order: 0 }, { id: 'dealer', name: 'Cardealer', roleId: ID.low, order: 1 }], channels: { hire: ID.channel, promote: ID.promoteChannel, demote: ID.channel, dismiss: ID.channel }, baseRoleIds: [ID.base], preserveRoleIds: [ID.unrelated], logSources: [] });

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

test('promotion requires a higher rank and keeps base, tracked and unrelated roles', () => {
  const extra = '100000000000000010';
  const result = planRoleChanges({ type: 'promote', rankId: 'manager', roleIds: new Set([ID.low, ID.base, ID.unrelated, extra]), settings: config(), trackedRoleIds: [extra] });
  assert.deepEqual(result.add, [ID.high]);
  assert.deepEqual(result.remove, [ID.low]);
  assert.throws(() => planRoleChanges({ type: 'promote', rankId: 'dealer', roleIds: new Set([ID.high]), settings: config() }), { code: 'INVALID_PROMOTION' });
  assert.throws(() => planRoleChanges({ type: 'promote', rankId: 'manager', roleIds: new Set([ID.high]), settings: config() }), { code: 'INVALID_PROMOTION' });
  assert.throws(() => planRoleChanges({ type: 'promote', rankId: 'manager', roleIds: new Set(), settings: config() }), { code: 'NOT_STAFF' });
});

test('hire refuses existing staff and conflicting preserved staff role configuration', () => {
  assert.throws(() => planRoleChanges({ type: 'hire', rankId: 'dealer', roleIds: new Set([ID.high]), settings: config() }), { code: 'ALREADY_STAFF' });
  const settings = config(); settings.preserveRoleIds.push(ID.low);
  assert.throws(() => planRoleChanges({ type: 'hire', rankId: 'dealer', roleIds: new Set(), settings }), { code: 'ROLE_CONFIG_CONFLICT' });
});

test('configured base roles cannot silently grant or retain a higher staff rank', () => {
  const settings = config(); settings.baseRoleIds.push(ID.high);
  assert.throws(() => planRoleChanges({ type: 'hire', rankId: 'dealer', roleIds: new Set(), settings }), { code: 'ROLE_CONFIG_CONFLICT' });
  assert.throws(() => planRoleChanges({ type: 'demote', rankId: 'dealer', roleIds: new Set([ID.high, ID.base]), settings }), { code: 'ROLE_CONFIG_CONFLICT' });
});

function fixture({ roleIds = [ID.high, ID.base, ID.unrelated], canSend = true, failRemove = null, ownerTarget = false, botPosition = 100, actorPosition = 15, settings = config() } = {}) {
  const messages = new Map(); const mutations = []; const logs = [];
  const registeredCommands = [];
  const rosterEdits = new EventEmitter();
  let rosterMessage = null;
  const role = (id, position) => ({ id, position, name: id, managed: false, hexColor: '#ee0000' });
  const roleCache = new Map([[ID.high, role(ID.high, 20)], [ID.low, role(ID.low, 10)], [ID.base, role(ID.base, 5)], [ID.unrelated, role(ID.unrelated, 3)]]);
  const targetRoles = new Map(roleIds.map(id => [id, roleCache.get(id)]));
  const target = { id: ownerTarget ? ID.owner : ID.member, displayName: 'Voorbeeld', user: { bot: false, username: 'voorbeeld' }, manageable: true, joinedAt: new Date('2026-01-01'), displayAvatarURL: () => 'https://cdn.discordapp.com/example.png', roles: { cache: targetRoles, highest: { position: Math.max(0, ...roleIds.map(id => roleCache.get(id)?.position || 0)) }, add: async id => { mutations.push(['add', id]); targetRoles.set(id, roleCache.get(id)); }, remove: async id => { if (id === failRemove) throw Error('simulated'); mutations.push(['remove', id]); targetRoles.delete(id); } } };
  const me = { id: ID.bot, user: { bot: true }, permissions: { has: () => true }, roles: { highest: { comparePositionTo: other => botPosition - other.position } } };
  const actor = { id: ID.actor, roles: { highest: { comparePositionTo: other => actorPosition - other.position } } };
  const channel = {
    id: ID.channel, guildId: ID.guild, name: 'personeel',
    isTextBased: () => true, isThread: () => false,
    permissionsFor: () => ({ has: () => canSend }),
    messages: {
      fetch: async options => {
        if (!options?.message) return messages;
        const message = messages.get(options.message);
        if (!message) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return message;
      },
    },
    send: async payload => {
      const id = String(100000000000000020n + BigInt(messages.size));
      const message = {
        id, author: { id: ID.bot }, ...payload,
        edit: async next => {
          Object.assign(message, next);
          rosterEdits.emit('edit', message);
          return message;
        },
      };
      messages.set(id, message);
      return message;
    },
  };
  const channels = new Map([[ID.channel, channel], [ID.promoteChannel, { ...channel, id: ID.promoteChannel, name: 'promoties' }]]);
  const guild = { id: ID.guild, ownerId: '100000000000000099', name: 'Royal Cars Test', memberCount: 2, roles: { cache: roleCache, fetch: async () => roleCache }, channels: { cache: channels, fetch: async id => id ? channels.get(id) : channels }, members: { cache: new Map([[target.id, target], [me.id, me]]), me, fetch: async input => input ? (input.user === ID.actor ? actor : target) : new Map([[target.id, target], [me.id, me]]), fetchMe: async () => me } };
  target.guild = guild;
  guild.commands = { create: async command => { registeredCommands.push(command); return { name: command.name }; } };
  const client = new EventEmitter(); Object.assign(client, { user: { id: ID.bot }, guilds: { fetch: async () => guild }, isReady: () => true, login: async () => {}, destroy: () => {} });
  const store = {
    getSettings: () => settings,
    addLog: log => logs.push(log),
    getRosterMessage: () => rosterMessage,
    setRosterMessage: (_guildId, pointer) => { rosterMessage = pointer; },
  };
  const service = createDiscordService({ store, env: { DISCORD_TOKEN: 'unit-test-token-not-real', DISCORD_GUILD_ID: ID.guild, OWNER_DISCORD_ID: ID.owner }, clientFactory: async () => client });
  return { service, targetRoles, mutations, messages, logs, client, guild, target, store, registeredCommands, rosterEdits };
}

test('ledenlijst posts one persistent message and edits it after a Discord role change', { timeout: 7000 }, async t => {
  const { service, messages, client, guild, target, targetRoles, store, registeredCommands, rosterEdits } = fixture();
  t.after(() => service.stop());
  await service.start();
  assert.equal(registeredCommands[0]?.name, 'ledenlijst');

  const runCommand = async (userId, permissions = [], channelId = ID.channel) => {
    const { promise, resolve } = Promise.withResolvers();
    client.emit('interactionCreate', {
      isChatInputCommand: () => true, commandName: 'ledenlijst', guildId: ID.guild,
      channelId, channel: guild.channels.cache.get(channelId),
      user: { id: userId }, memberPermissions: { has: bit => permissions.includes(bit) },
      reply: async value => resolve(value), deferReply: async () => {}, editReply: async value => resolve(value),
    });
    return promise;
  };
  await runCommand(ID.actor);
  await runCommand(ID.actor, [32n]);
  assert.equal(messages.size, 0);

  await runCommand(ID.owner);
  const pointer = store.getRosterMessage(ID.guild);
  assert.equal(pointer.channelId, ID.channel);
  const message = messages.get(pointer.messageId);
  const description = message.embeds[0].description;
  assert.ok(description.includes(`<@${ID.member}>`));
  assert.ok(description.includes(`<@&${ID.high}>`));
  assert.doesNotMatch(description, /royalcarsadmin\.nl/);
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(message.flags, 4096);
  const reply = await runCommand(ID.actor, [32n, 2048n], ID.promoteChannel);
  assert.equal(reply.content, 'De bestaande live ledenlijst is bijgewerkt.');
  assert.deepEqual(store.getRosterMessage(ID.guild), pointer);
  assert.equal(messages.size, 1);
  const previousEmbeds = JSON.stringify(message.embeds);

  const { promise, resolve } = Promise.withResolvers();
  rosterEdits.once('edit', resolve);
  const timeout = setTimeout(() => resolve(null), 4000);
  targetRoles.delete(ID.high);
  targetRoles.set(ID.low, guild.roles.cache.get(ID.low));
  client.emit('guildMemberUpdate', target, target);
  const updated = await promise;
  clearTimeout(timeout);
  assert.equal(updated?.id, pointer.messageId);
  assert.notEqual(JSON.stringify(updated.embeds), previousEmbeds);
  assert.equal((await service.getMembers()).members[0].rank.name, 'Cardealer');
  assert.equal(messages.size, 1);
});

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

test('promotion respects actor and bot hierarchy and requires a linked channel before changing roles', async () => {
  const roleIds = [ID.low, ID.base, ID.unrelated];
  const action = { type: 'promote', discordId: ID.member, rankId: 'manager', actorId: ID.owner };
  const settings = config(); delete settings.channels.promote;
  for (const [options, actorId, code] of [
    [{}, ID.actor, 'ACTOR_HIERARCHY'],
    [{ botPosition: 20 }, ID.owner, 'ROLE_HIERARCHY'],
    [{ settings }, ID.owner, 'CHANNEL_NOT_CONFIGURED'],
  ]) {
    const { service, mutations } = fixture({ roleIds, ...options });
    await service.start();
    await assert.rejects(service.performAction({ ...action, actorId }), { code });
    assert.deepEqual(mutations, []);
    await service.stop();
  }
});

test('successful promotion updates the roster and announces the new rank in the promotions channel', async () => {
  const { service, targetRoles, messages } = fixture({ roleIds: [ID.low, ID.base, ID.unrelated] });
  await service.start();
  const action = { type: 'promote', discordId: ID.member, rankId: 'manager', actorId: ID.owner, actorName: 'Directie', reason: `Test @everyone <@${ID.actor}>` };
  const result = await service.performAction(action);
  assert.equal(result.oldRankName, 'Cardealer');
  assert.equal(result.rankName, 'Manager');
  assert.deepEqual(new Set(targetRoles.keys()), new Set([ID.high, ID.base, ID.unrelated]));
  const notification = await service.notifyAction({ ...action, ...result, id: 'promotion-1' });
  assert.equal(notification.channelId, ID.promoteChannel);
  const announcement = messages.get(notification.messageId);
  assert.equal(announcement.embeds[0].title, 'ROYAL CARS · Gepromoveerd');
  assert.equal(announcement.content, `<@${ID.member}>`);
  assert.deepEqual(announcement.allowedMentions, { parse: [], users: [ID.member] });
  assert.equal((await service.notifyAction({ ...action, ...result, id: 'promotion-1' })).messageId, notification.messageId);
  assert.equal(messages.size, 1);
  assert.equal((await service.getMembers()).members[0].rank.name, 'Manager');
  await service.stop();
});

test('selected hiring roles are kept across demotion and removed at dismissal while unrelated roles survive',()=>{
  const extra='100000000000000010';const unrelated='100000000000000011';
  const hire=planRoleChanges({type:'hire',rankId:'manager',roleIds:new Set([unrelated]),settings:config(),extraRoleIds:[extra]});
  assert.equal(hire.add.includes(extra),true);assert.equal(hire.add.includes(ID.high),true);
  const demote=planRoleChanges({type:'demote',rankId:'dealer',roleIds:new Set([ID.high,ID.base,extra,unrelated]),settings:config(),trackedRoleIds:[extra]});
  assert.deepEqual(demote.remove,[ID.high]);assert.equal(demote.add.includes(ID.low),true);
  const dismiss=planRoleChanges({type:'dismiss',roleIds:new Set([ID.low,ID.base,extra,unrelated]),settings:config(),trackedRoleIds:[extra]});
  assert.equal(dismiss.remove.includes(extra),true);assert.equal(dismiss.remove.includes(unrelated),false);
  assert.throws(()=>planRoleChanges({type:'hire',rankId:'dealer',roleIds:new Set(),settings:config(),extraRoleIds:[ID.high]}),{code:'INVALID_EXTRA_ROLE'});
});

test('delegated hiring cannot grant an extra role outside the owner-configured allowlist',async()=>{
  const {service,mutations}=fixture();await service.start();
  await assert.rejects(service.performAction({type:'hire',discordId:ID.member,rankId:'dealer',actorId:'100000000000000099',roleIds:['100000000000000010']}),{code:'EXTRA_ROLE_FORBIDDEN'});
  assert.deepEqual(mutations,[]);await service.stop();
});
