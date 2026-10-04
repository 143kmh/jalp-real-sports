import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateSettings,DEFAULT_SETTINGS,keepReason,recoverNewPack,listNewCards,runMaximum} from './automation.mjs';
import {getLeagueCatalog,getPackInfo,searchPlayers,listingRequest,realRequest} from './core.mjs';
const settings=extra=>validateSettings({...DEFAULT_SETTINGS,...extra});
const account=()=>({id:'owner',name:'Alice',headers:{},balance:500,packs:{},seasons:{nfl:'2026',ufc:'2023'}});
const card=(id=1)=>({id,userId:'owner',cardPackId:100,sport:'nfl',canList:true,primaryPlayer:{id:10},secondaryPlayer:{id:20},entityType:'play',entityId:30});
function listingFixture(extra={}){
  const calls=[],records=[];let writes=0;
  return {calls,records,request:async(_a,_method,path)=>{
    calls.push(path);if(path==='/user')return {user:{id:'owner',virtualCurrencyBalance:500}};
    return {info:{canCreate:true,minBidPrice:10,durationOptions:[{value:24}]}};
  },listing:async(_a,path,body)=>{
    calls.push({path,body});
    if(path==='/quicklist/preview')return {config:{durationOptions:[{value:24}],pricingModeOptions:[{value:'default'},{value:'min'},{value:'max'}]},previews:body.cardIds.map(cardId=>({cardId,sport:'nfl',canQuickList:true,suggestedListPrice:89,priceDisplayByMode:{default:'80 min · 110'}})),...extra.preview};
    writes++;if(extra.fail)throw Object.assign(new Error('Lost reply'),{uncertain:true});
    return path==='/quicklist'?{success:true,listings:body.cardIds.map(cardId=>({cardId,listingId:null}))}:{listing:{id:700}};
  },save:async()=>{calls.push('save');},get writes(){return writes;}};
}
test('settings validate leagues, limits, modes and protected identifiers',()=>{
  assert.equal(settings({pricingMode:'suggested'}).pricingMode,'suggested');
  for(const bad of [{priority:[]},{priority:['nfl','nfl']},{priority:['unknown']},{maxPacks:0},{maxPacks:1001},{autoList:'true'},{protectedCardIds:['1']},{protectedPlayers:[{id:1,sport:'nfl',entityType:'player',name:''}]}])assert.throws(()=>settings(bad));
});
test('protection applies to either participant, the correct sport and individual cards',()=>{
  const p={id:20,sport:'nfl',entityType:'player',name:'Bob'};
  assert.match(keepReason(card(),settings({protectedPlayers:[p]})),/Защищённый/);
  assert.equal(keepReason(card(),settings({protectedPlayers:[{...p,sport:'nba'}]})),null);
  assert.match(keepReason(card(),settings({protectedCardIds:[1]})),/отдельно/);
  assert.match(keepReason({...card(),untouchable:true},settings()),/Untouchable/);
  assert.match(keepReason({...card(),canList:false},settings()),/не разрешает/);
});
test('UFC fighters are protected using team IDs including the opponent',()=>{
  const c={...card(),sport:'ufc',primaryPlayer:null,secondaryPlayer:null,opponentTeam:{id:483}};
  assert.match(keepReason(c,settings({protectedPlayers:[{id:483,sport:'ufc',entityType:'team',name:'Fighter'}]})),/Защищённый/);
});
test('new pack must be unique and belong to this account',async()=>{
  const before=[{packId:99}],request=async(_a,_m,path)=>path.endsWith('/packhistory')?{packs:[{packId:100,type:'mintpack',packIdentifer:'general',user:{id:'owner'}}]}:{cards:[card()]};
  assert.equal((await recoverNewPack(account(),'nfl',before,request)).id,100);
  await assert.rejects(recoverNewPack(account(),'nfl',before,async()=>({packs:[{packId:100,user:{id:'other'}}]})),/другой аккаунт/);
  await assert.rejects(recoverNewPack(account(),'nfl',before,async()=>({packs:[100,101].map(packId=>({packId,type:'mintpack',user:{id:'owner'}}))})),/однозначно/);
  await assert.rejects(recoverNewPack(account(),'nfl',before,async(_a,_m,path)=>path.endsWith('/packhistory')?{packs:[{packId:100,type:'mintpack',packIdentifer:'general',user:{id:'owner'}}]}:{cards:[{...card(),userId:'other'}]}),/владельца/);
});
test('confirmed pack history can settle without replaying a purchase or listing',async()=>{
  let reads=0;const pauses=[];
  const request=async(_a,method,path)=>{assert.equal(method,'GET');return path.endsWith('/packhistory')?{packs:++reads<3?[]:[{packId:100,type:'mintpack',packIdentifer:'general',user:{id:'owner'}}]}:{cards:[card()]};};
  assert.equal((await recoverNewPack(account(),'nfl',[],request,{kind:'general',retryDelays:[250,750],pause:async ms=>pauses.push(ms)})).id,100);
  assert.deepEqual(pauses,[250,750]);assert.equal(reads,3);
  await assert.rejects(recoverNewPack(account(),'nfl',[],request,{kind:'general',stopped:()=>true}),/остановлена/);
});
test('old or foreign cards never reach a listing endpoint',async()=>{
  const f=listingFixture();await assert.rejects(listNewCards(account(),100,[{...card(),cardPackId:99}],settings(),f),/нового пака/);assert.equal(f.calls.length,0);
});
for(const mode of ['default','min','max'])test('Quick list uses selected pricing mode and exactly 24 hours: '+mode,async()=>{
  const f=listingFixture();await listNewCards(account(),100,[card()],settings({pricingMode:mode}),f);
  const post=f.calls.find(c=>c.path==='/quicklist');assert.equal(post.body.pricingMode,mode);assert.equal(post.body.durationInHours,24);assert.equal(f.records[0].status,'queued');assert.equal(f.writes,1);
  assert.ok(f.calls.indexOf('save')<f.calls.indexOf(post));
});
test('Suggested price lists individually without auctions and keeps an available recommendation',async()=>{
  const f=listingFixture();await listNewCards(account(),100,[card()],settings({pricingMode:'suggested'}),f);
  const post=f.calls.find(c=>c.path==='/cardmarketplacelistings');assert.equal(post.body.buyNowPrice,89);assert.equal(post.body.allowBids,false);assert.equal(post.body.durationInHours,24);assert.equal(f.records[0].status,'listed');
  assert.equal(f.records[0].priceSource,'suggested');
});
test('Missing Suggested price falls back to the Real minimum for 24 hours without an auction',async()=>{
  for(const suggestedListPrice of [undefined,null,0]){
    const f=listingFixture({preview:{previews:[{cardId:1,sport:'nfl',canQuickList:true,suggestedListPrice}]}});
    await listNewCards(account(),100,[card()],settings({pricingMode:'suggested'}),f);
    const post=f.calls.find(c=>c.path==='/cardmarketplacelistings');
    assert.equal(post.body.buyNowPrice,10);assert.equal(post.body.minBidPrice,10);assert.equal(post.body.allowBids,false);assert.equal(post.body.durationInHours,24);
    assert.equal(f.records[0].priceSource,'minimum');assert.match(f.records[0].message,/минимальная цена Real/);assert.equal(f.writes,1);
  }
});
test('Suggested fallback never guesses a missing minimum or bypasses listing restrictions',async()=>{
  for(const info of [
    {canCreate:true,durationOptions:[{value:24}]},
    {canCreate:true,minBidPrice:null,durationOptions:[{value:24}]},
    {canCreate:true,minBidPrice:NaN,durationOptions:[{value:24}]},
    {canCreate:true,minBidPrice:-1,durationOptions:[{value:24}]},
    {canCreate:true,minBidPrice:0,durationOptions:[{value:24}]},
    {canCreate:false,minBidPrice:10,durationOptions:[{value:24}]},
    {canCreate:true,minBidPrice:10,durationOptions:[{value:48}]},
  ]){
    const f=listingFixture({preview:{previews:[{cardId:1,sport:'nfl',canQuickList:true,suggestedListPrice:null}]}});
    f.request=async(_a,_m,path)=>path==='/user'?{user:{id:'owner',virtualCurrencyBalance:500}}:{info};
    await assert.rejects(listNewCards(account(),100,[card()],settings({pricingMode:'suggested'}),f));assert.equal(f.writes,0);
  }
});
test('Suggested below the Real minimum is rejected rather than silently repriced',async()=>{
  const f=listingFixture({preview:{previews:[{cardId:1,sport:'nfl',canQuickList:true,suggestedListPrice:5}]}});
  await assert.rejects(listNewCards(account(),100,[card()],settings({pricingMode:'suggested'}),f));assert.equal(f.writes,0);
});
test('protected cards are retained and are excluded even from preview',async()=>{
  const f=listingFixture();await listNewCards(account(),100,[card(1),card(2)],settings({protectedCardIds:[1]}),f);
  assert.deepEqual(f.calls.find(c=>c.path==='/quicklist/preview').body.cardIds,[2]);assert.equal(f.records.find(r=>r.cardId===1).status,'kept');
});
test('preview cardinality, duration and entitlement changes prevent listing',async()=>{
  for(const preview of [{previews:[]},{config:{durationOptions:[{value:48}]}},{previews:[{cardId:2,sport:'nfl',canQuickList:true}]}]){
    const f=listingFixture({preview});await assert.rejects(listNewCards(account(),100,[card()],settings(),f));assert.equal(f.writes,0);
  }
  const blocked=listingFixture();blocked.request=async(_a,_m,path)=>path==='/user'?{user:{id:'owner',virtualCurrencyBalance:500}}:{info:{canCreate:false}};
  await assert.rejects(listNewCards(account(),100,[card()],settings({pricingMode:'suggested'}),blocked));assert.equal(blocked.writes,0);
});
test('lost listing reply is uncertain and is not retried',async()=>{
  const f=listingFixture({fail:true});await assert.rejects(listNewCards(account(),100,[card()],settings(),f),/Lost reply/);assert.equal(f.writes,1);assert.equal(f.records[0].status,'uncertain');
});
test('cancellation prevents marketplace writes',async()=>{
  const f=listingFixture();await listNewCards(account(),100,[card()],settings(),{...f,cancelled:()=>true});assert.equal(f.writes,0);
});
test('maximum drains the first league before proceeding, within frozen budget',async()=>{
  const opened=[];let remaining=550;
  const result=await runMaximum({priority:['nfl','ufc'],budget:550,maxPacks:100},{info:async s=>({cost:s==='nfl'?200:100}),balance:async()=>remaining,open:async(s,cost)=>{opened.push(s);remaining-=cost;}});
  assert.deepEqual(opened,['nfl','nfl','ufc']);assert.equal(result.spent,500);assert.equal(result.count,3);
});
test('maximum stops a disabled league and never spends later income',async()=>{
  const opened=[];
  const result=await runMaximum({priority:['nfl','ufc'],budget:250,maxPacks:100},{info:async s=>({cost:100,disabled:s==='nfl'?'Daily cap':null}),balance:async()=>10000,open:async s=>opened.push(s)});
  assert.deepEqual(opened,['ufc','ufc']);assert.equal(result.spent,200);
});
test('free packs respect visible safety limit and cancellation',async()=>{
  let count=0;const io={info:async()=>({cost:0}),balance:async()=>0,open:async()=>count++};
  assert.equal((await runMaximum({priority:['nfl'],budget:0,maxPacks:3},io)).limitReached,true);assert.equal(count,3);
  count=0;await runMaximum({priority:['nfl'],budget:500,maxPacks:100},{...io,stopped:()=>count===1});assert.equal(count,1);
});
test('failed/uncertain purchase is not retried or followed by another league',async()=>{
  let count=0;await assert.rejects(runMaximum({priority:['nfl','ufc'],budget:500,maxPacks:100},{info:async()=>({cost:100}),balance:async()=>500,open:async()=>{count++;throw new Error('uncertain');}}));assert.equal(count,1);
});
test('current seasons come from Real and soccer pack metadata is validated',async()=>{
  const a=account();await getLeagueCatalog(a,async()=>({info:{sportSeasonMap:{soccer:[{id:2026}],nba:[{id:2027}],fifa:[]}}}));assert.equal(a.seasons.soccer,'2026');assert.equal(a.seasons.fifa,undefined);
  const p=await getPackInfo(a,'soccer',async(_a,_m,path)=>{assert.match(path,/season=2026&sport=soccer/);return {info:{sport:'soccer',season:'2026',cost:200}};});assert.equal(p.cost,200);
});
test('search returns stable protected-player IDs and searches UFC teams',async()=>{
  assert.equal((await searchPlayers(account(),'nfl','Josh',async()=>({players:[{id:10,firstName:'Josh',lastName:'Allen'}]})))[0].name,'Josh Allen');
  const found=await searchPlayers(account(),'ufc','Karo',async(_a,_m,path)=>{assert.match(path,/teams\/sport\/ufc\/search/);return {teams:[{id:483,name:'Karo Parisyan'}]};});assert.equal(found[0].entityType,'team');
});
test('listing transport cannot mint, change duration or mix fixed-price auctions',()=>{
  assert.throws(()=>realRequest(account(),'POST','/collectingpacks/general',{}),/служебном браузере/);
  assert.throws(()=>listingRequest(account(),'/collectingpacks/general',{cardIds:[1]}));
  assert.throws(()=>listingRequest(account(),'/quicklist',{cardIds:[1],durationInHours:72,pricingMode:'default'}),/24/);
  assert.throws(()=>listingRequest(account(),'/cardmarketplacelistings',{cardId:1,listingType:'card',allowBids:true,durationInHours:24,minBidPrice:80,buyNowPrice:80}));
});
