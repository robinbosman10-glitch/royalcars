import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function context(){
  const app={innerHTML:''};
  const sandbox=vm.createContext({crypto:webcrypto,structuredClone,URLSearchParams,URL,FormData,console,
    document:{documentElement:{dataset:{}},activeElement:null,hidden:false,getElementById:id=>id==='app'?app:{children:[],classList:{add(){},remove(){}}},querySelectorAll:()=>[],addEventListener(){}},
    location:{pathname:'/preview',hash:'#dashboard',search:''},window:{addEventListener(){}},
    localStorage:{getItem:()=>null,setItem(){}},sessionStorage:{getItem:()=>null,setItem(){}},
    setInterval(){},setTimeout(){},clearTimeout(){},queueMicrotask,
    fetch:async()=>({status:401,ok:false,json:async()=>({error:'Gebruikersnaam of wachtwoord is onjuist.'})})});
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
