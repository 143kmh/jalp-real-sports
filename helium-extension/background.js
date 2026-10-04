const ORIGIN='http://127.0.0.1:5127';
let polling=false;
let wakePending=false;
async function api(path,body){
  const {token}=await chrome.storage.session.get('token');
  if(!token)throw new Error('Сначала подключите Helium в панели.');
  const response=await fetch(`${ORIGIN}/api/browser/${path}`,{method:'POST',headers:{'content-type':'application/json','x-local-token':token},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'Нет связи с панелью.'),{requiresAttention:Boolean(result.requiresAttention)});return result;
}
async function realTab(){
  const {realTabId}=await chrome.storage.session.get('realTabId');
  if(realTabId){try{const tab=await chrome.tabs.get(realTabId);if(/^https:\/\/(www\.)?realsports\.io\//.test(tab.url||''))return tab;}catch{}}
  const tab=await chrome.tabs.create({url:'https://realsports.io/',active:false});
  await chrome.storage.session.set({realTabId:tab.id});return tab;
}
async function messageReal(tabId,message){
  // EXECUTE is NEVER retried: losing the reply may mean a purchase already happened.
  if(message.type==='EXECUTE')return timedMessage(tabId,message,120000);
  for(let i=0;i<80;i++){
    try{return await timedMessage(tabId,message,1000);}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('Вкладка Real не загрузилась. Откройте её в Helium и завершите вход/проверку.');
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
  const snapshot=await messageReal(tab.id,{type:'SNAPSHOT'});
  if(snapshot.version!==chrome.runtime.getManifest().version)throw new Error('Обновите вкладку Real в Helium после перезагрузки расширения и подключите заново.');
  await api('hello',{tabId:tab.id,version:chrome.runtime.getManifest().version});
  await api('snapshot',{snapshot});
  await chrome.alarms.create('real-manager-poll',{periodInMinutes:0.5});
  poll();return {ok:true,tabId:tab.id,loggedIn:snapshot.loggedIn,version:snapshot.version};
}
async function poll(){
  if(polling){wakePending=true;return;}polling=true;
  // A cheap extension API call keeps the worker alive during a long background DOM action.
  const keepAlive=setInterval(()=>chrome.storage.session.get('realTabId').catch(()=>{}),20000);
  try{
    await api('heartbeat',{});
    const {reports=[]}=await chrome.storage.session.get('reports');
    for(const report of reports)await api('result',report);
    await chrome.storage.session.set({reports:[]});
    while(true){
      const {command,busy,stopping}=await api('next',{waitMs:20000});
      if(stopping)break;
      if(!command){if(busy)continue;break;}
      const tab=await realTab();
      let result;
      let delivered=false;
      const previousDiscardable=tab.autoDiscardable;
      const {attempted=[]}=await chrome.storage.session.get('attempted');
      if(attempted.includes(command.id))result={ok:false,uncertain:['open','list'].includes(command.action),message:'Команда уже выполнялась. Проверьте результат в Real.'};
      else try{
        if(command.action!=='reset')await ensureReady(tab.id,command.action!=='list');
        await chrome.tabs.update(tab.id,{autoDiscardable:false});
        await chrome.storage.session.set({attempted:[...attempted,command.id].slice(-200)});
        delivered=true;
        if(command.action==='reset'){
          if(command.generalRecovery!==true)throw new Error('Обновление не относится к очереди General.');
          await chrome.tabs.reload(tab.id);
          if(!await waitReady(tab.id))throw new Error('Real не загрузился после обновления.');
          result={ok:true,snapshot:{reset:true}};
        }else result=await messageReal(tab.id,{type:'EXECUTE',command});
        // The content script explicitly certifies a navigation timeout BEFORE activation.
        // Never recover a lost EXECUTE reply or refresh a pack summary for listing.
        if(result?.recoverable===true&&result.uncertain===false&&['open','check'].includes(command.action)&&Date.now()<command.expiresAt){
          delivered=false;
          await chrome.tabs.reload(tab.id);
          if(!await waitReady(tab.id))throw new Error('Не удалось восстановить страницу Real.');
          delivered=true;
          result=await messageReal(tab.id,{type:'EXECUTE',command});
          result={...result,recoveryAttempted:true};
        }
      }
      catch(error){result={ok:false,uncertain:delivered&&['open','list'].includes(command.action),requiresAttention:Boolean(error.requiresAttention),message:delivered&&['open','list'].includes(command.action)?'Вкладка не ответила. Результат открытия / листинга неизвестен.':error.message||'Real не готов.'};}
      finally{if(previousDiscardable!==undefined)try{await chrome.tabs.update(tab.id,{autoDiscardable:previousDiscardable});}catch{}}
      await chrome.storage.session.set({reports:[{commandId:command.id,result}]});
      await api('result',{commandId:command.id,result});
      await chrome.storage.session.set({reports:[]});
      try{await api('snapshot',{snapshot:await messageReal(tab.id,{type:'SNAPSHOT'})});}catch{/* Diagnostics must not retry the action. */}
    }
  }catch{/* No automatic purchase retries after transport errors. */}
  finally{clearInterval(keepAlive);polling=false;if(wakePending){wakePending=false;poll();}}
}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='real-manager-poll'){api('heartbeat',{}).catch(()=>{});poll();}});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(['AUTHORIZE_PURCHASE','AUTHORIZE_LISTING'].includes(message.type)){
    (async()=>{
      const {realTabId}=await chrome.storage.session.get('realTabId');
      if(sender.id!==chrome.runtime.id||sender.tab?.id!==realTabId||!/^https:\/\/(www\.)?realsports\.io\//.test(sender.url||''))throw new Error('Неизвестная вкладка Real.');
      return api(message.type==='AUTHORIZE_LISTING'?'authorize-listing':'authorize',{commandId:message.commandId});
    })().then(respond,e=>respond({ok:false,error:e.message,requiresAttention:Boolean(e.requiresAttention)}));return true;
  }
  if(!sender.url?.startsWith(`${ORIGIN}/`))return;
  (async()=>{
    if(message.type==='CONNECT')return connect(message.token);
    if(message.type==='WAKE'){poll();return {ok:true};}
    if(message.type==='CHECK')return {ok:true,version:chrome.runtime.getManifest().version};
    return {ok:false};
  })().then(respond,e=>respond({ok:false,error:e.message||'Не удалось подключить браузер.'}));
  return true;
});
