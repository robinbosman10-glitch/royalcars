import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import session from 'express-session';

export const EMPTY_SETTINGS = Object.freeze({ ranks: [], channels: { hire: '', promote: '', demote: '', dismiss: '' }, baseRoleIds: [], preserveRoleIds: [], logSources: [], salesChannelId: '' });
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

export class Store {
  constructor(path = ':memory:', { defaultSalesChannelId = '' } = {}) {
    this.defaultSalesChannelId = defaultSalesChannelId;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sale_vehicles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        price_cents INTEGER NOT NULL CHECK(price_cents BETWEEN 1 AND 999999999999)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS attendance_posts (message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL, UNIQUE(guild_id,day));
      CREATE TABLE IF NOT EXISTS attendance_reactions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL REFERENCES attendance_posts(message_id),
        user_id TEXT NOT NULL, name TEXT NOT NULL, choice TEXT NOT NULL CHECK(choice IN ('present','absent')),
        variant INTEGER NOT NULL DEFAULT 0, UNIQUE(message_id,user_id,choice,variant)
      );
      CREATE TABLE IF NOT EXISTS roster_messages (guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, permissions TEXT NOT NULL, log_sources TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, permissions TEXT NOT NULL, log_sources TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS personnel_roles (member_id TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY(member_id,role_id));
      CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, version TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, type TEXT NOT NULL, source_id TEXT NOT NULL, source_name TEXT NOT NULL, actor_id TEXT, actor_name TEXT, target_id TEXT, target_name TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_created ON logs(created_at DESC);
      CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(actor_id,request_key));
    `);
    if (!this.db.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'group_id')) this.db.exec('ALTER TABLE accounts ADD COLUMN group_id TEXT');
  }
  getSettings() {
    const value = parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get()?.value, structuredClone(EMPTY_SETTINGS));
    return { ...value, salesChannelId: value.salesChannelId || this.defaultSalesChannelId };
  }
  setSettings(value) { this.db.prepare('INSERT INTO settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value)); return this.getSettings(); }
  listSaleVehicles() {
    return this.db.prepare('SELECT id, name, price_cents AS priceCents FROM sale_vehicles ORDER BY name COLLATE NOCASE, price_cents, id').all();
  }
  getSaleVehicle(id) {
    return this.db.prepare('SELECT id, name, price_cents AS priceCents FROM sale_vehicles WHERE id=?').get(id) ?? null;
  }
  addSaleVehicle({ name, priceCents }) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO sale_vehicles (id, name, price_cents) VALUES (?,?,?)').run(id, name, priceCents);
    return { id, name, priceCents };
  }
  updateSaleVehicle(id, { name, priceCents }) {
    const { changes } = this.db.prepare('UPDATE sale_vehicles SET name=?, price_cents=? WHERE id=?').run(name, priceCents, id);
    return changes ? { id, name, priceCents } : null;
  }
  deleteSaleVehicle(id) {
    return this.db.prepare('DELETE FROM sale_vehicles WHERE id=?').run(id).changes > 0;
  }
  getAttendancePost(guildId, day) {
    return this.db.prepare('SELECT message_id AS messageId, channel_id AS channelId FROM attendance_posts WHERE guild_id=? AND day=?').get(guildId, day);
  }
  saveAttendancePost({ messageId, guildId, channelId, day, replaces }) {
    if (!replaces) {
      this.db.prepare('INSERT INTO attendance_posts VALUES(?,?,?,?)').run(messageId, guildId, channelId, day);
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.clearAttendanceReactions(guildId, replaces);
      const updated = this.db.prepare('UPDATE attendance_posts SET message_id=?, channel_id=? WHERE message_id=? AND guild_id=? AND day=?')
        .run(messageId, channelId, replaces, guildId, day);
      if (updated.changes !== 1) throw new Error('Attendance post changed before replacement');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  recordAttendanceReaction({ messageId, guildId, userId, name, choice, variant = 0, add }) {
    if (add) {
      this.db.prepare(`INSERT INTO attendance_reactions(message_id,user_id,name,choice,variant)
        SELECT message_id,?,?,?,? FROM attendance_posts WHERE message_id=? AND guild_id=?
        ON CONFLICT(message_id,user_id,choice,variant) DO NOTHING`).run(userId, name, choice, variant, messageId, guildId);
    } else {
      this.db.prepare(`DELETE FROM attendance_reactions WHERE message_id=? AND user_id=? AND choice=? AND variant=?
        AND EXISTS (SELECT 1 FROM attendance_posts WHERE message_id=? AND guild_id=?)`).run(messageId, userId, choice, variant, messageId, guildId);
    }
  }
  clearAttendanceReactions(guildId, messageId, choice = null) {
    this.db.prepare(`DELETE FROM attendance_reactions WHERE message_id=? AND (? IS NULL OR choice=?)
      AND EXISTS (SELECT 1 FROM attendance_posts WHERE message_id=? AND guild_id=?)`).run(messageId, choice, choice, messageId, guildId);
  }
  attendanceReport(guildId) {
    const days = this.db.prepare('SELECT day, message_id AS messageId, channel_id AS channelId FROM attendance_posts WHERE guild_id=? ORDER BY day DESC').all(guildId);
    const votes = this.db.prepare(`WITH ranked AS (
      SELECT p.day, r.user_id AS userId, r.name, r.choice, r.sequence,
        ROW_NUMBER() OVER (PARTITION BY r.message_id,r.user_id ORDER BY r.sequence DESC) AS position
      FROM attendance_reactions r JOIN attendance_posts p USING(message_id) WHERE p.guild_id=?
    ) SELECT day,userId,name,choice FROM ranked WHERE position=1 ORDER BY sequence DESC`).all(guildId);
    return { days, votes };
  }
  getRosterMessage(guildId) {
    const row = this.db.prepare('SELECT channel_id, message_id FROM roster_messages WHERE guild_id=?').get(guildId);
    return row ? { channelId: row.channel_id, messageId: row.message_id } : null;
  }
  setRosterMessage(guildId, { channelId, messageId }) {
    this.db.prepare('INSERT INTO roster_messages(guild_id,channel_id,message_id) VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id').run(guildId, channelId, messageId);
  }
  account(row) { return row ? { id: row.id, label: row.label, groupId: row.group_id || '', permissions: parse(row.permissions, []), logSourceIds: parse(row.log_sources, []), active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at } : null; }
  getAccount(id) { return this.account(this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id)); }
  listAccounts() { return this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all().map(row => this.account(row)); }
  saveAccount(account) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO accounts(id,label,permissions,log_sources,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,permissions=excluded.permissions,log_sources=excluded.log_sources,active=excluded.active,updated_at=excluded.updated_at`).run(account.id, account.label, JSON.stringify(account.permissions), JSON.stringify(account.logSourceIds), account.active ? 1 : 0, now, now);
    this.db.prepare('UPDATE accounts SET group_id=? WHERE id=?').run(account.groupId || null, account.id);
    return this.getAccount(account.id);
  }
  deleteAccount(id) { this.db.exec('BEGIN IMMEDIATE'); try { this.db.prepare('DELETE FROM credentials WHERE id=?').run(id); this.db.prepare('DELETE FROM accounts WHERE id=?').run(id); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  credential(row) { return row ? { id: row.id, username: row.username, passwordHash: row.password_hash, version: row.version, mustChangePassword: Boolean(row.must_change) } : null; }
  getCredential(id) { return this.credential(this.db.prepare('SELECT * FROM credentials WHERE id=?').get(id)); }
  findCredential(username) { return this.credential(this.db.prepare('SELECT * FROM credentials WHERE username=? COLLATE NOCASE').get(username)); }
  publicLogin(id) { const credential = this.getCredential(id); return { hasLogin: Boolean(credential), loginUsername: credential?.username || '', mustChangePassword: credential?.mustChangePassword || false }; }
  setCredential(value) {
    this.db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,version=excluded.version,must_change=excluded.must_change,updated_at=excluded.updated_at').run(value.id, value.username, value.passwordHash, randomUUID(), value.mustChangePassword ? 1 : 0, new Date().toISOString());
    return this.getCredential(value.id);
  }
  saveAccountAndLogin(account, login) { this.db.exec('BEGIN IMMEDIATE'); try { this.saveAccount(account); if (login) this.setCredential(login); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  loginFailures(key) { const row = this.db.prepare('SELECT failures,expires FROM login_attempts WHERE key=?').get(key); return row && row.expires > Date.now() ? row.failures : 0; }
  failLogin(key) { const now = Date.now(); this.db.prepare('DELETE FROM login_attempts WHERE expires<?').run(now); this.db.prepare('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET failures=failures+1').run(key, now + 15 * 60_000); }
  clearLoginFailures(key) { this.db.prepare('DELETE FROM login_attempts WHERE key=?').run(key); }
  group(row) { return row ? { id: row.id, name: row.name, color: row.color, permissions: parse(row.permissions, []), logSourceIds: parse(row.log_sources, []), memberIds: this.db.prepare('SELECT id FROM accounts WHERE group_id=? ORDER BY created_at').all(row.id).map(account => account.id) } : null; }
  getGroup(id) { return this.group(this.db.prepare('SELECT * FROM account_groups WHERE id=?').get(id)); }
  listGroups() { return this.db.prepare('SELECT * FROM account_groups ORDER BY name COLLATE NOCASE').all().map(row => this.group(row)); }
  saveGroup(group) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO account_groups VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,permissions=excluded.permissions,log_sources=excluded.log_sources').run(group.id, group.name, group.color, JSON.stringify(group.permissions), JSON.stringify(group.logSourceIds));
      if (group.memberIds) {
        const wanted = new Set(group.memberIds);
        for (const account of this.listAccounts().filter(account => account.groupId === group.id)) if (!wanted.has(account.id)) this.saveAccount({ ...account, groupId: '', permissions: [], logSourceIds: [], active: false });
        for (const id of group.memberIds) this.saveAccount({ ...(this.getAccount(id) || { id, label: id }), groupId: group.id, permissions: [], logSourceIds: [], active: true });
      }
      this.db.exec('COMMIT'); return this.getGroup(group.id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  deleteGroup(id) { this.db.prepare('DELETE FROM account_groups WHERE id=?').run(id); }
  getPersonnelRoleIds(id) { return this.db.prepare('SELECT role_id FROM personnel_roles WHERE member_id=?').all(id).map(row => row.role_id); }
  addLog(log) {
    const value = { id: log.id || randomUUID(), type: log.type || 'system', sourceId: log.sourceId || 'portal', sourceName: log.sourceName || 'Beheerportaal', actorId: log.actorId || '', actorName: log.actorName || '', targetId: log.targetId || '', targetName: log.targetName || '', content: String(log.content || log.message || '').slice(0, 6000), createdAt: log.createdAt || new Date().toISOString(), metadata: log.metadata || {} };
    this.db.prepare('INSERT OR IGNORE INTO logs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(value.id, value.type, value.sourceId, value.sourceName, value.actorId, value.actorName, value.targetId, value.targetName, value.content, value.createdAt, JSON.stringify(value.metadata));
    return value;
  }
  listLogs({ sourceIds = null, sourceId = '', type = '', q = '', page = 1, limit = 50 } = {}) {
    const clauses = []; const args = [];
    if (sourceIds) { if (!sourceIds.length) return { logs: [], total: 0, page }; clauses.push(`source_id IN (${sourceIds.map(() => '?').join(',')})`); args.push(...sourceIds); }
    if (sourceId) { clauses.push('source_id=?'); args.push(sourceId); }
    if (type) { clauses.push('type=?'); args.push(type); }
    if (q) { clauses.push('(content LIKE ? OR actor_name LIKE ? OR target_name LIKE ?)'); args.push(...Array(3).fill(`%${q}%`)); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) n FROM logs${where}`).get(...args).n);
    const logs = this.db.prepare(`SELECT * FROM logs${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit).map(row => ({ id: row.id, type: row.type, sourceId: row.source_id, sourceName: row.source_name, actorId: row.actor_id, actorName: row.actor_name, targetId: row.target_id, targetName: row.target_name, content: row.content, createdAt: row.created_at, metadata: parse(row.metadata, {}) }));
    return { logs, total, page };
  }
  getOperation(actorId, key) { return this.operation(this.db.prepare('SELECT * FROM operations WHERE actor_id=? AND request_key=?').get(actorId, key)); }
  operation(row) { return row ? { id: row.id, actorId: row.actor_id, key: row.request_key, fingerprint: row.fingerprint, payload: parse(row.payload, {}), status: row.status, result: parse(row.result, null), error: row.error, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
  createOperation({ actorId, key, fingerprint, payload }) {
    const now = new Date().toISOString(); const id = randomUUID();
    this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, actorId, key, fingerprint, JSON.stringify(payload), 'pending', null, null, now, now);
    return this.getOperation(actorId, key);
  }
  updateOperation(operation, changes) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE operations SET status=?,result=?,error=?,updated_at=? WHERE id=?').run(changes.status ?? operation.status, JSON.stringify(changes.result === undefined ? operation.result : changes.result), changes.error === undefined ? operation.error : changes.error, new Date().toISOString(), operation.id);
      if (changes.status === 'role_applied' && ['hire', 'dismiss'].includes(operation.payload.type)) {
        this.db.prepare('DELETE FROM personnel_roles WHERE member_id=?').run(operation.payload.discordId);
        if (operation.payload.type === 'hire') for (const id of changes.result?.extraRoleIds || []) this.db.prepare('INSERT OR IGNORE INTO personnel_roles VALUES(?,?)').run(operation.payload.discordId, id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getOperation(operation.actorId, operation.key);
  }
  operationStats() {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const rows = this.db.prepare("SELECT payload,created_at FROM operations WHERE status IN ('completed','notification_failed','role_applied')").all();
    const statKeys = { hire: 'hires', promote: 'promotions', demote: 'demotions', dismiss: 'dismissals' };
    return rows.reduce((result, row) => {
      const type = parse(row.payload, {}).type;
      if (Object.hasOwn(statKeys, type)) result[statKeys[type]]++;
      if (new Date(row.created_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }) === today) result.actionsToday++;
      return result;
    }, { hires: 0, promotions: 0, demotions: 0, dismissals: 0, actionsToday: 0 });
  }
  close() { this.db.close(); }
}

export class SQLiteSessionStore extends session.Store {
  constructor(store) { super(); this.db = store.db; }
  get(sid, callback) { try { const row = this.db.prepare('SELECT data,expires FROM sessions WHERE sid=?').get(sid); if (!row || row.expires < Date.now()) return callback(null, null); callback(null, parse(row.data, null)); } catch (error) { callback(error); } }
  set(sid, value, callback = () => {}) { try { const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 8 * 60 * 60 * 1000; this.db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires=excluded.expires').run(sid, JSON.stringify(value), expires); this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); callback(null); } catch (error) { callback(error); } }
  destroy(sid, callback = () => {}) { try { this.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); callback(null); } catch (error) { callback(error); } }
  touch(sid, value, callback = () => {}) { this.set(sid, value, callback); }
}
