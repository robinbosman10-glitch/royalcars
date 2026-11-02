import { createHash } from 'node:crypto';

const SNOWFLAKE = /^\d{17,20}$/;
const ACTION_LABELS = { hire: 'Aangenomen', demote: 'Demotie', dismiss: 'Ontslagen' };
const ACTION_COLORS = { hire: 0x39b980, demote: 0xeab35a, dismiss: 0xe34251 };
const permissionBits = { ManageRoles: 1n << 28n, ViewChannel: 1n << 10n, SendMessages: 1n << 11n, EmbedLinks: 1n << 14n, ReadMessageHistory: 1n << 16n };

export class DiscordServiceError extends Error {
  constructor(message, code = 'DISCORD_UNAVAILABLE', status = 503, details = {}) {
    super(message); this.name = 'DiscordServiceError'; this.code = code; this.status = status; this.details = details;
  }
}

const fail = (message, code = 'INVALID_ACTION', status = 400) => { throw new DiscordServiceError(message, code, status); };
const list = value => Array.isArray(value) ? value : [];
const ranksOf = settings => list(settings.ranks).slice().sort((a, b) => a.order - b.order);
const rolesOf = member => new Set(member.roles.cache.keys());
const bestRank = (settings, roleIds) => ranksOf(settings).find(rank => roleIds.has(rank.roleId)) || null;
const string = (value, max = 1000) => String(value ?? '').slice(0, max);

/** Calculates only configured staff role changes; unrelated server roles are never replaced. */
export function planRoleChanges({ type, rankId, roleIds, settings }) {
  if (!ACTION_LABELS[type]) fail('Onbekende personeelsactie.');
  const ranks = ranksOf(settings);
  if (!ranks.length) fail('Koppel eerst de personeelsrangen in Instellingen.', 'RANKS_NOT_CONFIGURED', 409);
  const current = bestRank(settings, roleIds);
  const target = ranks.find(rank => rank.id === rankId);
  const preserved = new Set(list(settings.preserveRoleIds));
  const base = list(settings.baseRoleIds);
  const staffRoles = new Set([...ranks.map(rank => rank.roleId), ...base]);
  if ([...staffRoles].some(id => preserved.has(id))) fail('Een personeelsrol staat ook bij behouden rollen. Pas eerst de configuratie aan.', 'ROLE_CONFIG_CONFLICT', 409);
  if (type !== 'dismiss' && !target) fail('Selecteer een geldige gekoppelde rang.');
  if (type === 'hire' && current) fail('Dit lid heeft al een personeelsrang.', 'ALREADY_STAFF', 409);
  if (type !== 'hire' && !current) fail('Dit lid heeft geen gekoppelde personeelsrang.', 'NOT_STAFF', 409);
  if (type === 'demote' && target.order <= current.order) fail('Bij een demotie moet de nieuwe rang lager zijn dan de huidige rang.', 'INVALID_DEMOTION', 409);
  const desired = new Set(type === 'dismiss' ? [] : [target.roleId, ...base]);
  const remove = [...staffRoles].filter(id => roleIds.has(id) && !desired.has(id) && !preserved.has(id));
  const add = [...desired].filter(id => !roleIds.has(id));
  return { add, remove, current, target: type === 'dismiss' ? null : target };
}

export function createDiscordService({ store, onChange = () => {}, env = process.env, clientFactory } = {}) {
  let client;
  let guild;
  let syncing = false;
  let lastSync = null;
  let lastError = null;
  let refreshTimer;
  const locks = new Set();
  const configured = () => Boolean(env.DISCORD_TOKEN && SNOWFLAKE.test(env.DISCORD_GUILD_ID || ''));
  const settings = () => store.getSettings();
  const changed = kind => { try { onChange(kind); } catch {} };
  const status = () => ({
    online: Boolean(client?.isReady() && guild && lastSync), configured: configured(),
    guildName: guild?.name || null, memberCount: guild?.memberCount || 0,
    lastSync, syncing, error: lastError,
  });
  const readyGuild = () => {
    if (!status().online) fail('De Discord-bot is nog niet verbonden. Controleer de koppeling.', 'DISCORD_OFFLINE', 503);
    return guild;
  };

  async function sync() {
    if (!client?.isReady() || syncing) return;
    syncing = true;
    try {
      guild = await client.guilds.fetch(env.DISCORD_GUILD_ID);
      await guild.roles.fetch();
      await guild.channels.fetch();
      await guild.members.fetch();
      lastSync = new Date().toISOString(); lastError = null;
      changed('members');
    } catch {
      lastError = 'Leden synchroniseren lukt niet. Controleer de server-ID en Server Members Intent.';
    } finally { syncing = false; }
  }

  function ingest(message) {
    if (message.guildId !== env.DISCORD_GUILD_ID) return;
    const source = list(settings().logSources).find(item => item.enabled && item.channelId === message.channelId);
    if (!source) return;
    const embeds = list(message.embeds).map(embed => [embed.title, embed.description, ...list(embed.fields).map(field => `${field.name}: ${field.value}`)].filter(Boolean).join('\n')).join('\n\n');
    try {
      store.addLog({
        id: `discord:${message.id}`, type: 'discord', sourceId: source.id, sourceName: source.name,
        actorId: message.author?.id || null, actorName: message.member?.displayName || message.author?.globalName || message.author?.username || 'Discord',
        content: string([message.content, embeds].filter(Boolean).join('\n\n') || 'Bericht zonder tekst', 10000),
        createdAt: message.createdAt?.toISOString() || new Date().toISOString(),
        metadata: { messageId: message.id, channelId: message.channelId, guildId: message.guildId, url: message.url },
      });
      changed('logs');
    } catch { /* A duplicate gateway delivery must not interrupt the bot. */ }
  }

  async function backfill() {
    for (const source of list(settings().logSources).filter(item => item.enabled)) {
      try {
        const channel = await guild.channels.fetch(source.channelId);
        if (channel?.isTextBased() && channel.messages) {
          const recent = await channel.messages.fetch({ limit: 50 });
          [...recent.values()].reverse().forEach(ingest);
        }
      } catch { lastError = 'Een logkanaal kan niet worden gelezen. Controleer de kanaalrechten.'; }
    }
  }

  async function start() {
    if (!configured() || client) return status();
    try {
      if (clientFactory) client = await clientFactory();
      else {
        const { Client, GatewayIntentBits } = await import('discord.js');
        client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], allowedMentions: { parse: [] } });
      }
      client.once('clientReady', async () => {
        await sync(); if (guild) await backfill();
        refreshTimer = setInterval(sync, 180000); refreshTimer.unref?.();
      });
      const memberChanged = member => {
        if (member.guild.id === env.DISCORD_GUILD_ID) { lastSync = new Date().toISOString(); changed('members'); }
      };
      client.on('guildMemberAdd', memberChanged);
      client.on('guildMemberUpdate', (_old, member) => memberChanged(member));
      client.on('guildMemberRemove', memberChanged);
      client.on('roleCreate', () => changed('members'));
      client.on('roleUpdate', () => changed('members'));
      client.on('roleDelete', () => changed('members'));
      client.on('messageCreate', ingest);
      client.on('error', () => { lastError = 'Discord-verbinding onderbroken. De bot probeert opnieuw te verbinden.'; changed('status'); });
      client.on('shardDisconnect', () => changed('status'));
      client.on('shardResume', () => { void sync(); });
      await client.login(env.DISCORD_TOKEN);
      // Test doubles and already-ready injected clients need no extra gateway event.
      if (client.isReady() && !lastSync) await sync();
    } catch {
      lastError = 'De bot kan niet inloggen. Controleer het bot-token, de server-ID en de ingeschakelde intents.';
      client?.destroy(); client = undefined;
    }
    return status();
  }

  async function stop() { clearInterval(refreshTimer); client?.destroy(); client = undefined; guild = undefined; }

  async function getCatalog() {
    const active = readyGuild();
    await active.roles.fetch(); await active.channels.fetch();
    return {
      guild: { id: active.id, name: active.name, icon: active.iconURL?.({ size: 128 }) || null },
      roles: [...active.roles.cache.values()].filter(role => role.id !== active.id).sort((a, b) => b.position - a.position).map(role => ({ id: role.id, name: role.name, color: role.hexColor, position: role.position, managed: role.managed })),
      channels: [...active.channels.cache.values()].filter(channel => channel.isTextBased() && !channel.isThread?.()).map(channel => ({ id: channel.id, name: channel.name, type: channel.type })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async function getMembers() {
    const active = readyGuild(); const config = settings();
    const members = [...active.members.cache.values()].filter(member => !member.user.bot).map(member => {
      const rank = bestRank(config, rolesOf(member));
      return { id: member.id, username: member.user.username, displayName: member.displayName, avatar: member.displayAvatarURL({ size: 128 }), rank: rank ? { id: rank.id, name: rank.name, order: rank.order } : null, roles: [...member.roles.cache.keys()], joinedAt: member.joinedAt?.toISOString() || null };
    }).filter(member => member.rank).sort((a, b) => a.rank.order - b.rank.order || a.displayName.localeCompare(b.displayName));
    return { members, ranks: ranksOf(config).map(({ id, name, order }) => ({ id, name, order })), updatedAt: lastSync };
  }

  async function notificationChannel(type, config) {
    const id = config.channels?.[type];
    if (!SNOWFLAKE.test(id || '')) fail('Koppel eerst het Discord-kanaal voor deze actie in Instellingen.', 'CHANNEL_NOT_CONFIGURED', 409);
    let channel;
    try { channel = await guild.channels.fetch(id); } catch {}
    if (!channel || channel.guildId !== guild.id || !channel.isTextBased() || !channel.send || !channel.messages) fail('Het gekoppelde kanaal is niet beschikbaar als tekstkanaal in deze server.', 'CHANNEL_UNAVAILABLE', 409);
    const permissions = channel.permissionsFor(guild.members.me || await guild.members.fetchMe());
    if (!permissions || !['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'].every(name => permissions.has(permissionBits[name]))) fail('De bot mist kanaalrechten: kanaal bekijken, berichten versturen, links insluiten of berichtgeschiedenis lezen.', 'CHANNEL_PERMISSIONS', 409);
    return channel;
  }

  async function performAction(input) {
    readyGuild();
    const { type, discordId, rankId, reason, actorId, actorName } = input;
    if (!SNOWFLAKE.test(discordId || '')) fail('Vul een geldig Discord-ID in.');
    if (locks.has(discordId)) fail('Voor dit lid wordt al een actie verwerkt.', 'MEMBER_BUSY', 409);
    locks.add(discordId);
    try {
      const config = settings();
      let target;
      try { target = await guild.members.fetch({ user: discordId, force: true }); }
      catch { fail('Dit Discord-lid zit niet in de gekoppelde server.', 'MEMBER_NOT_FOUND', 404); }
      if (target.user.bot || target.id === guild.ownerId || target.id === env.OWNER_DISCORD_ID || target.id === client.user.id) fail('Dit beschermde account kan niet via personeelsbeheer worden aangepast.', 'PROTECTED_MEMBER', 403);
      const plan = planRoleChanges({ type, rankId, roleIds: rolesOf(target), settings: config });
      const me = guild.members.me || await guild.members.fetchMe();
      if (!me.permissions.has(permissionBits.ManageRoles) || !target.manageable) fail('De bot kan dit lid niet beheren. Zet de botrol boven de personeelsrangen en geef Rollen beheren.', 'ROLE_HIERARCHY', 409);
      await guild.roles.fetch();
      const roles = [...plan.add, ...plan.remove].map(id => guild.roles.cache.get(id));
      if (roles.some(role => !role || role.managed || role.id === guild.id || me.roles.highest.comparePositionTo(role) <= 0)) fail('Een personeelsrol ontbreekt, is beheerd of staat boven de botrol.', 'ROLE_HIERARCHY', 409);
      if (actorId !== env.OWNER_DISCORD_ID) {
        let actor;
        try { actor = await guild.members.fetch({ user: actorId, force: true }); } catch {}
        if (!actor || actor.roles.highest.comparePositionTo(target.roles.highest) <= 0 || roles.some(role => actor.roles.highest.comparePositionTo(role) <= 0)) fail('Je kunt alleen leden en personeelsrangen onder je eigen Discord-rang beheren.', 'ACTOR_HIERARCHY', 403);
      }
      await notificationChannel(type, config);
      const auditReason = string(`Royal Cars portaal: ${ACTION_LABELS[type]} door ${actorName || actorId || 'bevoegd account'} (${actorId || ''}) — ${reason || 'Geen reden opgegeven'}`, 500);
      const added = []; const removed = [];
      try {
        // Add first so demoting never temporarily removes the base personnel access.
        for (const id of plan.add) { await target.roles.add(id, auditReason); added.push(id); }
        for (const id of plan.remove) { await target.roles.remove(id, auditReason); removed.push(id); }
      } catch {
        let rollbackFailed = false;
        for (const id of removed.reverse()) { try { await target.roles.add(id, 'Royal Cars herstel na mislukte actie'); } catch { rollbackFailed = true; } }
        for (const id of added.reverse()) { try { await target.roles.remove(id, 'Royal Cars herstel na mislukte actie'); } catch { rollbackFailed = true; } }
        throw new DiscordServiceError(rollbackFailed ? 'De rolwijziging is deels mislukt en kon niet volledig worden hersteld. Controleer dit lid handmatig in Discord.' : 'Discord heeft de rolwijziging geweigerd. De oorspronkelijke rollen zijn hersteld.', rollbackFailed ? 'PARTIAL_ROLE_FAILURE' : 'ROLE_UPDATE_FAILED', 502, { rollbackFailed });
      }
      lastSync = new Date().toISOString(); changed('members');
      return { targetId: target.id, targetName: target.displayName, rankId: plan.target?.id || null, rankName: plan.target?.name || null, oldRankId: plan.current?.id || null, oldRankName: plan.current?.name || null, addedRoleIds: plan.add, removedRoleIds: plan.remove };
    } finally { locks.delete(discordId); }
  }

  async function notifyAction(operation) {
    readyGuild();
    const channel = await notificationChannel(operation.type, settings());
    const operationId = string(operation.id || operation.operationId, 100);
    if (!operationId) fail('Het dossiernummer voor deze melding ontbreekt.');
    const marker = `Royal Cars • Dossier ${operationId}`;
    // Recover a response lost after a successful send without producing a second announcement.
    const recent = await channel.messages.fetch({ limit: 100 });
    const existing = [...recent.values()].find(message => message.author.id === client.user.id && message.embeds?.some(embed => embed.footer?.text === marker));
    if (existing) return { messageId: existing.id, channelId: channel.id };
    const fields = [
      { name: 'Medewerker', value: `${string(operation.targetName || operation.discordId, 180)}\n<@${operation.targetId || operation.discordId}>`, inline: true },
      { name: 'Uitgevoerd door', value: string(operation.actorName || operation.actorId || 'Bevoegd account', 200), inline: true },
    ];
    if (operation.oldRankName) fields.push({ name: 'Vorige rang', value: string(operation.oldRankName, 200), inline: true });
    if (operation.rankName) fields.push({ name: 'Nieuwe rang', value: string(operation.rankName, 200), inline: true });
    fields.push({ name: 'Reden', value: string(operation.reason || 'Geen reden opgegeven', 1000) });
    const nonce = BigInt(`0x${createHash('sha256').update(operationId).digest('hex').slice(0, 16)}`).toString();
    const message = await channel.send({ allowedMentions: { parse: [] }, nonce, enforceNonce: true, embeds: [{ title: `ROYAL CARS · ${ACTION_LABELS[operation.type]}`, color: ACTION_COLORS[operation.type], fields, timestamp: operation.createdAt || new Date().toISOString(), footer: { text: marker } }] });
    return { messageId: message.id, channelId: channel.id };
  }

  return { start, stop, status, getCatalog, getMembers, performAction, notifyAction };
}
