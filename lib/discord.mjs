import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderRosterMessage } from './discord-roster.mjs';

const SNOWFLAKE = /^\d{17,20}$/;
const ACTION_LABELS = { hire: 'Aangenomen', promote: 'Gepromoveerd', demote: 'Demotie', dismiss: 'Ontslagen' };
const ACTION_COLORS = { hire: 0x39b980, promote: 0x568bf0, demote: 0xeab35a, dismiss: 0xe34251 };
const permissionBits = { ManageGuild: 1n << 5n, AddReactions: 1n << 6n, ManageRoles: 1n << 28n, ViewChannel: 1n << 10n, SendMessages: 1n << 11n, EmbedLinks: 1n << 14n, AttachFiles: 1n << 15n, ReadMessageHistory: 1n << 16n, MentionEveryone: 1n << 17n, SendMessagesInThreads: 1n << 38n };
const ROSTER_COMMAND = 'ledenlijst';
const EPHEMERAL = 1 << 6;
const SUPPRESS_NOTIFICATIONS = 1 << 12;
const NO_MENTIONS = { parse: [], repliedUser: false };
const OPENING_CHANNEL = '1565489120262754524';
const OPENING_ROLE = '1189079959722008657';
const OPENING_IMAGE = fileURLToPath(new URL('./royal-cars-opening.jpg', import.meta.url));
const OPENING_CONTENT = `<@&${OPENING_ROLE}>

# 🏁 ROYAL CARS OPENT VANAVOND WEER

Vanavond om **21.00 uur** gaan de deuren van **Royal Cars** weer open op **postcode 768**. Er staat een selectie **exclusieve auto’s** voor jullie klaar. Kom langs, bekijk het aanbod en spreek een van onze verkopers aan als je iets moois ziet. 🏎️🔥

### 📱 Vergeet je telefoon niet

Neem een **opgeladen telefoon** mee, zodat je bij een aankoop de betaling direct via een **overschrijving** kunt regelen.

### 🛡️ Houd het netjes bij de ingang

- Wacht rustig op je beurt en houd de ingang vrij.
- Blijf vóór het hek tot ons team aangeeft dat je naar binnen mag.
- Houd je aan de regels en volg de aanwijzingen van het personeel en de beveiliging.

👑 **Tot vanavond bij Royal Cars!**
-- Team Royal Cars`;
const isMissingDiscordMessage = error => [10003, 10008].includes(Number(error?.code));
const rosterSendPermission = channel => channel.isThread?.() ? permissionBits.SendMessagesInThreads : permissionBits.SendMessages;

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
export function planRoleChanges({ type, rankId, roleIds, settings, extraRoleIds = [], trackedRoleIds = [] }) {
  if (!Object.hasOwn(ACTION_LABELS, type)) fail('Onbekende personeelsactie.');
  const ranks = ranksOf(settings);
  if (!ranks.length) fail('Koppel eerst de personeelsrangen in Instellingen.', 'RANKS_NOT_CONFIGURED', 409);
  const current = bestRank(settings, roleIds);
  const target = ranks.find(rank => rank.id === rankId);
  const preserved = new Set(list(settings.preserveRoleIds));
  const base = list(settings.baseRoleIds);
  if (base.some(id => ranks.some(rank => rank.roleId === id))) fail('Een basisrol mag niet ook als personeelsrang zijn ingesteld. Pas eerst de configuratie aan.', 'ROLE_CONFIG_CONFLICT', 409);
  if (extraRoleIds.some(id => !SNOWFLAKE.test(id) || ranks.some(rank => rank.roleId === id) || preserved.has(id))) fail('Kies extra rollen zonder rangrollen of behouden rollen.', 'INVALID_EXTRA_ROLE', 400);
  if (trackedRoleIds.some(id => ranks.some(rank => rank.roleId === id) || preserved.has(id))) fail('Een eerder toegekende extra rol staat nu als rang of behouden rol ingesteld. Controleer eerst de rolconfiguratie.', 'ROLE_CONFIG_CONFLICT', 409);
  const staffRoles = new Set([...ranks.map(rank => rank.roleId), ...base, ...trackedRoleIds]);
  if ([...staffRoles].some(id => preserved.has(id))) fail('Een personeelsrol staat ook bij behouden rollen. Pas eerst de configuratie aan.', 'ROLE_CONFIG_CONFLICT', 409);
  if (type !== 'dismiss' && !target) fail('Selecteer een geldige gekoppelde rang.');
  if (type === 'hire' && current) fail('Dit lid heeft al een personeelsrang.', 'ALREADY_STAFF', 409);
  if (type !== 'hire' && !current) fail('Dit lid heeft geen gekoppelde personeelsrang.', 'NOT_STAFF', 409);
  if (type === 'promote' && target.order >= current.order) fail('Bij een promotie moet de nieuwe rang hoger zijn dan de huidige rang.', 'INVALID_PROMOTION', 409);
  if (type === 'demote' && target.order <= current.order) fail('Bij een demotie moet de nieuwe rang lager zijn dan de huidige rang.', 'INVALID_DEMOTION', 409);
  const desired = new Set(type === 'dismiss' ? [] : [target.roleId, ...base, ...(type === 'hire' ? extraRoleIds : trackedRoleIds)]);
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
  let rosterTimer;
  let rosterWork = Promise.resolve();
  let lastRosterRevision;
  let rosterCommandRegistered = false;
  let rosterCommandRegistering = false;
  const locks = new Set();
  const configured = () => Boolean(env.DISCORD_TOKEN && SNOWFLAKE.test(env.DISCORD_GUILD_ID || ''));
  const settings = () => store.getSettings();
  const changed = kind => {
    if (kind === 'members') scheduleRosterRefresh();
    try { onChange(kind); } catch {}
  };
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
      void registerRosterCommand();
      void registerAttendanceCommand();
      void registerOpeningCommand();
    } catch {
      lastError = 'Leden synchroniseren lukt niet. Controleer de server-ID en Server Members Intent.';
    } finally { syncing = false; }
  }

  async function registerRosterCommand() {
    if (!guild?.commands?.create || rosterCommandRegistered || rosterCommandRegistering) return;
    rosterCommandRegistering = true;
    try {
      // The guild command POST upserts this command by name. Never bulk replace other commands.
      await guild.commands.create({ name: ROSTER_COMMAND, description: 'Plaats of vernieuw de live ledenlijst van Royal Cars.' });
      rosterCommandRegistered = true;
      console.info('Discord-opdracht /ledenlijst is geregistreerd.');
    } catch {
      console.warn('De Discord-opdracht /ledenlijst kon niet worden geregistreerd. De bot probeert het bij de volgende synchronisatie opnieuw.');
    } finally { rosterCommandRegistering = false; }
  }

  function scheduleRosterRefresh() {
    if (!status().online || typeof store.getRosterMessage !== 'function') return;
    clearTimeout(rosterTimer);
    rosterTimer = setTimeout(() => {
      rosterTimer = undefined;
      void queueRosterRefresh().catch(() => console.warn('De Discord-ledenlijst kon niet automatisch worden vernieuwd.'));
    }, 1000);
    rosterTimer.unref?.();
  }

  function queueRosterRefresh(options) {
    const request = rosterWork.then(() => upsertRosterMessage(options));
    rosterWork = request.catch(() => {});
    return request;
  }

  async function rosterChannel(active, channelId, canPost, requireEmbed = true) {
    if (!SNOWFLAKE.test(channelId || '')) fail('Gebruik dit commando in een tekstkanaal op Discord.', 'ROSTER_CHANNEL', 400);
    const channel = await active.channels.fetch(channelId, { force: true });
    if (!channel || channel.guildId !== active.id || !channel.isTextBased() || typeof channel.send !== 'function' || !channel.messages || typeof channel.permissionsFor !== 'function') fail('Dit kanaal ondersteunt dit commando niet.', 'ROSTER_CHANNEL', 409);
    if (canPost && !canPost(channel)) fail('Je moet in dit kanaal ook berichten kunnen versturen om dit commando hier te gebruiken.', 'ROSTER_CHANNEL_ACCESS', 403);
    const permissions = channel.permissionsFor(active.members.me || await active.members.fetchMe());
    if (!permissions || ![permissionBits.ViewChannel, rosterSendPermission(channel), permissionBits.ReadMessageHistory, ...(requireEmbed ? [permissionBits.EmbedLinks] : [])].every(bit => permissions.has(bit))) fail('De bot mist kanaalrechten. Controleer Kanaal bekijken, Berichten versturen en Berichtgeschiedenis lezen.', 'ROSTER_CHANNEL_PERMISSIONS', 409);
    return channel;
  }

  async function upsertRosterMessage({ destinationId, canPost } = {}) {
    const active = readyGuild();
    if (typeof store.getRosterMessage !== 'function' || typeof store.setRosterMessage !== 'function') fail('De opslag voor de Discord-ledenlijst is niet beschikbaar.', 'ROSTER_STORAGE', 503);
    const saved = store.getRosterMessage(active.id);
    if (!saved && !destinationId) return null;
    const payload = { ...renderRosterMessage(await getMembers({ includeRoleIds: true })), allowedMentions: NO_MENTIONS };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const revision = ({ channelId, messageId }) => `${active.id}:${channelId}:${messageId}:${hash}`;
    if (saved) {
      if (!destinationId && lastRosterRevision === revision(saved)) return saved;
      try {
        const channel = await rosterChannel(active, saved.channelId);
        const message = await channel.messages.fetch({ message: saved.messageId, force: true, cache: false });
        if (!message || message.author?.id !== client?.user?.id) fail('Het opgeslagen ledenlijstbericht kan niet door deze bot worden bijgewerkt.', 'ROSTER_MESSAGE_ACCESS', 409);
        await message.edit(payload);
        if (!lastRosterRevision && !destinationId) console.info('Bestaande Discord-ledenlijst bijgewerkt.');
        lastRosterRevision = revision(saved);
        return { ...saved, created: false };
      } catch (error) {
        // Missing access or a network failure does not mean the existing list has been deleted.
        if (!isMissingDiscordMessage(error)) throw error;
        lastRosterRevision = undefined;
        if (!destinationId) return null;
      }
    }
    const channel = await rosterChannel(active, destinationId, canPost);
    const nonce = BigInt(`0x${createHash('sha256').update(`ledenlijst:${active.id}:${channel.id}:${saved?.messageId || 'new'}`).digest('hex').slice(0, 16)}`).toString();
    const message = await channel.send({ ...payload, flags: SUPPRESS_NOTIFICATIONS, nonce, enforceNonce: true });
    const pointer = { channelId: channel.id, messageId: message.id };
    try { store.setRosterMessage(active.id, pointer); }
    catch (error) { try { await message.delete(); } catch {} throw error; }
    lastRosterRevision = revision(pointer);
    return { ...pointer, created: true };
  }

  async function handleRosterCommand(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== ROSTER_COMMAND || interaction.guildId !== env.DISCORD_GUILD_ID) return;
    const isOwner = Boolean(env.OWNER_DISCORD_ID && interaction.user?.id === env.OWNER_DISCORD_ID);
    if (!isOwner && !interaction.memberPermissions?.has(permissionBits.ManageGuild)) {
      try { await interaction.reply({ content: 'Alleen Directie en leden met Server beheren kunnen de ledenlijst plaatsen of vernieuwen.', flags: EPHEMERAL, allowedMentions: NO_MENTIONS }); } catch {}
      return;
    }
    try { await interaction.deferReply({ flags: EPHEMERAL }); } catch { return; }
    let content;
    try {
      const roster = await queueRosterRefresh({ destinationId: interaction.channelId, canPost: channel => isOwner || interaction.memberPermissions?.has(rosterSendPermission(channel)) });
      if (roster.channelId === interaction.channelId || isOwner) {
        const link = `https://discord.com/channels/${interaction.guildId}/${roster.channelId}/${roster.messageId}`;
        content = roster.created ? `De live ledenlijst staat in <#${roster.channelId}>: ${link}` : `De live ledenlijst in <#${roster.channelId}> is bijgewerkt: ${link}`;
      } else {
        content = 'De bestaande live ledenlijst is bijgewerkt.';
      }
    } catch (error) {
      content = error instanceof DiscordServiceError ? error.message : 'De ledenlijst kon niet worden bijgewerkt. Controleer of de bot toegang heeft tot het oorspronkelijke kanaal en probeer het opnieuw.';
    }
    try { await interaction.editReply({ content, allowedMentions: NO_MENTIONS }); } catch {}
  }

  let attendanceRegistered = false;
  let attendanceRegistering = false;
  let attendancePosting = false;
  const attendanceChoices = new Map([['✅', 'present'], ['❌', 'absent']]);
  let openingRegistered = false;
  let openingRegistering = false;

  async function registerOpeningCommand() {
    if (!guild?.commands?.create || openingRegistered || openingRegistering) return;
    openingRegistering = true;
    try {
      await guild.commands.create({ name: 'opening', description: 'Plaats de Royal Cars-aankondiging in het openingskanaal.' });
      openingRegistered = true;
      console.info('Discord-opdracht /opening is geregistreerd.');
    } catch {
      console.warn('Discord-opdracht /opening kon niet worden geregistreerd.');
    } finally {
      openingRegistering = false;
    }
  }

  async function handleOpeningCommand(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'opening' || interaction.guildId !== env.DISCORD_GUILD_ID) return;
    const isOwner = Boolean(env.OWNER_DISCORD_ID && interaction.user?.id === env.OWNER_DISCORD_ID);
    if (!isOwner && !interaction.memberPermissions?.has(permissionBits.ManageGuild)) {
      try { await interaction.reply({ content: 'Alleen Directie en leden met Server beheren kunnen de opening aankondigen.', flags: EPHEMERAL }); } catch {}
      return;
    }
    try { await interaction.deferReply({ flags: EPHEMERAL }); } catch { return; }
    let content;
    try {
      const active = readyGuild();
      const channel = await active.channels.fetch(OPENING_CHANNEL, { force: true });
      if (!channel || channel.guildId !== active.id || typeof channel.send !== 'function') fail('Het vaste openingskanaal is niet beschikbaar.', 'OPENING_CHANNEL', 409);
      const permissions = channel.permissionsFor(active.members.me || await active.members.fetchMe());
      if (!permissions || ![permissionBits.ViewChannel, rosterSendPermission(channel), permissionBits.AttachFiles].every(bit => permissions.has(bit))) {
        fail('De bot moet het openingskanaal kunnen bekijken en daar berichten met bestanden kunnen versturen.', 'OPENING_CHANNEL_PERMISSIONS', 409);
      }
      const role = active.roles.cache.get(OPENING_ROLE);
      if (!role || role.id === active.id || (!role.mentionable && !permissions.has(permissionBits.MentionEveryone))) {
        fail('De bot kan de opgegeven rol niet pingen in het openingskanaal.', 'OPENING_ROLE', 409);
      }
      const message = await channel.send({
        content: OPENING_CONTENT,
        files: [{ attachment: OPENING_IMAGE, name: 'royal-cars-opening.jpg', description: 'De locatie van Royal Cars' }],
        allowedMentions: { ...NO_MENTIONS, roles: [OPENING_ROLE] },
        nonce: interaction.id, enforceNonce: true,
      });
      content = 'Openingsbericht geplaatst: https://discord.com/channels/' + active.id + '/' + OPENING_CHANNEL + '/' + message.id;
    } catch (error) {
      content = error instanceof DiscordServiceError ? error.message : 'Het openingsbericht kon niet worden geplaatst. Controleer de kanaalrechten van de bot.';
      console.warn('/opening: bericht plaatsen mislukt.');
    }
    try { await interaction.editReply({ content, allowedMentions: NO_MENTIONS }); } catch {}
  }

  async function registerAttendanceCommand() {
    if (!guild?.commands?.create || attendanceRegistered || attendanceRegistering) return;
    attendanceRegistering = true;
    try {
      await guild.commands.create({ name: 'aanwezigheid', description: 'Plaats de aanwezigheidscheck van vandaag.' });
      attendanceRegistered = true;
      console.info('Discord-opdracht /aanwezigheid is geregistreerd.');
    } catch {
      console.warn('Discord-opdracht /aanwezigheid kon niet worden geregistreerd.');
    } finally {
      attendanceRegistering = false;
    }
  }

  function trackAttendance({ t, d }) {
    if (!t?.startsWith('MESSAGE_REACTION_') || !d?.guild_id || d.guild_id !== env.DISCORD_GUILD_ID) return;
    try {
      const choice = !d.emoji?.id && attendanceChoices.get(d.emoji?.name);
      if (t === 'MESSAGE_REACTION_REMOVE_ALL') {
        store.clearAttendanceReactions(d.guild_id, d.message_id);
      } else if (choice && t === 'MESSAGE_REACTION_REMOVE_EMOJI') {
        store.clearAttendanceReactions(d.guild_id, d.message_id, choice);
      } else if (choice && ['MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE'].includes(t) && d.user_id !== client.user?.id) {
        const member = guild?.members.cache.get(d.user_id);
        const user = d.member?.user || member?.user;
        if (user?.bot) return;
        store.recordAttendanceReaction({
          guildId: d.guild_id, messageId: d.message_id, userId: d.user_id, choice,
          name: d.member?.nick || member?.displayName || user?.global_name || user?.username || d.user_id, variant: d.type === 1 ? 1 : 0,
          add: t === 'MESSAGE_REACTION_ADD',
        });
      }
    } catch {
      console.warn('Aanwezigheidsreactie kon niet worden opgeslagen.');
    }
  }

  function attendanceMessage(active, day, permissions) {
    const [year, month, date] = day.split('-').map(Number);
    const normalize = name => name.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const names = ['Team Royal Cars', 'Team Beveiliging', 'Personeel'];
    const roles = [...active.roles.cache.values()];
    const targets = names.map(name => ({ name, role: roles.find(role => role.id !== active.id && normalize(role.name) === normalize(name)) }));
    const roleIds = targets.flatMap(({ role }) => role ? [role.id] : []);
    const canMentionAllRoles = permissions.has(permissionBits.MentionEveryone);
    const missedRoles = targets.filter(({ role }) => !role || (!role.mentionable && !canMentionAllRoles)).map(({ name }) => name);
    const absence = [...active.channels.cache.values()].find(channel => normalize(channel.name) === 'afwezigheid' && channel.isTextBased());
    const logo = active.emojis?.cache.find(emoji => /royal_?cars|^rc(?:_?logo)?$/i.test(emoji.name))?.toString() || '🚗';
    const content = [
      '# ' + logo + ' RoyalCars ' + date + '-' + month + '-' + year + ' ' + logo,
      'Aanwezigheid',
      '',
      '✅Aanwezig',
      '❌Afwezig (' + (absence ? '<#' + absence.id + '>' : '#afwezigheid') + ')',
      '',
      targets.map(({ name, role }) => role ? '<@&' + role.id + '>' : name).join(' '),
    ].join('\n');
    return { content, roleIds, missedRoles };
  }

  function attendanceDay() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts();
    const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${date.year}-${date.month}-${date.day}`;
  }

  async function handleAttendanceCommand(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'aanwezigheid' || interaction.guildId !== env.DISCORD_GUILD_ID) return;
    const isOwner = Boolean(env.OWNER_DISCORD_ID && interaction.user?.id === env.OWNER_DISCORD_ID);
    if (!isOwner && !interaction.memberPermissions?.has(permissionBits.ManageGuild)) {
      try { await interaction.reply({ content: 'Alleen Directie en leden met Server beheren kunnen een aanwezigheidscheck plaatsen.', flags: EPHEMERAL }); } catch {}
      return;
    }
    try { await interaction.deferReply({ flags: EPHEMERAL }); } catch { return; }
    if (attendancePosting) {
      try { await interaction.editReply('Er wordt al een aanwezigheidscheck geplaatst.'); } catch {}
      return;
    }
    attendancePosting = true;
    let reply;
    let step = 'opslag lezen';
    try {
      const active = readyGuild();
      const day = attendanceDay();
      const existing = store.getAttendancePost(active.id, day);
      if (existing && existing.channelId !== interaction.channelId && !isOwner) {
        await interaction.editReply('Er bestaat al een aanwezigheidscheck voor vandaag.');
        return;
      }
      step = 'kanaal ophalen';
      const channel = await rosterChannel(active, existing?.channelId || interaction.channelId, target => isOwner || interaction.memberPermissions?.has(rosterSendPermission(target)), false);
      const permissions = channel.permissionsFor(active.members.me || await active.members.fetchMe());
      if (!permissions?.has(permissionBits.AddReactions)) fail('Geef de bot in dit kanaal de machtiging Reacties toevoegen.', 'ATTENDANCE_REACTIONS', 409);
      let missedRoles = [];
      const addReactions = async messageId => {
        step = 'reacties toevoegen';
        for (const emoji of attendanceChoices.keys()) await channel.messages.react(messageId, emoji);
      };
      const postCheck = async replaces => {
        step = 'bericht opmaken';
        const { content, roleIds, missedRoles: unnotified } = attendanceMessage(active, day, permissions);
        missedRoles = unnotified;
        step = 'bericht plaatsen';
        const message = await channel.send({ content, allowedMentions: { ...NO_MENTIONS, roles: roleIds },
          nonce: createHash('sha256').update('attendance:' + active.id + ':' + day + ':' + (replaces || '')).digest('hex').slice(0, 24), enforceNonce: true });
        step = 'bericht opslaan';
        store.saveAttendancePost({ guildId: active.id, channelId: channel.id, messageId: message.id, day, replaces });
        await addReactions(message.id);
        return message.id;
      };
      let messageId = existing?.messageId;
      if (messageId) {
        try {
          await addReactions(messageId);
        } catch (error) {
          if (Number(error?.code) !== 10008) throw error;
          messageId = await postCheck(messageId);
        }
      } else {
        messageId = await postCheck();
      }
      console.info('/aanwezigheid: aanwezigheidscheck klaar.');
      reply = 'Aanwezigheidscheck: https://discord.com/channels/' + active.id + '/' + channel.id + '/' + messageId;
      if (missedRoles.length) reply += '\nGeen ping voor ' + missedRoles.join(', ') + '. Controleer de rolnamen en of de bot deze rollen in dit kanaal mag vermelden.';
    } catch (error) {
      const code = String(error?.code || error?.name || 'UNKNOWN');
      const safeCode = /^[a-z0-9_]{1,64}$/i.test(code) ? code : 'UNKNOWN';
      if (error instanceof DiscordServiceError) reply = error.message;
      else if (code === '50001' || code === '50013') reply = 'Discord weigert toegang bij ' + step + '. Controleer de rechten van de bot in dit kanaal.';
      else if (code === '10008') reply = 'Discord kon het nieuwe aanwezigheidsbericht niet meer vinden toen de bot de reacties wilde toevoegen.';
      else reply = 'De aanwezigheidscheck liep vast bij ' + step + ' (' + safeCode + ').';
      console.warn('/aanwezigheid: ' + step + ' mislukt (' + safeCode + ').');
    } finally {
      attendancePosting = false;
    }
    try { await interaction.editReply({ content: reply, allowedMentions: NO_MENTIONS }); } catch {}
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
        client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent], allowedMentions: { parse: [] } });
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
      client.on('interactionCreate', interaction => { void handleRosterCommand(interaction); void handleAttendanceCommand(interaction); void handleOpeningCommand(interaction); });
      client.on('raw', trackAttendance);
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

  async function stop() { clearInterval(refreshTimer); clearTimeout(rosterTimer); client?.destroy(); client = undefined; guild = undefined; rosterCommandRegistered = false; attendanceRegistered = false; openingRegistered = false; lastRosterRevision = undefined; }

  async function getCatalog() {
    const active = readyGuild();
    await active.roles.fetch(); await active.channels.fetch();
    return {
      guild: { id: active.id, name: active.name, icon: active.iconURL?.({ size: 128 }) || null },
      roles: [...active.roles.cache.values()].filter(role => role.id !== active.id).sort((a, b) => b.position - a.position).map(role => ({ id: role.id, name: role.name, color: role.hexColor, position: role.position, managed: role.managed, assignable: Boolean(role.editable) })),
      channels: [...active.channels.cache.values()].filter(channel => channel.isTextBased() && !channel.isThread?.()).map(channel => ({ id: channel.id, name: channel.name, type: channel.type })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async function getMembers({ includeRoleIds = false } = {}) {
    const active = readyGuild(); const config = settings();
    const manualRanksByMember = new Map();
    for (const rank of ranksOf(config)) {
      for (const id of list(rank.manualMemberIds)) {
        if (!manualRanksByMember.has(id)) manualRanksByMember.set(id, []);
        manualRanksByMember.get(id).push(rank.id);
      }
    }
    const members = [...active.members.cache.values()].filter(member => !member.user.bot).map(member => {
      const rank = bestRank(config, rolesOf(member));
      return { id: member.id, username: member.user.username, displayName: member.displayName, manualRankIds: (manualRanksByMember.get(member.id) || []).filter(id => id !== rank?.id), avatar: member.displayAvatarURL({ size: 128 }), rank: rank ? { id: rank.id, name: rank.name, order: rank.order } : null, roles: [...member.roles.cache.keys()], joinedAt: member.joinedAt?.toISOString() || null };
    }).filter(member => member.rank || member.manualRankIds.length).sort((a, b) => (a.rank?.order ?? Infinity) - (b.rank?.order ?? Infinity) || a.displayName.localeCompare(b.displayName));
    const ranks = ranksOf(config).map(({ id, name, order, roleId }) => ({
      id, name, order,
      ...(includeRoleIds && active.roles.cache.has(roleId) ? { roleId } : {}),
    }));
    return { members, ranks, updatedAt: lastSync };
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
      const extraRoleIds = [...new Set(input.roleIds || [])];
      if (extraRoleIds.length > 25 || (type !== 'hire' && extraRoleIds.length)) fail('Ongeldige extra rollen.');
      if (actorId !== env.OWNER_DISCORD_ID && extraRoleIds.some(id => !(config.hireRoleIds || []).includes(id))) fail('Deze extra rol is niet beschikbaar voor jouw aannamebevoegdheid.', 'EXTRA_ROLE_FORBIDDEN', 403);
      const plan = planRoleChanges({ type, rankId, roleIds: rolesOf(target), settings: config, extraRoleIds, trackedRoleIds: store.getPersonnelRoleIds?.(target.id) || [] });
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
        // Add the destination rank before removing the old one to keep personnel access during the transition.
        for (const id of plan.add) { await target.roles.add(id, auditReason); added.push(id); }
        for (const id of plan.remove) { await target.roles.remove(id, auditReason); removed.push(id); }
      } catch {
        let rollbackFailed = false;
        for (const id of removed.reverse()) { try { await target.roles.add(id, 'Royal Cars herstel na mislukte actie'); } catch { rollbackFailed = true; } }
        for (const id of added.reverse()) { try { await target.roles.remove(id, 'Royal Cars herstel na mislukte actie'); } catch { rollbackFailed = true; } }
        throw new DiscordServiceError(rollbackFailed ? 'De rolwijziging is deels mislukt en kon niet volledig worden hersteld. Controleer dit lid handmatig in Discord.' : 'Discord heeft de rolwijziging geweigerd. De oorspronkelijke rollen zijn hersteld.', rollbackFailed ? 'PARTIAL_ROLE_FAILURE' : 'ROLE_UPDATE_FAILED', 502, { rollbackFailed });
      }
      lastSync = new Date().toISOString(); changed('members');
      return { targetId: target.id, targetName: target.displayName, rankId: plan.target?.id || null, rankName: plan.target?.name || null, oldRankId: plan.current?.id || null, oldRankName: plan.current?.name || null, addedRoleIds: plan.add, removedRoleIds: plan.remove, extraRoleIds: type === 'hire' ? extraRoleIds : [], extraRoleNames: extraRoleIds.map(id => guild.roles.cache.get(id)?.name || id) };
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
    if (operation.extraRoleNames?.length) fields.push({ name: 'Extra rollen', value: string(operation.extraRoleNames.join(', '), 1000) });
    fields.push({ name: 'Reden', value: string(operation.reason || 'Geen reden opgegeven', 1000) });
    const nonce = BigInt(`0x${createHash('sha256').update(operationId).digest('hex').slice(0, 16)}`).toString();
    const targetId = operation.targetId || operation.discordId;
    const mentionTarget = operation.type === 'promote' && SNOWFLAKE.test(targetId || '');
    const message = await channel.send({
      ...(mentionTarget ? { content: `<@${targetId}>` } : {}),
      allowedMentions: mentionTarget ? { parse: [], users: [targetId] } : { parse: [] },
      nonce,
      enforceNonce: true,
      embeds: [{ title: `ROYAL CARS · ${ACTION_LABELS[operation.type]}`, color: ACTION_COLORS[operation.type], fields, timestamp: operation.createdAt || new Date().toISOString(), footer: { text: marker } }],
    });
    return { messageId: message.id, channelId: channel.id };
  }

  function getProfile(id) {
    const member = guild?.members.cache.get(id);
    return member ? { displayName: member.displayName, avatar: member.displayAvatarURL({ size: 128 }) } : null;
  }
  return { start, stop, status, getCatalog, getMembers, getProfile, performAction, notifyAction, scheduleRosterRefresh };
}
