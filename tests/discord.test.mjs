import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import { Store } from '../lib/store.mjs';
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
  let nextMessageId = 100000000000000020n;
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
      react: async (id, emoji) => {
        const message = messages.get(id);
        if (!message) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        if (!message.reactionsAdded.includes(emoji)) message.reactionsAdded.push(emoji);
      },
      fetch: async options => {
        if (!options?.message) return messages;
        const message = messages.get(options.message);
        if (!message) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return message;
      },
    },
    send: async payload => {
      const id = String(nextMessageId++);
      const message = {
        id, channelId: ID.channel, author: { id: ID.bot }, ...payload,
        reactionsAdded: [],
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
  assert.equal(message.content, '# Contact Dealers');
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

test('opening sends the approved announcement and image only to the fixed channel and role', async t => {
  const { service, client, guild, messages, registeredCommands } = fixture();
  const channelId = '1568248650533175377';
  const roleId = '1189079959722008657';
  guild.channels.cache.set(channelId, { ...guild.channels.cache.get(ID.channel), id: channelId });
  guild.roles.cache.set(roleId, { id: roleId, name: 'Royal Cars', mentionable: true });
  t.after(() => service.stop());
  await service.start();
  assert.ok(registeredCommands.some(command => command.name === 'opening'));
  const invoke = userId => {
    const { promise, resolve } = Promise.withResolvers();
    client.emit('interactionCreate', {
      id: '100000000000000060', isChatInputCommand: () => true, commandName: 'opening',
      guildId: ID.guild, channelId: ID.channel, user: { id: userId },
      reply: async value => resolve(value), deferReply: async () => {}, editReply: async value => resolve(value),
    });
    return promise;
  };
  assert.match((await invoke(ID.member)).content, /Alleen Directie/);
  assert.equal(messages.size, 0);
  assert.match((await invoke(ID.owner)).content, new RegExp('/' + channelId + '/'));
  const [message] = messages.values();
  assert.ok(message.content.startsWith('<@&' + roleId + '>\n'));
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false, roles: [roleId] });
  assert.equal(message.files.length, 1);
  assert.ok((await stat(message.files[0].attachment)).size > 0);
});

test('sell opens the vehicle form and posts the stored price to the sales channel only', async t => {
  const { service, client, guild, store, registeredCommands } = fixture();
  const sales = [];
  guild.channels.cache.set(ID.promoteChannel, {
    ...guild.channels.cache.get(ID.promoteChannel), name: '💰・𝗕𝗶𝗷-𝗛𝗼𝘂𝗱𝗲𝗻・Verkoop',
    send: async payload => { sales.push(payload); },
  });
  const vehicles = Array.from({ length: 26 }, (_, index) => ({
    id: 'vehicle-' + index, name: 'Model ' + index, priceCents: 5750050,
  }));
  store.listSaleVehicles = () => vehicles;
  store.getSaleVehicle = id => vehicles.find(vehicle => vehicle.id === id);
  t.after(() => service.stop());
  await service.start();
  assert.ok(registeredCommands.find(command => command.name === 'sell').options[0].autocomplete);

  const invoke = input => {
    const { promise, resolve } = Promise.withResolvers();
    const interaction = {
      id: '100000000000000061', guildId: ID.guild, channelId: ID.channel, user: { id: ID.member }, commandName: 'sell',
      showModal: async value => resolve(value), respond: async value => resolve(value),
      reply: async value => resolve(value), editReply: async value => resolve(value),
      deferReply: async () => { interaction.deferred = true; },
      ...input,
    };
    client.emit('interactionCreate', interaction);
    return promise;
  };
  const command = { isChatInputCommand: () => true, options: { getString: () => null } };
  assert.match((await invoke({ ...command, user: { id: ID.unrelated } })).content, /Alleen medewerkers/);
  const modal = await invoke(command);
  assert.equal(modal.components[0].component.options.length, 25);
  assert.equal(modal.components[1].component.custom_id, 'sale-buyer');
  const autocomplete = await invoke({ isAutocomplete: () => true, options: { getFocused: () => 'model 25' } });
  assert.deepEqual(autocomplete, [{ name: 'Model 25', value: 'vehicle-25' }]);
  const selectedModal = await invoke({ ...command, options: { getString: () => 'vehicle-25' } });
  const [selection] = selectedModal.components[0].component.options;
  assert.equal(selection.default, true);
  const submit = {
    isModalSubmit: () => true, customId: modal.custom_id,
    fields: { getTextInputValue: () => ' Test *Koper* @everyone ', getStringSelectValues: () => [selection.value] },
  };
  assert.match((await invoke({ ...submit, member: { roles: [] } })).content, /Alleen medewerkers/);
  assert.equal(sales.length, 0);
  vehicles[25].priceCents++;
  assert.match((await invoke(submit)).content, /gewijzigd/);
  assert.equal(sales.length, 0);
  vehicles[25].priceCents--;
  assert.match(await invoke(submit), /verkoop is vastgelegd/);
  assert.equal(sales.length, 1);
  assert.match(sales[0].content, /\*\*Auto:\*\* Model 25/);
  assert.match(sales[0].content, /Test \\\*Koper\\\* @\u200beveryone/);
  assert.match(sales[0].content, /57\.500,50/);
  assert.deepEqual(sales[0].allowedMentions, { parse: [], repliedUser: false });
  assert.equal(sales[0].enforceNonce, true);
});

test('aanwezigheid posts one daily check and counts the last active reaction', { timeout: 7000 }, async t => {
  const { service, store, client, guild, messages, registeredCommands } = fixture();
  const db = new Store();
  t.after(async () => { await service.stop(); db.close(); });
  for (const key of ['getAttendancePost','saveAttendancePost','recordAttendanceReaction','clearAttendanceReactions']) store[key] = db[key].bind(db);
  guild.roles.cache.set(ID.high, { id: ID.high, name: '🚗 | Team Royal Cars' });
  guild.roles.cache.set(ID.low, { id: ID.low, name: '🦺 | Team Beveiliging' });
  guild.roles.cache.set(ID.base, { id: ID.base, name: '-=-=-=- 𝗣𝗲𝗿𝘀𝗼𝗻𝗲𝗲𝗹 -=-=-=-' });
  guild.channels.cache.set(ID.promoteChannel, { id: ID.promoteChannel, name: '📜 | afwezigheid', isTextBased: () => true });
  await service.start();
  assert.ok(registeredCommands.some(command => command.name === 'aanwezigheid'));
  const invoke = () => {
    const { promise, resolve } = Promise.withResolvers();
    client.emit('interactionCreate', {
      isChatInputCommand: () => true, commandName: 'aanwezigheid', guildId: ID.guild,
      channelId: ID.channel, user: { id: ID.owner },
      deferReply: async () => {}, editReply: async value => resolve(value),
    });
    return promise;
  };
  const reply = await invoke();
  assert.match(reply.content, /^Aanwezigheidscheck: https:/);
  const message = [...messages.values()][0];
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  assert.ok(message.content.includes(day.split('-').reverse().map(Number).join('-')));
  assert.ok(message.content.includes('<#' + ID.promoteChannel + '>'));
  assert.ok(message.content.includes('<@&' + ID.high + '>'));
  assert.ok(message.content.includes('<@&' + ID.low + '>'));
  assert.ok(message.content.includes('<@&' + ID.base + '>'));
  assert.deepEqual(message.allowedMentions, { parse: [], repliedUser: false, roles: [ID.high, ID.low, ID.base] });
  assert.deepEqual(message.reactionsAdded, ['✅', '❌']);
  await invoke();
  assert.equal(messages.size, 1);
  const react = (event, emoji, userId = ID.member) => client.emit('raw', {
    t: 'MESSAGE_REACTION_' + event, d: { guild_id: ID.guild, message_id: message.id, user_id: userId, emoji: { name: emoji }, member: { nick: 'Voorbeeld' } },
  });
  react('ADD', '✅', ID.bot);
  react('ADD', '✅');
  react('ADD', '❌');
  react('ADD', '✅'); // Duplicate delivery must not change the winner.
  assert.deepEqual(db.attendanceReport(ID.guild).votes.map(v => v.choice), ['absent']);
  react('REMOVE', '❌');
  assert.deepEqual(db.attendanceReport(ID.guild).votes.map(v => v.choice), ['present']);
  react('REMOVE_ALL');
  assert.equal(db.attendanceReport(ID.guild).votes.length, 0);
  react('ADD', '✅');
  messages.delete(message.id);
  const replacementReply = await invoke();
  const replacement = [...messages.values()][0];
  assert.notEqual(replacement.id, message.id);
  assert.ok(replacementReply.content.endsWith(replacement.id));
  assert.deepEqual(replacement.reactionsAdded, ['✅', '❌']);
  assert.deepEqual(db.attendanceReport(ID.guild).days.map(post => post.messageId), [replacement.id]);
  assert.equal(db.attendanceReport(ID.guild).votes.length, 0);
});
