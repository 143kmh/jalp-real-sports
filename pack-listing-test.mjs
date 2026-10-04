import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {preparePackQuickList,DEFAULT_SETTINGS} from './automation.mjs';
import {getOwnedUfcFighters} from './core.mjs';
const scope={};vm.runInNewContext(await fs.readFile(new URL('./helium-extension/pack-listing.js',import.meta.url),'utf8'),scope);vm.runInNewContext(await fs.readFile(new URL('./helium-extension/workflow.js',import.meta.url),'utf8'),scope);
const plan=()=>({cards:[{id:1,mint:100,names:['A Fighter'],eligible:false},{id:2,mint:101,names:['B Fighter'],eligible:true}],selectedIds:[2],mode:'default',durationHours:24,durationLabel:'24h',pricingLabel:'Default'});
const command=()=>({id:'list-command',parentCommandId:'opened',accountId:'owner',expiresAt:Date.now()+10000,plan:plan()});
function uiMock({context=true,selection,failAt}={}){
  const calls=[];return {calls,ui:{listContext:async()=>context,prepareQuickList:async c=>{calls.push('select');return selection||{selectedIds:c.plan.selectedIds,mode:c.plan.mode,durationHours:24};},authorizeListing:async()=>{calls.push('authorize');if(failAt==='authorize')throw new Error('cancelled');},submitQuickList:async c=>{calls.push('submit');if(failAt==='submit')throw new Error('lost response');return {listedCardIds:c.plan.selectedIds};},finishSummary:async()=>calls.push('done')}};
}
test('Quick list UI selects, authorizes, submits once, then closes the summary',async()=>{
  const m=uiMock(),r=await scope.RealManagerWorkflow.list(command(),m.ui);assert.equal(r.ok,true);assert.deepEqual(m.calls,['select','authorize','submit','done']);assert.deepEqual(r.listedCardIds,[2]);
});
test('Protected-only pack closes without a marketplace submission',async()=>{
  const c=command();c.plan.selectedIds=[];const m=uiMock();assert.equal((await scope.RealManagerWorkflow.list(c,m.ui)).ok,true);assert.deepEqual(m.calls,['done']);
});
test('Foreign summary, expired commands and changed selection cannot submit',async()=>{
  const foreign=uiMock({context:false});assert.equal((await scope.RealManagerWorkflow.list(command(),foreign.ui)).ok,false);assert.deepEqual(foreign.calls,[]);
  const expired=command();expired.expiresAt=0;const m=uiMock();assert.equal((await scope.RealManagerWorkflow.list(expired,m.ui)).ok,false);assert.deepEqual(m.calls,[]);
  for(const selection of [{selectedIds:[1],mode:'default',durationHours:24},{selectedIds:[2],mode:'min',durationHours:24},{selectedIds:[2],mode:'default',durationHours:48}]){const m=uiMock({selection});assert.equal((await scope.RealManagerWorkflow.list(command(),m.ui)).ok,false);assert.deepEqual(m.calls,['select']);}
});
test('Listing cancellation precedes submission and lost replies never retry',async()=>{
  const blocked=uiMock({failAt:'authorize'});assert.equal((await scope.RealManagerWorkflow.list(command(),blocked.ui)).uncertain,false);assert.deepEqual(blocked.calls,['select','authorize']);
  const lost=uiMock({failAt:'submit'});assert.equal((await scope.RealManagerWorkflow.list(command(),lost.ui)).uncertain,true);assert.deepEqual(lost.calls,['select','authorize','submit']);
});
test('Card matching uses mint and every participant, rejecting duplicates and extras',()=>{
  const p=plan(),items=[{mint:101,text:'B FIGHTER #101'},{mint:100,text:'A FIGHTER #100'}];assert.equal(scope.RealManagerPackListing.matchCards(p,items)[0].card.id,1);
  assert.throws(()=>scope.RealManagerPackListing.matchCards(p,[...items,items[0]]));assert.throws(()=>scope.RealManagerPackListing.matchCards(p,[items[0],items[0]]));
  p.cards[1].names.push('Opponent');assert.throws(()=>scope.RealManagerPackListing.matchCards(p,items));
});
test('Pack UI plan excludes protected and blocked cards without any listing API requests',async()=>{
  const cards=[1,2,3].map(id=>({id,userId:'owner',cardPackId:100,sport:'ufc',canList:id!==3,mintNumber:id,team:{id,name:'Fighter '+id}}));
  const p=await preparePackQuickList({id:'owner'},100,cards,{...DEFAULT_SETTINGS,protectedCardIds:[1]});
  assert.deepEqual(p.selectedIds,[2]);assert.deepEqual(p.records.map(r=>r.cardId),[1,3]);assert.equal(p.durationLabel,'24h');
});
test('Pack UI plan rejects missing identity and foreign owner, with no listing writes',async()=>{
  await assert.rejects(preparePackQuickList({id:'owner'},100,[{id:1,userId:'other',cardPackId:100}],DEFAULT_SETTINGS));
  await assert.rejects(preparePackQuickList({id:'owner'},100,[{id:1,userId:'owner',cardPackId:100,canList:true,sport:'ufc'}],DEFAULT_SETTINGS),/Недостаточно/);
});
test('Owned UFC reads all owned passes, deduplicates fighters and ignores refunded passes',async()=>{
  const a={id:'owner',name:'Alice',seasons:{ufc:'2023'}},calls=[];
  const request=async(_a,_m,path)=>{calls.push(path);return path==='/user'?{user:{id:'owner',virtualCurrencyBalance:0}}:{passes:[1,1,2].map((entityId,i)=>({userId:'owner',sport:'ufc',season:2023,entityType:'team',entityId,entity:{name:'Fighter '+entityId},isRefunded:i===2}))};};
  const found=await getOwnedUfcFighters(a,request);assert.deepEqual(found,[{id:1,sport:'ufc',entityType:'team',name:'Fighter 1'}]);assert.match(calls[1],/^\/userpasses\/owner\/passes\?/);
});
test('Owned UFC rejects another owner or league, and accepts an empty owned collection',async()=>{
  const a=()=>({id:'owner',name:'Alice',seasons:{ufc:'2023'}});
  for(const pass of [{userId:'other',sport:'ufc',season:2023,entityType:'team',entityId:1},{userId:'owner',sport:'nfl',season:2023,entityType:'team',entityId:1}])await assert.rejects(getOwnedUfcFighters(a(),async(_a,_m,path)=>path==='/user'?{user:{id:'owner'}}:{passes:[pass]}));
  assert.deepEqual(await getOwnedUfcFighters(a(),async(_a,_m,path)=>path==='/user'?{user:{id:'owner'}}:{passes:[]}),[]);
});

// DOM-shaped fixture follows Real's published compact-card selection indicator and option toggles.
class Element {
  constructor(tag='DIV',label='',attributes={},style={}){this.tagName=tag;this.label=label;this.attributes=attributes;this.style=style;this.children=[];this.hidden=false;}
  add(e){e.parentElement=this;this.children.push(e);return e;}
  get innerText(){return [this.label,...this.children.filter(e=>!e.hidden).map(e=>e.innerText)].filter(Boolean).join('\n');}
  getAttribute(name){return this.attributes[name]??null;}
  getBoundingClientRect(){return {width:this.hidden?0:180,height:this.hidden?0:240};}
  contains(e){return e===this||this.children.some(c=>c.contains(e));}
  closest(selector){for(let e=this;e;e=e.parentElement){const disabledSelector=selector.includes('aria-disabled="true"');if(disabledSelector?e.getAttribute('aria-disabled')==='true':e.getAttribute('role')==='button'||e.tagName==='BUTTON'||selector.includes('[tabindex]')&&e.getAttribute('tabindex')!==null||selector.includes('[tabindex="0"]')&&e.getAttribute('tabindex')==='0'||selector.includes('[aria-disabled]')&&e.getAttribute('aria-disabled')!==null)return e;}return null;}
  querySelectorAll(selector){const found=[],matches=e=>selector.split(',').some(s=>s.trim()==='[role="button"]'?e.getAttribute('role')==='button':e.tagName===s.trim().toUpperCase());const visit=e=>{for(const c of e.children){if(matches(c))found.push(c);visit(c);}};visit(this);return found;}
}
function domFixture(mode,tabIndexOnly=false,flatOptions=false){
  const body=new Element('BODY'),root=body.add(new Element()),calls=[];
  root.add(new Element('DIV','Pack summary'));
  const row=root.add(new Element());row.getBoundingClientRect=()=>({width:600,height:240});
  const entries=[100,101].map((mint,i)=>{
    const wrapper=row.add(new Element()),indicator=wrapper.add(new Element('DIV','',{}, {position:'absolute',width:'24px',height:'24px',opacity:i===0?'1':'0'}));indicator.add(new Element('SVG'));
    const target=wrapper.add(new Element('DIV','',tabIndexOnly?{tabindex:'0'}:{role:'button'}));target.add(new Element('DIV',i===0?'A Fighter':'B Fighter'));target.add(new Element('SPAN','#'+mint));
    target.onClick=()=>{indicator.style.opacity=indicator.style.opacity==='1'?'0':'1';calls.push('toggle:'+mint);updateCount();};
    return {wrapper,indicator,target};
  });
  const button=(parent,label,onClick)=>{const e=parent.add(new Element('DIV','',tabIndexOnly?{tabindex:'0'}:{role:'button'}));const text=e.add(new Element('SPAN',label));e.onClick=onClick;return {e,text};};
  const quick=button(root,'Quick list (1)',()=>{modal.hidden=false;calls.push('open-drawer');});quick.e.hidden=true;
  function updateCount(){quick.text.label='Quick list ('+entries.filter(e=>e.indicator.style.opacity==='1').length+')';}
  button(root,'List',()=>{quick.e.hidden=false;calls.push('enter-list');});button(root,'Done',()=>{root.hidden=true;calls.push('done');});
  const modal=body.add(new Element());modal.hidden=true;modal.add(new Element('DIV','Quick list'));
  const toggles={};
  for(const [section,options] of [['Duration',['12h','24h','48h']],['Pricing',['Min','Default','Max']]]){
    const line=flatOptions?modal:modal.add(new Element());line.add(new Element('DIV',section));
    for(const label of options){const {e}=button(line,label,()=>{for(const option of options){toggles[option].attributes['aria-disabled']=String(option===label);if(tabIndexOnly)toggles[option].attributes.tabindex=option===label?'-1':'0';}calls.push('option:'+label);});toggles[label]=e;e.attributes['aria-disabled']=String(label===(section==='Duration'?'12h':'Default'));if(tabIndexOnly&&e.attributes['aria-disabled']==='true')e.attributes.tabindex='-1';}
  }
  button(modal,'Cancel',()=>{modal.hidden=true;});
  button(modal,'Quick list (1)',()=>{calls.push('submit');modal.hidden=true;entries[1].wrapper.add(new Element('DIV','Listed'));});
  const visible=e=>{for(let p=e;p;p=p.parentElement)if(p.hidden)return false;return true;};
  const text=e=>e?.innerText||'',clean=s=>s.replace(/\s+/g,' ').trim();
  const all=(s,scope=body)=>scope.querySelectorAll(s).filter(visible);
  const exact=(label,scope=body)=>{const matches=all('div,span,button,a',scope).filter(e=>clean(text(e))===label);return matches.filter(e=>!matches.some(c=>c!==e&&e.contains(c)));};
  const click=e=>{const target=e.closest('[role="button"],button,[tabindex="0"]')||e;if(target.getAttribute('aria-disabled')==='true')throw new Error('Disabled');target.onClick?.();};
  const wait=async check=>{const result=await check();if(!result)throw new Error('Fixture wait condition failed');return result;};
  scope.document={body};scope.getComputedStyle=e=>({position:'static',width:'180px',height:'240px',opacity:'1',...e.style});
  const adapter=scope.RealManagerPackListing.create({all,exact,text,clean,visible,click,wait,getSummary:()=>root,assertContext:()=>{},authorize:async()=>calls.push('authorize')});
  const c=command();c.plan.mode=mode;c.plan.pricingLabel={default:'Default',min:'Min',max:'Max'}[mode];
  return {adapter,c,calls,entries,toggles};
}
for(const mode of ['default','min','max'])test('Real-style DOM clears a preselected protected card and verifies 24h / '+mode,async()=>{
  const f=domFixture(mode),result=await scope.RealManagerWorkflow.list(f.c,f.adapter);
  assert.equal(result.ok,true,result.message);assert.equal(f.entries[0].indicator.style.opacity,'0');assert.equal(f.entries[1].indicator.style.opacity,'1');assert.equal(f.toggles['24h'].getAttribute('aria-disabled'),'true');assert.equal(f.calls.filter(c=>c==='submit').length,1);assert.ok(f.calls.indexOf('authorize')<f.calls.indexOf('submit'));assert.equal(f.calls.at(-1),'done');
});
test('A missing selection indicator prevents any marketplace submission',async()=>{
  const f=domFixture('default');f.entries[0].indicator.children=[];const result=await scope.RealManagerWorkflow.list(f.c,f.adapter);assert.equal(result.ok,false);assert.ok(!f.calls.includes('authorize'));assert.ok(!f.calls.includes('submit'));
});
test('Actual Real tabindex controls work without role=button',async()=>{const f=domFixture('default',true),r=await scope.RealManagerWorkflow.list(f.c,f.adapter);assert.equal(r.ok,true,r.message);assert.equal(f.calls.filter(c=>c==='submit').length,1);});
for(const mode of ['default','min','max'])test('Flat drawer and selected tabindex=-1 options verify 24h / '+mode,async()=>{
  const f=domFixture(mode,true,true);f.toggles['12h'].attributes['aria-disabled']='false';f.toggles['12h'].attributes.tabindex='0';f.toggles['24h'].attributes['aria-disabled']='true';f.toggles['24h'].attributes.tabindex='-1';
  const r=await scope.RealManagerWorkflow.list(f.c,f.adapter);assert.equal(r.ok,true,r.message);assert.ok(!f.calls.includes('option:24h'));assert.equal(f.calls.filter(c=>c==='submit').length,1);
});
test('Multiple disabled duration choices cannot be treated as confirmed 24h',async()=>{
  const f=domFixture('default',true,true);for(const label of ['12h','24h','48h']){f.toggles[label].attributes['aria-disabled']='true';f.toggles[label].attributes.tabindex='-1';}
  const r=await scope.RealManagerWorkflow.list(f.c,f.adapter);assert.equal(r.ok,false);assert.ok(!f.calls.includes('authorize'));assert.ok(!f.calls.includes('submit'));
});
test('Already chosen options with only aria-disabled, no role or tabindex, are recognized',async()=>{
  const f=domFixture('default',true,true);f.toggles['12h'].attributes['aria-disabled']='false';f.toggles['24h'].attributes['aria-disabled']='true';delete f.toggles['24h'].attributes.tabindex;delete f.toggles.Default.attributes.tabindex;
  const r=await scope.RealManagerWorkflow.list(f.c,f.adapter);assert.equal(r.ok,true,r.message);assert.ok(!f.calls.includes('option:24h'));assert.ok(!f.calls.includes('option:Default'));
});
test('Missing 24h never falls back to another duration or authorizes submission',async()=>{
  const f=domFixture('default',true,true);f.toggles['24h'].children[0].label='Different duration';
  const r=await scope.RealManagerWorkflow.list(f.c,f.adapter);assert.equal(r.ok,false);assert.ok(!f.calls.includes('authorize'));assert.ok(!f.calls.includes('submit'));
});
