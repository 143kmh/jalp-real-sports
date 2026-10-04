import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserAccount,hasBrowserSession,requireBrowserSession,mergeBrowserAccount} from './browser-accounts.mjs';
import {publicAccount} from './core.mjs';
const input={url:'https://web.realapp.com/user',method:'GET',status:200,headers:{'real-auth-info':'session-secret','real-request-token':'ephemeral','real-turnstile-token':'challenge',cookie:'private','user-agent':'Chrome'},user:{id:'a1',userName:'Alice',virtualCurrencyBalance:200}};
test('successful native profile registers credentials without HAR, cookie or challenge tokens',()=>{
  const a=browserAccount(input);assert.ok(hasBrowserSession(a));assert.equal(a.name,'Alice');assert.equal(a.balance,200);assert.equal(a.headers['real-auth-info'],'session-secret');assert.equal(a.sessionSource,'browser');
  for(const key of ['cookie','real-request-token','real-turnstile-token'])assert.equal(a.headers[key],undefined);
  assert.doesNotMatch(JSON.stringify(publicAccount(a)),/session-secret/);
});
test('failed login, third-party response, POST and missing authorization cannot create accounts',()=>{
  for(const patch of [{url:'https://evil.test/user'},{url:'https://web.realapp.com/user/profile'},{method:'POST'},{status:401},{headers:{}},{user:{id:'invalid/..'}},{headers:{'real-auth-info':'bad\nheader'}}])assert.equal(browserAccount({...input,...patch}),null);
});
test('new browser login replaces old credentials but preserves account settings and unknown-purchase hold',()=>{
  const old={id:'a1',name:'old',headers:{'real-auth-info':'old-secret'},purchaseHold:true,packs:{nfl:{cost:200}},seasons:{nfl:'2026'},importedAt:'old-date'};
  const merged=mergeBrowserAccount(old,browserAccount(input));assert.equal(merged,old);assert.equal(merged.purchaseHold,true);assert.equal(merged.packs.nfl.cost,200);assert.equal(merged.seasons.nfl,'2026');assert.equal(merged.importedAt,'old-date');assert.equal(merged.headers['real-auth-info'],'session-secret');
});
test('old imported accounts remain readable but cannot enter a browser task before manual login',()=>{
  assert.equal(hasBrowserSession({headers:input.headers}),false);assert.throws(()=>requireBrowserSession({name:'Alice',headers:input.headers}),/Добавить аккаунты/);assert.doesNotThrow(()=>requireBrowserSession(browserAccount(input)));
});
