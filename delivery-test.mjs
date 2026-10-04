import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { CommandNotifier } from './command-notifier.mjs';

test('ready command wakes a receiver that arrived during preflight',async()=>{
  const notifier=new CommandNotifier();let command;
  const start=performance.now();
  const result=notifier.wait(()=>command,5000);
  assert.equal(notifier.waitingCount,1);
  command={id:'ready'};notifier.notify();
  assert.equal((await result).id,'ready');assert.ok(performance.now()-start<500);
  assert.equal(notifier.waitingCount,0);
});
test('already ready command is delivered without waiting',async()=>{
  const notifier=new CommandNotifier();assert.equal(await notifier.wait(()=>42,5000),42);assert.equal(notifier.waitingCount,0);
});
test('one command is claimed by only one of two waiting receivers',async()=>{
  const notifier=new CommandNotifier();let ready=false,claimed=false;
  const take=()=>{if(ready&&!claimed){claimed=true;return {id:'once'};}};
  const first=notifier.wait(take,30),second=notifier.wait(take,30);
  ready=true;notifier.notify();
  assert.deepEqual(await first,{id:'once'});assert.equal(await second,null);assert.equal(notifier.waitingCount,0);
});
test('disconnect cleans up the receiver and does not claim a later command',async()=>{
  const notifier=new CommandNotifier(),controller=new AbortController();let calls=0;
  const result=notifier.wait(()=>{calls++;},10000,controller.signal);
  controller.abort();await result;const before=calls;notifier.notify();
  assert.equal(notifier.waitingCount,0);assert.equal(calls,before);
});
test('finished job releases the receiver without a permanent idle connection',async()=>{
  const notifier=new CommandNotifier();let busy=true;
  const result=notifier.wait(()=>busy?undefined:{busy:false,command:null},5000);
  busy=false;notifier.notify();assert.equal((await result).busy,false);
  assert.equal(notifier.waitingCount,0);
});

const backgroundCode=await fs.readFile(new URL('./helium-extension/background.js',import.meta.url),'utf8');
async function backgroundFixture(next,execute=()=>({ok:true,snapshot:{}}),probe=()=>({version:'0.3.3',ready:true,active:false}),fastTimeout=false){
  const values={token:'a'.repeat(64),realTabId:1};let listener,alarmListener;
  const requests=[],executions=[],updates=[],reloads=[];
  const context={setInterval,clearInterval,setTimeout:(fn,ms)=>setTimeout(fn,ms===500||fastTimeout&&ms===120000?0:ms),clearTimeout,URL,fetch:async(url,options)=>{
    const route=url.split('/').at(-1),body=JSON.parse(options.body);requests.push({route,body});
    return {ok:true,json:async()=>route==='next'?await next():{ok:true}};
  },chrome:{storage:{session:{get:async key=>typeof key==='string'?{[key]:values[key]}:values,set:async value=>Object.assign(values,value)}},
    tabs:{get:async()=>({id:1,url:'https://realsports.io/',autoDiscardable:true}),sendMessage:async(_id,message)=>{if(message.type==='READY')return probe({reloads});if(message.type==='SNAPSHOT')return {version:'0.3.3'};executions.push(message);return execute(message);},update:async(id,options)=>updates.push({id,options}),reload:async id=>reloads.push(id)},
    runtime:{id:'extension',getManifest:()=>({version:'0.3.3'}),onMessage:{addListener:fn=>listener=fn}},alarms:{create:async()=>{},onAlarm:{addListener:fn=>alarmListener=fn}}}};
  vm.runInNewContext(backgroundCode,context);
  const wake=()=>new Promise(resolve=>listener({type:'WAKE'},{url:'http://127.0.0.1:5127/'},resolve));
  const settle=async()=>{for(let i=0;i<120;i++){await new Promise(resolve=>setTimeout(resolve,0));if(!vm.runInNewContext('polling',context))return;}throw new Error('Worker did not settle');};
  return {wake,settle,requests,executions,values,updates,reloads,alarm:()=>alarmListener({name:'real-manager-poll'})};
}
test('worker waits through preflight timeout and executes once without a 30-second alarm',async()=>{
  const replies=[{command:null,busy:true},{command:{id:'test',action:'check'},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false});
  await worker.wake();await worker.settle();
  assert.equal(worker.executions.length,1);assert.equal(worker.requests.filter(r=>r.route==='next').length,3);
  assert.equal(worker.requests.find(r=>r.route==='next').body.waitMs,20000);
});
test('wake racing with an idle response is not lost',async()=>{
  let release;let count=0;
  const worker=await backgroundFixture(()=>{count++;return count===1?new Promise(resolve=>release=resolve):{command:null,busy:false};});
  await worker.wake();for(let i=0;i<10&&!release;i++)await new Promise(resolve=>setTimeout(resolve,0));
  await worker.wake();release({command:null,busy:false});await worker.settle();assert.equal(count,2);
});
test('lost execute reply never causes a command to execute again',async()=>{
  const replies=[{command:{id:'once',action:'open'},busy:true},{command:{id:'once',action:'open'},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false},()=>{throw new Error('reply lost');});
  await worker.wake();await worker.settle();assert.equal(worker.executions.length,1);
  const results=worker.requests.filter(r=>r.route==='result');assert.equal(results.length,2);
  assert.equal(results[0].body.result.uncertain,true);assert.equal(results[1].body.result.uncertain,true);
  assert.equal(worker.reloads.length,0);
  assert.ok(worker.updates.every(u=>u.options.active===undefined));
});

test('certified pre-activation navigation timeout refreshes and retries only once',async()=>{
  const command={id:'recover',action:'open',expiresAt:Date.now()+60000};
  const replies=[{command,busy:true},{command:null,busy:false}];let tries=0;
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false},()=>++tries===1?{ok:false,uncertain:false,recoverable:true}:{ok:true,pack:{}});
  await worker.wake();await worker.settle();assert.equal(worker.reloads.length,1);assert.equal(worker.executions.length,2);
  assert.equal(worker.requests.find(r=>r.route==='result').body.result.ok,true);
  assert.ok(worker.updates.every(u=>u.options.active===undefined));
  assert.equal(worker.updates.at(-1).options.autoDiscardable,true);
});
test('persistent navigation failure stops after one recovery, never loops',async()=>{
  const replies=[{command:{id:'twice',action:'open',expiresAt:Date.now()+60000},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false},()=>({ok:false,uncertain:false,recoverable:true}));
  await worker.wake();await worker.settle();assert.equal(worker.reloads.length,1);assert.equal(worker.executions.length,2);
});
test('listing failures never reload the summary or retry',async()=>{
  const replies=[{command:{id:'list',action:'list',expiresAt:Date.now()+60000},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false},()=>({ok:false,uncertain:false,recoverable:true}));
  await worker.wake();await worker.settle();assert.equal(worker.reloads.length,0);assert.equal(worker.executions.length,1);
});
test('missing receiver is refreshed before any execution and then command is sent once',async()=>{
  const replies=[{command:{id:'not-delivered',action:'open'},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false},()=>({ok:true}),({reloads})=>{if(!reloads.length)throw Error('receiver missing');return {version:'0.3.3',ready:true};});
  await worker.wake();await worker.settle();assert.equal(worker.reloads.length,1);assert.equal(worker.executions.length,1);
});
test('active content task prevents reload and new execution',async()=>{
  const replies=[{command:{id:'busy',action:'open'},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false},()=>({ok:true}),()=>({version:'0.3.3',active:true,ready:true}));
  await worker.wake();await worker.settle();assert.equal(worker.reloads.length,0);assert.equal(worker.executions.length,0);
  assert.equal(worker.requests.find(r=>r.route==='result').body.result.uncertain,false);
});
test('unavailable listing receiver is not refreshed because the summary must survive',async()=>{
  const replies=[{command:{id:'summary',action:'list'},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false},()=>({ok:true}),()=>{throw Error('receiver missing');});
  await worker.wake();await worker.settle();assert.equal(worker.reloads.length,0);assert.equal(worker.executions.length,0);
});

test('General reset refreshes an abandoned active task without executing a purchase',async()=>{
  const replies=[{command:{id:'reset',action:'reset',generalRecovery:true},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false},()=>{throw Error('must not EXECUTE');},({reloads})=>({version:'0.3.3',ready:true,active:!reloads.length}));
  await worker.wake();await worker.settle();assert.equal(worker.reloads.length,1);assert.equal(worker.executions.length,0);
  assert.equal(worker.requests.find(r=>r.route==='result').body.result.snapshot.reset,true);
  assert.ok(worker.updates.every(u=>u.options.active===undefined));
});
test('recovery command without General scope cannot refresh',async()=>{
  const replies=[{command:{id:'invalid-reset',action:'reset'},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false});
  await worker.wake();await worker.settle();assert.equal(worker.reloads.length,0);assert.equal(worker.executions.length,0);assert.equal(worker.requests.find(r=>r.route==='result').body.result.ok,false);
});
test('login or security check returns manual attention, without refreshing or executing',async()=>{
  const replies=[{command:{id:'login',action:'open'},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false},()=>({ok:true}),()=>({version:'0.3.3',requiresAttention:true,ready:false}));
  await worker.wake();await worker.settle();assert.equal(worker.reloads.length,0);assert.equal(worker.executions.length,0);assert.equal(worker.requests.find(r=>r.route==='result').body.result.requiresAttention,true);
});
test('a permanently lost execute reply times out once, never replaying that command',async()=>{
  const replies=[{command:{id:'hang',action:'open'},busy:true},{command:null,busy:false}];
  const worker=await backgroundFixture(()=>replies.shift()||{command:null,busy:false},()=>new Promise(()=>{}),undefined,true);
  await worker.wake();await worker.settle();assert.equal(worker.executions.length,1);assert.equal(worker.reloads.length,0);assert.equal(worker.requests.find(r=>r.route==='result').body.result.uncertain,true);
});
