import { LEAGUES, OperationError, realRequest, listingRequest, verifyAccount, getPackHistory } from './core.mjs';
import {validateBoosterTargets} from './boosters.mjs';

export const DEFAULT_SETTINGS=Object.freeze({priority:['nfl','ufc'],autoList:false,pricingMode:'default',maxPacks:100,generalResilience:true,generalNoLimit:true,protectedPlayers:[],protectedCardIds:[],playerPacks:[],boosterBoostAll:false,boosterUseLegendary:true,boosterTargets:[]});
export function validateSettings(value){
  const s={...DEFAULT_SETTINGS,...value};
  if(!Array.isArray(s.priority)||!s.priority.length||new Set(s.priority).size!==s.priority.length||s.priority.some(p=>!Object.hasOwn(LEAGUES,p)))throw new OperationError('Выберите лиги без повторений.');
  if(typeof s.autoList!=='boolean'||!['default','min','max','suggested'].includes(s.pricingMode)||!Number.isSafeInteger(s.maxPacks)||s.maxPacks<1||s.maxPacks>1000)throw new OperationError('Неверные настройки: лимит паков от 1 до 1000.');
  if(typeof s.generalResilience!=='boolean'||typeof s.generalNoLimit!=='boolean')throw new OperationError('Неверный режим восстановления General packs.');
  if(!Array.isArray(s.protectedPlayers)||s.protectedPlayers.length>5000||s.protectedPlayers.some(p=>!Object.hasOwn(LEAGUES,p.sport)||!['player','team'].includes(p.entityType)||!Number.isSafeInteger(p.id)||p.id<=0||typeof p.name!=='string'||!p.name.trim()||p.name.length>150))throw new OperationError('Неверный список защищённых игроков.');
  if(!Array.isArray(s.protectedCardIds)||s.protectedCardIds.length>1000||s.protectedCardIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw new OperationError('Неверные ID защищённых карт.');
  if(!Array.isArray(s.playerPacks)||s.playerPacks.length>5000||s.playerPacks.some(p=>typeof p.accountId!=='string'||! /^[a-zA-Z0-9]+$/.test(p.accountId)||!Object.hasOwn(LEAGUES,p.sport)||p.sport==='ufc'||!Number.isSafeInteger(p.id)||p.id<=0||typeof p.name!=='string'||!p.name.trim()||p.name.length>150||!Number.isSafeInteger(p.count)||p.count<1||p.count>100)||new Set(s.playerPacks.map(p=>`${p.accountId}:${p.sport}:${p.id}`)).size!==s.playerPacks.length)throw new OperationError('Неверный список Player packs (1–100 паков на игрока).');
  if(typeof s.boosterBoostAll!=='boolean'||typeof s.boosterUseLegendary!=='boolean')throw new OperationError('Неверные общие настройки бустеров.');
  const boosterTargets=validateBoosterTargets(s.boosterTargets);
  return {priority:[...s.priority],autoList:s.autoList,pricingMode:s.pricingMode,maxPacks:s.maxPacks,generalResilience:s.generalResilience,generalNoLimit:s.generalNoLimit,protectedPlayers:s.protectedPlayers.map(p=>({id:p.id,sport:p.sport,entityType:p.entityType,name:p.name.trim()})),protectedCardIds:[...new Set(s.protectedCardIds)],playerPacks:s.playerPacks.map(p=>({accountId:p.accountId,sport:p.sport,id:p.id,name:p.name.trim(),count:p.count})),boosterBoostAll:s.boosterBoostAll,boosterUseLegendary:s.boosterUseLegendary,boosterTargets};
}

export function keepReason(card,settings){
  if(settings.protectedCardIds.includes(card.id))return 'Отмечена отдельно';
  if(card.untouchable||card.entityUntouchable)return 'Untouchable в Real';
  const entities=[{entityType:card.entityType,id:card.entityId},
    {entityType:'player',id:card.playerId},{entityType:'team',id:card.teamId},
    {entityType:'player',id:card.primaryPlayer?.id},{entityType:'player',id:card.secondaryPlayer?.id},
    {entityType:'team',id:card.team?.id},{entityType:'team',id:card.opponentTeam?.id}];
  if(settings.protectedPlayers.some(p=>p.sport===card.sport&&entities.some(e=>e.entityType===p.entityType&&Number(e.id)===p.id)))return 'Защищённый игрок / участник';
  if(card.canList!==true||card.untradable)return 'Real не разрешает выставление';
  return null;
}

export function publicCard(c){return {id:c.id,rarity:c.rarityLabel||String(c.rarity||''),label:c.entityLabel||c.primaryPlayer?.displayName||c.team?.name||c.infoLabel||'Карточка',mint:c.mintNumber??null,sport:c.sport};}

export async function preparePackQuickList(account,packId,cards,settings){
  if(!['default','min','max'].includes(settings.pricingMode))throw new OperationError('Для Quick list выберите Default, Min или Max и сохраните правила.');
  if(!cards.length||cards.some(c=>c.userId!==account.id||Number(c.cardPackId)!==packId))throw new OperationError('Карты не принадлежат новому паку этого аккаунта.');
  const records=[],descriptors=cards.map(c=>{
    const reason=keepReason(c,settings);
    if(reason)records.push({cardId:c.id,status:'kept',message:reason});
    const participants=c.primaryPlayer||c.secondaryPlayer?[c.primaryPlayer,c.secondaryPlayer]:[c.team,c.opponentTeam];
    const names=participants.filter(Boolean).map(p=>p.fullName||[p.firstName,p.lastName].filter(Boolean).join(' ')||p.name||p.displayName).filter(Boolean);
    return {id:c.id,mint:c.mintNumber??null,names,eligible:!reason};
  });
  const ids=descriptors.filter(c=>c.eligible).map(c=>c.id);
  if(ids.length>25)throw new OperationError('В паке больше 25 доступных карт. Групповой листинг остановлен.');
  // The normal Quick list drawer obtains its own preview. No server-side listing POSTs.
  // Labels were observed in Real; the UI adapter must find and verify them again before submitting.
  const selected=descriptors.filter(c=>c.eligible);
  if(selected.some(c=>!Number.isSafeInteger(c.mint)||!c.names.length))throw new OperationError('Недостаточно данных для безопасного выбора карт в сводке Real.');
  return {cards:descriptors,selectedIds:selected.map(c=>c.id),records,mode:settings.pricingMode,durationHours:24,durationLabel:'24h',pricingLabel:{default:'Default',min:'Min',max:'Max'}[settings.pricingMode]};
}

export async function recoverNewPack(account,sport,before,request=realRequest,expected={kind:'general'}){
  const known=new Set(before.map(p=>String(p.packId)));
  let fresh=[];
  const delays=expected.retryDelays||[];
  for(let attempt=0;attempt<=delays.length;attempt++){
    if(expected.stopped?.())throw new OperationError('Очередь остановлена. Новый пак сохранён без автолистинга.');
    const after=await getPackHistory(account,sport,request);
    fresh=after.filter(p=>p.type==='mintpack'&&!known.has(String(p.packId)));
    if(fresh.length||attempt===delays.length)break;
    await (expected.pause||((ms)=>new Promise(resolve=>setTimeout(resolve,ms))))(delays[attempt]);
  }
  if(fresh.length!==1||fresh[0].packIdentifer!==expected.kind||!Number.isSafeInteger(Number(fresh[0].packId)))throw new OperationError('Не удалось однозначно определить новый пак. Автолистинг остановлен; покупка подтверждена.');
  const id=Number(fresh[0].packId),data=await request(account,'GET',`/collectingpacks/${id}/cards`);
  const cards=data?.cards;
  if(!Array.isArray(cards)||!cards.length||cards.length>100||new Set(cards.map(c=>c.id)).size!==cards.length||cards.some(c=>!Number.isSafeInteger(c.id)||c.userId!==account.id||Number(c.cardPackId)!==id||c.sport!==sport))throw new OperationError('Карты нового пака не прошли проверку владельца. Автолистинг остановлен.');
  return {id,cards};
}

export async function listNewCards(account,packId,cards,settings,{request=realRequest,listing=listingRequest,save=async()=>{},cancelled=()=>false,records=[]}={}){
  if(cards.some(c=>c.userId!==account.id||Number(c.cardPackId)!==packId))throw new OperationError('Листинг разрешён только для проверенных карт нового пака.');
  await verifyAccount(account,request);
  const eligible=[];
  for(const c of cards){const reason=keepReason(c,settings);if(reason)records.push({cardId:c.id,status:'kept',message:reason});else eligible.push(c);}
  await save();
  for(let offset=0;offset<eligible.length;offset+=25){
    if(cancelled())return records;
    const batch=eligible.slice(offset,offset+25),ids=batch.map(c=>c.id);
    const response=await listing(account,'/quicklist/preview',{cardIds:ids,source:'pack_open'});
    if(!Array.isArray(response?.previews)||response.previews.length!==ids.length||new Set(response.previews.map(p=>p.cardId)).size!==ids.length||response.previews.some(p=>!ids.includes(p.cardId)||p.sport!==batch[0].sport)||!response.config?.durationOptions?.some(o=>o.value===24))throw new OperationError('Real не подтвердил карты и срок 24 часа. Листинг остановлен.');
    const allowed=[];
    for(const p of response.previews){
      if(p.canQuickList===true)allowed.push(p);
      else records.push({cardId:p.cardId,status:'kept',message:p.errorMessage||'Real не разрешает листинг'});
    }
    if(!allowed.length){await save();continue;}
    if(settings.pricingMode==='suggested'){
      for(const p of allowed){
        if(cancelled())return records;
        const {info}=await request(account,'GET',`/cardmarketplacelistings/card/${p.cardId}/info`);
        if(!info?.canCreate||!info.durationOptions?.some(o=>o.value===24)||!Number.isFinite(info.minBidPrice)||info.minBidPrice<0)throw new OperationError(info?.createErrorMessage||'Real не подтвердил минимальную цену / срок 24 часа.');
        const hasSuggested=Number.isFinite(p.suggestedListPrice)&&p.suggestedListPrice>0;
        const price=hasSuggested?p.suggestedListPrice:info.minBidPrice;
        if(!Number.isFinite(price)||price<=0||price<info.minBidPrice)throw new OperationError('Real не разрешает выбранную фиксированную цену или не указал доступную минимальную цену.');
        if(cancelled())return records;
        const record={cardId:p.cardId,status:'submitting',durationHours:24,mode:'suggested',price,priceSource:hasSuggested?'suggested':'minimum',...(!hasSuggested?{message:'Нет рекомендации — минимальная цена Real'}:{})};records.push(record);await save();
        try{
          const result=await listing(account,'/cardmarketplacelistings',{listingType:'card',cardId:p.cardId,allowBids:false,minBidPrice:price,buyNowPrice:price,durationInHours:24,notificationSettings:{}});
          if(!result?.listing?.id||(result.listing.cardId!=null&&result.listing.cardId!==p.cardId)||(result.listing.userId!=null&&result.listing.userId!==account.id))throw new OperationError('Real не подтвердил ID / владельца листинга. Проверьте маркетплейс перед повтором.',true);
          record.status='listed';record.listingId=result.listing.id;await save();
        }catch(error){record.status=error.uncertain?'uncertain':'error';record.message=error.message;await save();throw error;}
      }
    }else{
      if(!response.config.pricingModeOptions?.some(o=>o.value===settings.pricingMode))throw new OperationError('Выбранный режим цены недоступен в Real.');
      const pending=allowed.map(p=>({cardId:p.cardId,status:'submitting',durationHours:24,mode:settings.pricingMode,priceDisplay:p.priceDisplayByMode?.[settings.pricingMode]}));records.push(...pending);await save();
      if(cancelled()){for(const r of pending)r.status='cancelled';await save();return records;}
      try{
        const result=await listing(account,'/quicklist',{cardIds:allowed.map(p=>p.cardId),durationInHours:24,pricingMode:settings.pricingMode});
        if(result?.success!==true||!Array.isArray(result.listings)||result.listings.length!==allowed.length||new Set(result.listings.map(l=>l.cardId)).size!==allowed.length||result.listings.some(l=>!allowed.some(p=>p.cardId===l.cardId)))throw new OperationError('Real не подтвердил все карты в Quick list. Проверьте маркетплейс перед повтором.',true);
        for(const r of pending){const l=result.listings.find(l=>l.cardId===r.cardId);r.status=l.listingId?'listed':'queued';r.listingId=l.listingId??null;}await save();
      }catch(error){for(const r of pending){r.status=error.uncertain?'uncertain':'error';r.message=error.message;}await save();throw error;}
    }
  }
  return records;
}

export async function runMaximum({priority,budget,maxPacks},{info,balance,open,stopped=()=>false}){
  let spent=0,count=0;
  for(const sport of priority){
    while(!stopped()&&count<maxPacks){
      const pack=await info(sport);
      if(!Number.isFinite(pack.cost)||pack.cost<0)throw new OperationError('Неизвестная цена пака.');
      const available=await balance();
      if(!Number.isFinite(available)||available<0)throw new OperationError('Неизвестный баланс аккаунта.');
      if(pack.disabled||pack.cost>budget-spent||pack.cost>available)break;
      await open(sport,pack.cost);spent+=pack.cost;count++;
    }
  }
  return {spent,count,limitReached:count>=maxPacks};
}
