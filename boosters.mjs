import {LEAGUES,OperationError} from './core.mjs';

export const BOOST_RARITIES=Object.freeze({3:'Rare',4:'Epic',5:'Legendary'});
export const BOOST_SPORTS=Object.freeze(Object.keys(LEAGUES));

const NORMALIZE=value=>String(value||'').trim().toLocaleLowerCase().replace(/[^a-z0-9а-яё]+/gi,' ');
export function boosterKey(value){return [value.accountId,value.sport,Number(value.entityId)].join(':');}
export function samePlayer(a,b){return a.accountId===b.accountId&&a.sport===b.sport&&Number(a.entityId)===Number(b.entityId);}
export function desiredRarity(value,useLegendary=true){
  const rarity=Number(value);
  if(![3,4,5].includes(rarity))return useLegendary?5:4;
  return useLegendary?rarity:Math.min(rarity,4);
}
export function rarityFallback(value,useLegendary=true){
  const top=desiredRarity(value,useLegendary);
  return [5,4,3].filter(r=>r<=top&&(useLegendary||r!==5));
}

const common={
  nfl:{
    QB:['PYDS','PTD','RUYDS','TD','REC'],RB:['RUYDS','TD','REC','PTD'],WR:['REC','TD','RUYDS','PTD'],TE:['REC','TD','RUYDS','PTD'],
    DB:['INT','TKL','FF','TFL','SACK'],LB:['TKL','SACK','TFL','FF','INT'],DL:['SACK','TFL','TKL','FF','INT'],K:['FGM']
  },
  ncaaf:null,
  nba:{G:['PTS','AST','3PM','STL','REB','BLK'],F:['PTS','REB','3PM','BLK','STL','AST'],C:['REB','BLK','PTS','AST','STL','3PM']},
  wnba:null,ncaam:null,
  soccer:{F:['GOAL','AST','DUEL','SAVE'],M:['AST','GOAL','DUEL','SAVE'],D:['DUEL','AST','GOAL','SAVE'],GK:['SAVE','DUEL','AST','GOAL']},
  nhl:{G:['SAVE','SV','GA'],D:['BLK','AST','SOG','GOAL'],F:['GOAL','AST','SOG','BLK']},
  mlb:{P:['SO','K','IP','W','SV'],SP:['SO','K','IP','W'],RP:['SO','K','SV','IP'],C:['HR','H','RBI','TB'],IF:['HR','H','RBI','TB'],OF:['HR','H','RBI','TB']},
  golf:{DEFAULT:['BIRDIE','EAGLE','GIR','FIR']},
  ufc:{DEFAULT:['SIG','STR','TD','SUB','KD']}
};
common.ncaaf=common.nfl;common.wnba=common.nba;common.ncaam=common.nba;

export function statPriority(sport,position=''){
  const table=common[sport]||{};
  const pos=String(position||'').toUpperCase();
  if(table[pos])return [...table[pos]];
  if(sport==='mlb'){
    if(/^(1B|2B|3B|SS)$/.test(pos))return ['HR','H','RBI','TB'];
    if(pos==='DH')return ['HR','H','RBI','TB'];
  }
  return [...(table.DEFAULT||[])];
}
export function optionScore(text,priority=[]){
  const value=' '+String(text||'').toUpperCase().replace(/[^A-Z0-9]+/g,' ')+' ';
  let score=0;
  priority.forEach((stat,index)=>{if(value.includes(' '+stat.toUpperCase()+' '))score=Math.max(score,1000-index*25);});
  const quantity=Number(String(text||'').match(/\bx(\d+)\s*$/i)?.[1]||0);
  return score+Math.min(quantity,20);
}
export function chooseOption(options,priority=[]){
  if(!Array.isArray(options)||!options.length)return null;
  return [...options].sort((a,b)=>optionScore(b.text??b,priority)-optionScore(a.text??a,priority))[0];
}
export function validateBoosterTargets(targets){
  if(!Array.isArray(targets)||targets.length>10000)throw new OperationError('Неверный список игроков для бустеров.');
  const clean=targets.map(t=>{
    if(typeof t.accountId!=='string'||!t.accountId||!Object.hasOwn(LEAGUES,t.sport)||!Number.isSafeInteger(Number(t.entityId))||Number(t.entityId)<=0||typeof t.name!=='string'||!t.name.trim()||t.name.length>150||![3,4,5].includes(Number(t.desiredRarity)))throw new OperationError('Неверная настройка игрока для бустеров.');
    const position=typeof t.position==='string'?t.position.trim().slice(0,20):'';
    return {accountId:t.accountId,sport:t.sport,entityId:Number(t.entityId),name:t.name.trim(),position,desiredRarity:Number(t.desiredRarity)};
  });
  if(new Set(clean.map(boosterKey)).size!==clean.length)throw new OperationError('Игрок для бустеров указан несколько раз.');
  return clean;
}
export function findConfiguredTarget(settings,accountId,sport,playerName){
  const name=NORMALIZE(playerName);
  return settings.boosterTargets.find(t=>t.accountId===accountId&&t.sport===sport&&NORMALIZE(t.name)===name)||null;
}
