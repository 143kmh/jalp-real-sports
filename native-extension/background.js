const ORIGIN='http://127.0.0.1:5127';
// The application renders this template for its exact loopback port.
let polling=false;
let executingCommand=null, nativeAttention=null;
const observedHeaders=new Map();
let wakePending=false;
async function api(path,body){
  const {token}=await chrome.storage.session.get('token');
  if(!token)throw new Error('Сначала подключите Chrome в панели.');
  const response=await fetch(`${ORIGIN}/api/browser/${path}`,{method:'POST',headers:{'content-type':'application/json','x-local-token':token},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'Нет связи с панелью.'),{requiresAttention:Boolean(result.requiresAttention)});return result;
}
async function realTab(){
  const {realTabId}=await chrome.storage.session.get('realTabId');
  if(realTabId){try{const tab=await chrome.tabs.get(realTabId);if(/^https:\/\/(www\.)?realsports\.io\//.test(tab.url||''))return tab;}catch{}}
  const matches=await chrome.tabs.query({url:['https://realsports.io/*','https://www.realsports.io/*']});
  if(matches.length>1)throw new Error('Оставьте только одну вкладку Real в служебном Chrome.');
  const tab=matches[0]||await chrome.tabs.create({url:'https://realsports.io/',active:true});
  await chrome.storage.session.set({realTabId:tab.id});return tab;
}
async function messageReal(tabId,message){
  // EXECUTE is NEVER retried: losing the reply may mean a purchase already happened.
  if(message.type==='EXECUTE')return timedMessage(tabId,message,120000);
  for(let i=0;i<80;i++){
    try{return await timedMessage(tabId,message,1000);}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('Вкладка Real не загрузилась. Откройте её в Chrome и завершите вход/проверку.');
}
async function timedMessage(tabId,message,timeout){
  let timer;
  try{return await Promise.race([chrome.tabs.sendMessage(tabId,message),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Ответ вкладки потерян.')),timeout);})]);}
  finally{clearTimeout(timer);}
}
async function waitReady(tabId,attempts=24){
  for(let i=0;i<attempts;i++){
    let status;
    try{status=await timedMessage(tabId,{type:'READY'},1000);}catch{}
    if(status){
      if(status.version!==chrome.runtime.getManifest().version)throw Object.assign(new Error('Обновите вкладку Real после перезагрузки расширения.'),{requiresAttention:true});
      if(status.requiresAttention)throw Object.assign(new Error('Real требует входа или ручной проверки. Выполните её в браузере.'),{requiresAttention:true});
      if(status.active)throw new Error('Вкладка Real уже выполняет действие. Дождитесь результата; обновлять её небезопасно.');
      if(status.ready)return true;
    }
    if(i<attempts-1)await new Promise(resolve=>setTimeout(resolve,500));
  }
  return false;
}
async function ensureReady(tabId,allowReload=true){
  if(await waitReady(tabId,6))return;
  if(!allowReload)throw new Error('Вкладка со сводкой пака не готова. Обновление перед Quick list запрещено: проверьте Real.');
  // No EXECUTE has been delivered: refreshing here cannot repeat a purchase.
  await chrome.tabs.reload(tabId);
  if(!await waitReady(tabId))throw new Error('Real не готов после обновления страницы. Проверьте вход и загрузку сайта; покупка не отправлена.');
}
async function connect(token){
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new Error('Обновите панель Real Manager.');
  await chrome.storage.session.set({token});
  const tab=await realTab();
  const snapshot={...await messageReal(tab.id,{type:'SNAPSHOT'}),requiresAttention:(await messageReal(tab.id,{type:'READY'})).requiresAttention};
  if(snapshot.version!==chrome.runtime.getManifest().version)throw new Error('Обновите вкладку Real в Chrome после перезагрузки расширения и подключите заново.');
  await api('hello',{native:true,tabId:tab.id,version:chrome.runtime.getManifest().version});
  await api('snapshot',{snapshot});
  await chrome.alarms.create('real-manager-poll',{periodInMinutes:0.5});
  poll();return {ok:true,tabId:tab.id,loggedIn:snapshot.loggedIn,version:snapshot.version};
}
async function poll(){
  if(polling){wakePending=true;return;}polling=true;
  // A cheap extension API call keeps the worker alive during a long background DOM action.
  const keepAlive=setInterval(()=>{chrome.storage.session.get('realTabId').catch(()=>{});api('heartbeat',{}).catch(()=>{});},20000);
  try{
    await api('heartbeat',{});
    const initialTab=await realTab();try{await api('snapshot',{snapshot:{...await messageReal(initialTab.id,{type:'SNAPSHOT'}),requiresAttention:(await messageReal(initialTab.id,{type:'READY'})).requiresAttention}});}catch{}
    const {reports=[]}=await chrome.storage.session.get('reports');
    for(const report of reports)await api('result',report);
    await chrome.storage.session.set({reports:[]});
    while(true){
      const {command,busy,stopping}=await api('next',{waitMs:20000});
      if(stopping){await new Promise(resolve=>setTimeout(resolve,500));continue;}
      if(!command){try{await api('snapshot',{snapshot:{...await messageReal((await realTab()).id,{type:'SNAPSHOT'}),requiresAttention:(await messageReal((await realTab()).id,{type:'READY'})).requiresAttention}});}catch{}continue;}
      if(command.action==='native-close'){
        const {realTabId}=await chrome.storage.session.get('realTabId');
        let keeper;
        try{
          if(realTabId){const tab=await chrome.tabs.get(realTabId);keeper=await chrome.tabs.create({windowId:tab.windowId,url:'about:blank',active:false});await chrome.tabs.remove(realTabId);}
          await api('native-closed',{});await chrome.storage.session.set({token:null,realTabId:null});
        }finally{if(keeper)await chrome.tabs.remove(keeper.id);}
        break;
      }
      const tab=await realTab();
      let result;
      let delivered=false;executingCommand=command;nativeAttention=null;
      const previousDiscardable=tab.autoDiscardable;
      const {attempted=[]}=await chrome.storage.session.get('attempted');
      if(attempted.includes(command.id))result={ok:false,uncertain:['open','list','boost'].includes(command.action),message:'Команда уже выполнялась. Проверьте результат в Real.'};
      else try{
        if(!['reset','prepare-account'].includes(command.action))await ensureReady(tab.id,command.action!=='list');
        if(command.expiresAt<=Date.now())throw new Error('Команда устарела; действие не отправлено.');
        await chrome.tabs.update(tab.id,{autoDiscardable:false});
        await chrome.storage.session.set({attempted:[...attempted,command.id].slice(-200)});
        delivered=true;
        if(['reset','prepare-account'].includes(command.action)){
          const reset=command.action==='reset';
          if(reset&&command.generalRecovery!==true&&command.accountRecovery!==true)throw new Error('Обновление не относится к задаче аккаунта.');
          if(reset){await chrome.tabs.reload(tab.id);if(!await waitReady(tab.id))throw new Error('Real не загрузился после обновления.');}
          if(command.accountId){
            const prepared=await messageReal(tab.id,{type:'EXECUTE',command:{...command,id:command.id+'-prepare',action:'prepare-account'}});
            if(!prepared?.ok||prepared.snapshot?.accountId!==command.accountId)throw Object.assign(new Error(prepared?.message||'Аккаунт не подтверждён.'),{requiresAttention:Boolean(prepared?.requiresAttention)});
            if(!reset||prepared.snapshot.switched){await chrome.tabs.reload(tab.id);if(!await waitReady(tab.id))throw new Error('Real не загрузился после смены аккаунта.');}
            const verified=await messageReal(tab.id,{type:'EXECUTE',command:{...command,id:command.id+'-verify',action:'verify-account'}});
            if(!verified?.ok||verified.snapshot?.accountId!==command.accountId)throw new Error('Аккаунт после обновления не подтверждён.');
          }
          result={ok:true,snapshot:{reset:true,prepared:true,accountId:command.accountId}};
        }else result=await messageReal(tab.id,{type:'EXECUTE',command});
        // The content script explicitly certifies a navigation timeout BEFORE activation.
        // Never recover a lost EXECUTE reply or refresh a pack summary for listing.
        if(!nativeAttention&&result?.recoverable===true&&result.uncertain===false&&['open','check'].includes(command.action)&&Date.now()<command.expiresAt){
          delivered=false;
          await chrome.tabs.reload(tab.id);
          if(!await waitReady(tab.id))throw new Error('Не удалось восстановить страницу Real.');
          delivered=true;
          result=await messageReal(tab.id,{type:'EXECUTE',command});
          result={...result,recoveryAttempted:true};
        }
      }
      catch(error){result={ok:false,uncertain:delivered&&['open','list','boost'].includes(command.action),requiresAttention:Boolean(error.requiresAttention),message:delivered&&['open','list','boost'].includes(command.action)?'Вкладка не ответила. Результат действия неизвестен.':error.message||'Real не готов.'};}
      finally{if(nativeAttention)result={...result,ok:false,requiresAttention:true,message:nativeAttention};executingCommand=null;if(previousDiscardable!==undefined)try{await chrome.tabs.update(tab.id,{autoDiscardable:previousDiscardable});}catch{}}
      await chrome.storage.session.set({reports:[{commandId:command.id,result}]});
      await api('result',{commandId:command.id,result});
      await chrome.storage.session.set({reports:[]});
      try{await api('snapshot',{snapshot:{...await messageReal(tab.id,{type:'SNAPSHOT'}),requiresAttention:(await messageReal(tab.id,{type:'READY'})).requiresAttention}});}catch{/* Diagnostics must not retry the action. */}
    }
  }catch{/* No automatic purchase retries after transport errors. */}
  finally{clearInterval(keepAlive);polling=false;if(wakePending){wakePending=false;poll();}}
}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='real-manager-poll'){api('heartbeat',{}).catch(()=>{});poll();}});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(['AUTHORIZE_PURCHASE','AUTHORIZE_LISTING','AUTHORIZE_BOOSTER'].includes(message.type)){
    (async()=>{
      const {realTabId}=await chrome.storage.session.get('realTabId');
      if(sender.id!==chrome.runtime.id||sender.tab?.id!==realTabId||!/^https:\/\/(www\.)?realsports\.io\//.test(sender.url||''))throw new Error('Неизвестная вкладка Real.');
      return api(message.type==='AUTHORIZE_LISTING'?'authorize-listing':message.type==='AUTHORIZE_BOOSTER'?'authorize-booster':'authorize',{commandId:message.commandId});
    })().then(respond,e=>respond({ok:false,error:e.message,requiresAttention:Boolean(e.requiresAttention)}));return true;
  }
  if(!sender.url?.startsWith(`${ORIGIN}/`))return;
  (async()=>{
    if(message.type==='CONNECT'){const result=await connect(message.token);if(new URL(sender.url).searchParams.get('native-bridge')==='1')await chrome.tabs.remove(sender.tab.id);return result;}
    if(message.type==='WAKE'){poll();return {ok:true};}
    if(message.type==='CHECK')return {ok:true,version:chrome.runtime.getManifest().version};
    return {ok:false};
  })().then(respond,e=>respond({ok:false,error:e.message||'Не удалось подключить браузер.'}));
  return true;
});


chrome.webRequest.onBeforeSendHeaders.addListener(details=>{
  if(details.method!=='GET'||details.type!=='xmlhttprequest')return;
  const headers={};
  for(const h of details.requestHeaders||[]){const key=h.name.toLowerCase();if((/^real-[a-z-]+$/.test(key)&&!['real-request-token','real-turnstile-token'].includes(key))||['authorization','user-agent'].includes(key))headers[key]=h.value;}
  if(!headers['real-auth-info'])return;
  observedHeaders.set(details.requestId,{headers,tabId:details.tabId,at:Date.now()});
  for(const [id,entry] of observedHeaders)if(Date.now()-entry.at>30000)observedHeaders.delete(id);
  if(observedHeaders.size>100)observedHeaders.delete(observedHeaders.keys().next().value);
},{urls:['https://web.realapp.com/*']},['requestHeaders']);
chrome.webRequest.onCompleted.addListener(details=>{
  const observed=observedHeaders.get(details.requestId);observedHeaders.delete(details.requestId);
  (async()=>{
    const {realTabId,token}=await chrome.storage.session.get(['realTabId','token']);
    if(!token||details.tabId!==realTabId||details.type!=='xmlhttprequest')return;
    const url=new URL(details.url);url.search='';
    if(executingCommand&&['POST','PUT'].includes(details.method)&&[401,403].includes(details.statusCode)&&
      (executingCommand.action==='open'&&url.pathname==='/collectingpacks/'+(executingCommand.kind==='player'?'player':'general')||
       executingCommand.action==='list'&&['/quicklist','/quicklist/preview','/cardmarketplacelistings'].includes(url.pathname)||
       executingCommand.action==='boost'&&/^\/userpassboostercards\/\d+\/rarity\/[345]$/.test(url.pathname)))
      nativeAttention='Real отклонил действие ('+details.statusCode+'). Завершите ручную проверку; очередь остановлена.';
    await api('native-network',{record:{url:url.href,method:details.method,status:details.statusCode}});
    if(observed&&details.statusCode===200&&details.method==='GET')await api('native-session',{headers:observed.headers});
  })().catch(()=>{});
},{urls:['https://web.realapp.com/*']});
chrome.webRequest.onErrorOccurred.addListener(details=>observedHeaders.delete(details.requestId),{urls:['https://web.realapp.com/*']});
