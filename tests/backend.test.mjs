import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { createApp, configuration } from '../server.mjs';
import { accessFor, allowedLogSources, createOperationRunner, validateSettings, validateAction } from '../lib/security.mjs';

const owner = '111111111111111111';
const member = '222222222222222222';
const target = '333333333333333333';
const env = { NODE_ENV: 'test', APP_URL: 'http://localhost', OWNER_DISCORD_ID: owner, DISCORD_GUILD_ID: '444444444444444444', DISCORD_CLIENT_ID: '555555555555555555', DISCORD_CLIENT_SECRET: 'fake-secret', DISCORD_TOKEN: 'fake-token', SESSION_SECRET: 'test-secret-must-be-at-least-32-characters' };
const bot = { status: () => ({ online: false, configured: true }), getMembers: async () => ({ members: [], ranks: [], updatedAt: null }), getCatalog: async () => ({ roles: [], channels: [] }) };
const response = data => ({ ok: true, status: 200, json: async () => data });

async function harness(t, profileId = owner, service = bot) {
  const store = new Store(); let tokenRequest;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/oauth2/token')) { tokenRequest = init; return response({ access_token: 'fake-user-token' }); }
    if (url.endsWith('/users/@me')) return response({ id: profileId, username: 'test', global_name: 'Test User' });
    return response({ user: { id: profileId } });
  };
  const app = createApp({ store, bot: service, env, fetchImpl });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(() => { store.close(); resolve(); })));
  const request = (path, options = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...options });
  const login = async () => {
    const start = await request('/auth/discord');
    const authorization = new URL(start.headers.get('location'));
    const state = authorization.searchParams.get('state');
    let cookie = start.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const callback = await request(`/auth/discord/callback?state=${state}&code=fake-code`, { headers: { Cookie: cookie } });
    const newCookie = callback.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); if (newCookie) cookie = newCookie;
    return { cookie, callback, authorization, tokenRequest };
  };
  return { store, request, login };
}

test('missing owner configuration never permits first-login takeover', () => {
  const store = new Store();
  assert.equal(accessFor(owner, store, ''), null);
  assert.equal(configuration({}).configured, false);
  store.close();
});

test('owner is immutable while account revocation is reflected immediately', () => {
  const store = new Store();
  store.saveAccount({ id: member, label: 'Staff', permissions: ['members'], logSourceIds: [], active: true });
  assert.equal(accessFor(owner, store, owner).isOwner, true);
  assert.deepEqual(accessFor(member, store, owner).permissions, ['members']);
  store.deleteAccount(member);
  assert.equal(accessFor(member, store, owner), null);
  store.close();
});

test('log restrictions apply before filtering and counting', () => {
  const store = new Store();
  store.addLog({ sourceId: 'public', content: 'visible' });
  store.addLog({ sourceId: 'private', content: 'secret' });
  const access = { isOwner: false, logSourceIds: ['public'] };
  assert.deepEqual(allowedLogSources(access), ['portal', 'public']);
  assert.equal(store.listLogs({ sourceIds: allowedLogSources(access), sourceId: 'private' }).total, 0);
  assert.equal(store.listLogs({ sourceIds: allowedLogSources(access) }).logs[0].content, 'visible');
  store.close();
});

test('notification retry never repeats Discord role mutation and keys cannot be reused for new payload', async () => {
  const store = new Store(); let mutations = 0; let notifications = 0;
  const service = { performAction: async () => { mutations++; return { targetName: 'Target' }; }, notifyAction: async () => { notifications++; if (notifications === 1) throw new Error('temporarily unavailable'); return { messageId: 'msg' }; } };
  const run = createOperationRunner({ store, bot: service });
  const payload = { type: 'hire', discordId: target, rankId: 'trial', reason: 'Aangenomen', idempotencyKey: 'unique_action_code_001' };
  assert.equal((await run(payload, { id: owner, displayName: 'Robin' })).status, 'notification_failed');
  assert.equal((await run(payload, { id: owner, displayName: 'Robin' })).status, 'completed');
  assert.equal((await run(payload, { id: owner, displayName: 'Robin' })).status, 'completed');
  assert.equal(mutations, 1); assert.equal(notifications, 2);
  assert.equal(store.listLogs().total, 1);
  await assert.rejects(() => run({ ...payload, reason: 'Other' }, { id: owner }), error => error.status === 409);
  store.close();
});

test('interrupted applying action cannot silently repeat a role mutation', async () => {
  const store = new Store(); let mutations = 0;
  const payload = { type: 'dismiss', discordId: target, rankId: '', reason: 'Test', idempotencyKey: 'unique_action_code_002' };
  const run = createOperationRunner({ store, bot: { performAction: async () => { mutations++; throw new Error('fail'); } } });
  await assert.rejects(() => run(payload, { id: owner }));
  const op = store.getOperation(owner, payload.idempotencyKey); store.updateOperation(op, { status: 'applying' });
  await assert.rejects(() => run(payload, { id: owner }), error => error.status === 409);
  assert.equal(mutations, 1);
  store.close();
});

test('audit-storage failure after applying roles preserves safe retry state', async () => {
  const store = new Store(); let mutations = 0;
  const service = { performAction: async () => { mutations++; return { targetName: 'Target' }; }, notifyAction: async () => ({ messageId: 'msg' }) };
  const run = createOperationRunner({ store, bot: service });
  const payload = { type: 'dismiss', discordId: target, rankId: '', reason: 'Test', idempotencyKey: 'unique_action_code_003' };
  const addLog = store.addLog.bind(store); store.addLog = () => { throw new Error('temporary audit failure'); };
  await assert.rejects(() => run(payload, { id: owner }), /audit failure/);
  assert.equal(store.getOperation(owner, payload.idempotencyKey).status, 'role_applied');
  store.addLog = addLog;
  assert.equal((await run(payload, { id: owner })).status, 'completed');
  assert.equal(mutations, 1); assert.equal(store.listLogs().total, 1);
  store.close();
});

test('OAuth validates state, uses S256 PKCE and regenerates the session ID', async t => {
  const { request, login } = await harness(t);
  const bad = await request('/auth/discord/callback?state=wrong&code=fake');
  assert.equal(bad.headers.get('location'), '/?error=oauth_state');
  const result = await login();
  assert.equal(result.callback.headers.get('location'), '/');
  assert.equal(result.authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(result.authorization.searchParams.get('scope'), 'identify');
  assert.equal(new URLSearchParams(result.tokenRequest.body).get('code_verifier').length, 64);
  const state = await request('/api/session', { headers: { Cookie: result.cookie } });
  const data = await state.json(); assert.equal(data.authenticated, true); assert.equal(data.user.isOwner, true); assert.ok(data.csrfToken);
  assert.equal((await request('/api/accounts', { headers: { Cookie: result.cookie } })).status, 200);
});

test('write routes reject absent CSRF and reject cross-origin requests even with a valid token', async t => {
  const { request, login } = await harness(t); const { cookie } = await login();
  const state = await (await request('/api/session', { headers: { Cookie: cookie } })).json();
  const account = { id: member, label: 'Staff', permissions: ['members'], logSourceIds: [] };
  const write = headers => request('/api/accounts', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(account) });
  assert.equal((await write({})).status, 403);
  assert.equal((await write({ 'X-CSRF-Token': state.csrfToken, Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await write({ 'X-CSRF-Token': state.csrfToken })).status, 200);
  assert.equal((await request(`/api/accounts/${owner}`, { method: 'DELETE', headers: { Cookie: cookie, 'X-CSRF-Token': state.csrfToken } })).status, 400);
});

test('logged-in allowlisted member cannot reach owner APIs and loses access after revocation', async t => {
  const { store, request, login } = await harness(t, member);
  store.saveAccount({ id: member, label: 'Staff', permissions: ['members'], logSourceIds: [], active: true });
  const { cookie } = await login();
  assert.equal((await request('/api/members', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await request('/api/accounts', { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await request('/api/settings', { headers: { Cookie: cookie } })).status, 403);
  store.deleteAccount(member);
  assert.equal((await request('/api/members', { headers: { Cookie: cookie } })).status, 403);
});

test('preview cannot access protected API and public session exposes no owner ID or tokens', async t => {
  const { request } = await harness(t);
  assert.equal((await request('/api/members')).status, 401);
  const state = await (await request('/api/session')).json();
  assert.equal(state.authenticated, false); assert.equal(state.user, null);
  const text = JSON.stringify(state); assert.ok(!text.includes(owner)); assert.ok(!text.includes('fake-token')); assert.ok(!text.includes('fake-secret'));
  assert.equal((await request('/healthz')).status, 200);
});

test('settings reject role duplication and reserved source names; personnel requires demotion rank', () => {
  assert.throws(() => validateSettings({ ranks: [{ id: 'a', name: 'A', roleId: target }, { id: 'b', name: 'B', roleId: target }], logSources: [] }), /maar één/);
  assert.throws(() => validateSettings({ ranks: [], logSources: [{ id: 'portal', name: 'Bad', channelId: target }] }), /gereserveerd/);
  assert.throws(() => validateSettings({ ranks: [{ id: 'a', name: 'A', roleId: target }], baseRoleIds: [target], logSources: [] }), /basisrol/);
  assert.throws(() => validateSettings({ ranks: [{ id: 'a', name: 'A', roleId: target }], preserveRoleIds: [target], logSources: [] }), /behouden/);
  assert.throws(() => validateAction({ type: 'demote', discordId: target, reason: 'Test', idempotencyKey: 'long_unique_key_123' }), /Kies een rang/);
});

test('portal ranks inherit current rights, transfer members and revoke access without affecting owner', () => {
  const store = new Store();
  const group = { id: 'managers', name: 'Management', color: '#ef3b48', permissions: ['members','hire'], logSourceIds: ['sales'], memberIds: [member] };
  store.saveGroup(group);
  assert.equal(store.getAccount(member).groupId, 'managers');
  assert.deepEqual(accessFor(member,store,owner).permissions, ['members','hire']);
  assert.deepEqual(allowedLogSources(accessFor(member,store,owner)), ['portal','sales']);
  store.saveGroup({...group,permissions:['members'],memberIds:undefined});
  assert.deepEqual(accessFor(member,store,owner).permissions,['members']);
  store.saveGroup({...group,id:'sales',name:'Sales',permissions:['logs'],logSourceIds:[]});
  assert.equal(store.getAccount(member).groupId,'sales');
  assert.deepEqual(store.getGroup('managers').memberIds,[]);
  store.deleteGroup('sales');
  assert.equal(accessFor(member,store,owner),null);
  assert.equal(accessFor(owner,store,owner).isOwner,true);
  store.saveGroup({...group,memberIds:[member]});
  store.saveGroup({...group,memberIds:[]});
  assert.equal(store.getAccount(member).active,false);
  assert.equal(accessFor(member,store,owner),null);
  store.close();
});

test('only fixed owner can manage portal ranks; group validation prevents owner assignment and admin grants', async t => {
  const {validateGroup}=await import('../lib/security.mjs');
  assert.throws(()=>validateGroup({id:'g',name:'Managers',permissions:['accounts'],memberIds:[]},owner),/paginarechten/);
  assert.throws(()=>validateGroup({id:'g',name:'Managers',permissions:['members'],memberIds:[owner]},owner),/Directie-account/);
  const {request,login,store}=await harness(t,member);
  store.saveAccount({id:member,label:'Staff',permissions:['members','hire'],logSourceIds:[],active:true});
  const {cookie}=await login();
  const session=await (await request('/api/session',{headers:{Cookie:cookie}})).json();
  assert.equal((await request('/api/account-groups',{headers:{Cookie:cookie}})).status,403);
  assert.equal((await request('/api/account-groups',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({id:'g',name:'New',permissions:['members']})})).status,403);
});

test('owner creates a rank with member IDs and receives memberships through API',async t=>{
  const {request,login}=await harness(t);const {cookie}=await login();
  const session=await (await request('/api/session',{headers:{Cookie:cookie}})).json();
  const headers={Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken};
  const body=JSON.stringify({id:'management',name:'Management',color:'#ef3b48',permissions:['members','demote'],logSourceIds:[],memberIds:[member]});
  assert.equal((await request('/api/account-groups',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body})).status,403);
  assert.equal((await request('/api/account-groups',{method:'POST',headers,body})).status,200);
  const groups=await(await request('/api/account-groups',{headers:{Cookie:cookie}})).json();
  assert.deepEqual(groups.groups[0].memberIds,[member]);
});

test('extra role selection is validated, fingerprinted and durably recorded through personnel operation',async()=>{
  const extra='777777777777777777';const another='888888888888888888';
  const payload=validateAction({type:'hire',discordId:target,rankId:'trial',reason:'New member',roleIds:[extra,extra],idempotencyKey:'hiring_with_extra_roles_001'});
  assert.deepEqual(payload.roleIds,[extra]);
  assert.throws(()=>validateAction({...payload,type:'demote'}),/alleen/);
  const store=new Store();let roles=0;let notices=0;
  const service={performAction:async input=>{roles++;return {targetName:'New member',extraRoleIds:input.roleIds||[]}},notifyAction:async()=>{if(++notices===1)throw Error('temporary');return {messageId:'ok'}}};
  const run=createOperationRunner({store,bot:service});
  assert.equal((await run(payload,{id:owner})).status,'notification_failed');
  assert.deepEqual(store.getPersonnelRoleIds(target),[extra]);
  await assert.rejects(()=>run({...payload,roleIds:[another]},{id:owner}),error=>error.status===409);
  await run(payload,{id:owner});assert.equal(roles,1);
  await run(validateAction({type:'dismiss',discordId:target,rankId:'',reason:'Leave',idempotencyKey:'dismiss_with_extra_roles_001'}),{id:owner});
  assert.deepEqual(store.getPersonnelRoleIds(target),[]);
  store.close();
});

test('database upgrade preserves existing accounts and inherited ranks survive a restart',async()=>{
  const {DatabaseSync}=await import('node:sqlite');const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'royalcars-migration-'));const path=join(dir,'portal.sqlite');
  try{
    const old=new DatabaseSync(path);old.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY,label TEXT NOT NULL,permissions TEXT NOT NULL,log_sources TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)');
    old.prepare('INSERT INTO accounts VALUES(?,?,?,?,?,?,?)').run(member,'Existing account','["members"]','[]',1,new Date().toISOString(),new Date().toISOString());old.close();
    let store=new Store(path);assert.equal(store.getAccount(member).label,'Existing account');assert.deepEqual(accessFor(member,store,owner).permissions,['members']);
    store.saveGroup({id:'team',name:'Team',color:'#ef3b48',permissions:['logs'],logSourceIds:[],memberIds:[member]});store.close();
    store=new Store(path);assert.equal(store.getAccount(member).label,'Existing account');assert.deepEqual(accessFor(member,store,owner).permissions,['logs']);store.close();
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test('personnel options show only assignable allowlisted extra roles for delegated accounts and refresh group permissions immediately',async t=>{
  const extra='777777777777777777',other='888888888888888888',rank='666666666666666666';
  const service={...bot,getCatalog:async()=>({roles:[{id:rank,name:'Rank',assignable:true},{id:extra,name:'Extra',assignable:true},{id:other,name:'Not allowed',assignable:true}],channels:[]})};
  const {request,login,store}=await harness(t,member,service);
  store.setSettings({ranks:[{id:'dealer',name:'Dealer',roleId:rank,order:0}],channels:{},baseRoleIds:[],preserveRoleIds:[],hireRoleIds:[extra],logSources:[]});
  const group={id:'hr',name:'HR',color:'#ef3b48',permissions:['hire'],logSourceIds:[],memberIds:[member]};store.saveGroup(group);
  const {cookie}=await login();
  const options=await(await request('/api/personnel/options',{headers:{Cookie:cookie}})).json();
  assert.deepEqual(options.roles.map(role=>role.id),[extra]);assert.equal(options.ranks[0].id,'dealer');
  store.saveGroup({...group,permissions:['members']});
  assert.equal((await request('/api/personnel/options',{headers:{Cookie:cookie}})).status,403);
});
