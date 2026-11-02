import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function context(overrides={}){
  const app={innerHTML:''};
  const sandbox=vm.createContext({crypto:webcrypto,structuredClone,URLSearchParams,URL,FormData,console,
    document:{documentElement:{dataset:{}},activeElement:null,hidden:false,getElementById:id=>id==='app'?app:{children:[],classList:{add(){},remove(){}}},querySelectorAll:()=>[],addEventListener(){}},
    location:{pathname:'/preview',hash:'#dashboard',search:''},window:{addEventListener(){}},
    localStorage:{getItem:()=>null,setItem(){}},sessionStorage:{getItem:()=>null,setItem(){}},
    setInterval(){},setTimeout(){},clearTimeout(){},queueMicrotask,
    fetch:async()=>({status:401,ok:false,json:async()=>({error:'Gebruikersnaam of wachtwoord is onjuist.'})}),...overrides});
  vm.runInContext(source,sandbox);return sandbox;
}

test('login renders username and password inputs without an OAuth login option',()=>{
  const ctx=context();const html=vm.runInContext("state.preview=false;state.session={configured:true,authenticated:false,csrfToken:'csrf-test'};renderLogin();app.innerHTML",ctx);
  assert.match(html,/autocomplete="username"/);assert.match(html,/type="password" autocomplete="current-password"/);
  assert.ok(!html.includes('href="/auth/discord"'));assert.match(html,/id="login-form"/);
});

test('a temporary-password session renders the change form even if shell is called directly',()=>{
  const ctx=context();const html=vm.runInContext("state.preview=false;state.session={authenticated:true,mustChangePassword:true,user:{id:'fake-id',username:'owner.test'}};shell();app.innerHTML",ctx);
  assert.match(html,/id="password-change-form"/);assert.match(html,/autocomplete="new-password"/);assert.match(html,/Tijdelijk wachtwoord/);
  assert.ok(!html.includes('id="sidebar"'));
});

test('a failed password login retains the pre-authentication CSRF token so the next attempt works',async()=>{
  const ctx=context();vm.runInContext("state.preview=false;state.session={configured:true,authenticated:false,csrfToken:'csrf-test'};renderLogin()",ctx);
  await assert.rejects(vm.runInContext("api('/auth/login',{method:'POST',body:'{}'})",ctx),/Gebruikersnaam of wachtwoord/);
  assert.equal(vm.runInContext('state.session.csrfToken',ctx),'csrf-test');
});


function accountFormContext(values={}){
  const ctx=context({FormData:class{constructor(){this.values={discordId:'222222222222222222',label:'Sales',loginUsername:'new.staff',loginPassword:'Example password phrase',groupId:'sales',permissions:['members'],...values}}get(key){return this.values[key]??null}getAll(key){return this.values[key]||[]}}});
  vm.runInContext("state.preview=false;state.accounts=[];state.session={user:{id:'424086753327054849'}}",ctx);return ctx;
}
test('account form validates missing data with useful errors and keeps managed passwords permanent',()=>{
  const html=vm.runInContext('individualAccountsView()',context());assert.match(html,/account-form" novalidate/);assert.match(html,/id="account-message"/);assert.ok(!html.includes('Tijdelijk wachtwoord'));
  assert.throws(()=>vm.runInContext('accountData({})',accountFormContext({loginPassword:''})),/Kies een wachtwoord/);
  assert.throws(()=>vm.runInContext('accountData({})',accountFormContext({loginPassword:'short'})),/12 tot 128/);
  assert.throws(()=>vm.runInContext('accountData({})',accountFormContext({discordId:'123'})),/Discord-ID/);
  const ctx=accountFormContext();const data=vm.runInContext('accountData({})',ctx);assert.equal(data.loginUsername,'new.staff');assert.equal(data.groupId,'sales');
  const edit=accountFormContext({loginPassword:''});vm.runInContext("state.accounts=[{id:'222222222222222222',hasLogin:true}]",edit);assert.equal(vm.runInContext('accountData({}).loginPassword',edit),'');
});
test('account save sends credentials and keeps fields on server errors',async()=>{
  const handlers=[];let submitted;
  const message={textContent:'',focus(){this.focused=true}},button={disabled:false};
  const form={id:{tagName:'INPUT'},getAttribute:name=>name==='id'?'account-form':null,querySelector:q=>q==='[role=alert]'?message:button};
  const ctx=context({FormData:class{get(key){return {discordId:'222222222222222222',label:'Sales',loginUsername:'sales.staff',loginPassword:'Example password phrase'}[key]||null}getAll(){return []}},document:{documentElement:{dataset:{}},activeElement:null,getElementById:()=>({innerHTML:'',children:[],classList:{add(){},remove(){}}}),querySelectorAll:()=>[],addEventListener(type,fn){if(type==='submit')handlers.push(fn)}},fetch:async(url,options)=>{submitted=JSON.parse(options.body);return {status:409,ok:false,json:async()=>({error:'Deze gebruikersnaam is al in gebruik.'})}}});
  vm.runInContext("state.preview=false;state.accounts=[];state.session={user:{id:'424086753327054849'},csrfToken:'test'}",ctx);
  await handlers[0]({target:form,preventDefault(){}});
  assert.equal(submitted.loginUsername,'sales.staff');assert.equal(submitted.loginPassword,'Example password phrase');assert.equal(message.textContent,'Deze gebruikersnaam is al in gebruik.');assert.equal(message.focused,true);assert.equal(button.disabled,false);
});


test('account Discord field cannot shadow the form id and submit routing uses the attribute',()=>{
  const html=vm.runInContext('individualAccountsView()',context());
  assert.match(html,/id="account-id" name="discordId"/);
  assert.ok(!/name="id"/.test(html));
  assert.ok(!source.includes('includes(e.target.id)'));
});
