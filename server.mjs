import express from 'express';
import session from 'express-session';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { Store, SQLiteSessionStore } from './lib/store.mjs';
import { HttpError, DISCORD_ID, accessFor, allowedLogSources, safeEqual, csrfToken, validateSettings, validateAccount, validateAction, createOperationRunner } from './lib/security.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DISCORD_API = 'https://discord.com/api/v10';

export function configuration(env) {
  const setup = { oauth: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET), bot: Boolean(env.DISCORD_TOKEN), guild: DISCORD_ID.test(env.DISCORD_GUILD_ID || ''), owner: DISCORD_ID.test(env.OWNER_DISCORD_ID || ''), session: Boolean(env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) };
  return { setup, configured: Object.values(setup).every(Boolean) };
}

export function createApp({ store, bot, env = process.env, fetchImpl = fetch }) {
  const app = express(); const { setup, configured } = configuration(env);
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
      if (!req.session.user) throw new HttpError(401, 'Log eerst in met Discord.');
      const access = accessFor(req.session.user.id, store, env.OWNER_DISCORD_ID);
      if (!access) { req.session.destroy(() => {}); throw new HttpError(403, 'Je account heeft geen toegang tot dit portaal.'); }
      if (permission && !access.permissions.includes(permission)) throw new HttpError(403, 'Je hebt geen toegang tot deze pagina of actie.');
      if (Date.now() - (req.session.membershipCheckedAt || 0) > 60_000) {
        try { await discordFetch(`/guilds/${env.DISCORD_GUILD_ID}/members/${req.session.user.id}`, { headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` } }); req.session.membershipCheckedAt = Date.now(); }
        catch (error) { if (error.status === 403) req.session.destroy(() => {}); throw error; }
      }
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
  async function discordFetch(path, init = {}) {
    const response = await fetchImpl(`${DISCORD_API}${path}`, { ...init, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new HttpError(response.status === 404 ? 403 : 503, response.status === 404 ? 'Je bent geen lid van de Royal Cars-server.' : 'Discord is tijdelijk niet bereikbaar. Probeer het later opnieuw.');
    return response.json();
  }

  app.get(['/health', '/healthz'], (req, res) => res.json({ status: 'ok', configured, bot: Boolean(bot.status().online) }));
  app.get('/api/session', (req, res) => {
    const access = accessFor(req.session.user?.id, store, env.OWNER_DISCORD_ID);
    if (!access) return res.json({ authenticated: false, configured, preview: false, user: null, permissions: [], csrfToken: null, setup, bot: { online: Boolean(bot.status().online), configured: setup.bot } });
    req.session.csrfToken ||= csrfToken();
    res.json({ authenticated: true, configured, preview: false, user: { ...req.session.user, isOwner: access.isOwner }, permissions: access.permissions, ranks: store.getSettings().ranks, csrfToken: req.session.csrfToken, setup, bot: bot.status() });
  });

  app.get('/auth/discord', throttle(20, 60_000), (req, res, next) => {
    if (!configured) return res.redirect('/?error=setup');
    req.session.oauthState = csrfToken(); req.session.oauthStartedAt = Date.now(); req.session.pkceVerifier = randomBytes(48).toString('base64url');
    const query = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, redirect_uri: `${appUrl.origin}/auth/discord/callback`, response_type: 'code', scope: 'identify', state: req.session.oauthState, code_challenge: createHash('sha256').update(req.session.pkceVerifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'consent' });
    req.session.save(error => error ? next(error) : res.redirect(`https://discord.com/oauth2/authorize?${query}`));
  });
  app.get('/auth/discord/callback', throttle(30, 60_000), asyncRoute(async (req, res) => {
    if (!configured || !safeEqual(req.session.oauthState, req.query.state) || Date.now() - (req.session.oauthStartedAt || 0) > 10 * 60_000) return res.redirect('/?error=oauth_state');
    const verifier = req.session.pkceVerifier;
    delete req.session.oauthState; delete req.session.oauthStartedAt; delete req.session.pkceVerifier;
    const code = req.query.code;
    if (typeof code !== 'string' || code.length > 1000) return res.redirect('/?error=oauth_cancelled');
    try {
      const token = await discordFetch('/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: `${appUrl.origin}/auth/discord/callback` }) });
      const profile = await discordFetch('/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
      const access = accessFor(profile.id, store, env.OWNER_DISCORD_ID);
      if (!access) return res.redirect('/?error=access_denied');
      await discordFetch(`/guilds/${env.DISCORD_GUILD_ID}/members/${profile.id}`, { headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` } });
      await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
      req.session.user = { id: profile.id, username: String(profile.username || '').slice(0, 80), displayName: String(profile.global_name || profile.username || 'Discord-gebruiker').slice(0, 80), avatar: profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128` : '' };
      req.session.csrfToken = csrfToken();
      req.session.membershipCheckedAt = Date.now();
      store.addLog({ type: 'login', actorId: profile.id, actorName: req.session.user.displayName, content: `${req.session.user.displayName} is ingelogd op het portaal.` });
      await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
      res.redirect('/');
    } catch (error) { res.redirect(`/?error=${error.status === 403 ? 'guild_access' : 'discord_unavailable'}`); }
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
  app.get('/api/accounts', guard('accounts'), (req, res) => res.json({ accounts: store.listAccounts() }));
  app.post('/api/accounts', guard('accounts'), csrf, throttle(60, 60_000), (req, res, next) => {
    try { const account = validateAccount(req.body, env.OWNER_DISCORD_ID); const existing = store.getAccount(account.id); store.saveAccount(account); store.addLog({ type: 'account', actorId: req.user.id, actorName: req.user.displayName, targetId: account.id, content: `Account ${existing ? 'gewijzigd' : 'aangemaakt'}: ${account.label || account.id}.` }); res.json({ account: store.getAccount(account.id) }); } catch (error) { next(error); }
  });
  app.delete('/api/accounts/:id', guard('accounts'), csrf, (req, res, next) => {
    if (req.params.id === env.OWNER_DISCORD_ID) return next(new HttpError(400, 'Het Directie-account kan niet worden verwijderd.'));
    if (!DISCORD_ID.test(req.params.id)) return next(new HttpError(400, 'Ongeldig Discord-ID.'));
    store.deleteAccount(req.params.id); store.addLog({ type: 'account', actorId: req.user.id, actorName: req.user.displayName, targetId: req.params.id, content: 'Accounttoegang ingetrokken.' }); res.json({ ok: true });
  });
  app.get('/api/settings', guard('settings'), (req, res) => res.json({ settings: store.getSettings() }));
  app.put('/api/settings', guard('settings'), csrf, (req, res, next) => {
    try { const value = validateSettings(req.body.settings || req.body); store.setSettings(value); store.addLog({ type: 'settings', actorId: req.user.id, actorName: req.user.displayName, content: 'Discord-koppelingen en rangen bijgewerkt.' }); res.json({ settings: value }); } catch (error) { next(error); }
  });
  app.get('/api/discord/catalog', guard('settings'), asyncRoute(async (req, res) => res.json(await bot.getCatalog())));
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
  app.use(express.static(join(ROOT, 'public'), { dotfiles: 'deny', index: false, maxAge: production ? '1h' : 0 }));
  app.use((error, req, res, next) => {
    const status = error.status >= 400 && error.status < 600 ? error.status : 500;
    const message = status === 500 ? 'Er ging iets mis bij het verwerken van het verzoek.' : error.type === 'entity.parse.failed' ? 'Ongeldige JSON.' : error.message;
    res.status(status).json({ error: message });
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
