import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { publicAccount, verifyAccount, getPackInfo,getPlayerPackInfo,getOwnedPackPlayers,getOwnedBoosterPlayers, getLeagueCatalog,getPackHistory,searchPlayers,getOwnedUfcFighters,LEAGUES,OperationError } from './core.mjs';
import { Store } from './storage.mjs';
import { CommandNotifier } from './command-notifier.mjs';
import {validateSettings,recoverNewPack,publicCard,preparePackQuickList,runMaximum} from './automation.mjs';
import {visitGeneral,scheduleGeneral,requiresGeneralAttention} from './general-runner.mjs';
import {NativeBrowser as OwnedBrowser} from './native-browser.mjs';
import {diagnosticArchive,scenarioArchive} from './diagnostics.mjs';
import {hasBrowserSession,requireBrowserSession,mergeBrowserAccount} from './browser-accounts.mjs';
import {BOOST_SPORTS,desiredRarity,rarityFallback,statPriority,findConfiguredTarget} from './boosters.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.REAL_MANAGER_PORT || 5127);
const origin = `http://127.0.0.1:${port}`;
const token = crypto.randomBytes(32).toString('hex');
const store = new Store(path.join(root, 'data'));
await store.load();
let busy = false;
let shuttingDown = false;
let worker = Promise.resolve();
const APP_VERSION='0.4.6';
const ownedKey=crypto.randomBytes(32).toString('hex');
const browserState={mode:'owned',lastSeen:0,tabId:null,snapshot:null,version:null};
const ownedBrowser=new OwnedBrowser({root,origin,version:APP_VERSION,notify:()=>commandNotifier.notify(),onAccount:async account=>{
  const previous=store.accounts.get(account.id),backup=previous?{...previous}:null;
  const merged=mergeBrowserAccount(previous,account);store.accounts.set(account.id,merged);
  try{await store.saveAccounts();}catch(error){
    if(previous){for(const key of Object.keys(previous))delete previous[key];Object.assign(previous,backup);}
    else store.accounts.delete(account.id);
    throw error;
  }
},api:async(route,body)=>{
  const response=await fetch(origin+'/api/browser/'+route,{method:'POST',headers:{'content-type':'application/json','x-local-token':token,'x-owned-browser':ownedKey},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw Object.assign(new OperationError(result.error||'Нет связи с сервером.'),{requiresAttention:Boolean(result.requiresAttention)});return result;
}});
await ownedBrowser.initialize();
const browserCommands=new Map();
const commandNotifier=new CommandNotifier();

function rejectBrowserCommand(id,pending,message){
  clearTimeout(pending.timer);clearInterval(pending.watchdog);browserCommands.delete(id);
  const uncertain=Boolean(pending.purchaseStarted||pending.listingStarted||pending.boosterStarted);
  pending.reject(Object.assign(new OperationError(message,uncertain),{
    chargePossible:Boolean(pending.purchaseStarted),
    cancelled:true,
  }));
}
function cancelBrowserCommands(jobId,message='Операция отменена пользователем.'){
  for(const [id,pending] of [...browserCommands]){
    if(pending.command.jobId===jobId)rejectBrowserCommand(id,pending,message);
  }
  commandNotifier.notify();
}
const playerQuotes=new Map();
let scenarioRecorder={active:false,name:null,startedAt:null};
function browserConnected(){return browserState.mode==='owned'?ownedBrowser.status().connected:browserState.version===APP_VERSION&&Date.now()-browserState.lastSeen<90000;}
const isResilientGeneral=job=>['open','max'].includes(job.type)&&job.settings.generalResilience===true;
async function saveJobHistory(){
  try{await store.saveHistory();}catch{throw Object.assign(new OperationError('Не удалось сохранить операции на диск. Покупки остановлены.'),{code:'STORAGE',requiresAttention:true});}
}
async function browserCommand(action,payload={}){
  if(browserState.mode==='owned'&&['open','check','reset','boost-scan','boost'].includes(action))await ownedBrowser.applyVisibility();
  if(!browserConnected())throw Object.assign(new OperationError('Браузер отключён. Запустите служебный Chrome в разделе «Приложение».'),{requiresAttention:true});
  const command={id:crypto.randomUUID(),action,...payload,expiresAt:Date.now()+180000};
  return new Promise((resolve,reject)=>{
    const pending={command,claimed:false,resolve,reject};
    pending.timer=setTimeout(()=>{
      clearInterval(pending.watchdog);browserCommands.delete(command.id);
      reject(Object.assign(new OperationError('Браузер не завершил действие.',Boolean(pending.boosterStarted||pending.claimed&&['open','list'].includes(action))),{chargePossible:Boolean(pending.purchaseStarted)}));
    },180000);
    pending.watchdog=setInterval(()=>{
      if(browserState.mode==='owned'&&!browserConnected()){
        rejectBrowserCommand(command.id,pending,'Служебный Chrome отключился во время действия.');
      }
    },1000);
    browserCommands.set(command.id,pending);
    commandNotifier.notify();
    if(browserState.mode==='owned')ownedBrowser.wake();
  });
}

if(process.argv.includes('--import'))throw new Error('Импорт HAR удалён. Добавляйте аккаунты входом в служебном браузере.');

function snapshot() {
  return {
    accounts: [...store.accounts.values()].map(a => ({ ...publicAccount(a), browserSession:hasBrowserSession(a),purchaseHold: Boolean(a.purchaseHold) })),
    jobs: store.jobs.slice(-40).reverse(), busy, seasons: { nfl: '2026', ufc: '2023' },
    version:APP_VERSION,
    settings:store.settings,leagues:LEAGUES,
    recorder:{...scenarioRecorder},
    browser:{connected:browserConnected(),mode:browserState.mode,tabId:browserState.tabId,loggedIn:browserState.mode==='owned'?ownedBrowser.status().loggedIn:browserState.snapshot?.loggedIn??false,version:browserState.mode==='owned'?APP_VERSION:browserState.version,owned:ownedBrowser.status()},
  };
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let size = 0; const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 60 * 1024 * 1024) throw new Error('Файл слишком большой (максимум 60 МБ).');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

function validateIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !store.accounts.has(id))) {
    throw new Error('Выберите существующие аккаунты без повторений (до 100).');
  }
  for(const id of ids)requireBrowserSession(store.accounts.get(id));
}

async function runBoosterJob(job){
  job.status='running';await saveJobHistory();
  let fatal=false;
  for(const item of job.items){
    if(job.cancelled||shuttingDown){item.status='cancelled';item.message='Очередь остановлена.';continue;}
    item.status='running';item.boosts=[];await saveJobHistory();
    const account=store.accounts.get(item.accountId);
    try{
      await verifyAccount(account);
      if(!account.seasons)await getLeagueCatalog(account);
      const eligible=[],seenPlayers=new Set();
      for(const sport of BOOST_SPORTS){
        if(job.cancelled||shuttingDown||eligible.length>=job.limit)break;
        if(!account.seasons?.[sport])continue;
        const configured=job.settings.boosterTargets.filter(t=>t.accountId===account.id&&t.sport===sport);
        if(!job.settings.boosterBoostAll&&!configured.length)continue;
        let scan;
        try{
          scan=await browserCommand('boost-scan',{jobId:job.id,accountId:account.id,accountName:account.name,sport,leagueLabel:LEAGUES[sport]});
        }catch(error){
          if(error.requiresAttention)throw error;
          item.boosts.push({sport,status:'warning',message:'Не удалось прочитать Today\'s players: '+error.message});
          await saveJobHistory();continue;
        }
        if(scan.accountId!==account.id||scan.sport!==sport||!Array.isArray(scan.players))throw new OperationError('Real вернул непроверенный список Today\'s players.');
        for(const player of scan.players){
          if(eligible.length>=job.limit)break;
          const playerKey=sport+':'+String(player.name||'').trim().toLocaleLowerCase();
          if(seenPlayers.has(playerKey))continue;
          const target=findConfiguredTarget(job.settings,account.id,sport,player.name);
          if(!job.settings.boosterBoostAll&&!target)continue;
          seenPlayers.add(playerKey);
          const desired=desiredRarity(target?.desiredRarity,job.settings.boosterUseLegendary);
          eligible.push({...player,sport,desiredRarity:desired,statPriority:statPriority(sport,target?.position||player.position),configured:Boolean(target)});
        }
      }
      if(!eligible.length){item.status='success';item.message='Сегодня не найдено подходящих owned игроков для буста.';item.finishedAt=new Date().toISOString();await saveJobHistory();continue;}
      for(const player of eligible){
        if(job.cancelled||shuttingDown)break;
        const record={sport:player.sport,playerName:player.name,position:player.position||'',mint:player.mint,desiredRarity:player.desiredRarity,status:'running'};item.boosts.push(record);await saveJobHistory();
        try{
          const result=await browserCommand('boost',{jobId:job.id,accountId:account.id,accountName:account.name,sport:player.sport,leagueLabel:LEAGUES[player.sport],playerName:player.name,position:player.position||'',mint:player.mint,rarityFallback:rarityFallback(player.desiredRarity,job.settings.boosterUseLegendary),statPriority:player.statPriority});
          if(result.accountId!==account.id||result.sport!==player.sport||result.playerName!==player.name||Number(result.mint)!==Number(player.mint))throw new OperationError('Real не подтвердил игрока после применения бустера.',true);
          if(result.applied){
            record.status='success';record.rarity=result.rarity;record.rarityLabel=result.rarityLabel;record.boosterText=result.boosterText;record.message=`${result.rarityLabel}: ${result.boosterText}`;
          }else{
            record.status='skipped';record.message=result.reason||'Подходящий бустер не найден.';
          }
        }catch(error){
          record.status=error.uncertain?'uncertain':'error';record.message=error.message;
          if(error.requiresAttention){fatal=true;job.cancelled=true;job.message=error.message;}
        }
        record.finishedAt=new Date().toISOString();await saveJobHistory();
        if(fatal)break;
      }
      if(job.cancelled&&!fatal){item.status='cancelled';item.message='Остановлено пользователем.';}
      else if(fatal){item.status='error';item.message=job.message;}
      else{
        const applied=item.boosts.filter(r=>r.status==='success').length,skipped=item.boosts.filter(r=>r.status==='skipped').length,problems=item.boosts.filter(r=>['error','uncertain','warning'].includes(r.status)).length;
        item.status=problems?'warning':'success';item.message=`Применено ${applied} бустеров; пропущено ${skipped}; проблем ${problems}. Обработано до ${job.limit} игроков.`;
      }
    }catch(error){
      item.status=error.uncertain?'uncertain':'error';item.message=error instanceof OperationError?error.message:'Не удалось выполнить бустеры.';
      if(error.requiresAttention){fatal=true;job.cancelled=true;job.message=item.message;}
    }
    item.finishedAt=new Date().toISOString();
    try{await store.saveHistory();await store.saveAccounts();}catch{fatal=true;job.cancelled=true;job.message='Не удалось сохранить результат бустеров на диск.';}
    if(fatal)break;
  }
  for(const item of job.items)if(['queued','running'].includes(item.status)){item.status='cancelled';item.message='Очередь остановлена.';}
  job.status=fatal?'error':job.cancelled?'cancelled':'done';job.finishedAt=new Date().toISOString();await saveJobHistory();
}

async function runJob(job) {
  job.status = 'running'; await store.saveHistory();
  if(job.type==='boosters')return runBoosterJob(job);
  if(isResilientGeneral(job))return runResilientGeneral(job);
  let fatal = false;
  for (const item of job.items) {
    if (job.cancelled || shuttingDown) { item.status = 'cancelled'; item.message = 'Отменено до отправки запроса.'; continue; }
    item.status = 'running'; await store.saveHistory();
    const account = store.accounts.get(item.accountId);
    try {
      if (job.type === 'refresh') {
        await verifyAccount(account);
        await getLeagueCatalog(account);
        for (const sport of new Set(['nfl','ufc',...store.settings.priority])) {
          if(!account.seasons[sport]){account.packs[sport]={cost:null,disabled:'Нет доступного сезона'};continue;}
          await getPackInfo(account, sport);
        }
        item.message = 'Профиль и цены обновлены.';
      } else if(job.type==='player'||job.type==='player-check'){
        if(account.purchaseHold)throw new OperationError('Проверьте предыдущую покупку в Real.');
        item.packs=[];
        for(let i=0;i<item.count;i++){
          if(job.cancelled||shuttingDown)break;
          await verifyAccount(account);
          const info=await getPlayerPackInfo(account,job.sport,item.playerId);
          if(info.disabled){item.message=`Открыто ${item.packs.length} из ${item.count}. ${info.disabled}`;break;}
          if(info.cost!==item.cost)throw new OperationError('Цена Player Pack изменилась. Покупка остановлена.');
          if(job.type==='player-check'){
            const r=await browserCommand('check',{jobId:job.id,accountId:account.id,accountName:account.name,sport:job.sport,kind:'player',playerId:item.playerId,playerName:info.playerName,season:info.season,leagueLabel:LEAGUES[job.sport],cost:info.cost,packImage:info.packImage,description:info.description,activateLabel:info.activateLabel,openLabel:info.openLabel});
            if(!r.checked||r.accountId!==account.id||r.playerId!==item.playerId||r.cost!==info.cost)throw new OperationError('Переход к Player Pack не подтверждён.');
            item.message=`${item.playerName}: переход и цена проверены. Пак не активирован и не куплен.`;break;
          }else await openOne(job,item,account,job.sport,item.cost,info);
        }
        item.message??=`${item.playerName}: открыто ${item.packs.length} из ${item.count} Player packs. Все карты оставлены.`;
      } else if(job.type==='max'){
        if(account.purchaseHold)throw new OperationError('Проверьте предыдущую покупку / листинг в Real.');
        await verifyAccount(account);
        item.packs=[];
        const result=await runMaximum({priority:job.settings.priority,budget:item.budget,maxPacks:job.settings.maxPacks},{
          info:sport=>getPackInfo(account,sport),balance:async()=>account.balance,
          open:(sport,cost)=>openOne(job,item,account,sport,cost),stopped:()=>job.cancelled||shuttingDown,
        });
        item.spent=result.spent;
        item.message=`Открыто ${result.count} паков; потрачено ${result.spent} из бюджета ${item.budget} Rax.${result.limitReached?' Достигнут заданный лимит паков.':''}`;
      } else {
        if (account.purchaseHold) throw new OperationError('Есть покупка с неизвестным результатом. Сначала проверьте её в Real.');
        await verifyAccount(account);
        const info=await getPackInfo(account,job.sport);
        if(info.disabled||info.cost!==item.cost)throw new OperationError('Цена/доступность изменилась. Обновите аккаунт перед покупкой.');
        if(account.balance===null||account.balance<info.cost)throw new OperationError('Недостаточно баланса или баланс неизвестен.');
        if(!info.packImage||!info.description)throw new OperationError('Не удалось проверить изображение/описание General Pack.');
        if(job.cancelled||shuttingDown)throw new OperationError('Операция отменена до покупки.');
        if(job.type==='check'){
          const result=await browserCommand('check',{jobId:job.id,accountId:account.id,accountName:account.name,sport:job.sport,leagueLabel:LEAGUES[job.sport],cost:item.cost,packImage:info.packImage,description:info.description,activateLabel:info.activateLabel,openLabel:info.openLabel});
          if(!result.checked||result.accountId!==account.id||result.sport!==job.sport||result.cost!==item.cost)throw new OperationError('Не удалось подтвердить проверку интерфейса.');
          item.message=`Аккаунт, ${job.sport.toUpperCase()} General Pack и цена ${item.cost} Rax проверены. Пак не активирован и не куплен.`;
        }else{
          const result=await openOne(job,item,account,job.sport,item.cost,info);
          item.message = `Получено ${result.cardCount} карт / бустеров. Цена покупки ${item.cost} Rax.`;
        }
      }
      item.status = 'success';
    } catch (e) {
      item.status = e.uncertain ? 'uncertain' : 'error';
      item.message = e instanceof OperationError ? e.message : 'Операция остановлена из-за ошибки приложения.';
      account.lastError = item.message;
      if(['player','player-check'].includes(job.type))job.cancelled=true;
      if (e.uncertain) { account.purchaseHold = true; job.cancelled = true; }
      if (job.type === 'refresh') account.status = 'error';
    }
    item.finishedAt = new Date().toISOString();
    // Persist the response before the next account; a failure stops the entire batch.
    try { await store.saveHistory(); await store.saveAccounts(); }
    catch {
      fatal = true; job.cancelled = true;
      job.message = 'Не удалось сохранить результат на диск. Проверьте выполненные операции в Real.';
    }
  }
  job.status = fatal ? 'error' : job.cancelled ? 'cancelled' : 'done';
  job.finishedAt = new Date().toISOString();
  await store.saveHistory();
}

async function runResilientGeneral(job){
  let fatal=false;
  const stopped=()=>job.cancelled||shuttingDown;
  for(const item of job.items){item.packs=[];item.generalProgress={needsReset:true,phase:'В очереди',leagues:Object.fromEntries(job.settings.priority.map(s=>[s,{state:'queued',count:0,unknown:0}]))};}
  try{
    await scheduleGeneral(job.items,{
      stopped,
      visit:async item=>{
        const account=store.accounts.get(item.accountId),progress=item.generalProgress;
        item.status='running';progress.retryAt=null;await saveJobHistory();
        const result=await visitGeneral({
          priority:job.type==='open'?[job.sport]:job.settings.priority,
          budget:item.budget,spendIncoming:true,
          limit:job.type==='open'?1:Infinity
        },progress,{
          stopped,finalCheck:true,
          refresh:async()=>{
            await verifyAccount(account);
            if(!progress.catalogChecked){await getLeagueCatalog(account);progress.catalogChecked=true;}
            return account.balance;
          },
          info:sport=>account.seasons?.[sport]?getPackInfo(account,sport):{cost:0,disabled:'Нет доступного сезона в Real'},
          reset:async()=>{
            if(stopped())return;
            progress.phase='Обновление Real / проверка аккаунта';await saveJobHistory();
            const r=await browserCommand('reset',{jobId:job.id,accountId:account.id,accountName:account.name,generalRecovery:true});
            if(!r.reset)throw new OperationError('Браузер не подтвердил обновление страницы.');
            progress.catalogChecked=false;progress.refreshes=(progress.refreshes||0)+1;progress.phase='Открытие паков';
          },
          confirmUnavailable:async(sport,info)=>{
            const result=await browserCommand('availability',{jobId:job.id,accountId:account.id,accountName:account.name,sport,leagueLabel:LEAGUES[sport],kind:'general',cost:info.cost,packImage:info.packImage,description:info.description,activateLabel:info.activateLabel,unavailableMessage:info.disabled});
            return result.unavailable===true&&result.accountId===account.id&&result.sport===sport;
          },
          open:(sport,cost,info)=>openOne(job,item,account,sport,cost,info),
          save:saveJobHistory,
        });
        const summary=`Подтверждено ${progress.count||0} паков; непроверенных открытий ${progress.unknown||0}. Подтверждённые расходы ${(progress.spent||0)-(progress.reserved||0)} Rax.`;
        item.spent=(progress.spent||0)-(progress.reserved||0);
        if(result.retry){
          item.status='running';progress.retryAt=Date.now()+result.delayMs;item.message=`Восстановление через ${Math.ceil(result.delayMs/1000)} с. ${summary} ${result.message}`;
        }else{
          item.finishedAt=new Date().toISOString();
          item.status=result.cancelled?'cancelled':result.attention?'error':progress.warnings?.length||progress.unknown?'warning':'success';
          item.message=`${summary} ${result.attention?result.message:result.cancelled?'Остановлено пользователем.':result.reason==='limit'?'Достигнуто выбранное количество открытий.':'Доступные General packs в выбранных лигах закончились: лимит Real или недостаточно текущего баланса.'}`;
          if(result.attention){account.lastError=result.message;fatal=true;job.cancelled=true;job.message=result.message;}
        }
        await saveJobHistory();
        try{await store.saveAccounts();}catch{throw Object.assign(new OperationError('Не удалось сохранить аккаунты. Покупки остановлены.'),{code:'STORAGE'});}
        return result;
      }
    });
  }catch(error){
    fatal=true;job.cancelled=true;
    job.message=error instanceof OperationError?error.message:'Ошибка приложения. Очередь General остановлена.';
    for(const item of job.items)if(item.status==='running'){item.status='error';item.message=job.message;}
  }
  for(const item of job.items)if(['queued','running'].includes(item.status)){item.status='cancelled';item.message='Очередь остановлена.';}
  job.status=fatal?'error':job.cancelled?'cancelled':'done';job.finishedAt=new Date().toISOString();
  await saveJobHistory();
}

async function openOne(job,item,account,sport,cost,verifiedInfo){
  const resilient=isResilientGeneral(job);
  if(account.purchaseHold&&!resilient||job.cancelled||shuttingDown)throw new OperationError('Операция остановлена до покупки.');
  if(!verifiedInfo)await verifyAccount(account);
  const isPlayer=job.type==='player',info=verifiedInfo||await getPackInfo(account,sport);
  if(info.disabled||info.cost!==cost||account.balance===null||account.balance<cost||!info.packImage||!info.description)throw new OperationError('Цена, баланс или доступность пака изменились. Покупка остановлена.');
  const needsCards=isPlayer||job.settings.autoList;
  let before=null,historyWarning=null;
  try{if(needsCards)before=await getPackHistory(account,sport);}catch(error){
    if(!resilient||requiresGeneralAttention(error))throw error;
    historyWarning=error.message;
  }
  if(job.cancelled||shuttingDown)throw new OperationError('Операция отменена до покупки.');
  let pack;
  try{pack=await browserCommand('open',{jobId:job.id,accountId:account.id,accountName:account.name,sport,kind:isPlayer?'player':'general',...(isPlayer?{playerId:item.playerId,playerName:info.playerName,season:info.season}:{}),leagueLabel:LEAGUES[sport],cost,packImage:info.packImage,description:info.description,activateLabel:info.activateLabel,openLabel:info.openLabel,keepSummary:!isPlayer&&job.settings.autoList,generalResilience:resilient});}
  catch(error){if(error.uncertain){account.purchaseHold=true;await store.saveAccounts();}throw error;}
  pack.kind=isPlayer?'player':'general';if(isPlayer)pack.playerName=info.playerName;
  item.packs??=[];item.packs.push(pack);if(job.type==='open')item.pack=pack;
  await saveJobHistory(); // Record the confirmed purchase BEFORE any marketplace write.
  if(!needsCards)return pack;
  let listingError=null;
  try{
    if(!before)throw new OperationError(historyWarning||'История нового пака недоступна. Карты оставлены без автолистинга.');
    const recovered=await recoverNewPack(account,sport,before,undefined,{kind:isPlayer?'player':'general',...(resilient?{retryDelays:[250,750,1500],stopped:()=>job.cancelled||shuttingDown}:{})});
    if(isPlayer&&recovered.cards.some(c=>Number(c.playerId??c.primaryPlayer?.id)!==item.playerId))throw new OperationError('Real вернул карты другого игрока. Проверьте пак.');
    pack.id=recovered.id;pack.cards=recovered.cards.map(publicCard);await saveJobHistory();
    if(isPlayer)pack.listings=recovered.cards.map(c=>({cardId:c.id,status:'kept',message:'Player Pack — всегда сохраняется'}));
    if(!isPlayer&&job.settings.autoList&&!job.cancelled&&!shuttingDown){
      if(resilient){item.generalProgress.phase='Quick list · '+sport.toUpperCase();await saveJobHistory();}
      const plan=await preparePackQuickList(account,recovered.id,recovered.cards,job.settings);
      pack.listings=plan.records;await saveJobHistory();
      await browserCommand('list',{jobId:job.id,accountId:account.id,accountName:account.name,sport,parentCommandId:pack.openCommandId,plan});
    }
  }catch(error){
    if(error.code==='STORAGE')throw error;
    pack.listingError=error instanceof OperationError?error.message:'Не удалось сохранить / проверить листинг.';
    if(job.settings.autoList||isPlayer){await saveJobHistory();listingError=error;}
  }
  if(resilient&&listingError){
    if(listingError.code==='STORAGE')throw listingError;
    if(requiresGeneralAttention(listingError)){listingError.confirmedPack=true;throw listingError;}
    item.generalProgress.needsReset=true;
    item.generalProgress.warnings??=[];
    item.generalProgress.warnings.push({at:new Date().toISOString(),message:pack.listingError,phase:'listing',uncertain:Boolean(listingError.uncertain)});
    item.generalProgress.warnings=item.generalProgress.warnings.slice(-40);
    listingError=null;
  }
  if(!resilient)try{await verifyAccount(account);}catch{account.balance=null;account.status='error';if(!listingError)listingError=new OperationError('Пак открыт, но новый баланс не подтверждён. Следующие покупки остановлены.');}
  await saveJobHistory();if(listingError)throw listingError;return pack;
}

async function createJob(body) {
  if(body.type==='open')body={...body,type:'max'};
  if (!['refresh', 'open','check','max','player','player-check','boosters'].includes(body.type)) throw new Error('Неверный тип задачи.');
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw new Error('Неверный идентификатор операции.');
  const existing = store.jobs.find(j => j.requestId === body.requestId);
  if (existing) return existing;
  if (busy||ownedBrowser.starting) throw new Error('Дождитесь окончания текущей задачи или запуска браузера.');
  if (scenarioRecorder.active) throw new Error('Сначала завершите запись сценария.');
  validateIds(body.accountIds);
  // Starting any job opens the owned Real window if it was closed/stopped.
  browserState.mode='owned';
  if(!ownedBrowser.running){
    busy=true;
    try{await ownedBrowser.start('visible');if(!await ownedBrowser.waitReady())throw new OperationError('Real ещё загружается. Дождитесь интерфейса в открытом окне и запустите задачу снова.');}
    finally{busy=false;}
  }
  if(body.type==='player'||body.type==='player-check'){
    const quote=playerQuotes.get(body.quoteId);
    if(!quote||quote.expiresAt<Date.now()||body.accountIds.length!==1||body.accountIds[0]!==quote.accountId||body.sport!==quote.sport||JSON.stringify(store.settings.playerPacks.filter(p=>p.accountId===quote.accountId&&p.sport===quote.sport))!==quote.selection)throw new OperationError('Проверьте цены Player packs заново после сохранения выбора.');
    if(quote.targets.reduce((n,p)=>n+p.count,0)>store.settings.maxPacks)throw new OperationError('Player packs превышают текущий лимит на запуск.');
    if(!browserConnected()||store.accounts.get(quote.accountId).purchaseHold)throw new OperationError('Запустите служебный браузер и проверьте предыдущие покупки.');
    if(body.type==='player'&&!quote.canAfford)throw new OperationError('Недостаточно баланса для этого запуска. Проверьте цены заново после пополнения.');
    const job={id:crypto.randomUUID(),requestId:body.requestId,type:body.type,sport:quote.sport,settings:{...validateSettings(store.settings),autoList:false},createdAt:new Date().toISOString(),status:'queued',items:quote.targets.map(p=>({accountId:quote.accountId,accountName:store.accounts.get(quote.accountId).name,playerId:p.id,playerName:p.name,count:p.count,cost:p.cost,status:'queued'}))};
    busy=true;store.jobs.push(job);try{await store.saveHistory();}catch(e){busy=false;store.jobs.pop();throw e;}
    if(body.type==='player')playerQuotes.delete(body.quoteId);
    worker=runJob(job).catch(()=>{job.status='error';job.message='Ошибка сохранения. Проверьте покупки в Real.';}).finally(async()=>{try{if(browserState.mode==='owned')await ownedBrowser.applyVisibility();}catch{}busy=false;commandNotifier.notify();});return job;
  }
  if (body.type !== 'refresh') {
    if(!browserConnected()||!ownedBrowser.status().loggedIn)throw new OperationError('Запустите служебный браузер и войдите в Real через «Добавить аккаунты».');
    if(body.type==='boosters'){
      if(!store.settings.boosterBoostAll&&!store.settings.boosterTargets.some(t=>body.accountIds.includes(t.accountId)))throw new OperationError('Включите «Забустить всех» или выберите игроков и сохраните правила.');
    }else{
      if(store.settings.autoList&&!['default','min','max'].includes(store.settings.pricingMode))throw new OperationError('Suggested удалён: выберите Default / Min / Max и сохраните правила до открытия пака.');
      if(body.type!=='max'&&!Object.hasOwn(LEAGUES,body.sport))throw new Error('Выберите лигу.');
      for (const id of body.accountIds) {
        const a = store.accounts.get(id), info = a.packs?.[body.sport];
        const resilient=['open','max'].includes(body.type);
        if (a.purchaseHold&&!resilient) throw new Error(`Проверьте предыдущую покупку на аккаунте ${a.name}.`);
        if(resilient)continue;
        if(body.type==='max'){
          if(a.status!=='ready'||!Number.isFinite(body.budgets?.[id])||body.budgets[id]<0||body.budgets[id]!==a.balance||store.settings.priority.some(s=>!a.seasons?.[s]||!a.packs?.[s]))throw new Error(`Сначала обновите баланс и выбранные лиги для ${a.name}.`);
        }else if (!info || info.disabled || !Number.isFinite(body.costs?.[id]) || info.cost !== body.costs[id]) throw new Error(`Сначала обновите цену ${body.sport.toUpperCase()} для ${a.name}.`);
      }
    }
  }
  const job = {
    id: crypto.randomUUID(), requestId: body.requestId, type: body.type, sport: body.sport || null,
    settings:{...validateSettings(store.settings),...(['open','max'].includes(body.type)?{generalResilience:true,generalNoLimit:true}:{})},
    ...(body.type==='boosters'?{limit:25}:{}),
    createdAt: new Date().toISOString(), status: 'queued', items: body.accountIds.map(id => ({ accountId: id, accountName: store.accounts.get(id).name, status: 'queued', cost: ['open','check'].includes(body.type)?body.costs?.[id]:null,...(body.type==='max'?{budget:body.budgets[id]}:{}) })),
  };
  busy = true;
  store.jobs.push(job);
  try { await store.saveHistory(); } catch (e) { busy = false; store.jobs.pop(); throw e; }
  worker = runJob(job).catch(() => {
    job.status = 'error'; job.message = 'Ошибка сохранения задачи. Проверьте последние покупки в Real.';
  }).finally(async() => { try{if(browserState.mode==='owned')await ownedBrowser.applyVisibility();}catch{}busy = false; commandNotifier.notify(); });
  return job;
}

const server = http.createServer(async (req, res) => {
  const allowedHost = `127.0.0.1:${port}`;
  const extensionRequest=req.url?.startsWith('/api/browser/')&&/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin||'');
  if (req.headers.host !== allowedHost || (!extensionRequest && ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site'))) {
    send(res, 403, { error: 'Доступ только из локальной панели приложения.' }); return;
  }
  const url = new URL(req.url, origin);
  // Public readiness metadata contains no user data, session, local token or path.
  if(req.method==='GET'&&url.pathname==='/health'){
    send(res,200,{app:'real-manager',version:APP_VERSION,root:crypto.createHash('sha256').update(root.toLowerCase()).digest('hex')});return;
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-local-token'] !== token) { send(res, 403, { error: 'Обновите страницу приложения.' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/state') { send(res, 200, snapshot()); return; }
      if(req.method==='GET'&&url.pathname==='/api/player-pack-players'){
        if(busy)throw new OperationError('Дождитесь текущей задачи.');
        const id=url.searchParams.get('accountId');validateIds([id]);busy=true;
        try{const players=await getOwnedPackPlayers(store.accounts.get(id),url.searchParams.get('sport'));await store.saveAccounts();send(res,200,{players});}finally{busy=false;commandNotifier.notify();}return;
      }
      if(req.method==='GET'&&url.pathname==='/api/player-pack-quote'){
        if(busy)throw new OperationError('Дождитесь текущей задачи.');
        const id=url.searchParams.get('accountId'),sport=url.searchParams.get('sport');validateIds([id]);
        const selected=store.settings.playerPacks.filter(p=>p.accountId===id&&p.sport===sport);
        if(!selected.length||selected.reduce((n,p)=>n+p.count,0)>store.settings.maxPacks)throw new OperationError('Выберите игроков и количество в пределах лимита паков, сохраните правила.');
        busy=true;try{
          const account=store.accounts.get(id);await verifyAccount(account);await getLeagueCatalog(account);
          const targets=[];for(const p of selected){const info=await getPlayerPackInfo(account,sport,p.id);if(info.disabled)throw new OperationError(`${p.name}: ${info.disabled}`);targets.push({...p,cost:info.cost});}
          const total=targets.reduce((n,p)=>n+p.cost*p.count,0),canAfford=account.balance!==null&&account.balance>=total;
          const quote={accountId:id,sport,targets,total,canAfford,selection:JSON.stringify(selected),expiresAt:Date.now()+600000};playerQuotes.clear();const quoteId=crypto.randomUUID();playerQuotes.set(quoteId,quote);
          await store.saveAccounts();send(res,200,{quoteId,total,canAfford,balance:account.balance,expiresAt:quote.expiresAt,targets});
        }finally{busy=false;commandNotifier.notify();}return;
      }
      if(req.method==='GET'&&url.pathname==='/api/players'){
        const id=url.searchParams.get('accountId');validateIds([id]);
        const account=store.accounts.get(id);if(!account.seasons)throw new OperationError('Сначала обновите аккаунты.');
        send(res,200,{players:await searchPlayers(account,url.searchParams.get('sport'),url.searchParams.get('query'))});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/booster-owned'){
        if(busy)throw new OperationError('Дождитесь текущей задачи.');
        const id=url.searchParams.get('accountId');validateIds([id]);const sport=url.searchParams.get('sport')||null;
        busy=true;try{
          const players=await getOwnedBoosterPlayers(store.accounts.get(id),sport);await store.saveAccounts();send(res,200,{players});
        }finally{busy=false;commandNotifier.notify();}
        return;
      }
      if (req.method !== 'POST') { send(res, 405, { error: 'Метод не поддерживается.' }); return; }
      const body = await readJson(req);
      if(url.pathname==='/api/owned-ufc'){
        if(busy)throw new OperationError('Дождитесь окончания задачи перед чтением owned UFC.');
        const players=new Map(),errors=[];let checked=0;busy=true;
        try{
          for(const account of [...store.accounts.values()].filter(hasBrowserSession)){
            try{for(const p of await getOwnedUfcFighters(account))players.set(p.id,p);checked++;}
            catch(e){errors.push({accountName:account.name,message:e instanceof OperationError?e.message:'Не удалось прочитать owned UFC.'});}
          }
          send(res,200,{players:[...players.values()],errors,checked,total:[...store.accounts.values()].filter(hasBrowserSession).length});
        }finally{busy=false;commandNotifier.notify();}
        return;
      }
      if(url.pathname==='/api/settings'){
        if(busy)throw new Error('Дождитесь окончания задачи перед изменением настроек.');
        busy=true;try{await store.saveSettings(body);send(res,200,{settings:store.settings});}finally{busy=false;commandNotifier.notify();}return;
      }
      if(url.pathname==='/api/recorder/start'){
        if(busy)throw new OperationError('Дождитесь завершения текущей задачи перед записью сценария.');
        if(scenarioRecorder.active)throw new OperationError('Запись сценария уже идёт.');
        if(!browserConnected()||!ownedBrowser.status().loggedIn)throw new OperationError('Запустите служебный Chrome и войдите в Real перед записью.');
        const name=String(body.name||'').trim();
        if(!name||name.length>80)throw new OperationError('Название сценария должно содержать от 1 до 80 символов.');
        const started=await browserCommand('record-start',{name});
        scenarioRecorder={active:true,name,startedAt:started.startedAt||new Date().toISOString()};
        send(res,200,{recorder:{...scenarioRecorder}});return;
      }
      if(url.pathname==='/api/recorder/stop'){
        if(!scenarioRecorder.active)throw new OperationError('Запись сценария не запущена.');
        const meta={...scenarioRecorder};
        let stopped;
        try{stopped=await browserCommand('record-stop',{name:meta.name});}
        catch(error){scenarioRecorder={active:false,name:null,startedAt:null};throw error;}
        scenarioRecorder={active:false,name:null,startedAt:null};
        const secrets=[token,ownedKey,...[...store.accounts.values()].flatMap(a=>Object.entries(a.headers||{}).filter(([k])=>/auth|token|cookie/i.test(k)).map(([,v])=>v))];
        const network=ownedBrowser.network.filter(record=>!meta.startedAt||Date.parse(record.at)>=Date.parse(meta.startedAt));
        const payload={schema:1,version:APP_VERSION,name:meta.name,startedAt:meta.startedAt,finishedAt:new Date().toISOString(),scenario:stopped.scenario||null,network};
        const zip=scenarioArchive(payload,secrets);
        const safeName=meta.name.replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,50)||'scenario';
        res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="real-manager-'+safeName+'-'+Date.now()+'.zip"','cache-control':'no-store','x-content-type-options':'nosniff'});
        res.end(Buffer.from(zip));return;
      }
      if(url.pathname==='/api/owned-diagnostics'){
        const capture=await ownedBrowser.diagnostics();
        const secrets=[token,ownedKey,...[...store.accounts.values()].flatMap(a=>Object.entries(a.headers||{}).filter(([k])=>/auth|token|cookie/i.test(k)).map(([,v])=>v))];
        const payload={schema:1,version:APP_VERSION,createdAt:new Date().toISOString(),browser:ownedBrowser.status(),page:capture.page,network:capture.network,jobs:store.jobs.slice(-8).map(j=>({id:j.id,type:j.type,sport:j.sport,status:j.status,createdAt:j.createdAt,message:j.message,items:j.items.map(i=>({accountId:i.accountId,accountName:i.accountName,status:i.status,message:i.message,generalProgress:i.generalProgress,packs:(i.packs||(i.pack?[i.pack]:[])).slice(-5)}))}))};
        const zip=diagnosticArchive(payload,capture.png,secrets);
        res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="real-manager-diagnostic-'+Date.now()+'.zip"','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(Buffer.from(zip));return;
      }
      if(url.pathname==='/api/owned-browser'){
        if(body.action==='visibility'){
          if(shuttingDown||ownedBrowser.starting)throw new OperationError('Дождитесь запуска браузера.');
          const owned=await ownedBrowser.requestVisibility(body.visible,busy);send(res,200,{owned});return;
        }
        if(busy||shuttingDown||ownedBrowser.starting)throw new OperationError('Дождитесь завершения задачи перед управлением браузером.');
        if(scenarioRecorder.active)throw new OperationError('Сначала завершите запись сценария.');
        if(!['visible','headless','stop','refresh','add-accounts','finish-accounts'].includes(body.action))throw new OperationError('Неверное действие браузера.');
        if(body.action==='refresh'){send(res,200,{owned:await ownedBrowser.refresh()});return;}
        if(body.action==='stop'){send(res,200,{owned:await ownedBrowser.stop()});return;}
        browserState.mode='owned';browserState.snapshot=null;
        if(body.action==='add-accounts'){send(res,200,{owned:await ownedBrowser.addAccounts()});return;}
        if(body.action==='finish-accounts'){send(res,200,{owned:await ownedBrowser.finishAccounts()});return;}
        send(res,200,{owned:await ownedBrowser.start(body.action)});return;
      }
      if(url.pathname.startsWith('/api/browser/')){
        const ownedRequest=req.headers['x-owned-browser']===ownedKey;
        if(ownedRequest&&browserState.mode!=='owned')throw new OperationError('Служебный браузер больше не выбран.');
        const route=url.pathname.slice('/api/browser/'.length);
        const nativeHello=route==='hello'&&body.native===true;
        if(!ownedRequest&&!nativeHello&&!ownedBrowser.trusted(req.headers.origin))throw new OperationError('Подключите расширение служебного Chrome.');
        if(!nativeHello)ownedBrowser.heartbeat();
        if(['hello','heartbeat','snapshot','next','result'].includes(route))browserState.lastSeen=Date.now();
        if(route==='hello'){if(!nativeHello)throw new OperationError('Подключите новое расширение Chrome.');ownedBrowser.acceptHello(req.headers.origin,body);browserState.mode='owned';browserState.tabId=body.tabId;browserState.version=body.version;browserState.snapshot=null;send(res,200,{ok:true});return;}
        if(route==='wake-receiver'&&ownedRequest){commandNotifier.notify();send(res,200,{ok:true});return;}
        if(route==='heartbeat'){ownedBrowser.heartbeat();send(res,200,{ok:true});return;}
        if(route==='snapshot'){ownedBrowser.receiveSnapshot(body.snapshot);browserState.snapshot=body.snapshot;send(res,200,{ok:true});return;}
        if(route==='native-session'){await ownedBrowser.observeSession(body.headers);send(res,200,{ok:true});return;}
        if(route==='native-network'){ownedBrowser.recordNetwork(body.record);send(res,200,{ok:true});return;}
        if(route==='native-closed'){ownedBrowser.closed();send(res,200,{ok:true});return;}
        if(route==='debug'){send(res,200,{snapshot:browserState.snapshot});return;}
        if(route==='next'){
          const waitMs=Math.min(20000,Math.max(0,Number(body.waitMs)||0));
          const controller=new AbortController();
          const disconnect=()=>controller.abort();res.once('close',disconnect);
          try{
            const result=await commandNotifier.wait(()=>{
              if(ownedBrowser.closeWanted)return {command:{action:'native-close'},busy:false};
              if(shuttingDown||ownedRequest&&ownedBrowser.switching)return {command:null,busy:false,stopping:true};
              const pending=[...browserCommands.values()].find(p=>!p.claimed);
              if(pending){pending.claimed=true;return {command:pending.command,busy};}
              // One 20-second idle receiver keeps native tasks responsive without
              // frequent polling or waiting for Chrome's 30-second alarm.
              return undefined;
            },waitMs,controller.signal);
            if(!res.destroyed)send(res,200,result??{command:null,busy});
          }finally{res.off('close',disconnect);controller.abort();}
          return;
        }
        if(route==='authorize'){
          const pending=browserCommands.get(body.commandId),job=pending&&store.jobs.find(j=>j.id===pending.command.jobId);
          if(!pending?.claimed||pending.command.action!=='open'||pending.command.expiresAt<=Date.now()||!job||job.cancelled||shuttingDown||job.status!=='running'||pending.purchaseStarted||pending.authorizing)throw new OperationError('Операция отменена, устарела или уже отправлена.');
          pending.authorizing=true;
          const account=store.accounts.get(pending.command.accountId);
          await verifyAccount(account);
          const info=pending.command.kind==='player'?await getPlayerPackInfo(account,pending.command.sport,pending.command.playerId):await getPackInfo(account,pending.command.sport);
          if(info.disabled||info.cost!==pending.command.cost||account.balance===null||account.balance<info.cost||account.purchaseHold&&!isResilientGeneral(job))throw new OperationError('Цена, баланс или доступность изменились. Покупка остановлена.');
          if(!browserCommands.has(body.commandId)||job.cancelled||shuttingDown||pending.command.expiresAt<=Date.now())throw new OperationError('Операция отменена или устарела.');
          pending.purchaseStarted=true;
          send(res,200,{ok:true});return;
        }
        if(route==='authorize-booster'){
          const pending=browserCommands.get(body.commandId),job=pending&&store.jobs.find(j=>j.id===pending.command.jobId);
          if(!pending?.claimed||pending.command.action!=='boost'||pending.command.expiresAt<=Date.now()||!job||job.type!=='boosters'||job.cancelled||shuttingDown||job.status!=='running'||pending.boosterStarted||pending.authorizing)throw new OperationError('Бустер отменён, устарел или уже применялся.');
          pending.authorizing=true;
          const account=store.accounts.get(pending.command.accountId);await verifyAccount(account);
          if(!browserCommands.has(body.commandId)||job.cancelled||shuttingDown||pending.command.expiresAt<=Date.now())throw new OperationError('Бустер отменён или аккаунт больше не подтверждён.');
          pending.boosterStarted=true;
          send(res,200,{ok:true});return;
        }
        if(route==='authorize-listing'){
          const pending=browserCommands.get(body.commandId),job=pending&&store.jobs.find(j=>j.id===pending.command.jobId);
          if(!pending?.claimed||pending.command.action!=='list'||pending.command.expiresAt<=Date.now()||!job||['player','player-check'].includes(job.type)||job.cancelled||shuttingDown||job.status!=='running'||pending.listingStarted||pending.authorizing)throw new OperationError('Листинг отменён, устарел или уже отправлен.');
          pending.authorizing=true;
          const account=store.accounts.get(pending.command.accountId);await verifyAccount(account);
          if(account.purchaseHold&&!isResilientGeneral(job)||!browserCommands.has(body.commandId)||job.cancelled||shuttingDown||pending.command.expiresAt<=Date.now())throw new OperationError('Листинг отменён или доступ не подтверждён.');
          for(const cardId of pending.command.plan.selectedIds)pending.command.plan.records.push({cardId,status:'submitting',durationHours:24,mode:pending.command.plan.mode,via:'pack-ui'});
          await store.saveHistory();pending.listingStarted=true;
          send(res,200,{ok:true});return;
        }
        if(route==='result'){
          const pending=browserCommands.get(body.commandId);
          if(pending){
            clearTimeout(pending.timer);clearInterval(pending.watchdog);browserCommands.delete(body.commandId);
            const result=body.result;
            if(result?.ok&&pending.command.action==='open'){
              const pack=result.pack,c=pending.command;
              if(!pending.purchaseStarted||pack?.accountId!==c.accountId||pack?.sport!==c.sport||pack?.cost!==c.cost||!Number.isInteger(pack?.cardCount)||pack.cardCount<1||pack.cardCount>100||typeof pack?.summaryText!=='string'||!pack.summaryText.includes('Pack summary'))pending.reject(new OperationError('Получен непроверенный результат. Проверьте пак в Real.',true));
              else pending.resolve({...pack,openCommandId:c.id,summaryText:pack.summaryText.slice(0,12000),cards:[]});
            }
            else if(result?.ok&&pending.command.action==='boost'){
              const r=result.snapshot,c=pending.command;
              if(r?.skipped===true&&!pending.boosterStarted)pending.resolve(r);
              else if(!pending.boosterStarted||r?.applied!==true||r?.accountId!==c.accountId||r?.sport!==c.sport||r?.playerName!==c.playerName||Number(r?.mint)!==Number(c.mint)||![3,4,5].includes(Number(r?.rarity))){
                pending.reject(new OperationError('Real не подтвердил применение бустера. Не повторяйте его вручную, пока не проверите карточку.',pending.boosterStarted));
              }else pending.resolve(r);
            }
            else if(result?.ok&&pending.command.action==='list'){
              const plan=pending.command.plan,ids=result.listedCardIds;
              if((plan.selectedIds.length&&!pending.listingStarted)||!Array.isArray(ids)||ids.length!==plan.selectedIds.length||new Set(ids).size!==ids.length||ids.some(id=>!plan.selectedIds.includes(id))||result.mode!==plan.mode||result.durationHours!==24){
                for(const r of plan.records)if(r.status==='submitting')r.status='uncertain';
                pending.reject(new OperationError('Real не подтвердил выбранные карты / настройки Quick list. Проверьте маркетплейс.',pending.listingStarted));
              }else{
                for(const r of plan.records)if(r.status==='submitting')r.status='queued';
                pending.resolve(result);
              }
            }
            else if(result?.ok)pending.resolve(result.snapshot||{});
            else{
              for(const r of pending.command.plan?.records||[])if(r.status==='submitting'){r.status='uncertain';r.message=result?.message||'Проверьте Quick list в Real.';}
              pending.reject(Object.assign(new OperationError(result?.message||'Real не завершил действие в браузере.',Boolean(result?.uncertain||pending.purchaseStarted||pending.listingStarted||pending.boosterStarted)),{chargePossible:Boolean(pending.purchaseStarted),requiresAttention:Boolean(result?.requiresAttention)}));
            }
          }
          send(res,200,{ok:true});return;
        }
        send(res,404,{error:'Не найдено.'});return;
      }
      if (url.pathname === '/api/import') {
        send(res,410,{error:'Импорт HAR удалён. Нажмите «Добавить аккаунты» и войдите в Real.'});
        return;
      }
      if (url.pathname === '/api/jobs') { send(res, 202, { job: await createJob(body) }); return; }
      if (url.pathname === '/api/cancel') {
        const job = store.jobs.find(j => j.id === body.jobId);
        if (!job) throw new Error('Задача не найдена.');
        job.cancelled = true;
        cancelBrowserCommands(job.id);
        send(res, 200, { ok: true }); return;
      }
      if (url.pathname === '/api/acknowledge') {
        if (busy) throw new Error('Дождитесь окончания задачи.');
        validateIds([body.accountId]);
        busy = true;
        try {
          store.accounts.get(body.accountId).purchaseHold = false;
          await store.saveAccounts(); send(res, 200, { ok: true });
        } finally { busy = false; }
        return;
      }
      if (url.pathname === '/api/shutdown') {
        shuttingDown = true;
        commandNotifier.notify();
        for (const j of store.jobs) if (['running', 'queued'].includes(j.status)) { j.cancelled = true; cancelBrowserCommands(j.id,'Приложение останавливается.'); }
        send(res, 200, { ok: true });
        worker.finally(async()=>{
          while(ownedBrowser.polling||ownedBrowser.starting)await new Promise(resolve=>setTimeout(resolve,100));
          try{await ownedBrowser.close();}catch{console.error('Служебный браузер не завершился; закройте его вручную.');}
          server.close(()=>process.exit(0));
        });
        return;
      }
      send(res, 404, { error: 'Не найдено.' }); return;
    }
    const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
    if (req.method !== 'GET' || !files[url.pathname]) { send(res, 404, { error: 'Не найдено.' }); return; }
    let content = await fs.readFile(path.join(root, 'public', files[url.pathname]), 'utf8');
    if (url.pathname === '/') content = content.replace('__LOCAL_TOKEN__', token);
    res.writeHead(200, {
      'content-type': url.pathname === '/' ? 'text/html; charset=utf-8' : url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(content);
  } catch (e) { send(res, 400, { requiresAttention:requiresGeneralAttention(e), error: e instanceof OperationError ? e.message : /HAR|аккаунт|задач|цен|выберите|Выберите|Неверн|Дождитесь|доступен|Проверьте|Обновите|Файл|Нет успешных|начала|файл/i.test(e.message) ? e.message : 'Не удалось выполнить действие. Проверьте файл или параметры.' }); }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Порт ${port} занят. Приложение, возможно, уже работает.` : 'Не удалось запустить локальный сервер.');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Real Manager: ${origin}`);
  if(ownedBrowser.autoStart){browserState.mode='owned';ownedBrowser.start(ownedBrowser.preferredMode,{persist:false}).catch(()=>console.error('Служебный браузер не запустился. Проверьте раздел «Приложение».'));}
});
