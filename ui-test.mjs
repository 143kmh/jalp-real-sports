import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const html=await fs.readFile(new URL('./public/index.html',import.meta.url),'utf8');
const script=await fs.readFile(new URL('./public/app.js',import.meta.url),'utf8');
const css=await fs.readFile(new URL('./public/style.css',import.meta.url),'utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
test('UI has exactly five working sections and unique control IDs',()=>{
  assert.equal(new Set(ids).size,ids.length);
  assert.deepEqual([...html.matchAll(/\bdata-section="([^"]+)"/g)].map(m=>m[1]),['accounts','player','general','application','boosters']);
  for(const section of ['accounts','player','general','application','boosters'])assert.ok(ids.includes('view-'+section));
  for(const match of script.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.includes(match[1]),'Missing control '+match[1]);
});
test('booster workspace exposes first-25, boost-all and Legendary controls',()=>{
  for(const id of ['booster-account','booster-sport','booster-all','booster-no-legendary','booster-load','booster-owned','booster-selected','booster-run'])assert.ok(ids.includes(id));
  assert.match(html,/Забустить всех играющих сегодня/);
  assert.match(html,/Не применять Legendary/);
  assert.match(html,/Запустить первые 25/);
  assert.match(script,/type:'boosters'/);
  assert.match(script,/booster-owned/);
  assert.match(script,/boosterDirty/);
  assert.match(script,/Настройки бустеров сохранены автоматически/);
});
test('scenario recorder controls are present and use explicit start/stop endpoints',()=>{
  for(const id of ['recorder-name','recorder-start','recorder-stop','recorder-status'])assert.ok(ids.includes(id));
  assert.match(script,/recorder\/start/);assert.match(script,/recorder\/stop/);
  assert.match(html,/Scenario Recorder/);
});
test('restrained palette, reduced motion and no remote assets',()=>{
  assert.match(css,/#60519b/);assert.match(css,/#f5ecd8/);assert.match(css,/prefers-reduced-motion/);
  assert.doesNotMatch(css,/gradient\(|backdrop-filter|box-shadow/);
  assert.doesNotMatch(html,/https?:\/\//);
});

function fixture(){
  const elements=new Map();
  for(const id of ids)elements.set(id,{id,value:'',innerHTML:'',textContent:'',disabled:false,hidden:false,checked:false,options:[],dataset:{},listeners:{},classList:{toggle(){}},addEventListener(type,fn){this.listeners[type]=fn;},querySelectorAll(){return [];},contains(){return false;},setAttribute(){},removeAttribute(){}});
  elements.get('job-filter').value='all';elements.get('single-sport').value='nfl';
  const views=['accounts','player','general','application','boosters'].map(s=>elements.get('view-'+s));
  const nav=views.map((v,i)=>({dataset:{section:v.id.slice(5)},attributes:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},addEventListener(){}}));
  const location={hash:'',origin:'http://127.0.0.1:5127'};
  let posts=0;
  const context={structuredClone,URLSearchParams,Date,crypto:{},console,location,history:{replaceState(_a,_b,hash){location.hash=hash;}},window:{addEventListener(){},scrollTo(){},postMessage(){posts++;}},document:{activeElement:null,title:'',querySelector:()=>({content:'local-test'}),getElementById:id=>elements.get(id),querySelectorAll:selector=>selector==='.view'?views:selector.includes('[data-section]')?nav:[],addEventListener(){}},setTimeout:()=>1,clearTimeout(){},fetch(){throw Error('No network requests permitted in UI tests');}};
  vm.runInNewContext(script.replace(/sync\(\);\s*$/,''),context);
  return {elements,views,nav,context,posts:()=>posts,run:code=>vm.runInNewContext(code,context)};
}
test('navigation changes only the active panel, without network or purchase messages',()=>{
  const f=fixture();
  for(const section of ['accounts','player','general','application','boosters']){
    f.run(`navigate('${section}')`);
    assert.equal(f.views.filter(v=>!v.hidden).length,1);assert.equal(f.views.find(v=>!v.hidden).id,'view-'+section);
    assert.equal(f.nav.filter(n=>n.attributes['aria-current']==='page').length,1);
  }
  assert.equal(f.posts(),0);
  f.run("navigate('unknown')");assert.equal(f.views.find(v=>!v.hidden).id,'view-accounts');
});
test('account search stays local, escapes names and leaves balance/status visible',()=>{
  const f=fixture();f.run(`state.accounts=[{id:'a',name:'Alice',balance:200,status:'ready'},{id:'b',name:'<Bob>',balance:0,status:'error'}];renderAccounts();`);
  assert.match(f.elements.get('accounts').innerHTML,/&lt;Bob&gt;/);assert.match(f.elements.get('accounts').innerHTML,/200/);
  f.elements.get('account-query').value='bob';f.run('renderAccounts()');assert.doesNotMatch(f.elements.get('accounts').innerHTML,/Alice/);
  assert.equal(f.posts(),0);
});
test('changing sections preserves selected accounts and unsaved automation rules',()=>{
  const f=fixture();f.run("selected.add('a');settingsDraft={maxPacks:7};settingsDirty=true;navigate('player');navigate('general');");
  assert.equal(f.run("selected.has('a')"),true);assert.equal(f.run('settingsDraft.maxPacks'),7);assert.equal(f.run('settingsDirty'),true);
});
test('unchanged render data leaves existing DOM intact',()=>{
  const f=fixture();f.run("updateHTML('pp-selected','stable')");f.elements.get('pp-selected').innerHTML='focused input state';
  f.run("updateHTML('pp-selected','stable')");assert.equal(f.elements.get('pp-selected').innerHTML,'focused input state');
});
test('pack quantity input immediately marks a draft dirty without saving',()=>{
  const f=fixture();f.run('settingsDraft={playerPacks:[{count:1}]};editSettings=()=>settingsDirty=true;');
  f.elements.get('pp-selected').listeners.input({target:{dataset:{ppCount:'0'},value:'2'}});
  assert.equal(f.run('settingsDraft.playerPacks[0].count'),2);assert.equal(f.run('settingsDirty'),true);assert.equal(f.posts(),0);
});
test('resilient General batch accepts stale data and purchase holds, but read-only checks remain strict',()=>{
  const f=fixture();f.run("state.settings={generalResilience:true,priority:['nfl']};state.browser={connected:true};state.busy=false;");
  const account="({id:'a',browserSession:true,status:'error',balance:null,purchaseHold:true})";
  assert.equal(f.run('Boolean(canMax('+account+'))'),true);assert.equal(f.run('Boolean(canBuy('+account+'))'),true);assert.equal(f.run("Boolean(canBuy("+account+",'nfl',true))"),false);
  f.run('settingsDirty=true');assert.equal(f.run('Boolean(canMax('+account+'))'),false);
});
test('new General controls edit local draft immediately without triggering a task',()=>{
  const f=fixture();f.run('settingsDraft={generalResilience:true,generalNoLimit:true};editSettings=()=>settingsDirty=true;');
  for(const id of ['general-resilience','general-no-limit']){f.elements.get(id).checked=false;f.elements.get(id).listeners.change();}
  assert.equal(f.run('settingsDraft.generalResilience'),false);assert.equal(f.run('settingsDraft.generalNoLimit'),false);assert.equal(f.run('settingsDirty'),true);assert.equal(f.posts(),0);
});
test('General progress shows verified green completion and keeps uncertain attempts separate',()=>{
  const f=fixture();f.run("state.leagues={nfl:'NFL',ufc:'UFC'}");
  const markup=f.run(`generalProgressMarkup({type:'max',status:'done',settings:{priority:['nfl','ufc'],autoList:true,pricingMode:'min'},items:[{accountName:'<Alice>',status:'warning',generalProgress:{completed:true,count:3,unknown:1,leagues:{nfl:{state:'done',count:2,unknown:1,evidence:'Real UI',reason:'limit'},ufc:{state:'done',count:1,evidence:'balance'}}}}]})`);
  assert.match(markup,/account-complete/);assert.match(markup,/&lt;Alice&gt;/);assert.match(markup,/Неизвестно/);assert.match(markup,/Недостаточно Rax/);assert.match(markup,/Лимит Real/);assert.match(markup,/24ч/);assert.doesNotMatch(markup,/<Alice>/);
});
test('partial or cancelled account is not green even with successful openings',()=>{
  const f=fixture();
  for(const status of ['running','cancelled','error']){
    const markup=f.run(`generalProgressMarkup({type:'max',status:'running',settings:{priority:['nfl']},items:[{accountName:'Alice',status:'${status}',packs:[{},{}],generalProgress:{completed:true,count:1,leagues:{nfl:{state:'done',count:1}}}}]})`);
    assert.doesNotMatch(markup,/account-complete/);assert.match(markup,/>2</);
  }
});
test('General launch ignores removed strict-mode flags but requires linked session and saved rules',()=>{
  const f=fixture();f.run("state.settings={generalResilience:false,generalNoLimit:false,priority:['nfl']};state.browser={connected:true};");
  assert.equal(f.run("Boolean(canMax({browserSession:true,balance:null,status:'error',purchaseHold:true}))"),true);
});
test('recovery history escapes errors rather than rendering Real content as markup',()=>{
  const f=fixture(),markup=f.run("renderRecovery({accountId:'a',generalProgress:{warnings:[{at:'2026-10-04T00:00:00Z',message:'<img src=x onerror=alert(1)>'}]}},'j')");
  assert.match(markup,/&lt;img/);assert.doesNotMatch(markup,/<img/);
});
test('owned browser login is required before purchasing even if transport is connected',()=>{
  const f=fixture();f.run("state.settings={generalResilience:true,priority:['nfl']};state.browser={mode:'owned',connected:true,loggedIn:false};");assert.equal(f.run("Boolean(canMax({id:'a',browserSession:true}))"),false);f.run('state.browser.loggedIn=true');assert.equal(f.run("Boolean(canMax({id:'a',browserSession:true}))"),true);assert.equal(f.run("Boolean(canMax({id:'legacy',browserSession:false}))"),false);
});
test('visible-only browser explains the window requirement during tasks',()=>{
  const f=fixture();f.run("state.busy=true;state.browser={owned:{running:true,mode:'visible',visible:true,loggedIn:true}};renderOwnedBrowser();");
  assert.equal(f.elements.has('owned-visible'),false);
  for(const id of ['owned-start','owned-login','owned-stop'])assert.equal(f.elements.get(id).disabled,true);
  assert.equal(f.elements.get('diagnostic-export').disabled,false);assert.match(f.elements.get('visibility-hint').textContent,/видимом окне/);
});
test('linked accounts can launch jobs that open a stopped browser automatically',()=>{
  const f=fixture();f.run("state.settings={priority:['nfl']};state.browser={mode:'owned',connected:false,loggedIn:false,owned:{available:true,running:false}};");assert.equal(f.run("Boolean(canMax({browserSession:true}))"),true);
  f.run('state.browser.owned.manualLogin=true');assert.equal(f.run("Boolean(canMax({browserSession:true}))"),false);
});
