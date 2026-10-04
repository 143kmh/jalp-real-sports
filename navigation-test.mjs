import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const navigationCode=await fs.readFile(new URL('./helium-extension/navigation.js',import.meta.url),'utf8');
const adapterCode=await fs.readFile(new URL('./helium-extension/real.js',import.meta.url),'utf8');
const listingCode=await fs.readFile(new URL('./helium-extension/pack-listing.js',import.meta.url),'utf8');
const scope={};vm.runInNewContext(navigationCode,scope);
const navigation=scope.RealManagerNavigation;
// Geometry observed in Helium with both an image avatar and the letter "o" avatar.
const fixture=()=>[16,60,116,172,228,284,340,396,508,564].map((y,i)=>({x:444,y,w:i?23:20,h:i?24:20}));
test('desktop navigation is recognized without any avatar image',()=>{
  const records=fixture(),column=navigation.column(records);
  assert.equal(column.length,10);assert.equal(column[2].y,116);assert.equal(column.at(-2).y,508);
});
test('navigation works when the column is repositioned',()=>{
  const records=fixture().map(r=>({...r,x:r.x+300,y:r.y+80}));assert.equal(navigation.column(records).length,10);
});
test('unrelated feed icons cannot become navigation',()=>{
  const records=[...fixture(),{x:500,y:17,w:20,h:20},{x:600,y:375,w:20,h:20},{x:600,y:627,w:24,h:24}];
  assert.equal(navigation.column(records).length,10);
});
test('ambiguous or incomplete navigation fails closed',()=>{
  assert.throws(()=>navigation.column(fixture().slice(2)),/навигацию/);
  assert.throws(()=>navigation.column([...fixture(),...fixture().map(r=>({...r,x:r.x+300}))]),/навигацию/);
});
test('full account name is extracted only from the Log out row',()=>{
  assert.equal(navigation.logoutName('Log out\nfixture_user'),'fixture_user');
  assert.equal(navigation.logoutName('Log out\n@other'),'other');
  assert.equal(navigation.logoutName('o'),null);assert.equal(navigation.logoutName('Options Log out fixture_user Other'),null);
});

class Element {
  constructor(tag,rect,text=''){this.tagName=tag;this.rect=rect;this.innerText=text;this.textContent=text;this.children=[];this.hidden=false;this.attributes={};}
  add(e){e.parentElement=this;this.children.push(e);return e;}
  contains(e){return this===e||this.children.some(c=>c.contains(e));}
  getBoundingClientRect(){for(let p=this;p;p=p.parentElement)if(p.hidden)return {x:0,y:0,width:0,height:0};return this.rect;}
  querySelectorAll(selector){const tags=selector.split(',').map(s=>s.trim().toUpperCase());const found=[];const visit=e=>{for(const c of e.children){if(tags.includes(c.tagName))found.push(c);visit(c);}};visit(this);return found;}
  getAttribute(name){return this.attributes[name]??null;}
  matches(selector){return selector.includes('tabindex')&&this.attributes.tabindex==='0'||selector.includes('role')&&this.attributes.role==='button'||this.tagName==='BUTTON';}
  closest(){for(let e=this;e;e=e.parentElement)if(e.attributes['aria-disabled']==='true')return e;return null;}
  scrollIntoView(){}
  click(){this.onClick?.();this.parentElement?.click();}
}
function letterAvatarPage(name='fixture_user',run,configure=()=>{}){
  const body=new Element('BODY',{x:0,y:0,width:1500,height:1000},'o');
  const nav=body.add(new Element('DIV',{x:428,y:0,width:55,height:700}));
  const records=fixture();
  let settingsButton;
  for(const r of records){
    if(r.y===508)nav.add(new Element('DIV',{x:428,y:436,width:55,height:56},'o'));
    const button=nav.add(new Element('DIV',{x:428,y:r.y===16?0:r.y-16,width:55,height:r.y===16?52:56}));
    const svg=button.add(new Element('SVG',{x:r.x,y:r.y,width:r.w,height:r.h}));svg.click=undefined;
    if(r.y===508)settingsButton=button;
  }
  const settings=body.add(new Element('DIV',{x:484,y:0,width:620,height:700}));settings.hidden=true;
  const row=settings.add(new Element('DIV',{x:500,y:500,width:500,height:50},'Log out\n'+name));
  row.add(new Element('DIV',{x:510,y:510,width:100,height:20},'Log out'));
  row.add(new Element('DIV',{x:810,y:510,width:150,height:20},name));
  settingsButton.onClick=()=>{settings.hidden=false;};
  const handlers={};let listener;
  const document={body,querySelectorAll:s=>body.querySelectorAll(s),addEventListener:(name,fn)=>{handlers[name]=fn;}};
  const context={document,location:{href:'https://realsports.io/'},getComputedStyle:()=>({visibility:'visible',display:'block',fontSize:'16px'}),setTimeout,URL,
    chrome:{runtime:{id:'test-extension',onMessage:{addListener:fn=>{listener=fn;}}}},
    RealManagerWorkflow:{check:async(c,ui)=>({ok:true,snapshot:await run(c,ui,handlers)})},
  };
  configure({body,nav,context});
  vm.runInNewContext(navigationCode,context);vm.runInNewContext(listingCode,context);vm.runInNewContext(adapterCode,context);
  const message=(data)=>new Promise(resolve=>listener(data,{id:'test-extension'},resolve));
  return {message,settings,handlers,body};
}
test('real content adapter verifies a letter avatar by full username in Settings',async()=>{
  const page=letterAvatarPage('fixture_user',async(c,ui)=>({id:await ui.accountId(c)}));
  const command={id:'letter-avatar-check',action:'check',accountId:'user-o',accountName:'fixture_user'};
  const result=await page.message({type:'EXECUTE',command});assert.equal(result.snapshot.id,'user-o');assert.equal(page.settings.hidden,false);
  const snapshot=await page.message({type:'SNAPSHOT'});assert.equal(snapshot.accountId,'user-o');assert.equal(snapshot.version,'0.4.4');
});
test('scenario recorder captures manual clicks without field values',async()=>{
  const page=letterAvatarPage('fixture_user',async()=>({}));
  const start=await page.message({type:'EXECUTE',command:{id:'record-start',action:'record-start',name:'apply-booster'}});
  assert.equal(start.ok,true);assert.equal(start.snapshot.recording,true);
  page.handlers.click({isTrusted:true,target:page.settings});
  const stop=await page.message({type:'EXECUTE',command:{id:'record-stop',action:'record-stop'}});
  assert.equal(stop.ok,true);assert.equal(stop.snapshot.scenario.name,'apply-booster');assert.equal(stop.snapshot.scenario.events.length,1);
  assert.equal(Object.hasOwn(stop.snapshot.scenario.events[0].target,'value'),false);
});
test('image avatar URL cannot bypass Settings username verification',async()=>{
  const page=letterAvatarPage('other',async(c,ui)=>({id:await ui.accountId(c)}),({nav})=>{
    const profile=nav.children.find(e=>e.innerText==='o');
    const image=profile.add(new Element('IMG',{x:440,y:445,width:28,height:28}));
    image.src='https://media.realapp.com/user-o_avatar.png';
  });
  const result=await page.message({type:'EXECUTE',command:{id:'misleading-avatar',action:'check',accountId:'user-o',accountName:'fixture_user'}});
  assert.equal(result.snapshot.id,null);
  assert.equal(page.settings.hidden,false);
});
test('same initial is never accepted as account identity',async()=>{
  const page=letterAvatarPage('other',async(c,ui)=>({id:await ui.accountId(c)}));
  const result=await page.message({type:'EXECUTE',command:{id:'wrong-name',action:'check',accountId:'user-o',accountName:'fixture_user'}});
  assert.equal(result.snapshot.id,null);
});

test('extra verification requires attention even when the regular sidebar is present',async()=>{
  const page=letterAvatarPage('fixture_user',async()=>({}),({body})=>{body.innerText='Extra verification is required to perform this action, please turn off any adblock or script blockers and retry';});
  const result=await page.message({type:'READY'});assert.equal(result.ready,true);assert.equal(result.requiresAttention,true);
});
test('human interaction invalidates confirmed identity before another action',async()=>{
  const page=letterAvatarPage('fixture_user',async(c,ui,handlers)=>{
    const first=await ui.accountId(c);handlers.pointerdown({isTrusted:true});return {first,second:await ui.accountId(c)};
  });
  const r=await page.message({type:'EXECUTE',command:{id:'interrupted',action:'check',accountId:'user-o',accountName:'fixture_user'}});
  assert.equal(r.snapshot.first,'user-o');assert.equal(r.snapshot.second,null);
});

test('pack preparation ignores disabled feed NFL and waits for the Cards pane',async()=>{
  let feedClicks=0,navClicks=0,packClicks=0;
  const source='assets/packs/nflgeneralicon.png';
  const page=letterAvatarPage('fixture_user',async(c,ui)=>{const result=await ui.preparePack(c);await ui.finishCheck(c);return result;},({body,nav,context})=>{
    const feed=body.add(new Element('DIV',{x:1120,y:60,width:60,height:20},'NFL'));feed.attributes['aria-disabled']='true';feed.onClick=()=>feedClicks++;
    const cardsNav=nav.children.find(e=>e.children.some(s=>s.rect.y===116));cardsNav.attributes['aria-disabled']='true';cardsNav.onClick=()=>navClicks++;
    const shop=body.add(new Element('DIV',{x:484,y:0,width:620,height:900}));
    shop.add(new Element('DIV',{x:500,y:12,width:60,height:30},'Cards'));
    const dialog=body.add(new Element('DIV',{x:550,y:150,width:400,height:650},'General Pack NFL'));dialog.hidden=true;
    dialog.add(new Element('DIV',{x:570,y:180,width:180,height:30},'Activate pack'));
    const price=dialog.add(new Element('SPAN',{x:600,y:520,width:60,height:50},'Free'));
    const cancel=dialog.add(new Element('DIV',{x:570,y:170,width:60,height:20},'Cancel'));cancel.onClick=()=>dialog.hidden=true;
    const modalImage=dialog.add(new Element('IMG',{x:600,y:250,width:200,height:250}));modalImage.src='https://media.realapp.com/'+source;
    context.getComputedStyle=e=>({visibility:'visible',display:'block',fontSize:e===price?'42px':'16px'});
    setTimeout(()=>{const img=shop.add(new Element('IMG',{x:600,y:100,width:120,height:160}));img.src='https://media.realapp.com/'+source;img.onClick=()=>{packClicks++;dialog.hidden=false;};},10);
  });
  const result=await page.message({type:'EXECUTE',command:{id:'shop-race',action:'check',sport:'NFL',packImage:source,description:'General Pack NFL',activateLabel:'Activate pack'}});
  assert.equal(result.ok,true,result.message);assert.equal(result.snapshot.cost,0);assert.equal(feedClicks,0);assert.equal(navClicks,0);assert.equal(packClicks,1);
});

test('disabled controls report the actual step instead of a nonexistent Real button',async()=>{
  const page=letterAvatarPage('fixture_user',async(c,ui)=>ui.accountId(c),({nav})=>{nav.children.find(e=>e.children.some(s=>s.rect.y===508)).attributes['aria-disabled']='true';});
  const result=await page.message({type:'EXECUTE',command:{id:'disabled-settings',action:'check',accountId:'user-o',accountName:'fixture_user'}});
  assert.equal(result.ok,false);assert.match(result.message,/Settings.*недоступный/);assert.doesNotMatch(result.message,/Кнопка Real/);
});
test('Player preparation uses the owned full-name card and scoped menu, with no activation',async()=>{
  let passClicks=0,packClicks=0,activations=0;
  const source='assets/packs/wnbaplayer3general.png',name='Napheesa Collier';
  const page=letterAvatarPage('fixture_alt',async(c,ui)=>{const r=await ui.preparePack(c);await ui.finishCheck(c);return r;},({body,context})=>{
    const shop=body.add(new Element('DIV',{x:484,y:0,width:400,height:900},'Cards WNBA Players'));
    shop.add(new Element('DIV',{x:500,y:12,width:60,height:30},'Cards'));
    for(const text of ['WNBA','Players']){const label=shop.add(new Element('DIV',{x:500,y:80,width:60,height:30},text));label.attributes['aria-disabled']='true';}
    const card=body.add(new Element('DIV',{x:890,y:100,width:200,height:300},`Uncommon Player 2026 ${name} fixture_alt #6493`));card.attributes.tabindex='0';card.add(new Element('DIV',{x:900,y:150,width:180,height:25},name));
    const menu=body.add(new Element('DIV',{x:600,y:100,width:500,height:500},`${name} 2026 Manage card Earnings`));menu.hidden=true;
    for(const text of [name+' 2026','Manage card','Earnings'])menu.add(new Element('DIV',{x:610,y:150,width:200,height:25},text));
    card.onClick=()=>{passClicks++;menu.hidden=false;};
    const dialog=body.add(new Element('DIV',{x:550,y:150,width:400,height:650},'Includes 3 N. Collier 2026 cards'));dialog.hidden=true;
    const activate=dialog.add(new Element('DIV',{x:570,y:180,width:180,height:30},'Activate pack'));activate.onClick=()=>activations++;
    const price=dialog.add(new Element('SPAN',{x:600,y:520,width:80,height:50},'270'));
    const cancel=dialog.add(new Element('DIV',{x:570,y:170,width:60,height:20},'Cancel'));cancel.onClick=()=>dialog.hidden=true;
    const image=dialog.add(new Element('IMG',{x:600,y:250,width:200,height:250}));image.src='https://media.realapp.com/'+source;
    const inline=menu.add(new Element('IMG',{x:600,y:100,width:74,height:100}));inline.src='https://media.realapp.com/'+source;inline.onClick=()=>{packClicks++;dialog.hidden=false;};
    context.getComputedStyle=e=>({visibility:'visible',display:'block',fontSize:e===price?'42px':'16px'});
  });
  const result=await page.message({type:'EXECUTE',command:{id:'owned-player',action:'check',kind:'player',sport:'wnba',leagueLabel:'WNBA',playerId:650,playerName:name,season:'2026',accountName:'fixture_alt',packImage:source,description:'Includes 3 N. Collier 2026 cards',activateLabel:'Activate pack'}});
  assert.equal(result.ok,true,result.message);assert.equal(result.snapshot.playerId,650);assert.equal(result.snapshot.cost,270);assert.equal(passClicks,1);assert.equal(packClicks,1);assert.equal(activations,0);
});
