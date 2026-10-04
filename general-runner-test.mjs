import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {OperationError} from './core.mjs';
import {visitGeneral,scheduleGeneral,generalBackoff} from './general-runner.mjs';
import {DEFAULT_SETTINGS,validateSettings} from './automation.mjs';

const options={priority:['nfl','ufc']};
function fixture(){
  let balance=550;const opened=[],resets=[];
  const ops={refresh:async()=>balance,info:async sport=>({cost:sport==='nfl'?200:100}),open:async(sport,cost)=>{opened.push(sport);balance-=cost;},reset:async()=>resets.push(true),save:async()=>{}};
  return {ops,opened,resets,setBalance:n=>balance=n};
}
test('resilient defaults migrate to all available income and no quantity cap',()=>{
  assert.equal(DEFAULT_SETTINGS.generalResilience,true);assert.equal(DEFAULT_SETTINGS.generalNoLimit,true);
  for(const key of ['generalResilience','generalNoLimit'])assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,[key]:'true'}));
});
test('General drains leagues in priority order with fresh balances',async()=>{
  const f=fixture(),p={};const result=await visitGeneral(options,p,f.ops);
  assert.deepEqual(f.opened,['nfl','nfl','ufc']);assert.equal(result.reason,'unavailable');assert.equal(p.count,3);assert.equal(p.spent,500);
});
test('incoming Rax is spendable beyond original launch budget',async()=>{
  let count=0;const p={};await visitGeneral({priority:['nfl'],budget:100},p,{refresh:async()=>count<3?100:0,info:async()=>({cost:100}),open:async()=>count++});
  assert.equal(count,3);assert.equal(p.spent,300);assert.equal(p.budget,100);
});
test('free General packs can exceed 1000 until Real disables them',async()=>{
  let count=0;const p={};await visitGeneral({priority:['ufc']},p,{refresh:async()=>0,info:async()=>({cost:0,disabled:count>=1005?'Real limit':null}),open:async()=>count++});assert.equal(count,1005);
});
test('unknown charged opening resets then continues using actual balance',async()=>{
  const f=fixture(),p={};let attempts=0;f.ops.open=async()=>{attempts++;if(attempts===1)throw Object.assign(new OperationError('lost',true),{chargePossible:true});f.setBalance(0);};
  assert.equal((await visitGeneral({priority:['nfl']},p,f.ops)).retry,true);
  assert.equal(p.unknown,1);assert.equal(p.reserved,200);
  assert.equal((await visitGeneral({priority:['nfl']},p,f.ops)).done,true);assert.equal(attempts,2);assert.equal(f.resets.length,1);assert.equal(p.count,1);
});
test('pre-authorization uncertainty does not count as a possible purchase',async()=>{
  const f=fixture(),p={};f.ops.open=async()=>{throw Object.assign(new OperationError('lost',true),{chargePossible:false});};
  await visitGeneral(options,p,f.ops);assert.equal(p.unknown,0);assert.equal(p.spent,0);
});
test('single-pack mode never purchases again after a potentially charged attempt',async()=>{
  const f=fixture(),p={};let attempts=0;f.ops.open=async()=>{attempts++;throw new OperationError('lost',true);};
  await visitGeneral({...options,limit:1},p,f.ops);assert.equal((await visitGeneral({...options,limit:1},p,f.ops)).reason,'limit');assert.equal(attempts,1);
});
test('known opening with listing warning remains counted and refreshes before next opening',async()=>{
  const f=fixture(),p={},events=[];let count=0;f.ops.reset=async()=>events.push('reset');f.ops.open=async()=>{events.push('open');if(++count===1)p.needsReset=true;else f.setBalance(0);};
  await visitGeneral({priority:['nfl']},p,f.ops);assert.deepEqual(events,['open','reset','open']);assert.equal(p.count,2);
});
test('authorization rejection stops only this account for human attention',async()=>{
  const f=fixture(),p={};f.ops.refresh=async()=>{throw Object.assign(new OperationError('login'),{httpStatus:403});};
  const result=await visitGeneral(options,p,f.ops);assert.equal(result.attention,true);assert.equal(result.retry,undefined);assert.equal(f.opened.length,0);
});
test('invalid price or balance never reaches opening',async()=>{
  for(const invalid of ['price','balance']){const f=fixture();if(invalid==='price')f.ops.info=async()=>({cost:NaN});else f.ops.refresh=async()=>null;assert.equal((await visitGeneral(options,{},f.ops)).attention,true);assert.equal(f.opened.length,0);}
});
test('disk errors and internal defects stop rather than loop purchases',async()=>{
  const f=fixture();for(const error of [new Error('bug'),Object.assign(new OperationError('disk'),{code:'STORAGE'})]){
    f.ops.save=async()=>{throw error;};await assert.rejects(visitGeneral({...options,limit:1},{},f.ops),e=>e===error);
  }
});
test('transient failure retries the same account before serving the next',async()=>{
  const visits=[];let now=0,first=true;
  await scheduleGeneral(['a','b'],{now:()=>now,pause:async ms=>now+=ms,visit:async item=>{visits.push(item);if(item==='a'&&first){first=false;return {retry:true,delayMs:2000};}return {done:true};}});
  assert.deepEqual(visits,['a','a','b']);assert.equal(now,2000);
});
test('final fresh check returns to a priority league after incoming balance',async()=>{
  let balance=0,resets=0;const opened=[],p={needsReset:true};
  const result=await visitGeneral(options,p,{finalCheck:true,refresh:async()=>balance,info:async()=>({cost:200}),reset:async()=>{if(++resets===2)balance=200;},open:async s=>{opened.push(s);balance-=200;}});
  assert.equal(result.done,true);assert.deepEqual(opened,['nfl']);assert.equal(p.completed,true);assert.equal(resets,3);
  assert.equal(p.leagues.nfl.count,1);assert.equal(p.leagues.ufc.state,'done');assert.equal(p.leagues.nfl.evidence,'balance');
});
test('an unconfirmed Real UI limit is retried and cannot complete an account',async()=>{
  const p={};const result=await visitGeneral({priority:['nfl']},p,{refresh:async()=>500,info:async()=>({cost:200,disabled:'Daily limit',packImage:'nfl'}),confirmUnavailable:async()=>false,reset:async()=>{}});
  assert.equal(result.retry,true);assert.equal(p.completed,undefined);assert.equal(p.cursor,0);assert.equal(p.exhausted.length,0);
});
test('a disabled league is revalidated on fresh page before account completion',async()=>{
  let checks=0,resets=0;const p={needsReset:true};
  await visitGeneral({priority:['nfl']},p,{finalCheck:true,refresh:async()=>500,info:async()=>({cost:200,disabled:'Daily limit',packImage:'nfl'}),confirmUnavailable:async()=>{checks++;return true;},reset:async()=>resets++});
  assert.equal(checks,2);assert.equal(resets,4);assert.equal(p.completed,true);assert.equal(p.leagues.nfl.evidence,'Real UI');
});
test('attention on first account never starts the next account',async()=>{
  const visits=[];const result=await scheduleGeneral(['a','b'],{visit:async a=>{visits.push(a);return {attention:true,message:'403'};}});
  assert.deepEqual(visits,['a']);assert.equal(result.attention,true);
});
test('cancellation interrupts recovery wait and prevents new purchases',async()=>{
  let stop=false,visits=0;
  await scheduleGeneral(['a','b'],{stopped:()=>stop,visit:async()=>{visits++;return {retry:true,delayMs:2000};},pause:async()=>{stop=true;}});assert.equal(visits,1);
  const f=fixture();f.ops.stopped=()=>true;assert.equal((await visitGeneral(options,{},f.ops)).cancelled,true);assert.equal(f.opened.length,0);
});
test('retries back off without count cap and respect Retry-After',async()=>{
  assert.equal(generalBackoff(1),2000);assert.equal(generalBackoff(50),120000);
  const f=fixture(),p={};f.ops.refresh=async()=>{throw Object.assign(new OperationError('429'),{retryAfterMs:90000});};
  assert.equal((await visitGeneral(options,p,f.ops)).delayMs,90000);
});
test('server routes only General to resilience and listing warning preserves known purchase',async()=>{
  const source=await fs.readFile(new URL('./server.mjs',import.meta.url),'utf8');
  assert.match(source,/if\(isResilientGeneral\(job\)\)return runResilientGeneral\(job\)/);
  const openCode=source.slice(source.indexOf('async function openOne('),source.indexOf('async function createJob('));
  const item={generalProgress:{warnings:[]}},account={id:'a',name:'Alice',balance:500,purchaseHold:true};let saved=0,listAttempts=0;
  const job={id:'job',type:'max',settings:{generalResilience:true,autoList:true}};
  const context={OperationError,LEAGUES:{nfl:'NFL'},isResilientGeneral:j=>['open','max'].includes(j.type)&&j.settings.generalResilience,requiresGeneralAttention:e=>!!e.requiresAttention,shuttingDown:false,verifyAccount:async()=>{throw Error('verified info must avoid duplicate verification');},getPackHistory:async()=>[],browserCommand:async action=>{if(action==='list'){listAttempts++;throw new OperationError('Quick list failed',true);}return {cost:200,openCommandId:'open'};},saveJobHistory:async()=>saved++,recoverNewPack:async()=>({id:10,cards:[]}),publicCard:c=>c,preparePackQuickList:async()=>({records:[]}),store:{saveAccounts:async()=>{}}};
  vm.runInNewContext(openCode+';globalThis.openOne=openOne;',context);
  await context.openOne(job,item,account,'nfl',200,{cost:200,packImage:'assets/packs/test',description:'pack'});
  assert.equal(item.packs.length,1);assert.equal(listAttempts,1);assert.equal(item.generalProgress.needsReset,true);assert.match(item.generalProgress.warnings[0].message,/Quick list/);assert.ok(saved>0);
  await assert.rejects(context.openOne({...job,type:'player'},item,account,'nfl',200,{}),/остановлена до покупки/);
});
test('server General batch recovers unknown results, finishes leagues, then starts next account',async()=>{
  const source=await fs.readFile(new URL('./server.mjs',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function runResilientGeneral('),source.indexOf('async function openOne('));
  const events=[],accounts=new Map(['a','b'].map(id=>[id,{id,name:id,balance:2000,seasons:{nfl:'2026',ufc:'2023'}}]));let failed=false,clock=0;
  const counts=new Map();const count=(a,s)=>counts.get(a.id+':'+s)||0;
  const context={OperationError,LEAGUES:{nfl:'NFL',ufc:'UFC'},visitGeneral,scheduleGeneral:(items,ops)=>scheduleGeneral(items,{...ops,now:()=>clock,pause:async ms=>clock+=ms}),shuttingDown:false,saveJobHistory:async()=>{},verifyAccount:async()=>{},getLeagueCatalog:async()=>{},getPackInfo:async(a,s)=>({cost:200,packImage:s,description:'General',disabled:count(a,s)>=(s==='nfl'?2:1)?'Daily limit':null}),store:{accounts,saveAccounts:async()=>{}},browserCommand:async(action,payload)=>{events.push([action,payload.accountId]);return action==='reset'?{reset:true}:{unavailable:true,accountId:payload.accountId,sport:payload.sport};},openOne:async(job,item,a,s,cost)=>{
    events.push(['open',a.id]);if(!failed){failed=true;throw Object.assign(new OperationError('lost summary',true),{chargePossible:true});}
    counts.set(a.id+':'+s,count(a,s)+1);a.balance-=cost;item.packs.push({sport:s,cost});
  }};
  vm.runInNewContext(code+';globalThis.run=runResilientGeneral;',context);
  const job={id:'j',type:'max',settings:{priority:['nfl','ufc'],generalResilience:true,generalNoLimit:true},items:['a','b'].map(id=>({accountId:id,accountName:id,status:'queued'}))};
  await context.run(job);assert.equal(job.status,'done');assert.equal(job.items[0].status,'warning');assert.equal(job.items[1].status,'success');
  for(const item of job.items){assert.equal(item.generalProgress.completed,true);assert.equal(item.generalProgress.count,3);assert.equal(item.generalProgress.leagues.nfl.count,2);assert.equal(item.generalProgress.leagues.ufc.count,1);}
  assert.equal(job.items[0].generalProgress.unknown,1);
  const firstB=events.findIndex(([,a])=>a==='b');assert.ok(firstB>0);assert.ok(events.slice(firstB).every(([,a])=>a==='b'));assert.equal(events[firstB][0],'reset');
});
