import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { hashPassword, verifyPassword, bootstrapOwner } from '../lib/passwords.mjs';
import { createApp, configuration } from '../server.mjs';
import { accessFor, allowedLogSources, createOperationRunner, validateSettings, validateAction } from '../lib/security.mjs';

const owner = '111111111111111111';
const member = '222222222222222222';
const target = '333333333333333333';
const env = { NODE_ENV: 'test', APP_URL: 'http://localhost', OWNER_DISCORD_ID: owner, DISCORD_GUILD_ID: '444444444444444444', DISCORD_CLIENT_ID: '555555555555555555', DISCORD_CLIENT_SECRET: 'fake-secret', DISCORD_TOKEN: 'fake-token', SESSION_SECRET: 'test-secret-must-be-at-least-32-characters' };
const bot = { status: () => ({ online: false, configured: true }), getMembers: async () => ({ members: [], ranks: [], updatedAt: null }), getCatalog: async () => ({ roles: [], channels: [] }) };
// Fictitious test credentials; never used in production.
const testPassword = 'Test-only-password-123!';
const testHash = await hashPassword(testPassword);

async function harness(t, profileId = owner, service = bot) {
  const store = new Store();
  store.setCredential({ id: owner, username: 'owner.test', passwordHash: testHash, mustChangePassword: false });
  if(profileId !== owner) store.setCredential({ id: profileId, username: 'member.test', passwordHash: testHash, mustChangePassword: false });
  const app = createApp({ store, bot: service, env });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => server.close(() => { store.close(); resolve(); })));
  const request = (path, options = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...options });
  const login = async () => {
    const start = await request('/api/session');
    const preauth = await start.json();
    let cookie = start.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const callback = await request('/auth/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': preauth.csrfToken }, body: JSON.stringify({ username: profileId === owner ? 'owner.test' : 'member.test', password: testPassword }) });
    const data = await callback.json();
    const newCookie = callback.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); if (newCookie) cookie = newCookie;
    return { cookie, callback, data, originalCookie: start.headers.getSetCookie()[0]?.split(';')[0] };
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

test('password login rotates session ID, protects fixed owner and disables former OAuth endpoints', async t => {
  const { request, login } = await harness(t);
  assert.equal((await request('/auth/discord')).headers.get('location'), '/?error=password_login');
  assert.equal((await request('/auth/discord/callback?code=fake')).headers.get('location'), '/?error=password_login');
  const result = await login();
  assert.equal(result.callback.status, 200);
  assert.notEqual(result.cookie, result.originalCookie);
  assert.equal(result.data.authenticated,true);assert.equal(result.data.user.isOwner,true);
  assert.equal(result.data.authMethod,'password');assert.ok(result.data.csrfToken);
  assert.equal((await request('/api/accounts', { headers: { Cookie: result.cookie } })).status, 200);
});

test('write routes reject absent CSRF and reject cross-origin requests even with a valid token', async t => {
  const { request, login } = await harness(t); const { cookie } = await login();
  const state = await (await request('/api/session', { headers: { Cookie: cookie } })).json();
  const account = { id: member, label: 'Staff', permissions: ['members'], logSourceIds: [], loginUsername: 'staff.test', loginPassword: testPassword };
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
  assert.equal((await request('/api/members', { headers: { Cookie: cookie } })).status, 401);
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

test('roster message survives restart and stale settings writes', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'royalcars-roster-'));
  const path = join(dir, 'portal.sqlite');
  const first = { channelId: '555555555555555555', messageId: '666666666666666666' };
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const staleSettings = store.getSettings();
  assert.equal(store.getRosterMessage(env.DISCORD_GUILD_ID), null);
  store.setRosterMessage(env.DISCORD_GUILD_ID, first);
  store.setSettings({ ...staleSettings, channels: { ...staleSettings.channels, hire: target } });
  store.close();
  store = new Store(path);
  assert.deepEqual(store.getRosterMessage(env.DISCORD_GUILD_ID), first);
  assert.equal(store.getSettings().channels.hire, target);
  assert.equal(store.getRosterMessage(member), null);
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

test('promotions require a separate permission and record the rank change', async t => {
  const announcements = [];
  const service = {
    ...bot,
    performAction: async input => {
      assert.equal(input.type, 'promote');
      assert.equal(input.rankId, 'senior');
      return { targetName: 'Medewerker', oldRankName: 'Dealer', rankName: 'Senior' };
    },
    notifyAction: async operation => {
      announcements.push(operation);
      return { messageId: 'test-announcement' };
    },
  };
  const { request, login, store } = await harness(t, member, service);
  const account = { id: member, label: 'Teamleider', permissions: ['demote'], logSourceIds: [], active: true };
  store.saveAccount(account);
  const { cookie, data } = await login();
  const submit = () => request('/api/personnel', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrfToken },
    body: JSON.stringify({ type: 'promote', discordId: target, rankId: 'senior', reason: 'Goede inzet', idempotencyKey: 'promote_operation_test' }),
  });
  assert.equal((await submit()).status, 403);
  assert.equal(announcements.length, 0);

  store.saveAccount({ ...account, permissions: ['promote'] });
  assert.equal((await request('/api/personnel/options', { headers: { Cookie: cookie } })).status, 200);
  const response = await submit();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).operation.status, 'completed');
  assert.equal(announcements[0].type, 'promote');
  assert.match(store.listLogs({ type: 'promote' }).logs[0].content, /van Dealer naar Senior/);
  assert.equal(store.operationStats().promotions, 1);
});

test('salted password hashes differ and never accept an incorrect or malformed password',async()=>{
  const other=await hashPassword(testPassword);
  assert.notEqual(other,testHash);assert.equal(await verifyPassword(testPassword,other),true);
  assert.equal(await verifyPassword('incorrect-password',other),false);
  assert.equal(await verifyPassword('x'.repeat(1000),other),false);
  await assert.rejects(()=>hashPassword('short'),/minimaal 12/);
});

test('owner bootstrap never overwrites a changed password and cannot create a first-visitor owner',()=>{
  const store=new Store();
  bootstrapOwner(store,{OWNER_DISCORD_ID:owner,OWNER_LOGIN_USERNAME:'Robin',OWNER_LOGIN_PASSWORD_HASH:testHash});
  const initial=store.getCredential(owner);assert.equal(initial.mustChangePassword,true);assert.equal(initial.username,'Robin');
  store.setCredential({id:owner,username:'ChangedName',passwordHash:testHash,mustChangePassword:false});
  bootstrapOwner(store,{OWNER_DISCORD_ID:owner,OWNER_LOGIN_USERNAME:'Robin',OWNER_LOGIN_PASSWORD_HASH:testHash});
  assert.equal(store.getCredential(owner).username,'ChangedName');assert.equal(store.getCredential(owner).mustChangePassword,false);
  bootstrapOwner(store,{OWNER_DISCORD_ID:member,OWNER_LOGIN_USERNAME:'Wrong',OWNER_LOGIN_PASSWORD_HASH:'invalid'});
  assert.equal(store.getCredential(member),null);store.close();
});

async function anonymous(t){
  const h=await harness(t);const response=await h.request('/api/session');const data=await response.json();
  const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  return {...h,cookie,csrf:data.csrfToken,postLogin:(username,password,extra={})=>h.request('/auth/login',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':data.csrfToken,...extra},body:JSON.stringify({username,password})})};
}

test('login is CSRF protected and repeated failures are persistently limited without exposing account existence',async t=>{
  const h=await anonymous(t);
  assert.equal((await h.postLogin('owner.test',testPassword,{'X-CSRF-Token':''})).status,403);
  assert.equal((await h.postLogin('owner.test',testPassword,{Origin:'https://attacker.example'})).status,403);
  const missing=await h.postLogin('does-not-exist','incorrect-password');
  const incorrect=await h.postLogin('owner.test','incorrect-password');
  assert.equal(missing.status,401);assert.equal(incorrect.status,401);assert.deepEqual(await missing.json(),await incorrect.json());
  for(let i=1;i<5;i++)assert.equal((await h.postLogin('owner.test','incorrect-password')).status,401);
  assert.equal((await h.postLogin('owner.test',testPassword)).status,429);
});

test('temporary password must be replaced; changing it rotates the session and invalidates every old session',async t=>{
  const {store,request,login}=await harness(t);
  store.setCredential({id:owner,username:'owner.test',passwordHash:testHash,mustChangePassword:true});
  const first=await login();const second=await login();assert.equal(first.data.mustChangePassword,true);
  assert.equal((await request('/api/members',{headers:{Cookie:first.cookie}})).status,403);
  const changed=await request('/api/account/password',{method:'POST',headers:{Cookie:first.cookie,'Content-Type':'application/json','X-CSRF-Token':first.data.csrfToken},body:JSON.stringify({username:'NewName',currentPassword:testPassword,newPassword:'A new test password phrase!'})});
  assert.equal(changed.status,200);const data=await changed.json();assert.equal(data.mustChangePassword,false);assert.equal(data.user.loginUsername,'NewName');
  const nextCookie=changed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.notEqual(nextCookie,first.cookie);
  assert.equal((await request('/api/members',{headers:{Cookie:second.cookie}})).status,401);
  assert.equal((await request('/api/members',{headers:{Cookie:nextCookie}})).status,200);
  assert.equal(await verifyPassword('A new test password phrase!',store.getCredential(owner).passwordHash),true);
});

test('admin credential reset logs out existing users, rejects duplicate usernames and never returns password material',async t=>{
  const h=await harness(t);
  h.store.saveAccount({id:member,label:'Existing Staff',permissions:['members'],logSourceIds:[],active:true});
  h.store.setCredential({id:member,username:'staff.test',passwordHash:testHash,mustChangePassword:false});
  const ownerSession=await h.login();const headers={Cookie:ownerSession.cookie,'Content-Type':'application/json','X-CSRF-Token':ownerSession.data.csrfToken};
  const account={id:member,label:'Staff',permissions:['members'],logSourceIds:[],active:true,loginUsername:'staff.new',loginPassword:'New temporary password!'};
  const duplicate=await h.request('/api/accounts',{method:'POST',headers,body:JSON.stringify({...account,loginUsername:'OWNER.TEST'})});assert.equal(duplicate.status,409);assert.equal(h.store.getAccount(member).label,'Existing Staff');
  const weak=await h.request('/api/accounts',{method:'POST',headers,body:JSON.stringify({...account,loginPassword:'short'})});assert.equal(weak.status,400);assert.equal(h.store.getAccount(member).label,'Existing Staff');
  const anonResponse=await h.request('/api/session');const anonData=await anonResponse.json();const anonCookie=anonResponse.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const staffLogin=await h.request('/auth/login',{method:'POST',headers:{Cookie:anonCookie,'Content-Type':'application/json','X-CSRF-Token':anonData.csrfToken},body:JSON.stringify({username:'STAFF.TEST',password:testPassword})});assert.equal(staffLogin.status,200);await staffLogin.json();
  const oldStaffCookie=staffLogin.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  const original=h.store.getCredential(member).version;
  const update=await h.request('/api/accounts',{method:'POST',headers,body:JSON.stringify(account)});assert.equal(update.status,200);
  assert.equal((await h.request('/api/members',{headers:{Cookie:oldStaffCookie}})).status,401);
  const returned=await update.json();assert.equal(returned.account.loginUsername,'staff.new');assert.equal(returned.account.mustChangePassword,false);assert.notEqual(h.store.getCredential(member).version,original);
  const list=await(await h.request('/api/accounts',{headers:{Cookie:ownerSession.cookie}})).json();
  assert.ok(!JSON.stringify(list).includes('passwordHash'));assert.ok(!JSON.stringify(list).includes(account.loginPassword));assert.ok(!JSON.stringify(list).includes('scrypt$'));
  const logs=JSON.stringify(h.store.listLogs());assert.ok(!logs.includes(account.loginPassword));assert.ok(!logs.includes('scrypt$'));
});

test('a legacy OAuth session cannot authenticate after the switch to passwords',async t=>{
  const h=await anonymous(t);
  const row=h.store.db.prepare('SELECT sid,data FROM sessions LIMIT 1').get();
  const data=JSON.parse(row.data);data.user={id:owner,username:'Old owner'};data.authType='discord';
  h.store.db.prepare('UPDATE sessions SET data=? WHERE sid=?').run(JSON.stringify(data),row.sid);
  assert.equal((await h.request('/api/accounts',{headers:{Cookie:h.cookie}})).status,401);
  const session=await(await h.request('/api/session',{headers:{Cookie:h.cookie}})).json();assert.equal(session.authenticated,false);
  assert.equal((await h.request('/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
});


test('new managed account saves credentials and rank, logs in directly and retains password on rights edits',async t=>{
  const h=await harness(t);const ownerSession=await h.login();
  const headers={Cookie:ownerSession.cookie,'Content-Type':'application/json','X-CSRF-Token':ownerSession.data.csrfToken};
  h.store.saveGroup({id:'sales',name:'Verkoop',color:'#ef3b48',permissions:['members'],logSourceIds:[]});
  const account={id:member,label:'New Staff',groupId:'sales',permissions:[],logSourceIds:[],active:true,loginUsername:'new.staff',loginPassword:testPassword};
  const incomplete=await h.request('/api/accounts',{method:'POST',headers,body:JSON.stringify({...account,loginPassword:''})});
  assert.equal(incomplete.status,400);assert.equal(h.store.getAccount(member),null);
  const created=await h.request('/api/accounts',{method:'POST',headers,body:JSON.stringify(account)});
  assert.equal(created.status,200);const saved=(await created.json()).account;
  assert.equal(saved.hasLogin,true);assert.equal(saved.mustChangePassword,false);assert.equal(saved.groupId,'sales');
  const pre=await h.request('/api/session'),session=await pre.json();
  const signedIn=await h.request('/auth/login',{method:'POST',headers:{Cookie:pre.headers.getSetCookie()[0].split(';')[0],'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({username:'new.staff',password:testPassword})});
  assert.equal(signedIn.status,200);const staff=await signedIn.json();assert.equal(staff.mustChangePassword,false);assert.deepEqual(staff.permissions,['members']);
  const staffCookie=signedIn.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await h.request('/api/members',{headers:{Cookie:staffCookie}})).status,200);
  const hash=h.store.getCredential(member).passwordHash;
  const edited=await h.request('/api/accounts',{method:'POST',headers,body:JSON.stringify({...account,label:'Updated Staff',loginPassword:''})});
  assert.equal(edited.status,200);assert.equal(h.store.getAccount(member).label,'Updated Staff');assert.equal(h.store.getCredential(member).passwordHash,hash);
});
