import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {realRequest,parseHar} from './core.mjs';
const scope={};vm.runInNewContext(await fs.readFile(new URL('./helium-extension/workflow.js',import.meta.url),'utf8'),scope);
const flow=scope.RealManagerWorkflow;
const command=()=>({id:'test',accountId:'alpha',accountName:'Alice',sport:'nfl',cost:200,expiresAt:Date.now()+10000});
function mock({id='alpha',cost=200,sport='nfl',switchWorks=true,failAt=null}={}){
  const calls=[];
  const step=name=>{calls.push(name);if(failAt===name)throw new Error('test '+name);};
  return {calls,ui:{
    accountId:async()=>id,
    switchAccount:async()=>{step('switch');if(switchWorks)id='alpha';},
    preparePack:async()=>{step('prepare');return {sport,kind:'general',cost};},
    activate:async()=>step('activate'),authorize:async()=>step('authorize'),purchaseOnce:async()=>step('purchase'),
    revealSummary:async()=>{step('summary');return {cardCount:7,summaryText:'Pack summary\nPlayer\nDone'};},
  }};
}
test('browser workflow opens once and returns a confirmed summary',async()=>{
  const m=mock(),result=await flow.open(command(),m.ui);
  assert.equal(result.ok,true);assert.equal(result.pack.cardCount,7);
  assert.deepEqual(m.calls,['prepare','activate','authorize','purchase','summary']);
});
test('interface check never activates, authorizes, or purchases a pack',async()=>{
  const m=mock(),result=await flow.check(command(),m.ui);assert.equal(result.ok,true);assert.equal(result.snapshot.checked,true);
  assert.deepEqual(m.calls,['prepare']);
});
test('interface check can switch accounts without buying anything',async()=>{
  const m=mock({id:'beta'}),result=await flow.check(command(),m.ui);assert.equal(result.ok,true);assert.deepEqual(m.calls,['switch','prepare']);
});
test('interface check closes its unactivated pack dialog before completing',async()=>{
  const m=mock();m.ui.finishCheck=async()=>m.calls.push('close');const result=await flow.check(command(),m.ui);
  assert.equal(result.ok,true);assert.deepEqual(m.calls,['prepare','close']);
});
test('browser workflow switches to selected identity before preparing a pack',async()=>{
  const m=mock({id:'beta'});assert.equal((await flow.open(command(),m.ui)).ok,true);assert.equal(m.calls[0],'switch');
});
test('failed account switch never reaches the shop or purchase',async()=>{
  const m=mock({id:'beta',switchWorks:false}),r=await flow.open(command(),m.ui);
  assert.equal(r.ok,false);assert.equal(r.uncertain,false);assert.deepEqual(m.calls,['switch']);
});
for(const options of [{cost:300},{sport:'ufc'}])test('different visible price/league prevents activation '+JSON.stringify(options),async()=>{
  const m=mock(options),r=await flow.open(command(),m.ui);assert.equal(r.ok,false);assert.deepEqual(m.calls,['prepare']);
});
test('expired commands cannot purchase',async()=>{
  const m=mock(),c=command();c.expiresAt=Date.now()-1;assert.equal((await flow.open(c,m.ui)).ok,false);assert.deepEqual(m.calls,[]);
});
test('cancelled authorization cannot purchase',async()=>{
  const m=mock({failAt:'authorize'}),r=await flow.open(command(),m.ui);assert.equal(r.uncertain,false);assert.ok(!m.calls.includes('purchase'));
});
test('lost purchase reply is uncertain and never retries',async()=>{
  const m=mock({failAt:'purchase'}),r=await flow.open(command(),m.ui);assert.equal(r.uncertain,true);assert.equal(m.calls.filter(c=>c==='purchase').length,1);
});
test('failed summary after a click is uncertain',async()=>{
  const m=mock({failAt:'summary'}),r=await flow.open(command(),m.ui);assert.equal(r.uncertain,true);assert.equal(m.calls.filter(c=>c==='purchase').length,1);
});
test('only a certified timeout before activation permits page recovery',async()=>{
  const m=mock();m.ui.preparePack=async()=>{const e=new Error('loading timeout');e.recoverable=true;throw e;};
  const r=await flow.open(command(),m.ui);assert.equal(r.uncertain,false);assert.equal(r.recoverable,true);
  m.ui.interrupted=()=>true;assert.equal((await flow.open(command(),m.ui)).recoverable,false);
});
for(const stage of ['activate','authorize','purchaseOnce','revealSummary'])test('recovery is forbidden after reaching '+stage,async()=>{
  const m=mock();m.ui[stage]=async()=>{const e=new Error('timeout');e.recoverable=true;throw e;};
  assert.equal((await flow.open(command(),m.ui)).recoverable,false);
});
test('semantic validation errors never trigger a refresh/retry',async()=>{
  for(const options of [{cost:300},{sport:'ufc'},{id:'beta',switchWorks:false}]){
    const r=await flow.open(command(),mock(options).ui);assert.equal(r.recoverable,false);
  }
});
test('official server free price works without modifying the UI price',async()=>{
  const m=mock({cost:0}),c=command();c.cost=0;assert.equal((await flow.open(c,m.ui)).ok,true);
});
test('native Real transport refuses all purchases before network access',()=>{
  assert.throws(()=>realRequest({headers:{}},'POST','/collectingpacks/general',{cost:200}),/служебном браузере/);
});
test('HAR import discards browser challenge and replay tokens',()=>{
  const a=parseHar({log:{entries:[{request:{url:'https://web.realapp.com/user',method:'GET',headers:[{name:'real-auth-info',value:'secret'},{name:'real-turnstile-token',value:'discard'},{name:'real-request-token',value:'discard'}]},response:{status:200,content:{text:JSON.stringify({user:{id:'alpha'}})}}}]}})[0];
  assert.equal(a.headers['real-turnstile-token'],undefined);assert.equal(a.headers['real-request-token'],undefined);
});
