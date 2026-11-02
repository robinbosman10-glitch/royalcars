import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import session from 'express-session';

export const EMPTY_SETTINGS = Object.freeze({ ranks: [], channels: { hire: '', demote: '', dismiss: '' }, baseRoleIds: [], preserveRoleIds: [], logSources: [] });
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, permissions TEXT NOT NULL, log_sources TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, type TEXT NOT NULL, source_id TEXT NOT NULL, source_name TEXT NOT NULL, actor_id TEXT, actor_name TEXT, target_id TEXT, target_name TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_created ON logs(created_at DESC);
      CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(actor_id,request_key));
    `);
  }
  getSettings() { return parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get()?.value, structuredClone(EMPTY_SETTINGS)); }
  setSettings(value) { this.db.prepare('INSERT INTO settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value)); return this.getSettings(); }
  account(row) { return row ? { id: row.id, label: row.label, permissions: parse(row.permissions, []), logSourceIds: parse(row.log_sources, []), active: Boolean(row.active), createdAt: row.created_at, updatedAt: row.updated_at } : null; }
  getAccount(id) { return this.account(this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id)); }
  listAccounts() { return this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all().map(row => this.account(row)); }
  saveAccount(account) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO accounts(id,label,permissions,log_sources,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,permissions=excluded.permissions,log_sources=excluded.log_sources,active=excluded.active,updated_at=excluded.updated_at`).run(account.id, account.label, JSON.stringify(account.permissions), JSON.stringify(account.logSourceIds), account.active ? 1 : 0, now, now);
    return this.getAccount(account.id);
  }
  deleteAccount(id) { this.db.prepare('DELETE FROM accounts WHERE id=?').run(id); }
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
    this.db.prepare('UPDATE operations SET status=?,result=?,error=?,updated_at=? WHERE id=?').run(changes.status ?? operation.status, JSON.stringify(changes.result === undefined ? operation.result : changes.result), changes.error === undefined ? operation.error : changes.error, new Date().toISOString(), operation.id);
    return this.getOperation(operation.actorId, operation.key);
  }
  operationStats() {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const rows = this.db.prepare("SELECT payload,created_at FROM operations WHERE status IN ('completed','notification_failed','role_applied')").all();
    return rows.reduce((result, row) => { const type = parse(row.payload, {}).type; if (type === 'hire') result.hires++; if (type === 'demote') result.demotions++; if (type === 'dismiss') result.dismissals++; if (new Date(row.created_at).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }) === today) result.actionsToday++; return result; }, { hires: 0, demotions: 0, dismissals: 0, actionsToday: 0 });
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
