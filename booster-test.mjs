import {test} from 'node:test';
import assert from 'node:assert/strict';
import {desiredRarity,rarityFallback,statPriority,chooseOption,validateBoosterTargets} from './boosters.mjs';
import {validateSettings,DEFAULT_SETTINGS} from './automation.mjs';
import {getOwnedBoosterPlayers} from './core.mjs';

test('booster rarity falls down and global Legendary block caps at Epic',()=>{
  assert.deepEqual(rarityFallback(5,true),[5,4,3]);
  assert.deepEqual(rarityFallback(5,false),[4,3]);
  assert.deepEqual(rarityFallback(4,true),[4,3]);
  assert.equal(desiredRarity(undefined,false),4);
});
test('position-aware booster choice prefers useful stats but accepts any fallback',()=>{
  const options=[{text:'25x 15 TFL 10 FGM x4'},{text:'25x 0.5 RUYDS 25 SACK x3'},{text:'25x 3.5 REC 3.5 TKL x4'}];
  assert.equal(chooseOption(options,statPriority('nfl','RB')).text,'25x 0.5 RUYDS 25 SACK x3');
  assert.equal(chooseOption([{text:'25x 8 SAVE x17'}],statPriority('soccer','F')).text,'25x 8 SAVE x17');
  assert.equal(chooseOption([{text:'15x 4 3PM x2'},{text:'15x 6 BLK x1'}],statPriority('wnba','PG')).text,'15x 4 3PM x2');
  assert.equal(chooseOption([{text:'25x 50 AST x22'},{text:'25x 32.5 GOAL x20'}],statPriority('soccer','ST')).text,'25x 32.5 GOAL x20');
});
test('booster targets are persisted as one account/sport/player rule',()=>{
  const target={accountId:'owner',sport:'nfl',entityId:7,name:'Lamar Jackson',position:'QB',desiredRarity:5};
  const settings=validateSettings({...DEFAULT_SETTINGS,boosterBoostAll:true,boosterUseLegendary:false,boosterTargets:[target]});
  assert.equal(settings.boosterBoostAll,true);assert.equal(settings.boosterUseLegendary,false);assert.deepEqual(settings.boosterTargets,[target]);
  assert.throws(()=>validateBoosterTargets([target,target]),/несколько раз/);
});
test('owned booster players are deduplicated by entity and retain positions',async()=>{
  const account={id:'owner',name:'Alice',headers:{},seasons:{nfl:'2026'}};
  const pass={userId:'owner',sport:'nfl',season:2026,entityType:'player',entityId:7,label:'Lamar Jackson',entity:{position:'QB'}};
  const request=async(_a,_method,path)=>{
    if(path==='/user')return {user:{id:'owner',userName:'Alice',virtualCurrencyBalance:0}};
    if(path==='/collecting/owner/info')return {info:{sportSeasonMap:{nfl:[{id:2026}]}}};
    if(path.startsWith('/userpasses/'))return {passes:[pass,pass]};
    throw new Error('unexpected '+path);
  };
  const players=await getOwnedBoosterPlayers(account,'nfl',request);
  assert.deepEqual(players,[{accountId:'owner',id:7,entityId:7,name:'Lamar Jackson',sport:'nfl',entityType:'player',position:'QB'}]);
});
