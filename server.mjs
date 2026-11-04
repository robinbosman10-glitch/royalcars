import express from 'express';
import session from 'express-session';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { Store, SQLiteSessionStore } from './lib/store.mjs';
import { bootstrapOwner, DUMMY_HASH, isPasswordHash, hashPassword, verifyPassword, validateUsername, validatePassword } from './lib/passwords.mjs';
import { HttpError, DISCORD_ID, PERSONNEL_ACTIONS, accessFor, allowedLogSources, safeEqual, csrfToken, validateSettings, validateAccount, validateGroup, validateAction, createOperationRunner } from './lib/security.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
export function configuration(env, store) {
  const setup = { login: Boolean(store ? store.getCredential(env.OWNER_DISCORD_ID || '') : (env.OWNER_LOGIN_USERNAME && isPasswordHash(env.OWNER_LOGIN_PASSWORD_HASH))), bot: Boolean(env.DISCORD_TOKEN), guild: DISCORD_ID.test(env.DISCORD_GUILD_ID || ''), owner: DISCORD_ID.test(env.OWNER_DISCORD_ID || ''), session: Boolean(env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) };
  return { setup, configured: setup.login && setup.owner && setup.session };
}

export function createApp({ store, bot, env = process.env }) {
  bootstrapOwner(store, env);
  const app = express(); const { setup, configured } = configuration(env, store);
  const production = env.NODE_ENV === 'production';
  const appUrl = new URL(env.APP_URL || 'http://localhost:3000');
  if (production && appUrl.protocol !== 'https:') throw new Error('APP_URL moet in productie https gebruiken.');
  const sessionSecret = setup.session ? env.SESSION_SECRET : randomBytes(48).toString('hex');
  app.disable('x-powered-by'); app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '48kb', strict: true }));
  app.use(session({ name: 'rc.sid', secret: sessionSecret, store: new SQLiteSessionStore(store), resave: false, saveUninitialized: false, proxy: true, cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: 8 * 60 * 60 * 1000 } }));

  const rate = new Map();
  function throttle(limit, windowMs) { return (req, res, next) => { const key = `${req.ip}:${req.path}`; const now = Date.now(); let entry = rate.get(key); if (!entry || entry.until < now) { entry = { count: 0, until: now + windowMs }; rate.set(key, entry); } if (++entry.count > limit) return res.status(429).json({ error: 'Te veel verzoeken. Probeer het later opnieuw.' }); if (rate.size > 5000) for (const [key, value] of rate) if (value.until < now) rate.delete(key); next(); }; }
  const guard = (permission) => async (req, res, next) => {
    try {
      if (!req.session.user || req.session.authType !== 'password') throw new HttpError(401, 'Log eerst in met je gebruikersnaam en wachtwoord.');
      const credential = store.getCredential(req.session.user.id);
      if (!credential || credential.version !== req.session.authVersion) { req.session.destroy(() => {}); throw new HttpError(401, 'Je inloggegevens zijn gewijzigd. Log opnieuw in.'); }
      req.credential = credential;
      if (credential.mustChangePassword && req.path !== '/api/account/password' && req.path !== '/auth/logout') { const error = new HttpError(403, 'Stel eerst je eigen wachtwoord in.'); error.code = 'PASSWORD_CHANGE_REQUIRED'; throw error; }
      const access = accessFor(req.session.user.id, store, env.OWNER_DISCORD_ID);
      if (!access) { req.session.destroy(() => {}); throw new HttpError(403, 'Je account heeft geen toegang tot dit portaal.'); }
      if (permission && !access.permissions.includes(permission)) throw new HttpError(403, 'Je hebt geen toegang tot deze pagina of actie.');
      req.access = access; req.user = { ...req.session.user, isOwner: access.isOwner };
      next();
    } catch (error) { next(error); }
  };
  const csrf = (req, res, next) => {
    const origin = req.get('origin');
    if ((origin && origin !== appUrl.origin) || !safeEqual(req.session.csrfToken, req.get('x-csrf-token'))) return next(new HttpError(403, 'De beveiligingscode is verlopen. Vernieuw de pagina.'));
    next();
  };
  const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const saveSession = req => new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
  const regenerateSession = req => new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  function publicUser(credential, access) {
    const account = store.getAccount(credential.id);
    const profile = bot.getProfile?.(credential.id);
    return { id: credential.id, username: credential.username, loginUsername: credential.username, displayName: profile?.displayName || account?.label || credential.username, avatar: profile?.avatar || '', isOwner: access.isOwner, groupName: access.groupName || '', groupColor: access.groupColor || '' };
  }
  function sessionResponse(req) {
    req.session.csrfToken ||= csrfToken();
    const credential = req.session.user && req.session.authType === 'password' ? store.getCredential(req.session.user.id) : null;
    const access = credential && credential.version === req.session.authVersion ? accessFor(credential.id, store, env.OWNER_DISCORD_ID) : null;
    if (!access) return { authenticated: false, configured, authMethod: 'password', preview: false, user: null, permissions: [], csrfToken: req.session.csrfToken, setup, bot: { online: Boolean(bot.status().online), configured: setup.bot } };
    return { authenticated: true, configured, authMethod: 'password', preview: false, mustChangePassword: credential.mustChangePassword, user: publicUser(credential, access), permissions: access.permissions, ranks: store.getSettings().ranks, csrfToken: req.session.csrfToken, setup, bot: bot.status() };
  }
  app.get(['/health', '/healthz'], (req, res) => res.json({ status: 'ok', configured, bot: Boolean(bot.status().online) }));
  app.get('/api/session', (req, res) => res.json(sessionResponse(req)));
  app.get(['/auth/discord', '/auth/discord/callback'], (req, res) => res.redirect('/?error=password_login'));
  app.post('/auth/login', throttle(12, 60_000), csrf, asyncRoute(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 128) : '';
    const key = createHash('sha256').update(`${sessionSecret}|${req.ip}|${username.toLowerCase()}`).digest('hex');
    const ipKey = createHash('sha256').update(`${sessionSecret}|${req.ip}`).digest('hex');
    if (store.loginFailures(key) >= 5 || store.loginFailures(ipKey) >= 30) throw new HttpError(429, 'Te veel mislukte inlogpogingen. Probeer het over 15 minuten opnieuw.');
    const credential = store.findCredential(username);
    const correct = await verifyPassword(req.body?.password, credential?.passwordHash || DUMMY_HASH);
    const access = credential ? accessFor(credential.id, store, env.OWNER_DISCORD_ID) : null;
    if (!configured || !credential || !correct || !access) { store.failLogin(key); store.failLogin(ipKey); throw new HttpError(401, 'Gebruikersnaam of wachtwoord is onjuist.'); }
    store.clearLoginFailures(key);
    await regenerateSession(req);
    req.session.user = publicUser(credential, access); req.session.authType = 'password'; req.session.authVersion = credential.version; req.session.authenticatedAt = Date.now(); req.session.csrfToken = csrfToken();
    store.addLog({ type: 'login', actorId: credential.id, actorName: req.session.user.displayName, content: `${req.session.user.displayName} is ingelogd op het portaal.` });
    await saveSession(req); res.json(sessionResponse(req));
  }));
  app.post('/api/account/password', guard(), csrf, throttle(8, 60_000), asyncRoute(async (req, res) => {
    const credential = req.credential;
    if (!await verifyPassword(req.body?.currentPassword, credential.passwordHash)) throw new HttpError(400, 'Je huidige wachtwoord is onjuist.');
    const password = validatePassword(req.body?.newPassword);
    if (await verifyPassword(password, credential.passwordHash)) throw new HttpError(400, 'Kies een nieuw wachtwoord dat verschilt van je huidige wachtwoord.');
    const username = req.body?.username ? validateUsername(req.body.username) : credential.username;
    const existing = store.findCredential(username);
    if (existing && existing.id !== credential.id) throw new HttpError(409, 'Deze gebruikersnaam is al in gebruik.');
    const next = store.setCredential({ id: credential.id, username, passwordHash: await hashPassword(password), mustChangePassword: false });
    await regenerateSession(req);
    req.session.user = publicUser(next, req.access); req.session.authType = 'password'; req.session.authVersion = next.version; req.session.authenticatedAt = Date.now(); req.session.csrfToken = csrfToken();
    store.addLog({ type: 'account', actorId: credential.id, actorName: req.session.user.displayName, content: 'Eigen inloggegevens bijgewerkt.' });
    await saveSession(req); res.json(sessionResponse(req));
  }));
  app.post('/auth/logout', guard(), csrf, (req, res, next) => req.session.destroy(error => { if (error) return next(error); res.clearCookie('rc.sid', { httpOnly: true, sameSite: 'lax', secure: production }); res.json({ ok: true }); }));

  app.get('/api/dashboard', guard('dashboard'), asyncRoute(async (req, res) => {
    const data = await bot.getMembers();
    const recentActivity = req.access.permissions.includes('logs') ? store.listLogs({ sourceIds: allowedLogSources(req.access), limit: 8 }).logs : [];
    res.json({ stats: { members: data.members.filter(member => member.rank).length, serverMembers: bot.status().memberCount || 0, ranks: data.ranks.length, ...store.operationStats() }, recentActivity, bot: bot.status() });
  }));
  app.get('/api/members', guard('members'), asyncRoute(async (req, res) => res.json(await bot.getMembers())));
  app.get('/api/logs', guard('logs'), (req, res) => {
    const page = Math.max(1, Math.min(10_000, Number.parseInt(req.query.page, 10) || 1));
    const options = { sourceIds: allowedLogSources(req.access), sourceId: String(req.query.sourceId || '').slice(0, 80), type: String(req.query.type || '').slice(0, 30), q: String(req.query.q || '').slice(0, 200), page };
    const sources = store.getSettings().logSources.filter(source => req.access.isOwner || req.access.logSourceIds.includes('*') || req.access.logSourceIds.includes(source.id)).map(({ id, name, channelId }) => ({ id, name, channelId }));
    res.json({ ...store.listLogs(options), sources: [{ id: 'portal', name: 'Beheerportaal', channelId: '' }, ...sources] });
  });
  app.get('/api/accounts', guard('accounts'), (req, res) => res.json({ accounts: store.listAccounts().map(account => ({ ...account, ...store.publicLogin(account.id) })) }));
  app.post('/api/accounts', guard('accounts'), csrf, throttle(60, 60_000), asyncRoute(async (req, res) => {
    const account = validateAccount(req.body, env.OWNER_DISCORD_ID);
    if (account.groupId && !store.getGroup(account.groupId)) throw new HttpError(400, 'Deze beheerrang bestaat niet.');
    const existing = store.getAccount(account.id);
    const credential = store.getCredential(account.id);
    if (!credential && (!req.body.loginUsername || !req.body.loginPassword)) throw new HttpError(400, 'Vul een gebruikersnaam en wachtwoord in voor dit nieuwe account.');
    let login;
    if (req.body.loginUsername || req.body.loginPassword) {
      const username = validateUsername(req.body.loginUsername || credential?.username);
      const taken = store.findCredential(username);
      if (taken && taken.id !== account.id) throw new HttpError(409, 'Deze gebruikersnaam is al in gebruik.');
      if (!credential || req.body.loginPassword) validatePassword(req.body.loginPassword);
      login = { id: account.id, username, passwordHash: req.body.loginPassword ? await hashPassword(req.body.loginPassword) : credential.passwordHash, mustChangePassword: req.body.loginPassword ? false : credential.mustChangePassword };
    }
    store.saveAccountAndLogin(account, login);
    store.addLog({ type: 'account', actorId: req.user.id, actorName: req.user.displayName, targetId: account.id, content: `Account ${existing ? 'gewijzigd' : 'aangemaakt'}: ${account.label || account.id}.` });
    res.json({ account: { ...store.getAccount(account.id), ...store.publicLogin(account.id) } });
  }));
  app.delete('/api/accounts/:id', guard('accounts'), csrf, (req, res, next) => {
    if (req.params.id === env.OWNER_DISCORD_ID) return next(new HttpError(400, 'Het Directie-account kan niet worden verwijderd.'));
    if (!DISCORD_ID.test(req.params.id)) return next(new HttpError(400, 'Ongeldig Discord-ID.'));
    store.deleteAccount(req.params.id); store.addLog({ type: 'account', actorId: req.user.id, actorName: req.user.displayName, targetId: req.params.id, content: 'Accounttoegang ingetrokken.' }); res.json({ ok: true });
  });
  app.get('/api/settings', guard('settings'), (req, res) => res.json({ settings: store.getSettings() }));
  app.get('/api/account-groups', guard('accounts'), (req, res) => res.json({ groups: store.listGroups() }));
  app.post('/api/account-groups', guard('accounts'), csrf, (req, res, next) => {
    try {
      const group = validateGroup(req.body, env.OWNER_DISCORD_ID);
      if (!store.getGroup(group.id) && store.listGroups().length >= 50) throw new HttpError(400, 'Maximaal 50 beheerrangen toegestaan.');
      const saved = store.saveGroup(group);
      store.addLog({ type: 'account', actorId: req.user.id, actorName: req.user.displayName, content: `Beheerrang bijgewerkt: ${group.name}.` });
      res.json({ group: saved });
    } catch (error) { next(error); }
  });
  app.delete('/api/account-groups/:id', guard('accounts'), csrf, (req, res) => {
    store.deleteGroup(req.params.id);
    store.addLog({ type: 'account', actorId: req.user.id, actorName: req.user.displayName, content: 'Beheerrang verwijderd; bijbehorende toegang ingetrokken.' });
    res.json({ ok: true });
  });
  app.put('/api/settings', guard('settings'), csrf, (req, res, next) => {
    try {
      const value = validateSettings(req.body.settings || req.body);
      store.setSettings(value);
      bot.scheduleRosterRefresh?.();
      store.addLog({ type: 'settings', actorId: req.user.id, actorName: req.user.displayName, content: 'Discord-koppelingen en rangen bijgewerkt.' });
      res.json({ settings: value });
    } catch (error) { next(error); }
  });
  app.get('/api/discord/catalog', guard('settings'), asyncRoute(async (req, res) => res.json(await bot.getCatalog())));
  app.get('/api/personnel/options', guard(), asyncRoute(async (req, res) => {
    if (!PERSONNEL_ACTIONS.some(permission => req.access.permissions.includes(permission))) throw new HttpError(403, 'Je hebt geen toegang tot personeelsbeheer.');
    const settings = store.getSettings();
    const catalog = await bot.getCatalog();
    const excluded = new Set([...settings.ranks.map(rank => rank.roleId), ...(settings.preserveRoleIds || []), ...(settings.baseRoleIds || [])]);
    const roles = catalog.roles.filter(role => role.assignable && !excluded.has(role.id) && (req.access.isOwner || (settings.hireRoleIds || []).includes(role.id)));
    res.json({ ranks: settings.ranks, roles: req.access.permissions.includes('hire') ? roles : [], baseRoles: catalog.roles.filter(role => (settings.baseRoleIds || []).includes(role.id)) });
  }));
  const runOperation = createOperationRunner({ store, bot });
  app.post('/api/personnel', guard(), csrf, throttle(30, 60_000), asyncRoute(async (req, res) => {
    const input = validateAction(req.body);
    if (!req.access.permissions.includes(input.type)) throw new HttpError(403, 'Je hebt geen toestemming voor deze personeelsactie.');
    if (input.discordId === env.OWNER_DISCORD_ID) throw new HttpError(403, 'Het vaste Directie-account kan niet via het portaal worden aangepast.');
    const operation = await runOperation(input, req.user);
    res.status(operation.status === 'notification_failed' ? 202 : 200).json({ operation: { id: operation.id, status: operation.status, result: operation.result, error: operation.error }, message: operation.status === 'completed' ? 'Personeelsactie verwerkt en in Discord geplaatst.' : operation.error });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Deze API-route bestaat niet.' }));
  app.get(['/', '/preview'], (req, res) => res.sendFile(join(ROOT, 'public', 'index.html')));
  app.use(express.static(join(ROOT, 'public'), { dotfiles: 'deny', index: false, maxAge: 0 }));
  app.use((error, req, res, next) => {
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    const message = status === 500 ? 'Er ging iets mis bij het verwerken van het verzoek.' : error.type === 'entity.parse.failed' ? 'Ongeldige JSON.' : error.message;
    res.status(status).json({ error: message, ...(error.code === 'PASSWORD_CHANGE_REQUIRED' ? { code: error.code } : {}) });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createDiscordService } = await import('./lib/discord.mjs');
  const store = new Store(process.env.DATABASE_PATH || join(process.env.DATA_DIR || join(ROOT, 'data'), 'royalcars.sqlite'));
  const bot = createDiscordService({ store, onChange: () => {} });
  const app = createApp({ store, bot });
  const portArgument = process.argv.indexOf('--port');
  const port = Number(process.env.PORT || (portArgument >= 0 ? process.argv[portArgument + 1] : 3000)) || 3000;
  const server = app.listen(port, '0.0.0.0', () => console.log('Royal Cars Admin luistert op de ingestelde poort.'));
  Promise.resolve(bot.start()).catch(() => console.error('Discord kon niet verbinden. Controleer de botconfiguratie.'));
  const stop = async () => { await bot.stop(); server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(0), 10_000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
