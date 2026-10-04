import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {DEFAULT_SETTINGS,validateSettings,recoverNewPack,preparePackQuickList} from './automation.mjs';
import {getPlayerPackInfo,getOwnedPackPlayers} from './core.mjs';
const owner=()=>({id:'owner',name:'Alice',balance:1000,seasons:{wnba:'2026'},packs:{}});
const info={packIdentifer:'player',sport:'wnba',season:'2026',entityId:'650',packEntityId:'650',cost:200,packBackgroundSource:'assets/packs/wnbaplayer3general.png',description:'Includes 3 N. Collier 2026 cards',packLabel:'Napheesa Collier',secondaryDescription:'5 packs remaining today.'};
test('Player pack price checks exact player, season, type and league using GET only',async()=>{
  const calls=[],request=async(_a,method,path)=>{calls.push([method,path]);return {info};};
  const pack=await getPlayerPackInfo(owner(),'wnba',650,request);assert.equal(pack.cost,200);assert.equal(pack.playerName,'Napheesa Collier');assert.equal(calls[0][0],'GET');assert.match(calls[0][1],/entityId=650&season=2026&sport=wnba/);
  for(const change of [{entityId:651,packEntityId:651},{sport:'nba'},{season:2025},{packIdentifer:'general'},{cost:-1},{packBackgroundSource:'https://bad.example/img'},{packLabel:''}])await assert.rejects(getPlayerPackInfo(owner(),'wnba',650,async()=>({info:{...info,...change}})));
});
test('Player pack selections persist separately for each account and sport; old rules migrate safely',()=>{
  assert.deepEqual(validateSettings({}).playerPacks,[]);
  const target={accountId:'owner',sport:'wnba',id:650,name:'Napheesa Collier',count:2};
  const settings=validateSettings({...DEFAULT_SETTINGS,playerPacks:[target,{...target,accountId:'other'},{...target,sport:'nba'}]});assert.equal(settings.playerPacks.length,3);
  for(const p of [{...target,count:0},{...target,count:101},{...target,sport:'ufc'},{...target,id:0},{...target,accountId:'bad/path'}])assert.throws(()=>validateSettings({playerPacks:[p]}));
  assert.throws(()=>validateSettings({playerPacks:[target,target]}));
});
test('Owned player choices reject another account, sport, season or entity type',async()=>{
  const pass={userId:'owner',sport:'wnba',season:2026,entityType:'player',entityId:650,label:'Napheesa Collier'};
  const mock=passes=>async(_a,method,path)=>{assert.equal(method,'GET');if(path==='/user')return {user:{id:'owner',virtualCurrencyBalance:1000}};if(path.startsWith('/collecting/'))return {info:{sportSeasonMap:{wnba:[{id:2026}]}}};return {passes};};
  assert.deepEqual(await getOwnedPackPlayers(owner(),'wnba',mock([pass,pass])),[{id:650,sport:'wnba',entityType:'player',name:'Napheesa Collier'}]);
  for(const change of [{userId:'other'},{sport:'nba'},{season:2025},{entityType:'team'}])await assert.rejects(getOwnedPackPlayers(owner(),'wnba',mock([{...pass,...change}])));
});
const scope={};vm.runInNewContext(await fs.readFile(new URL('./helium-extension/workflow.js',import.meta.url),'utf8'),scope);
function fixture(change={}){
  const c={id:'command',kind:'player',playerId:650,playerName:'Napheesa Collier',accountId:'owner',sport:'wnba',cost:200,keepSummary:false,expiresAt:Date.now()+10000},calls=[];
  const ui={accountId:async()=>c.accountId,switchAccount:async()=>calls.push('switch'),preparePack:async()=>({sport:'wnba',kind:'player',playerId:650,cost:200,...change}),activate:async()=>calls.push('activate'),authorize:async()=>calls.push('authorize'),purchaseOnce:async()=>calls.push('purchase'),revealSummary:async()=>{calls.push('summary-and-done');return {cardCount:3,summaryText:'Pack summary Napheesa Collier'};}};
  return {c,calls,ui};
}
test('Player UI opens exactly once, leaves all cards and never invokes a listing action',async()=>{
  const f=fixture(),r=await scope.RealManagerWorkflow.open(f.c,f.ui);assert.equal(r.ok,true);assert.deepEqual(f.calls,['activate','authorize','purchase','summary-and-done']);
});
test('Wrong player/type/price and listing-enabled player command cannot purchase',async()=>{
  for(const change of [{playerId:651},{kind:'general'},{cost:270},{sport:'nba'}]){const f=fixture(change);assert.equal((await scope.RealManagerWorkflow.open(f.c,f.ui)).ok,false);assert.deepEqual(f.calls,[]);}
  const f=fixture();f.c.keepSummary=true;assert.equal((await scope.RealManagerWorkflow.open(f.c,f.ui)).ok,false);assert.deepEqual(f.calls,[]);
});
test('Player pack recovery does not accept a new general pack',async()=>{
  const request=async(_a,_m,path)=>path.endsWith('packhistory')?{packs:[{type:'mintpack',packId:77,packIdentifer:'general',user:{id:'owner'}}]}:{cards:[]};
  await assert.rejects(recoverNewPack(owner(),'wnba',[],request,{kind:'player'}));
});
test('Quick list matches full player names rather than API abbreviations',async()=>{
  const plan=await preparePackQuickList(owner(),77,[{id:1,userId:'owner',cardPackId:77,sport:'wnba',canList:true,mintNumber:1,primaryPlayer:{id:650,displayName:'N. Collier',firstName:'Napheesa',lastName:'Collier'},team:{id:5,name:'Lynx'}}],DEFAULT_SETTINGS);
  assert.deepEqual(plan.cards[0].names,['Napheesa Collier']);
});
test('Player interface check never activates or purchases and returns the exact player',async()=>{const f=fixture();f.ui.finishCheck=async()=>f.calls.push('cancel-dialog');const r=await scope.RealManagerWorkflow.check(f.c,f.ui);assert.equal(r.ok,true);assert.equal(r.snapshot.playerId,650);assert.deepEqual(f.calls,['cancel-dialog']);});
