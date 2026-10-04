import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {spawn} from 'node:child_process';
import {OperationError,realRequest} from './core.mjs';
import {OwnedRealm,REAL_URL} from './owned-realm.mjs';
import {networkRecord} from './diagnostics.mjs';
import {browserAccount,browserSessionHeaders} from './browser-accounts.mjs';

export async function findChrome(env=process.env,access=fs.access){
  const candidates=[env.ProgramFiles&&path.join(env.ProgramFiles,'Google','Chrome','Application','chrome.exe'),env['ProgramFiles(x86)']&&path.join(env['ProgramFiles(x86)'],'Google','Chrome','Application','chrome.exe'),env.LOCALAPPDATA&&path.join(env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe')].filter(Boolean);
  for(const candidate of candidates)try{await access(candidate);return candidate;}catch{}
  throw new OperationError('Chrome не найден. Установите Google Chrome с официального сайта.');
}
export function launchOptions(executablePath,profile,mode){
  if(!['visible','headless'].includes(mode))throw new OperationError('Неверный режим служебного браузера.');
  return {executablePath,userDataDir:profile,headless:mode==='headless',pipe:true,timeout:30000,protocolTimeout:150000,
    defaultViewport:{width:1440,height:1000},handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,
    args:['--no-first-run','--no-default-browser-check','--disable-session-crashed-bubble','--window-size=1440,1000']};
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new OperationError('Служебная вкладка не ответила.')),ms))]);}finally{clearTimeout(timer);}}

export class OwnedBrowser{
  constructor({root,api,version,onAccount=async()=>{},readProfile=headers=>realRequest({headers},'GET','/user'),launch=options=>puppeteer.launch(options),spawnManual=(file,args,options)=>spawn(file,args,options),detect=findChrome,realmFactory=(...args)=>new OwnedRealm(...args)}){
    Object.assign(this,{root,api,version,onAccount,readProfile,launch,spawnManual,detect,realmFactory});this.profile=path.join(root,'data','browser-profile');this.preferenceFile=path.join(root,'data','browser.json');this.manualProcess=null;
    this.lastCapturedAuth=null;this.profileProbeAuth=null;this.profileProbeAt=0;
    this.browser=null;this.page=null;this.realm=null;this.mode=null;this.starting=false;this.polling=false;this.wakePending=false;this.activeCommand=null;this.lastReady=null;this.lastError=null;this.autoStart=false;this.preferredMode='headless';this.requestedMode=null;this.switching=false;this.timer=null;this.attempted=new Set();this.available=false;this.report=null;this.network=[];this.addingAccounts=false;this.accountCapture={count:0,lastName:null,lastAt:null,error:null};this.captureQueue=Promise.resolve();
  }
  get running(){return Boolean(this.browser?.connected&&this.page&&!this.page.isClosed());}
  status(){return {available:this.available,running:this.running,starting:this.starting,mode:this.mode,connected:this.running&&Boolean(this.lastReady?.version===this.version),loggedIn:Boolean(this.lastReady?.ready&&!this.lastReady?.requiresAttention),requiresAttention:Boolean(this.lastReady?.requiresAttention),autoStart:this.autoStart,error:this.lastError,active:Boolean(this.activeCommand),visible:(this.requestedMode||this.mode||this.preferredMode)==='visible',pendingVisibility:Boolean(this.requestedMode),addingAccounts:this.addingAccounts,manualLogin:Boolean(this.manualProcess),accountCapture:{...this.accountCapture}};}
  async initialize(){
    try{await this.detect();this.available=true;}catch{this.available=false;}
    try{const pref=JSON.parse(await fs.readFile(this.preferenceFile,'utf8'));this.autoStart=pref.autoStart===true;this.preferredMode=pref.visible===true?'visible':'headless';}catch(error){if(error.code!=='ENOENT')this.lastError='Не удалось прочитать настройки браузера. Автозапуск отключён.';}
  }
  async preference(autoStart){const data={autoStart,visible:this.preferredMode==='visible'};await fs.mkdir(path.dirname(this.preferenceFile),{recursive:true});await fs.writeFile(this.preferenceFile+'.tmp',JSON.stringify(data));await fs.rename(this.preferenceFile+'.tmp',this.preferenceFile);this.autoStart=autoStart;}
  async start(mode='headless',{persist=true}={}){
    if(this.manualProcess)throw new OperationError('Закройте обычное окно входа Real, затем нажмите «Готово».');
    if(this.starting||this.polling||this.activeCommand)throw new OperationError('Дождитесь текущего действия браузера.');
    if(this.running&&this.mode===mode){if(mode==='visible')await this.showWindow();await this.refresh();if(persist){this.preferredMode=mode;await this.preference(this.autoStart||mode==='headless');}return this.status();}
    this.starting=true;this.lastError=null;
    try{
      await this.close();const executable=await this.detect();this.available=true;await fs.mkdir(this.profile,{recursive:true});
      const sources=await Promise.all(['navigation.js','pack-listing.js','workflow.js','real.js'].map(file=>fs.readFile(path.join(this.root,'helium-extension',file),'utf8')));
      this.browser=await this.launch(launchOptions(executable,this.profile,mode));this.mode=mode;const browser=this.browser;
      this.lastCapturedAuth=null;this.profileProbeAuth=null;this.profileProbeAt=0;this.accountCapture.error=null;
      browser.on('disconnected',()=>{if(this.browser===browser){this.lastReady=null;this.lastError='Служебный браузер закрыт. Запустите его из панели.';clearInterval(this.timer);}});
      const pages=await browser.pages();this.page=pages[0]||await browser.newPage();
      const startedRequests=new WeakMap();
      this.page.on('request',request=>startedRequests.set(request,Date.now()));
      this.page.on('response',response=>{
        const request=response.request(),record=networkRecord(response.url(),request.method(),response.status(),request.resourceType(),startedRequests.has(request)?Date.now()-startedRequests.get(request):null);
        if(record){this.network.push(record);this.network=this.network.slice(-200);}
        if(record?.origin==='https://web.realapp.com'&&record.status===200&&record.method==='GET'){
          if(record.path==='/user')this.captureQueue=this.captureQueue.then(()=>this.captureAccount(response,browser)).catch(()=>this.captureError());
          else this.queueProfileProbe(response,browser);
        }
      });
      this.realm=this.realmFactory(this.page,sources,(route,body)=>this.api(route,body));await this.realm.install();
      this.page.on('close',()=>{if(this.browser===browser){this.lastReady=null;clearInterval(this.timer);this.lastError='Служебная вкладка закрыта. Запустите браузер заново.';}});
      this.page.setDefaultNavigationTimeout(30000);
      try{await this.page.goto(REAL_URL,{waitUntil:'domcontentloaded'});}catch{this.lastError='Real не завершил загрузку. Проверьте соединение или откройте окно для входа.';}
      if(mode==='visible')await this.showWindow();
      // Never copy cookies/passwords from the user's browsers or HAR into this profile.
      await this.api('hello',{tabId:'owned',version:this.version});await this.refresh();
      this.timer=setInterval(()=>{if(!this.starting&&!this.polling&&!this.activeCommand)this.refresh().catch(()=>{});},mode==='visible'?5000:30000);this.timer.unref?.();
      if(persist){this.preferredMode=mode;await this.preference(this.autoStart||mode==='headless');}return this.status();
    }catch(error){await this.close();this.lastError=error instanceof OperationError?error.message:'Не удалось запустить служебный Chrome. Проверьте, что его профиль не открыт другим экземпляром.';throw new OperationError(this.lastError);}
    finally{this.starting=false;}
  }
  async captureAccount(response,browser=this.browser){
    if(this.browser!==browser)return;
    const request=response.request();let url;try{url=new URL(response.url());}catch{return;}
    if(url.origin!=='https://web.realapp.com'||url.pathname!=='/user'||request.method()!=='GET'||response.status()!==200)return;
    if(Number(response.headers?.()['content-length'])>1024*1024)return;
    const bytes=await bounded(response.buffer(),5000);if(bytes.length>1024*1024||this.browser!==browser)return;
    let data;try{data=JSON.parse(bytes.toString('utf8'));}catch{return;}
    const account=browserAccount({url:response.url(),method:request.method(),status:response.status(),headers:request.headers(),user:data?.user});
    if(!account)return;
    await this.saveCapturedAccount(account,browser);
  }
  captureError(){this.accountCapture.error='Не удалось проверить и сохранить сессию. Повторите «Готово»; если ошибка остаётся, войдите через «Добавить аккаунты» заново.';}
  async saveCapturedAccount(account,browser){
    if(this.browser!==browser)return;
    await this.onAccount(account);this.lastCapturedAuth=account.headers['real-auth-info'];
    this.accountCapture={count:this.accountCapture.count+1,lastName:account.name,lastAt:account.lastSessionAt,error:null};
  }
  queueProfileProbe(response,browser=this.browser){
    // Real can restore a cached user object without requesting /user on reload.
    // Validate the session from an observed, successful first-party GET using
    // the same read-only /user endpoint. Never read passwords, localStorage,
    // cookies, third-party traffic or challenge tokens to register an account.
    if(this.browser!==browser)return;
    let url;try{url=new URL(response.url());}catch{return;}
    const request=response.request();
    if(url.origin!=='https://web.realapp.com'||response.status()!==200||request.method()!=='GET'||!['xhr','fetch'].includes(request.resourceType()))return;
    const headers=browserSessionHeaders(request.headers());if(!headers)return;
    const auth=headers['real-auth-info'];
    if(auth===this.lastCapturedAuth||(auth===this.profileProbeAuth&&Date.now()-this.profileProbeAt<30000))return;
    this.profileProbeAuth=auth;this.profileProbeAt=Date.now();
    this.captureQueue=this.captureQueue.then(async()=>{
      if(this.browser!==browser||auth===this.lastCapturedAuth)return;
      const data=await this.readProfile(headers);
      const account=browserAccount({url:'https://web.realapp.com/user',method:'GET',status:200,headers,user:data?.user});
      if(!account)throw new OperationError('Real не подтвердил профиль.');
      await this.saveCapturedAccount(account,browser);
    }).catch(()=>this.captureError());
  }
  async addAccounts(){
    if(this.manualProcess)return this.status();
    if(this.polling||this.activeCommand||this.starting)throw new OperationError('Дождитесь текущей задачи.');
    await this.close();const executable=await this.detect();await fs.mkdir(this.profile,{recursive:true});
    this.starting=true;this.addingAccounts=true;this.lastError=null;
    try{
      // Human-only sign-in. No CDP, webdriver masking, interception or challenge
      // token extraction. Chrome performs all normal site checks itself.
      const child=this.spawnManual(executable,['--user-data-dir='+this.profile,'--new-window','--no-first-run','--no-default-browser-check',REAL_URL],{windowsHide:false,stdio:'ignore'});
      this.manualProcess=child;
      child.once('exit',()=>{if(this.manualProcess===child)this.manualProcess=null;});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref?.();
      return this.status();
    }catch{this.manualProcess=null;this.addingAccounts=false;throw new OperationError('Не удалось открыть обычный Chrome для входа.');}
    finally{this.starting=false;}
  }
  async finishAccounts(){
    if(this.manualProcess)throw new OperationError('Сначала закройте окно Chrome для входа крестиком. Затем нажмите «Готово» — профиль сохранится.');
    if(!this.running)await this.start('headless');
    await this.refresh();await this.captureQueue;
    if(!this.status().loggedIn)throw new OperationError('Сначала завершите вход в Real и откройте обычный интерфейс сайта.');
    for(let i=0;i<40&&!this.lastCapturedAuth&&!this.accountCapture.error;i++){await sleep(250);await this.captureQueue;}
    if(this.accountCapture.error)throw new OperationError(this.accountCapture.error);
    if(!this.lastCapturedAuth)throw new OperationError('Real открыт, но аккаунт ещё не сохранён. Подождите загрузки и нажмите «Готово» снова.');
    this.addingAccounts=false;await this.preference(true);return this.requestVisibility(false);
  }
  async showWindow(){
    if(!this.running||this.mode!=='visible')return;
    // Puppeteer's Windows launcher uses windowsHide:true even for headful Chrome.
    // Explicit user-requested visible mode must restore its own window and tab.
    const session=await this.page.createCDPSession();
    try{
      const {windowId}=await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
      await session.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
      await session.send('Browser.setWindowBounds',{windowId,bounds:{left:50,top:50,width:1440,height:1000}});
      await this.page.bringToFront();
    }catch{throw new OperationError('Не удалось показать окно служебного Chrome. Остановите браузер и запустите видимый режим заново.');}
    finally{await session.detach().catch(()=>{});}
  }
  async close(){
    if(this.manualProcess)throw new OperationError('Закройте обычное окно входа Chrome вручную.');
    clearInterval(this.timer);this.timer=null;
    await this.captureQueue;
    const browser=this.browser;
    if(browser){
      // Only close this app's browser. Never taskkill all Chrome/Helium processes.
      try{await bounded(browser.close(),15000);}catch{throw new OperationError('Служебный Chrome не завершился. Закройте его окно вручную; новый экземпляр не запущен.');}
    }
    this.browser=null;this.page=null;this.realm=null;this.lastReady=null;this.mode=null;this.attempted.clear();await this.captureQueue;
  }
  async stop(){if(this.polling||this.activeCommand||this.starting)throw new OperationError('Дождитесь завершения текущей операции.');await this.preference(false);await this.close();this.addingAccounts=false;this.lastError=null;return this.status();}
  async refresh(){
    if(!this.running)return this.status();
    try{this.lastReady=await bounded(this.realm.message({type:'READY'}),3000);if(this.lastReady?.version!==this.version)throw new OperationError('Адаптер браузера устарел. Перезапустите служебный браузер.');
      this.lastError=this.lastReady.requiresAttention?'Real требует входа или ручной проверки. Нажмите «Открыть окно для входа».':this.lastReady.ready?null:'Real загружается или интерфейс не распознан.';
      await this.api('heartbeat',{});
    }catch(error){this.lastReady=null;this.lastError=error instanceof OperationError?error.message:'Real пока не готов. Откройте окно для входа или повторите проверку.';}
    return this.status();
  }
  async waitReady(attempts=16){
    for(let i=0;i<attempts;i++){
      let status;try{status=await bounded(this.realm.message({type:'READY'}),1000);}catch{}
      if(status){this.lastReady=status;
        if(status.version!==this.version||status.requiresAttention)throw Object.assign(new OperationError('Real требует входа / ручной проверки. Откройте служебное окно.'),{requiresAttention:true});
        if(status.active)throw new OperationError('Real ещё выполняет предыдущее действие.');
        if(status.ready)return true;
      }
      if(i<attempts-1)await sleep(500);
    }return false;
  }
  async execute(command){
    if(this.attempted.has(command.id))return {ok:false,uncertain:['open','list'].includes(command.action),message:'Команда уже выполнялась; повторная отправка запрещена.'};
    if(command.expiresAt<=Date.now())return {ok:false,message:'Команда устарела до отправки.'};
    let delivered=false;
    this.activeCommand=command;this.realm.inflight=command;
    try{
      if(['reset','prepare-account'].includes(command.action)){
        if(command.action==='reset'&&command.generalRecovery!==true&&command.accountRecovery!==true)throw new OperationError('Восстановление разрешено только для задачи аккаунта.');
        this.attempted.add(command.id);
        const reset=command.action==='reset';
        if(reset){await this.page.reload({waitUntil:'domcontentloaded'});if(!await this.waitReady())throw new OperationError('Real не загрузился после обновления.');}
        if(command.accountId){
          const prepare=await this.realm.message({type:'EXECUTE',command:{...command,id:command.id+'-prepare',action:'prepare-account'}});
          if(!prepare?.ok||prepare.snapshot?.accountId!==command.accountId)throw Object.assign(new OperationError(prepare?.message||'Не подтверждён выбранный аккаунт.'),{requiresAttention:!!prepare?.requiresAttention});
          if(!reset||prepare.snapshot.switched){await this.page.reload({waitUntil:'domcontentloaded'});if(!await this.waitReady())throw new OperationError('Real не загрузился после смены аккаунта.');}
          const verified=await this.realm.message({type:'EXECUTE',command:{...command,id:command.id+'-verify',action:'verify-account'}});
          if(!verified?.ok||verified.snapshot?.accountId!==command.accountId)throw new OperationError(verified?.message||'Аккаунт после обновления не подтверждён.');
        }
        return {ok:true,snapshot:{reset:true,prepared:true,accountId:command.accountId}};
      }
      if(!await this.waitReady(6)){
        if(command.action==='list')throw new OperationError('Сводка не готова. Обновление перед Quick list запрещено.');
        await this.page.reload({waitUntil:'domcontentloaded'});if(!await this.waitReady())throw new OperationError('Real не готов после обновления. Покупка не отправлена.');
      }
      if(command.expiresAt<=Date.now())throw new OperationError('Команда устарела до отправки.');
      this.attempted.add(command.id);if(this.attempted.size>1000)this.attempted.delete(this.attempted.values().next().value);delivered=true;
      let result=await bounded(this.realm.message({type:'EXECUTE',command}),120000);
      if(result?.recoverable===true&&result.uncertain===false&&['open','check'].includes(command.action)&&Date.now()<command.expiresAt){
        delivered=false;await this.page.reload({waitUntil:'domcontentloaded'});if(!await this.waitReady())throw new OperationError('Real не загрузился после восстановления.');
        delivered=true;result=await bounded(this.realm.message({type:'EXECUTE',command}),120000);result={...result,recoveryAttempted:true};
      }return result;
    }catch(error){return {ok:false,uncertain:delivered&&['open','list'].includes(command.action),requiresAttention:Boolean(error.requiresAttention),message:error instanceof OperationError?error.message:delivered?'Служебная вкладка не ответила. Результат неизвестен.':'Страница Real не готова; действие не отправлено.'};}
    finally{this.activeCommand=null;this.realm.inflight=null;}
  }
  async diagnostics(){
    if(!this.running)throw new OperationError('Запустите служебный браузер перед экспортом диагностики.');
    let ready;try{ready=await bounded(this.realm.message({type:'READY'}),3000);}catch{}
    if(!ready?.ready||ready.requiresAttention)return {page:{omitted:'Вход / неподтверждённый интерфейс: снимок страницы не сохраняется.'},network:this.network.slice(-100),png:null};
    const page=await bounded(this.realm.message({type:'DIAGNOSTIC'}),5000);
    const snapshot=await bounded(this.realm.message({type:'SNAPSHOT'}),5000);
    page.quickListOptions=snapshot?.quickListOptions||null;page.lastAction=snapshot?.lastAction||null;
    let png=null;
    if(!page.sensitiveFieldsVisible){
      png=await this.page.screenshot({type:'png',fullPage:false});
      const after=await bounded(this.realm.message({type:'DIAGNOSTIC'}),5000);
      if(after.sensitiveFieldsVisible||after.url!==page.url)png=null;
    }
    return {page,network:this.network.slice(-100),png};
  }
  async requestVisibility(visible,defer=false){
    if(typeof visible!=='boolean')throw new OperationError('Неверное состояние видимости.');
    this.preferredMode=visible?'visible':'headless';await this.preference(this.autoStart);
    if(!this.running){this.requestedMode=null;return this.status();}
    this.requestedMode=this.mode===this.preferredMode?null:this.preferredMode;
    if(!defer)await this.applyVisibility();return this.status();
  }
  async applyVisibility(){
    if(!this.requestedMode)return;
    this.switching=true;
    try{
      await this.api('wake-receiver',{});
      while(this.polling)await sleep(50);
      const mode=this.requestedMode;await this.start(mode,{persist:false});this.requestedMode=null;
    }finally{this.switching=false;}
  }
  wake(){if(this.switching)return;if(this.polling){this.wakePending=true;return;}if(this.running)this.poll().catch(()=>{});}
  async poll(){
    if(this.polling||!this.running)return;this.polling=true;
    try{
      if(this.report){await this.api('result',this.report);this.report=null;}
      while(this.running&&!this.switching){
        const {command,busy,stopping}=await this.api('next',{waitMs:20000});
        if(stopping)break;if(!command){if(busy)continue;break;}
        const result=await this.execute(command);this.report={commandId:command.id,result};await this.api('result',this.report);this.report=null;
      }
    }catch{this.lastError='Нет связи с очередью. Проверьте журнал перед повторным запуском.';}
    finally{this.polling=false;if(this.wakePending){this.wakePending=false;this.wake();}}
  }
}
