import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {unzipSync,strFromU8} from 'fflate';
import {OwnedBrowser,findChrome,launchOptions} from './owned-browser.mjs';
import {OwnedRealm,buildRealmSource,isRealUrl} from './owned-realm.mjs';
import {diagnosticArchive,scrubDiagnostics,networkRecord} from './diagnostics.mjs';
import {OperationError} from './core.mjs';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'real-owned-test-'));await fs.mkdir(path.join(root,'helium-extension'));for(const name of ['navigation.js','pack-listing.js','workflow.js','real.js'])await fs.writeFile(path.join(root,'helium-extension',name),'// fixture');
  const launches=[],calls=[],realms=[],pages=[];let closed=0;
  const service=new OwnedBrowser({root,version:'test',detect:async()=>'C:/Chrome/chrome.exe',spawnManual:(file,args,options)=>{const child=new EventEmitter();child.unref=()=>{};child.args=args;child.options=options;queueMicrotask(()=>child.emit('spawn'));return child;},launch:async options=>{
    launches.push(options);const page=new EventEmitter();Object.assign(page,{isClosed:()=>false,url:()=> 'https://realsports.io/',setDefaultNavigationTimeout(){},goto:async()=>{},reload:async()=>{page.reloads++;},reloads:0,screenshot:async()=>Buffer.from('PNG')});pages.push(page);
    page.windowCalls=[];page.frontCalls=0;page.bringToFront=async()=>{page.frontCalls++;};page.createCDPSession=async()=>({send:async(method,params)=>{page.windowCalls.push({method,params});return {windowId:17};},detach:async()=>{}});
    const browser=new EventEmitter();Object.assign(browser,{connected:true,pages:async()=>[page],close:async()=>{closed++;browser.connected=false;browser.emit('disconnected');}});return browser;
  },realmFactory:page=>{const realm={install:async()=>{},message:async message=>message.type==='READY'?{version:'test',ready:true,active:false}:message.type==='DIAGNOSTIC'?{url:'https://realsports.io/',sensitiveFieldsVisible:false,nodes:[]}:message.type==='SNAPSHOT'?{quickListOptions:[],lastAction:null}:{ok:true,pack:{}}};realms.push(realm);return realm;},api:async(route,body)=>{calls.push({route,body});return route==='next'?{command:null,busy:false}:{ok:true};}});
  t.after(async()=>{service.manualProcess=null;service.activeCommand=null;service.polling=false;await service.close();await fs.rm(root,{recursive:true,force:true});});
  return {service,launches,calls,realms,pages,closed:()=>closed};
}

test('launch uses a separate persistent profile and pipe, with sandbox/TLS protections intact',()=>{
  const options=launchOptions('chrome.exe','app/data/browser-profile','headless');assert.equal(options.headless,false);assert.equal(options.pipe,true);assert.equal(options.userDataDir,'app/data/browser-profile');
  assert.ok(options.args.every(arg=>!arg.includes('no-sandbox')&&!arg.includes('ignore-certificate')&&!arg.includes('remote-debugging-port')&&!arg.includes('disable-web-security')));assert.equal(launchOptions('chrome.exe','profile','visible').headless,false);assert.throws(()=>launchOptions('chrome.exe','profile','bad'));
});
test('Chrome discovery uses exact installation paths, not user browsing profiles',async()=>{
  const searched=[];const chrome=await findChrome({ProgramFiles:'C:/Programs',LOCALAPPDATA:'C:/Local'},async p=>{searched.push(p);if(!p.startsWith('C:')||!p.includes('Local'))throw Error('absent');});assert.ok(chrome.includes('Chrome'));assert.equal(searched.length,2);
  await assert.rejects(findChrome({},async()=>{}),/Chrome не найден/);
});
test('start and stop use only the owned process, preserve profile and persist auto-start',async t=>{
  const f=await fixture(t);await f.service.start('headless');assert.equal(f.service.status().connected,true);assert.equal(f.service.status().loggedIn,true);assert.equal(f.service.autoStart,true);assert.equal(f.launches.length,1);
  await f.service.start('headless');assert.equal(f.launches.length,1);
  await f.service.stop();assert.equal(f.closed(),1);assert.equal(f.service.autoStart,false);assert.equal(f.service.running,false);
  assert.equal(JSON.parse(await fs.readFile(f.service.preferenceFile)).autoStart,false);
});
test('legacy headless callers are migrated to the same visible profile',async t=>{
  const f=await fixture(t);await f.service.start('headless');
  assert.equal(f.launches[0].headless,false);assert.equal(f.service.mode,'visible');
  await f.service.requestVisibility(true,true);await f.service.applyVisibility();assert.equal(f.launches.length,1);assert.equal(f.service.status().pendingVisibility,false);
});
test('headless mode cannot be enabled even by an old panel',async t=>{
  const f=await fixture(t);await f.service.start();await assert.rejects(f.service.requestVisibility(false,true),/без окна отключена/);assert.equal(f.launches.length,1);assert.equal(f.service.mode,'visible');
});
test('persisted hidden preference migrates to visible while preserving auto-start',async t=>{
  const f=await fixture(t);await fs.mkdir(path.dirname(f.service.preferenceFile),{recursive:true});await fs.writeFile(f.service.preferenceFile,JSON.stringify({visible:false,autoStart:true}));
  await f.service.initialize();assert.equal(f.service.preferredMode,'visible');assert.equal(f.service.autoStart,true);assert.equal(JSON.parse(await fs.readFile(f.service.preferenceFile)).visible,true);
});
test('closing visible window marks connection offline without killing personal Chrome',async t=>{
  const f=await fixture(t);await f.service.start('visible');f.service.browser.connected=false;f.service.browser.emit('disconnected');assert.equal(f.service.status().connected,false);assert.equal(f.closed(),0);
});
test('visible startup restores the owned window and repeated login brings it forward without relaunch',async t=>{
  const f=await fixture(t);await f.service.start('visible');const page=f.pages[0];assert.equal(page.frontCalls,1);
  assert.deepEqual(page.windowCalls[1],{method:'Browser.setWindowBounds',params:{windowId:17,bounds:{windowState:'minimized'}}});
  assert.deepEqual(page.windowCalls[2],{method:'Browser.setWindowBounds',params:{windowId:17,bounds:{windowState:'normal'}}});
  await f.service.start('visible');assert.equal(page.frontCalls,2);assert.equal(f.launches.length,1);
});
test('visible readiness polling never steals focus again',async t=>{
  const f=await fixture(t);await f.service.start();const calls=f.pages[0].frontCalls;await f.service.refresh();assert.equal(f.pages[0].frontCalls,calls);assert.equal(calls,1);
});
test('same command ID is never delivered twice after a lost execute reply',async t=>{
  const f=await fixture(t);await f.service.start('headless');let sent=0;f.service.realm.message=async message=>{if(message.type==='READY')return {version:'test',ready:true};sent++;throw Error('lost');};
  const command={id:'once',action:'open',expiresAt:Date.now()+60000};assert.equal((await f.service.execute(command)).uncertain,true);assert.equal((await f.service.execute(command)).uncertain,true);assert.equal(sent,1);assert.equal(f.pages[0].reloads,0);
});
test('reset is scoped to General and can clear an abandoned active command',async t=>{
  const f=await fixture(t);await f.service.start('headless');assert.equal((await f.service.execute({id:'invalid',action:'reset',expiresAt:Date.now()+60000})).ok,false);assert.equal(f.pages[0].reloads,0);
  assert.equal((await f.service.execute({id:'reset',action:'reset',generalRecovery:true,expiresAt:Date.now()+60000})).snapshot.reset,true);assert.equal(f.pages[0].reloads,1);
});
test('General reset reloads before switch and again after switch, then verifies identity',async t=>{
  const f=await fixture(t);await f.service.start('headless');const events=[];
  f.pages[0].reload=async()=>events.push('reload');
  f.service.realm.message=async message=>{if(message.type==='READY')return {version:'test',ready:true};events.push(message.command.action);return {ok:true,snapshot:{accountId:'a1',switched:message.command.action==='prepare-account'}};};
  const r=await f.service.execute({id:'fresh-account',action:'reset',accountId:'a1',generalRecovery:true,expiresAt:Date.now()+60000});
  assert.equal(r.ok,true);assert.deepEqual(events,['reload','prepare-account','reload','verify-account']);
});
test('manual login stops before any execution or automatic reload',async t=>{
  const f=await fixture(t);await f.service.start('headless');f.service.realm.message=async()=>({version:'test',requiresAttention:true});
  const result=await f.service.execute({id:'login',action:'open',expiresAt:Date.now()+60000});assert.equal(result.requiresAttention,true);assert.equal(result.uncertain,false);assert.equal(f.pages[0].reloads,0);
});

test('native purchase 403 stops the queue instead of treating it as a reload-only failure',async t=>{
  const f=await fixture(t);await f.service.start();
  const response={url:()=> 'https://web.realapp.com/collectingpacks/general',status:()=>403,request:()=>({method:()=> 'POST',resourceType:()=> 'xhr'})};
  f.service.realm.message=async message=>{if(message.type==='READY')return {version:'test',ready:true};f.pages[0].emit('response',response);return {ok:false,uncertain:true,message:'No summary'};};
  const result=await f.service.execute({id:'denied',action:'open',kind:'general',expiresAt:Date.now()+60000});
  assert.equal(result.requiresAttention,true);assert.match(result.message,/ручная проверка/);assert.equal(f.pages[0].reloads,0);
});

test('unrelated rejected request cannot mark a purchase as denied',async t=>{
  const f=await fixture(t);await f.service.start();
  f.service.realm.message=async message=>{if(message.type==='READY')return {version:'test',ready:true};f.pages[0].emit('response',{url:()=> 'https://web.realapp.com/tracking/web',status:()=>403,request:()=>({method:()=> 'POST',resourceType:()=> 'xhr'})});return {ok:true};};
  const result=await f.service.execute({id:'not-denied',action:'open',expiresAt:Date.now()+60000});assert.equal(result.ok,true);
});

test('native 403 during the safe pre-purchase recovery also stops the queue',async t=>{
  const f=await fixture(t);await f.service.start();let tries=0;
  f.service.realm.message=async message=>{if(message.type==='READY')return {version:'test',ready:true};if(++tries===1)return {ok:false,uncertain:false,recoverable:true};f.pages[0].emit('response',{url:()=> 'https://web.realapp.com/collectingpacks/general',status:()=>403,request:()=>({method:()=> 'POST',resourceType:()=> 'xhr'})});return {ok:false,uncertain:true};};
  const result=await f.service.execute({id:'recovery-denied',action:'open',expiresAt:Date.now()+60000});assert.equal(result.requiresAttention,true);assert.equal(tries,2);
});
test('transport retains result for reporting, not replay, when server reply is lost',async t=>{
  const f=await fixture(t);await f.service.start('headless');let next=0,executed=0,reports=0;f.service.execute=async()=>{executed++;return {ok:true};};
  f.service.api=async route=>{if(route==='next')return next++===0?{command:{id:'one'}}:{command:null,busy:false};if(route==='result'&&++reports===1)throw Error('lost server');return {ok:true};};
  await f.service.poll();assert.equal(f.service.report.commandId,'one');await f.service.poll();assert.equal(executed,1);assert.equal(f.service.report,null);assert.equal(reports,2);
});
test('diagnostics omits screen/DOM on login and screenshot for populated fields',async t=>{
  const f=await fixture(t);await f.service.start('visible');f.service.realm.message=async()=>({version:'test',requiresAttention:true});const login=await f.service.diagnostics();assert.equal(login.png,null);assert.match(login.page.omitted,/Вход/);
  f.service.realm.message=async m=>m.type==='READY'?{ready:true}:m.type==='DIAGNOSTIC'?{sensitiveFieldsVisible:true,url:'https://realsports.io/',nodes:[]}:{quickListOptions:[]};assert.equal((await f.service.diagnostics()).png,null);
});
test('ZIP is local, redacts known credentials and emails, and preserves troubleshooting controls',()=>{
  const zip=diagnosticArchive({token:'local',cookies:'secret',page:{text:'user@example.com private-session-value',nodes:[{role:'button',text:'Quick list'}]},headers:{authorization:'private-session-value'}},Buffer.from('PNG'),['private-session-value']);
  const files=unzipSync(zip),json=strFromU8(files['diagnostic.json']);assert.doesNotMatch(json,/private-session-value|user@example.com|cookies|authorization|token/);assert.match(json,/Quick list/);assert.ok(files['real-screen.png']);assert.ok(files['README.txt']);assert.equal(scrubDiagnostics('ok'),'ok');
});
test('isolated bridge bootstraps only on exact Real host, with no server token',async()=>{
  const source=buildRealmSource(["chrome.runtime.onMessage.addListener((message,sender,reply)=>{reply({ready:true});});"],'testBinding');
  const context={location:{href:'https://realsports.io/'},window:{},setTimeout,clearTimeout,testBinding(){}};context.window.top=context.window;vm.runInNewContext(source,context);assert.equal((await context.__rmDispatch({type:'READY'})).ready,true);assert.doesNotMatch(source,/x-local-token|localhost|127\.0\.0\.1/);
  const other={...context,location:{href:'https://evil.example/'}};delete other.__rmDispatch;vm.runInNewContext(source,other);assert.equal(other.__rmDispatch,undefined);
  assert.equal(isRealUrl('https://realsports.io.evil.example/'),false);assert.equal(isRealUrl('http://realsports.io/'),false);assert.equal(isRealUrl('https://realsports.io:8443/'),false);assert.equal(isRealUrl('https://user:pass@realsports.io/'),false);
});
test('binding requires the main isolated context, active command ID and matching action',async()=>{
  const authorized=[],replies=[],realm=new OwnedRealm({url:()=> 'https://realsports.io/'},[],async(...args)=>{authorized.push(args);return {ok:true};});
  realm.context=async()=>7;realm.contexts.set(7,{name:realm.world});realm.contexts.set(8,{name:realm.world});realm.session={send:async(_method,params)=>replies.push(params)};realm.inflight={id:'good',action:'open'};
  const event=(id,type='AUTHORIZE_PURCHASE',executionContextId=7)=>({name:realm.binding,executionContextId,payload:JSON.stringify({id:'req',message:{type,commandId:id}})});
  await realm.handleBinding(event('good','AUTHORIZE_PURCHASE',8));assert.equal(replies.length,0);
  await realm.handleBinding(event('wrong'));await realm.handleBinding(event('good','AUTHORIZE_LISTING'));assert.equal(authorized.length,0);
  await realm.handleBinding(event('good'));assert.equal(authorized.length,1);assert.equal(authorized[0][0],'authorize');
});
test('changing visibility at a job boundary does not switch between open and listing',async()=>{
  const source=await fs.readFile(new URL('./server.mjs',import.meta.url),'utf8');assert.match(source,/\['open','check','reset'\]\.includes\(action\)\)await ownedBrowser.applyVisibility/);assert.match(source,/pipe|OwnedBrowser/);assert.match(source,/if\(busy\|\|shuttingDown\|\|ownedBrowser.starting\)/);
});
test('network fingerprint records route/status only and never query values or foreign telemetry',()=>{
  const record=networkRecord('https://web.realapp.com/collectingpacks/player?sport=wnba&entityId=123&token=secret&code=otp','GET',200,'xhr',12);
  assert.deepEqual(record.queryKeys,['sport','entityId']);assert.equal(record.path,'/collectingpacks/player');assert.equal(record.status,200);assert.doesNotMatch(JSON.stringify(record),/secret|123|otp/);
  assert.equal(networkRecord('https://analytics.example.com/user?email=user@example.com','GET',200,'xhr'),null);assert.equal(networkRecord('https://web.realapp.com/private','GET',200,'document'),null);
});
test('native login response is captured and saved; failed or external responses are ignored',async t=>{
  const f=await fixture(t);await f.service.start('visible');const accounts=[];f.service.onAccount=async a=>accounts.push(a);
  const response=(url='https://web.realapp.com/user',status=200)=>({url:()=>url,status:()=>status,headers:()=>({}),request:()=>({method:()=> 'GET',headers:()=>({'real-auth-info':'secret-session'})}),buffer:async()=>Buffer.from(JSON.stringify({user:{id:'a1',userName:'Alice',virtualCurrencyBalance:200}}))});
  await f.service.captureAccount(response());assert.equal(accounts[0].id,'a1');assert.equal(f.service.status().accountCapture.lastName,'Alice');
  await f.service.captureAccount(response('https://other.test/user'));await f.service.captureAccount(response(undefined,401));assert.equal(accounts.length,1);
});
test('account onboarding opens a manual window, then resumes visibly in the same profile',async t=>{
  const f=await fixture(t);assert.equal((await f.service.addAccounts()).addingAccounts,true);const manual=f.service.manualProcess;
  assert.ok(manual.args.includes('--user-data-dir='+f.service.profile));assert.ok(manual.args.every(a=>!a.includes('debugging')&&!a.includes('automation')));assert.equal(manual.options.windowsHide,false);assert.equal(f.launches.length,0);
  await assert.rejects(f.service.finishAccounts(),/закройте окно/i);manual.emit('exit',0);
  await f.service.start('headless');await f.service.saveCapturedAccount({id:'a1',name:'Alice',headers:{'real-auth-info':'test-auth'},lastSessionAt:'now'},f.service.browser);
  await f.service.finishAccounts();assert.equal(f.service.mode,'visible');assert.equal(f.service.addingAccounts,false);assert.equal(f.service.autoStart,true);assert.equal(f.launches[0].headless,false);assert.equal(f.launches[0].userDataDir,f.service.profile);
});

test('cached login is validated with GET /user from observed native auth, once per session',async t=>{
  const f=await fixture(t);await f.service.start('headless');const accounts=[],reads=[];
  f.service.onAccount=async a=>accounts.push(a);f.service.readProfile=async headers=>{reads.push(headers);return {user:{id:'a1',userName:'Alice'}};};
  const response=(url='https://web.realapp.com/home/nba/next',status=200,method='GET',type='xhr',headers={'real-auth-info':'native-auth',cookie:'private','real-turnstile-token':'challenge'})=>({url:()=>url,status:()=>status,request:()=>({method:()=>method,resourceType:()=>type,headers:()=>headers})});
  for(const r of [response('https://evil.test/home'),response(undefined,403),response(undefined,200,'POST'),response(undefined,200,'GET','document'),response(undefined,200,'GET','xhr',{})])f.service.queueProfileProbe(r);
  await f.service.captureQueue;assert.equal(reads.length,0);
  f.service.queueProfileProbe(response());f.service.queueProfileProbe(response());await f.service.captureQueue;
  assert.equal(reads.length,1);assert.deepEqual(reads[0],{'real-auth-info':'native-auth'});assert.equal(accounts[0].name,'Alice');
  f.service.queueProfileProbe(response());await f.service.captureQueue;assert.equal(reads.length,1);
  assert.equal((await f.service.finishAccounts()).addingAccounts,false);
});

test('profile verification or disk failure does not declare onboarding complete',async t=>{
  const f=await fixture(t);await f.service.start('headless');f.service.addingAccounts=true;
  f.service.readProfile=async()=>({user:{id:'a1',userName:'Alice'}});f.service.onAccount=async()=>{throw Error('disk');};
  f.service.queueProfileProbe({url:()=> 'https://web.realapp.com/home/nba/next',status:()=>200,request:()=>({method:()=> 'GET',resourceType:()=> 'fetch',headers:()=>({'real-auth-info':'native-auth'})})});
  await f.service.captureQueue;assert.equal(f.service.accountCapture.count,0);assert.equal(f.service.lastCapturedAuth,null);
  await assert.rejects(f.service.finishAccounts(),/сессию/);assert.equal(f.service.addingAccounts,true);
});
test('unfinished login cannot silently finish onboarding',async t=>{
  const f=await fixture(t);await f.service.addAccounts();f.service.manualProcess.emit('exit',0);await f.service.start('visible');f.service.realm.message=async()=>({version:'test',ready:false,requiresAttention:true});await assert.rejects(f.service.finishAccounts(),/завершите вход/);assert.equal(f.service.addingAccounts,true);assert.equal(f.service.mode,'visible');
});
