import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {OperationError,realRequest} from './core.mjs';
import {browserAccount,browserSessionHeaders} from './browser-accounts.mjs';
import {networkRecord} from './diagnostics.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function nativeArguments(profile,origin){
  const url=new URL(origin);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw new Error('Loopback only');
  return ['--user-data-dir='+profile,'--new-window','--no-first-run','--no-default-browser-check','https://realsports.io/',origin+'/?native-bridge=1'];
}
export class NativeBrowser {
  constructor({root,version,origin='http://127.0.0.1:5127',onAccount,notify=()=>{},spawnChrome=spawn,detect,readProfile=headers=>realRequest({headers},'GET','/user')}){
    Object.assign(this,{root,version,origin,onAccount,notify,spawnChrome,readProfile});
    this.detect=detect||(async()=>{for(const base of [process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA].filter(Boolean)){const candidate=path.join(base,'Google','Chrome','Application','chrome.exe');try{await fs.access(candidate);return candidate;}catch{}}throw new OperationError('Установите Google Chrome.');});
    this.profile=path.join(root,'data','browser-profile');this.preferenceFile=path.join(root,'data','browser.json');this.extensionPath=path.join(root,'chrome-extension');
    this.driver='native';this.mode='visible';this.preferredMode='visible';this.autoStart=false;this.available=false;this.starting=false;this.polling=false;this.switching=false;this.requestedMode=null;this.windowOpen=false;this.lastSeen=0;this.extensionOrigin=null;this.tabId=null;this.snapshot=null;this.lastError=null;this.addingAccounts=false;this.closeWanted=false;this.captureQueue=Promise.resolve();this.lastCapturedAuth=null;this.accountCapture={count:0,lastName:null,lastAt:null,error:null};this.network=[];
  }
  get connected(){return Boolean(this.extensionOrigin&&this.lastSeen&&Date.now()-this.lastSeen<45000);}
  get running(){return Boolean(this.windowOpen&&(!this.lastSeen||this.connected));}
  status(){return {driver:'native',available:this.available,running:this.running,connected:this.connected,loggedIn:Boolean(this.connected&&this.snapshot?.loggedIn&&!this.snapshot?.requiresAttention),requiresAttention:Boolean(this.snapshot?.requiresAttention),starting:this.starting,mode:'visible',visible:true,autoStart:this.autoStart,active:false,pendingVisibility:false,manualLogin:this.addingAccounts,addingAccounts:this.addingAccounts,extensionRequired:!this.connected,extensionPath:this.extensionPath,error:this.lastError,accountCapture:{...this.accountCapture}};}
  async initialize(){
    try{await this.detect();this.available=true;}catch{}
    try{const pref=JSON.parse(await fs.readFile(this.preferenceFile,'utf8'));this.autoStart=pref.autoStart===true;}catch(error){if(error.code!=='ENOENT')this.lastError='Не удалось прочитать настройки браузера.';}
    await fs.mkdir(this.extensionPath,{recursive:true});
    const template=path.join(this.root,'native-extension');
    const manifest=JSON.parse(await fs.readFile(path.join(template,'manifest.json'),'utf8'));
    manifest.version=this.version;manifest.host_permissions=manifest.host_permissions.map(host=>host.startsWith('http://127.0.0.1:')?this.origin+'/*':host);manifest.content_scripts[0].matches=[this.origin+'/*'];
    await fs.writeFile(path.join(this.extensionPath,'manifest.json'),JSON.stringify(manifest,null,2));
    for(const file of ['background.js','panel.js'])await fs.writeFile(path.join(this.extensionPath,file),(await fs.readFile(path.join(template,file),'utf8')).replaceAll('http://127.0.0.1:5127',this.origin));
    // Shared, project-owned DOM adapters. No website code or credentials copied.
    for(const file of ['navigation.js','pack-listing.js','workflow.js','real.js'])await fs.copyFile(path.join(this.root,'helium-extension',file),path.join(this.extensionPath,file));
  }
  async preference(autoStart){await fs.mkdir(path.dirname(this.preferenceFile),{recursive:true});await fs.writeFile(this.preferenceFile+'.tmp',JSON.stringify({autoStart,visible:true,driver:'native'}));await fs.rename(this.preferenceFile+'.tmp',this.preferenceFile);this.autoStart=autoStart;}
  async start(_mode='visible',{persist=true}={}){
    if(this.starting)throw new OperationError('Дождитесь открытия Chrome.');
    if(this.connected)return this.status();
    this.starting=true;
    try{
      if(!this.running){const executable=await this.detect();await fs.mkdir(this.profile,{recursive:true});this.windowOpen=true;
        const child=this.spawnChrome(executable,nativeArguments(this.profile,this.origin),{windowsHide:false,stdio:'ignore'});
        child.once('exit',()=>{if(!this.connected)this.windowOpen=false;});
        await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref?.();
      }
      this.lastError='Один раз загрузите расширение из папки chrome-extension в этом Chrome и обновите вкладку локальной панели.';
      if(persist)await this.preference(true);return this.status();
    }catch(error){this.windowOpen=false;throw error instanceof OperationError?error:new OperationError('Не удалось открыть обычный Chrome.');}
    finally{this.starting=false;}
  }
  acceptHello(extensionOrigin,{tabId,version}){
    if(!this.windowOpen||!/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin||'')||!Number.isInteger(tabId)||version!==this.version)throw new OperationError('Подключите новое расширение Chrome в служебном профиле.');
    if(this.extensionOrigin&&this.extensionOrigin!==extensionOrigin)throw new OperationError('Другой экземпляр расширения уже подключён.');
    this.extensionOrigin=extensionOrigin;this.tabId=tabId;this.lastSeen=Date.now();this.lastError=null;
  }
  trusted(extensionOrigin){return Boolean(this.extensionOrigin&&this.extensionOrigin===extensionOrigin);}
  heartbeat(){this.lastSeen=Date.now();}
  receiveSnapshot(snapshot){if(snapshot?.version!==this.version||!/^https:\/\/(www\.)?realsports\.io\//.test(snapshot.url||''))throw new OperationError('Неверный снимок Real.');this.snapshot=snapshot;this.heartbeat();}
  async observeSession(headers){
    const safe=browserSessionHeaders(headers);if(!safe)throw new OperationError('Нет подтверждённой сессии.');
    if(safe['real-auth-info']===this.lastCapturedAuth)return;
    this.captureQueue=this.captureQueue.catch(()=>{}).then(async()=>{
      if(safe['real-auth-info']===this.lastCapturedAuth)return;
      const data=await this.readProfile(safe),account=browserAccount({url:'https://web.realapp.com/user',method:'GET',status:200,headers:safe,user:data?.user});
      if(!account)throw new OperationError('Real не подтвердил аккаунт.');await this.onAccount(account);this.lastCapturedAuth=safe['real-auth-info'];this.accountCapture={count:this.accountCapture.count+1,lastName:account.name,lastAt:account.lastSessionAt,error:null};
    });
    try{await this.captureQueue;}catch{this.accountCapture.error='Не удалось проверить / сохранить сессию. Обновите Real и повторите «Готово».';throw new OperationError(this.accountCapture.error);}
  }
  recordNetwork(record){const safe=networkRecord(record?.url,record?.method,record?.status,'xhr');if(safe){this.network.push(safe);this.network=this.network.slice(-200);}}
  async waitReady(){if(!this.connected)throw new OperationError('Сначала установите расширение Chrome и дождитесь подключения в панели.');if(this.snapshot?.requiresAttention)throw Object.assign(new OperationError('Завершите ручную проверку в обычном Chrome.'),{requiresAttention:true});return Boolean(this.snapshot?.loggedIn);}
  async refresh(){return this.status();}
  async addAccounts(){this.addingAccounts=true;await this.start();return this.status();}
  async finishAccounts(){await this.captureQueue;if(!this.status().loggedIn||!this.lastCapturedAuth)throw new OperationError('Войдите в Real, обновите вкладку и дождитесь подтверждённого имени аккаунта. Окно закрывать не нужно.');this.addingAccounts=false;await this.preference(true);return this.status();}
  async close(){
    if(!this.running)return;
    if(!this.connected)throw new OperationError('Расширение не подключено. Закройте служебное окно Chrome вручную.');
    this.closeWanted=true;this.notify();
    for(let i=0;i<80&&this.closeWanted;i++)await pause(100);
    if(this.closeWanted){this.closeWanted=false;throw new OperationError('Chrome не подтвердил закрытие. Закройте его окно вручную.');}
  }
  closed(){this.windowOpen=false;this.lastSeen=0;this.snapshot=null;this.closeWanted=false;this.tabId=null;this.lastCapturedAuth=null;}
  async stop(){await this.close();await this.preference(false);this.addingAccounts=false;return this.status();}
  async applyVisibility(){}
  async requestVisibility(visible){if(!visible)throw new OperationError('Real работает только в видимом Chrome.');return this.status();}
  wake(){this.notify();}
  async diagnostics(){if(!this.connected)throw new OperationError('Подключите расширение Chrome.');return {page:this.status().loggedIn?this.snapshot:{omitted:'Экран входа / проверки не экспортируется.'},network:this.network,png:null};}
}
