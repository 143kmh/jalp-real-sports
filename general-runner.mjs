import {OperationError} from './core.mjs';

export function requiresGeneralAttention(error){
  return Boolean(error?.requiresAttention||[401,403].includes(error?.httpStatus));
}
export function generalBackoff(failures){return Math.min(120000,2000*2**Math.min(Math.max(0,failures-1),6));}

// Each account is completed before the next. Every opening is a NEW, authorized
// command; a transport failure never replays the old purchase or listing command.
export async function visitGeneral({priority,budget,spendIncoming=true,limit=Infinity},progress,ops){
  Object.assign(progress,{cursor:0,count:0,unknown:0,spent:0,reserved:0,retries:0,failures:0,exhausted:[],warnings:[],...progress});
  progress.leagues??=Object.fromEntries(priority.map(sport=>[sport,{state:'queued',count:0,unknown:0}]));
  let attemptedCost=null,attemptedSport=null;
  const stopped=()=>ops.stopped?.();
  const finish=reason=>({done:true,reason,count:progress.count,unknown:progress.unknown,spent:progress.spent,budget:progress.budget});
  const validBalance=value=>{if(!Number.isFinite(value)||value<0)throw Object.assign(new OperationError('Real не подтвердил баланс. Нужна проверка аккаунта.'),{requiresAttention:true});return value;};
  const validPack=pack=>{if(!pack||!Number.isFinite(pack.cost)||pack.cost<0)throw Object.assign(new OperationError('Real не подтвердил цену General Pack.'),{requiresAttention:true});return pack;};
  const unavailable=(pack,balance)=>pack.disabled||pack.cost>balance||!spendIncoming&&pack.cost>progress.budget-progress.spent;
  const recordUnavailable=async(sport,pack)=>{
    if(pack.disabled&&ops.confirmUnavailable&&pack.packImage){
      progress.phase='Проверка лимита '+sport.toUpperCase();await ops.save?.();
      if(!await ops.confirmUnavailable(sport,pack))throw new OperationError('Лимит '+sport.toUpperCase()+' пока не подтверждён в интерфейсе Real.');
      await ops.reset();
    }
    const reason=pack.disabled||'Недостаточно доступного баланса';
    progress.exhausted=progress.exhausted.filter(e=>e.sport!==sport);progress.exhausted.push({sport,reason});
    Object.assign(progress.leagues[sport],{state:'done',reason,evidence:pack.disabled?(pack.packImage?'Real UI':'Real API'):'balance'});
  };
  try{
    if(stopped())return {cancelled:true};
    if(progress.needsReset){await ops.reset();progress.needsReset=false;if(stopped())return {cancelled:true};}
    progress.budget??=Number.isFinite(budget)?budget:null;
    while(!stopped()){
      if(progress.cursor>=priority.length){
        // Reload and recheck all leagues before leaving this account. Income
        // received in a lower league can make an earlier league affordable.
        if(ops.finalCheck){
          progress.phase='Финальная проверка лиг';await ops.save?.();
          await ops.reset();progress.needsReset=false;if(stopped())return {cancelled:true};
          const balance=validBalance(await ops.refresh());let restart=-1;
          for(let index=0;index<priority.length&&!stopped();index++){
            const sport=priority[index],pack=validPack(await ops.info(sport));
            if(!unavailable(pack,balance)){restart=index;break;}
            await recordUnavailable(sport,pack);await ops.save?.();
          }
          if(stopped())return {cancelled:true};
          if(restart>=0){progress.cursor=restart;progress.exhausted=progress.exhausted.filter(e=>e.sport!==priority[restart]);continue;}
        }
        progress.completed=true;progress.currentSport=null;progress.phase='Все выбранные лиги проверены';await ops.save?.();return finish('unavailable');
      }
      if(progress.count+progress.unknown>=limit)return finish('limit');
      const sport=priority[progress.cursor];
      progress.currentSport=sport;progress.phase='Проверка '+sport.toUpperCase();
      progress.leagues[sport]??={state:'queued',count:0,unknown:0};progress.leagues[sport].state='running';await ops.save?.();
      let available=validBalance(await ops.refresh()),pack=validPack(await ops.info(sport));
      progress.budget??=available;
      if(stopped())return {cancelled:true};
      if(unavailable(pack,available)){
        await recordUnavailable(sport,pack);
        progress.cursor++;await ops.save?.();continue;
      }
      if(stopped())return {cancelled:true};
      attemptedCost=pack.cost;attemptedSport=sport;
      progress.phase='Открытие '+sport.toUpperCase();await ops.save?.();
      await ops.open(sport,pack.cost,pack);
      progress.spent+=pack.cost;progress.count++;progress.leagues[sport].count++;progress.failures=0;attemptedCost=null;
      await ops.save?.();
      if(progress.needsReset){await ops.reset();progress.needsReset=false;}
    }
    return stopped()?{cancelled:true}:finish('unavailable');
  }catch(error){
    if(error?.code==='STORAGE'||!(error instanceof OperationError))throw error;
    // Known packs can fail later (reading balance / listing): they still consume
    // exactly one opening and their approved price. Unknown charged attempts
    // remain separate from confirmed spending. Available-balance mode does NOT
    // cap later openings by this estimate: it reads the actual balance each time.
    if(attemptedCost!==null&&(error.confirmedPack||error.uncertain&&error.chargePossible!==false)){
      progress.spent+=attemptedCost;
      if(error.confirmedPack)progress.count++;else{progress.unknown++;progress.reserved+=attemptedCost;}
      if(attemptedSport){if(error.confirmedPack)progress.leagues[attemptedSport].count++;else progress.leagues[attemptedSport].unknown++;}
    }
    progress.warnings.push({at:new Date().toISOString(),message:error.message,uncertain:Boolean(error.uncertain),confirmedPack:Boolean(error.confirmedPack)});
    progress.warnings=progress.warnings.slice(-40);
    await ops.save?.();
    if(stopped())return {cancelled:true};
    if(requiresGeneralAttention(error))return {...finish('attention'),attention:true,message:error.message};
    progress.retries++;progress.failures++;
    progress.needsReset=true;
    progress.phase='Восстановление';progress.lastError=error.message;
    return {retry:true,delayMs:Math.max(generalBackoff(progress.failures),Number(error.retryAfterMs)||0),message:error.message};
  }
}

export async function scheduleGeneral(items,{visit,stopped=()=>false,now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  for(const item of items){
    while(!stopped()){
      const result=await visit(item);if(result.attention)return result;if(!result.retry)break;
      const until=now()+result.delayMs;
      while(!stopped()&&now()<until)await pause(Math.min(1000,Math.max(1,until-now())));
    }
    if(stopped())break;
  }
}
