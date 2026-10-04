import https from 'node:https';
import Hashids from 'hashids';

const requestHash = new Hashids('realwebapp', 16);
export function requestToken(time = Date.now()) { return requestHash.encode(time); }

export const SEASONS = Object.freeze({ nfl: '2026', ufc: '2023' });
export const LEAGUES = Object.freeze({nfl:'NFL',ufc:'UFC',soccer:'FC',nba:'NBA',wnba:'WNBA',nhl:'NHL',mlb:'MLB',ncaaf:'CFB',ncaam:'CBB',golf:'Golf'});

export class OperationError extends Error {
  constructor(message, uncertain = false) { super(message); this.uncertain = uncertain; }
}

export function parseHar(input) {
  const har = typeof input === 'string' ? JSON.parse(input) : input;
  if (!Array.isArray(har?.log?.entries)) throw new Error('Файл не содержит HAR log.entries.');
  const accounts = new Map();
  for (const entry of har.log.entries) {
    let url;
    try { url = new URL(entry.request.url); } catch { continue; }
    if (url.origin !== 'https://web.realapp.com' || url.pathname !== '/user' || entry.request.method !== 'GET' || entry.response.status !== 200) continue;
    let result;
    try {
      const c = entry.response.content;
      result = JSON.parse(c.encoding === 'base64' ? Buffer.from(c.text, 'base64').toString('utf8') : c.text);
    } catch { continue; }
    const user = result?.user;
    if (!user?.id) continue;
    const headers = {};
    for (const h of entry.request.headers || []) {
      const name = h.name.toLowerCase();
      if (/^real-[a-z-]+$/.test(name) && !['real-request-token','real-turnstile-token'].includes(name)) headers[name] = String(h.value);
      if (['authorization', 'cookie', 'user-agent'].includes(name)) headers[name] = String(h.value);
    }
    if (!headers['real-auth-info']) continue;
    accounts.set(String(user.id), {
      id: String(user.id), name: user.userName || user.name || String(user.id),
      balance: Number.isFinite(user.virtualCurrencyBalance) ? user.virtualCurrencyBalance : null,
      importedAt: new Date().toISOString(), observedAt: entry.startedDateTime,
      checkedAt: null, status: 'imported', headers, packs: {},
    });
  }
  if (!accounts.size) throw new Error('Нет успешных GET /user с real-auth-info. Запишите переключение аккаунтов с включённым Preserve log.');
  return [...accounts.values()];
}

export function publicAccount(account) {
  return Object.fromEntries(['id', 'name', 'balance', 'importedAt', 'observedAt', 'checkedAt', 'status', 'packs', 'seasons','lastError','sessionSource','lastSessionAt'].map(k => [k, account[k] ?? null]));
}

export function realRequest(account, method, path, body) {
  if(method!=='GET'||body!==undefined)throw new OperationError('Покупки доступны только через обычный интерфейс Real в служебном браузере.');
  if (!/^\/(user$|collectingpacks\/|collecting\/[a-zA-Z0-9]+\/info$|userpasses\/[a-zA-Z0-9]+\/passes\?|(?:players|teams)\/sport\/[a-z]+\/search\?|cardmarketplacelistings\/card\/\d+\/info)/.test(path)) throw new Error('Недопустимый API путь.');
  return sendReal(account,method,path,body);
}

// Only official listing operations. Mint/purchase endpoints remain GET-only above.
// There are no challenge headers, automatic retries or subscription changes here.
export function listingRequest(account,path,body){
  if(!['/quicklist/preview','/quicklist','/cardmarketplacelistings'].includes(path))throw new Error('Недопустимый путь листинга.');
  const ids=path==='/cardmarketplacelistings'?[body?.cardId]:body?.cardIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>25||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<=0))throw new Error('Неверные карты для листинга.');
  if(path!=='/quicklist/preview'&&body.durationInHours!==24)throw new Error('Листинг разрешён только на 24 часа.');
  if(path==='/quicklist'&&!['default','min','max'].includes(body.pricingMode))throw new Error('Неверный режим цены.');
  if(path==='/cardmarketplacelistings'&&(body.listingType!=='card'||body.allowBids!==false||!Number.isFinite(body.buyNowPrice)||body.buyNowPrice<=0||body.minBidPrice!==body.buyNowPrice))throw new Error('Неверная фиксированная цена.');
  return sendReal(account,'POST',path,body);
}

function sendReal(account,method,path,body){
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers = {
    ...Object.fromEntries(Object.entries(account.headers).filter(([key])=>key!=='real-turnstile-token')),
    'real-request-token': requestToken(),
    accept: 'application/json', 'content-type': 'application/json',
    origin: 'https://realsports.io', referer: 'https://realsports.io/',
    'accept-encoding': 'identity',
  };
  if (payload) headers['content-length'] = payload.length;
  return new Promise((resolve, reject) => {
    let submitted = false;
    const request = https.request({ hostname: 'web.realapp.com', port: 443, path, method, headers, timeout: 25000 }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) request.destroy(new Error('Response too large'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(new OperationError('Соединение прервано. Проверьте результат в Real.', method === 'POST' && submitted)));
      response.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new OperationError('Real вернул ответ не в JSON. Проверьте вход в браузере.', method === 'POST' && submitted)); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const messages = {
            401: data.message === 'Invalid request.' ? 'Real отклонил request-token. Проверьте время Windows и версию клиента.' : 'Real отклонил авторизацию: нажмите «Добавить аккаунты» и войдите заново.',
            403: 'Real отклонил запрос (403). Проверьте доступ и состояние аккаунта в Real.',
            429: 'Лимит запросов Real (429). Повторите позже.',
          };
          const error=new OperationError(messages[response.statusCode] || `Ошибка Real HTTP ${response.statusCode}.`, method === 'POST' && response.statusCode >= 500);
          error.httpStatus=response.statusCode;
          const retryAfter=response.headers['retry-after'];
          if(response.statusCode===429)error.retryAfterMs=Math.max(60000,/^\d+$/.test(String(retryAfter))?Number(retryAfter)*1000:Date.parse(retryAfter)-Date.now()||0);
          reject(error);
          return;
        }
        resolve(data);
      });
    });
    request.on('finish', () => { submitted = true; });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => reject(new OperationError('Не удалось завершить запрос к Real. Проверьте соединение.', method === 'POST' && submitted)));
    if (payload) request.write(payload);
    request.end();
  });
}

export async function verifyAccount(account, request = realRequest) {
  const data = await request(account, 'GET', '/user');
  if (String(data?.user?.id) !== account.id) throw Object.assign(new OperationError('Сессия вернула другой аккаунт. Войдите заново через «Добавить аккаунты»; покупка остановлена.'),{requiresAttention:true});
  const user = data.user;
  account.name = user.userName || account.name;
  account.balance = Number.isFinite(user.virtualCurrencyBalance) ? user.virtualCurrencyBalance : null;
  account.checkedAt = new Date().toISOString();
  account.status = 'ready'; account.lastError = null;
  return user;
}

export async function getPackInfo(account, sport, request = realRequest) {
  const season=account.seasons?.[sport]||SEASONS[sport];
  if (!Object.hasOwn(LEAGUES,sport)||!season) throw new OperationError('Обновите доступные лиги и сезоны аккаунта.');
  const response = await request(account, 'GET', `/collectingpacks/general?season=${season}&sport=${sport}`);
  const info = response?.info;
  if (!info || info.sport !== sport || String(info.season) !== String(season) || !Number.isFinite(info.cost) || info.cost < 0) throw new OperationError('Не удалось проверить цену/сезон пака.');
  const pack = {
    cost: info.cost, season: String(info.season), description: info.description || '',
    details: info.secondaryDescription || '', disabled: info.purchaseDisabledMessage || null,
    packImage: typeof info.packBackgroundSource==='string' && /^assets\/packs\/[a-zA-Z0-9._/-]+$/.test(info.packBackgroundSource) ? info.packBackgroundSource : null,
    activateLabel: info.confirmCallToAction || 'Activate pack', openLabel: info.callToAction || 'Press the pack to open 👆',
    checkedAt: new Date().toISOString(),
  };
  account.packs[sport] = pack;
  return pack;
}

export async function getLeagueCatalog(account,request=realRequest){
  const data=await request(account,'GET',`/collecting/${account.id}/info`),map=data?.info?.sportSeasonMap;
  if(!map||typeof map!=='object')throw new OperationError('Real не вернул список сезонов.');
  account.seasons=Object.fromEntries(Object.keys(LEAGUES).filter(s=>Number.isSafeInteger(Number(map[s]?.[0]?.id))).map(s=>[s,String(map[s][0].id)]));
  return account.seasons;
}

export async function searchPlayers(account,sport,query,request=realRequest){
  if(!Object.hasOwn(LEAGUES,sport)||typeof query!=='string'||query.trim().length<2||query.length>100)throw new OperationError('Выберите лигу и введите минимум два символа.');
  const season=account.seasons?.[sport]||SEASONS[sport];if(!season)throw new OperationError('Сначала обновите лиги аккаунта.');
  const entity=sport==='ufc'?'teams':'players';
  const params=new URLSearchParams({query:query.trim(),season,includeNoOneOption:'false'});
  const data=await request(account,'GET',`/${entity}/sport/${sport}/search?${params}`);
  if(!Array.isArray(data?.[entity]))throw new OperationError('Real не вернул результаты поиска.');
  return data[entity].filter(p=>Number.isSafeInteger(Number(p.id))&&Number(p.id)>0).slice(0,30).map(p=>({id:Number(p.id),sport,entityType:sport==='ufc'?'team':'player',name:[p.firstName,p.lastName].filter(Boolean).join(' ')||p.name||p.fullName||p.displayName||String(p.id)}));
}

export async function getPackHistory(account,sport,request=realRequest){
  const season=account.seasons?.[sport]||SEASONS[sport];
  const data=await request(account,'GET',`/collectingpacks/${sport}/season/${season}/packhistory`);
  if(!Array.isArray(data?.packs))throw new OperationError('Real не вернул историю паков.');
  if(data.packs.some(p=>p.user?.id!==account.id))throw Object.assign(new OperationError('История содержит другой аккаунт. Автолистинг остановлен.'),{requiresAttention:true});
  return data.packs;
}

export async function getPlayerPackInfo(account,sport,playerId,request=realRequest){
  const season=account.seasons?.[sport];
  if(!Object.hasOwn(LEAGUES,sport)||!season||!Number.isSafeInteger(playerId)||playerId<=0)throw new OperationError('Обновите лиги аккаунта и выберите игрока.');
  const {info}=await request(account,'GET',`/collectingpacks/player?${new URLSearchParams({entityId:String(playerId),season,sport})}`);
  if(!info||info.packIdentifer!=='player'||info.sport!==sport||String(info.season)!==String(season)||Number(info.packEntityId??info.entityId)!==playerId||!Number.isFinite(info.cost)||info.cost<0||!/^assets\/packs\/[a-zA-Z0-9._/-]+$/.test(info.packBackgroundSource||'')||!info.description||!info.packLabel)throw new OperationError('Real не подтвердил Player Pack выбранного игрока.');
  return {cost:info.cost,season:String(season),playerId,playerName:info.packLabel,description:info.description,details:info.secondaryDescription||'',disabled:info.cost!==200?`Player packs покупаются только по 200 Rax. Real показывает ${info.cost} Rax.`:info.purchaseDisabledMessage||null,packImage:info.packBackgroundSource,activateLabel:info.confirmCallToAction||'Activate pack',openLabel:info.callToAction||'Press the pack to open 👆'};
}

export async function getOwnedPackPlayers(account,sport,request=realRequest){
  await verifyAccount(account,request);await getLeagueCatalog(account,request);
  const season=account.seasons?.[sport];
  if(!Object.hasOwn(LEAGUES,sport)||!season||sport==='ufc')throw new OperationError('Player packs этой лиги пока не поддерживаются; UFC использует бойцов, а не player.');
  const {passes}=await request(account,'GET',`/userpasses/${account.id}/passes?${new URLSearchParams({sport,season,entityType:'player'})}`);
  if(!Array.isArray(passes)||passes.length>10000||passes.some(p=>p.userId!==account.id||p.sport!==sport||p.entityType!=='player'||String(p.season)!==season||!Number.isSafeInteger(p.entityId)||p.entityId<=0))throw new OperationError('Real не подтвердил владельца игроков.');
  const players=new Map();
  for(const p of passes){if(p.isRefunded===true)continue;const name=p.label||p.entity?.displayName||p.entity?.name;if(typeof name!=='string'||!name.trim()||name.length>150)throw new OperationError('Не удалось прочитать имя игрока.');players.set(p.entityId,{id:p.entityId,name:name.trim(),sport,entityType:'player'});}
  return [...players.values()];
}

export async function getOwnedBoosterPlayers(account,sport=null,request=realRequest){
  await verifyAccount(account,request);
  await getLeagueCatalog(account,request);
  const sports=sport?[sport]:Object.keys(account.seasons||{}).filter(s=>Object.hasOwn(LEAGUES,s));
  if(sport&&!Object.hasOwn(LEAGUES,sport))throw new OperationError('Неизвестный вид спорта для бустеров.');
  const players=[];
  for(const current of sports){
    const season=account.seasons?.[current];
    if(!season)continue;
    const entityType=current==='ufc'?'team':'player';
    const params=new URLSearchParams({sport:current,season,entityType});
    const data=await request(account,'GET',`/userpasses/${account.id}/passes?${params}`);
    const passes=data?.passes;
    if(!Array.isArray(passes)||passes.length>15000)throw new OperationError('Real не вернул owned-карты для бустеров.');
    for(const p of passes){
      if(p?.isRefunded===true||String(p?.userId)!==account.id||p?.sport!==current||p?.entityType!==entityType||String(p?.season)!==String(season))continue;
      const entityId=Number(p.entityId);
      if(!Number.isSafeInteger(entityId)||entityId<=0)continue;
      const name=p.label||p.entity?.displayName||p.entity?.fullName||p.entity?.name;
      if(typeof name!=='string'||!name.trim()||name.length>150)continue;
      const position=String(p.position||p.entity?.position||p.primaryPlayer?.position||'').trim().slice(0,20);
      players.push({accountId:account.id,id:entityId,entityId,name:name.trim(),sport:current,entityType,position});
    }
  }
  const unique=new Map();
  for(const p of players)if(!unique.has(`${p.sport}:${p.entityId}`))unique.set(`${p.sport}:${p.entityId}`,p);
  return [...unique.values()].sort((a,b)=>a.sport.localeCompare(b.sport)||a.name.localeCompare(b.name));
}

export async function getOwnedUfcFighters(account,request=realRequest){
  await verifyAccount(account,request);
  const season=account.seasons?.ufc||SEASONS.ufc;
  const params=new URLSearchParams({sport:'ufc',season,entityType:'team'});
  const data=await request(account,'GET',`/userpasses/${account.id}/passes?${params}`);
  if(!Array.isArray(data?.passes)||data.passes.length>10000||data.passes.some(p=>p.userId!==account.id||p.sport!=='ufc'||p.entityType!=='team'||String(p.season)!==season||!Number.isSafeInteger(p.entityId)||p.entityId<=0))throw new OperationError('Owned UFC не прошли проверку владельца / лиги.');
  const fighters=new Map();
  for(const p of data.passes){
    if(p.isRefunded===true)continue;
    const name=p.entity?.name||p.entity?.displayName||p.label;
    if(typeof name!=='string'||!name.trim()||name.length>150)throw new OperationError('Real не вернул имя owned UFC-бойца.');
    fighters.set(p.entityId,{id:p.entityId,sport:'ufc',entityType:'team',name:name.trim()});
  }
  return [...fighters.values()];
}

export function packSummary(pack) {
  const cards = [...(Array.isArray(pack.cards) ? pack.cards : []), ...(Array.isArray(pack.boosterCards) ? pack.boosterCards : [])];
  return {
    id: pack.id, sport: pack.sport, season: pack.season, cost: pack.cost,
    cards: cards.map(c => ({
      id: c.id, rarity: c.rarityLabel || String(c.rarity ?? ''),
      label: c.entityLabel || c.primaryPlayer?.fullName || c.primaryPlayer?.name || c.infoLabel || c.collectingCategoryLabel || 'Карточка / бустер',
      category: c.collectingCategoryLabel || '', mint: c.mintNumber ?? null,
    })),
  };
}

export async function openPack(account, sport, approvedCost, request = realRequest) {
  // Identity is checked on the same immutable credentials immediately before purchase.
  await verifyAccount(account, request);
  const info = await getPackInfo(account, sport, request);
  if (info.disabled) throw new OperationError(`Пак недоступен: ${info.disabled}`);
  if (info.cost !== approvedCost) throw new OperationError('Цена изменилась. Обновите аккаунт и проверьте новую цену.');
  if (account.balance === null || account.balance < info.cost) throw new OperationError('Недостаточно баланса или баланс неизвестен.');
  const response = await request(account, 'POST', '/collectingpacks/general', {
    sport, season: SEASONS[sport], cost: approvedCost, acceptPriceChanges: false,
  });
  if (!response?.pack?.id || String(response.pack.userId) !== account.id || response.pack.sport !== sport) {
    throw new OperationError('Получен нестандартный результат покупки. Проверьте пак в Real перед повторением.', true);
  }
  account.balance -= info.cost;
  const summary = packSummary(response.pack);
  return summary;
}
