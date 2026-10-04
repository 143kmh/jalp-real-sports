import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {NativeBrowser,nativeArguments} from './native-browser.mjs';
const extension='chrome-extension://'+'a'.repeat(32);
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'real-native-test-'));await fs.mkdir(path.join(root,'helium-extension'));for(const file of ['navigation.js','pack-listing.js','workflow.js','real.js'])await fs.writeFile(path.join(root,'helium-extension',file),'// test adapter');
  await fs.mkdir(path.join(root,'native-extension'));for(const file of ['manifest.json','background.js','panel.js'])await fs.copyFile(new URL('./native-extension/'+file,import.meta.url),path.join(root,'native-extension',file));
  const spawns=[],accounts=[];
  const browser=new NativeBrowser({root,version:'0.4.3',detect:async()=> 'chrome.exe',onAccount:async account=>accounts.push(account),spawnChrome:(exe,args,options)=>{spawns.push({exe,args,options});const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;},readProfile:async()=>({user:{id:'testUser',userName:'Fixture',virtualCurrencyBalance:200}})});
  await browser.initialize();t.after(()=>fs.rm(root,{recursive:true,force:true}));return {browser,spawns,accounts,root};
}
test('native launch has no DevTools, automation masking, sandbox override or extension-injection flags',()=>{
  const args=nativeArguments('app/data/browser-profile','http://127.0.0.1:5127');assert.equal(args.length,6);assert.ok(args.some(arg=>arg.includes('native-bridge=1')));assert.doesNotMatch(args.join(' '),/debugging|automation|headless|disable-blink|load-extension|no-sandbox|ignore-certificate/i);assert.throws(()=>nativeArguments('profile','https://remote.test'));
});
test('native startup uses the existing profile and generates only project-owned adapters',async t=>{
  const f=await fixture(t);await f.browser.start();assert.equal(f.spawns.length,1);assert.ok(f.spawns[0].args.includes('--user-data-dir='+f.browser.profile));assert.equal(f.spawns[0].options.windowsHide,false);assert.equal(f.browser.status().extensionRequired,true);assert.equal(await fs.readFile(path.join(f.root,'chrome-extension','real.js'),'utf8'),'// test adapter');
});
test('pairing requires launched own window, exact extension origin, tab and matching version',async t=>{
  const f=await fixture(t);assert.throws(()=>f.browser.acceptHello(extension,{version:'0.4.3',tabId:1}));await f.browser.start();assert.throws(()=>f.browser.acceptHello('https://evil.test',{version:'0.4.3',tabId:1}));assert.throws(()=>f.browser.acceptHello(extension,{version:'wrong',tabId:1}));f.browser.acceptHello(extension,{version:'0.4.3',tabId:1});assert.equal(f.browser.connected,true);assert.equal(f.browser.trusted(extension),true);assert.equal(f.browser.trusted('chrome-extension://'+'b'.repeat(32)),false);
});
test('native readiness respects site verification; wrong-host snapshots are rejected',async t=>{
  const f=await fixture(t);await f.browser.start();f.browser.acceptHello(extension,{version:'0.4.3',tabId:1});assert.throws(()=>f.browser.receiveSnapshot({version:'0.4.3',url:'https://evil.test/',loggedIn:true}));f.browser.receiveSnapshot({version:'0.4.3',url:'https://realsports.io/',loggedIn:true,requiresAttention:true});await assert.rejects(f.browser.waitReady(),/ручную проверку/);assert.equal(f.browser.status().loggedIn,false);
});
test('native session registration validates GET /user and never imports cookies/challenge tokens',async t=>{
  const f=await fixture(t);await f.browser.observeSession({'real-auth-info':'test-auth',cookie:'private','real-turnstile-token':'challenge'});await f.browser.observeSession({'real-auth-info':'test-auth'});assert.equal(f.accounts.length,1);assert.equal(f.accounts[0].headers.cookie,undefined);assert.equal(f.accounts[0].headers['real-turnstile-token'],undefined);assert.equal(f.browser.accountCapture.lastName,'Fixture');
});
test('native onboarding keeps Chrome open and requires actual saved session',async t=>{
  const f=await fixture(t);await f.browser.addAccounts();f.browser.acceptHello(extension,{version:'0.4.3',tabId:1});f.browser.receiveSnapshot({version:'0.4.3',url:'https://realsports.io/',loggedIn:true});await assert.rejects(f.browser.finishAccounts(),/дождитесь/);await f.browser.observeSession({'real-auth-info':'test-auth'});await f.browser.finishAccounts();assert.equal(f.browser.running,true);assert.equal(f.browser.addingAccounts,false);
});
test('native stop closes only paired Real tab via extension, never kills Chrome processes',async t=>{
  const f=await fixture(t);await f.browser.start();f.browser.acceptHello(extension,{version:'0.4.3',tabId:1});f.browser.notify=()=>f.browser.closed();await f.browser.stop();assert.equal(f.browser.running,false);assert.equal(f.browser.autoStart,false);
  assert.doesNotMatch(await fs.readFile(new URL('./native-browser.mjs',import.meta.url),'utf8'),/taskkill|\.kill\(|puppeteer|createCDPSession/);
});

async function workerFixture(commands,execute){
  const values={token:'a'.repeat(64),realTabId:1},executions=[],requests=[],reloads=[];let listener;
  const context={URL,setTimeout,clearTimeout,setInterval,clearInterval,fetch:async(url,options)=>{const route=url.split('/').at(-1),body=JSON.parse(options.body);requests.push({route,body});if(route==='next'&&!commands.length)throw Error('test stop');return {ok:true,json:async()=>route==='next'?{command:commands.shift(),busy:true}:{ok:true}};},chrome:{
    storage:{session:{get:async key=>typeof key==='string'?{[key]:values[key]}:values,set:async data=>Object.assign(values,data)}},
    tabs:{get:async()=>({id:1,url:'https://realsports.io/',autoDiscardable:true}),update:async()=>{},reload:async id=>reloads.push(id),sendMessage:async(_id,message)=>{if(message.type==='READY')return {version:'0.4.3',ready:true};if(message.type==='SNAPSHOT')return {version:'0.4.3',url:'https://realsports.io/',loggedIn:true};executions.push(message.command);return execute(message.command);}},
    runtime:{id:'a'.repeat(32),getManifest:()=>({version:'0.4.3'}),onMessage:{addListener:fn=>listener=fn}},alarms:{create:async()=>{},onAlarm:{addListener(){}}},webRequest:{onBeforeSendHeaders:{addListener(){}},onCompleted:{addListener(){}},onErrorOccurred:{addListener(){}}}
  }};
  vm.runInNewContext(await fs.readFile(new URL('./native-extension/background.js',import.meta.url),'utf8'),context);
  await new Promise(resolve=>listener({type:'WAKE'},{url:'http://127.0.0.1:5127/'},resolve));
  for(let i=0;i<100&&vm.runInNewContext('polling',context);i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(vm.runInNewContext('polling',context),false);return {executions,requests,reloads};
}
test('native extension refreshes before switch and again after switch, then verifies identity',async()=>{
  const f=await workerFixture([{id:'native-reset',action:'reset',generalRecovery:true,accountId:'a',expiresAt:Date.now()+60000}],command=>({ok:true,snapshot:{accountId:'a',switched:command.action==='prepare-account'}}));
  assert.equal(f.reloads.length,2);assert.deepEqual(f.executions.map(command=>command.action),['prepare-account','verify-account']);assert.equal(f.requests.find(request=>request.route==='result').body.result.ok,true);
});
test('native extension never replays an opening with a lost reply',async()=>{
  const f=await workerFixture([{id:'native-open',action:'open',expiresAt:Date.now()+60000}],()=>{throw Error('lost');});assert.equal(f.executions.length,1);assert.equal(f.requests.find(request=>request.route==='result').body.result.uncertain,true);
});
