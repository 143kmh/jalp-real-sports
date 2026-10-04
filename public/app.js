const token = document.querySelector('meta[name="local-token"]').content;
const $ = id => document.getElementById(id);
const selected = new Set();
const UI_VERSION='0.4.5';
let state = { accounts: [], jobs: [], busy: false, runtimeVersion:null };
let sport = 'nfl';
let timer;
let sending = false;
let stopped = false;
let bridgeAvailable=false;
let connectTimer;
let settingsDraft=null,settingsDirty=false;
let searchResults=[];
let ppResults=[],ppQuote=null;
let boosterOwned=[];
let generalJobId=null;
const sections={
  accounts:['Аккаунты','Сессии, балансы и доступ к операциям.'],
  player:['Player packs','Выбор игроков и количества паков для каждого аккаунта.'],
  general:['General packs','Открытие, приоритет лиг и правила автолистинга.'],
  application:['Приложение','Подключение браузера, журнал и управление локальным сервером.'],
  boosters:['Бустеры','Автоматическое применение бустеров к owned игрокам, которые играют сегодня.']
};
function navigate(section){
  if(!sections[section])section='accounts';
  document.querySelectorAll('.view').forEach(view=>view.hidden=view.id!=='view-'+section);
  document.querySelectorAll('[data-section]').forEach(button=>{
    if(button.dataset.section===section)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  });
  $('view-title').textContent=sections[section][0];$('view-description').textContent=sections[section][1];
  document.title=sections[section][0]+' · Real Manager';
  if(location.hash!=='#'+section)history.replaceState(null,'','#'+section);
  window.scrollTo({top:0,behavior:'instant'});
}
document.querySelectorAll('[data-section],[data-go]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.section||button.dataset.go)));
window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)));
document.addEventListener('keydown',event=>{
  if(event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&/^Digit[1-5]$/.test(event.code)){
    event.preventDefault();navigate(Object.keys(sections)[Number(event.code.at(-1))-1]);
  }
});
navigate(location.hash.slice(1));
const renderedHTML=new Map();
function updateHTML(id,html){if(renderedHTML.get(id)!==html){$(id).innerHTML=html;renderedHTML.set(id,html);}}
function renderAccounts(){
  const query=$('account-query').value.toLocaleLowerCase().trim();
  const accounts=state.accounts.filter(a=>(a.name+' '+a.id).toLocaleLowerCase().includes(query));
  updateHTML('accounts',accounts.map(a=>{
    const status=!a.browserSession?'Нужен вход в браузере':a.purchaseHold?'Проверьте покупку в Real':a.status==='ready'?'Сессия браузера':a.status==='error'?'Нужна проверка сессии':'Аккаунт подключён';
    return `<tr><td><div class="account-name">${esc(a.name)}</div><div class="account-id mono">ID ${esc(a.id)}</div></td><td class="account-balance">${a.balance===null?'—':fmt(a.balance)}<small>Rax</small></td><td><span class="status ${a.purchaseHold?'hold':esc(a.status)}">${esc(status)}</span>${a.lastError?`<p class="card-error">${esc(a.lastError)}</p>`:''}</td><td><div class="row-actions"><button class="button secondary" data-account-player="${esc(a.id)}">Player packs</button><button class="button secondary" data-account-general="${esc(a.id)}">General packs</button><button class="button secondary" data-refresh="${esc(a.id)}" ${state.busy||sending?'disabled':''}>Обновить</button>${a.purchaseHold?`<button class="button danger" data-ack="${esc(a.id)}" ${state.busy?'disabled':''}>Результат проверен</button>`:''}</div></td></tr>`;
  }).join('')||(!state.accounts.length?'':'<tr><td colspan="4" class="empty-inline">Аккаунтов по этому запросу не найдено.</td></tr>'));
}
function renderGeneralAccounts(){
  updateHTML('general-accounts',connectedAccounts().map(a=>{
    return `<div class="account-choice account-card ${selected.has(a.id)?'selected':''}" data-id="${esc(a.id)}"><input type="checkbox" data-select="${esc(a.id)}" aria-label="Выбрать ${esc(a.name)}" ${selected.has(a.id)?'checked':''} ${state.busy||sending?'disabled':''}><span><b>${esc(a.name)}</b><small>${a.purchaseHold?'Есть неизвестное открытие · General продолжатся':'Сессия браузера подключена'}</small></span><span class="mono">${a.balance===null?'—':fmt(a.balance)} Rax</span></div>`;
  }).join('')||'<p class="empty-inline">Нажмите «Добавить аккаунты» в разделе «Аккаунты» и войдите в Real.</p>');
}
$('account-query').addEventListener('input',renderAccounts);
$('job-filter').addEventListener('change',render);
function renderPlayerPacks(){
  if(!settingsDraft)return;
  for(const id of ['pp-account','pp-sport']){
    const chosen=$(id).value;
    updateHTML(id,(id==='pp-account'?connectedAccounts().map(a=>[a.id,a.name]):Object.entries(state.leagues).filter(([s])=>s!=='ufc')).map(([v,n])=>`<option value="${esc(v)}">${esc(n)}</option>`).join(''));
    if([...$(id).options].some(o=>o.value===chosen))$(id).value=chosen;
  }
  const accountId=$('pp-account').value,league=$('pp-sport').value;
  if(!$('pp-selected').contains(document.activeElement))updateHTML('pp-selected',(settingsDraft.playerPacks||[]).map((p,i)=>p.accountId===accountId&&p.sport===league?`<div class="player-result"><span>${esc(p.name)} · ${esc(leagueName(p.sport))}</span><label>Паков <input type="number" min="1" max="100" value="${p.count}" data-pp-count="${i}" ${state.busy?'disabled':''}></label><button data-pp-remove="${i}" ${state.busy?'disabled':''}>Убрать</button></div>`:'').join('')||'<p class="empty-inline">Добавьте игроков из списка слева.</p>');
  for(const id of ['pp-owned','pp-search','pp-account','pp-sport','pp-query'])$(id).disabled=state.busy||sending||!connectedAccounts().length;
  $('pp-quote').disabled=state.busy||sending||settingsDirty||!settingsDraft.playerPacks?.some(p=>p.accountId===accountId&&p.sport===league);
  const quoteInvalid=state.busy||sending||state.recorder?.active||settingsDirty||!usableBrowser()||!ppQuote||ppQuote.expiresAt<Date.now()||ppQuote.accountId!==accountId||ppQuote.sport!==league;
  $('pp-open').disabled=quoteInvalid||!ppQuote?.canAfford;
  $('pp-check').disabled=quoteInvalid;
}
const leagueName=s=>state.leagues?.[s]||s.toUpperCase();
window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==location.origin||event.data?.source!=='real-manager-extension')return;
  bridgeAvailable=true;
  if(event.data.type==='CONNECT'){
    clearTimeout(connectTimer);
    notice(event.data.result?.ok?'Helium подключён. При необходимости войдите в Real в созданной вкладке.':event.data.result?.error||'Не удалось подключить Helium.',!event.data.result?.ok);
    sync();
  }
});
function wakeBrowser(){window.postMessage({source:'real-manager-panel',type:'WAKE'},location.origin);}
const fmt = n => Number(n).toLocaleString('ru-RU');
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(route, body) {
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-local-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка приложения.');
  return data;
}

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'notice error' : 'notice';
  $('notice').hidden = false;
}

function usableBrowser(){const owned=state.browser?.owned;if(state.browser?.mode==='owned'&&owned?.available&&!owned.running&&!owned.starting&&!owned.manualLogin)return true;return state.browser?.connected&&(state.browser.mode!=='owned'||state.browser.loggedIn);}
function connectedAccounts(){return state.accounts.filter(a=>a.browserSession===true);}
function canBuy(a, league = sport, strict = false) {
  if(!a.browserSession)return false;
  if(!strict&&state.settings?.generalResilience)return canMax(a);
  const p = a.packs?.[league];
  return !settingsDirty && usableBrowser() && !state.busy && !sending && !state.recorder?.active && a.status === 'ready' && !a.purchaseHold && p && !p.disabled && a.balance !== null && a.balance >= p.cost;
}
function canMax(a){return a.browserSession===true&&!settingsDirty&&usableBrowser()&&!state.busy&&!sending&&!state.recorder?.active&&state.settings?.priority?.length>0;}
function editSettings(){settingsDirty=true;ppQuote=null;$('settings-status').textContent='Есть несохранённые правила. Сохраните перед запуском.';render();}
function renderRules(){
  if(!state.settings)return;
  if(!settingsDraft){settingsDraft=structuredClone(state.settings);
    if(settingsDraft.pricingMode==='suggested'){settingsDirty=true;$('settings-status').textContent='Suggested удалён. Выберите Default / Min / Max и сохраните правила.';}
    $('general-resilience').checked=settingsDraft.generalResilience;$('general-no-limit').checked=settingsDraft.generalNoLimit;$('max-packs').value=settingsDraft.maxPacks;$('auto-list').checked=settingsDraft.autoList;$('pricing-mode').value=settingsDraft.pricingMode;$('protected-card-ids').value=settingsDraft.protectedCardIds.join(', ');
    $('search-sport').innerHTML=Object.entries(state.leagues).map(([s,name])=>`<option value="${esc(s)}">${esc(name)}</option>`).join('');
    $('single-sport').innerHTML=Object.entries(state.leagues).map(([s,name])=>`<option value="${esc(s)}">${esc(name)}</option>`).join('');$('single-sport').value=sport;
    $('booster-sport').innerHTML='<option value="">Все виды спорта</option>'+Object.entries(state.leagues).map(([s,name])=>`<option value="${esc(s)}">${esc(name)}</option>`).join('');
    $('booster-all').checked=Boolean(settingsDraft.boosterBoostAll);$('booster-no-legendary').checked=!settingsDraft.boosterUseLegendary;
  }
  const order=[...settingsDraft.priority,...Object.keys(state.leagues).filter(s=>!settingsDraft.priority.includes(s))];
  const leagueRow=s=>{const i=settingsDraft.priority.indexOf(s);return `<div class="priority-row"><input type="checkbox" data-priority="${esc(s)}" aria-label="Учитывать ${esc(leagueName(s))}" ${i>=0?'checked':''} ${state.busy?'disabled':''}><span>${i>=0?`${i+1}. `:''}${esc(leagueName(s))}</span>${i>=0?`<button data-move="${esc(s)}" data-direction="-1" ${i===0||state.busy?'disabled':''} aria-label="Поднять ${esc(leagueName(s))}">↑</button><button data-move="${esc(s)}" data-direction="1" ${i===settingsDraft.priority.length-1||state.busy?'disabled':''} aria-label="Опустить ${esc(leagueName(s))}">↓</button>`:''}</div>`;};
  const moreLeaguesOpen=$('priority-list').querySelectorAll('details[open]').length>0;
  updateHTML('priority-list',settingsDraft.priority.map(leagueRow).join('')+`<details class="league-options" ${moreLeaguesOpen?'open':''}><summary>Добавить лиги</summary><div>${order.filter(s=>!settingsDraft.priority.includes(s)).map(leagueRow).join('')||'<span class="muted">Все лиги выбраны</span>'}</div></details>`);
  $('protected-players').innerHTML=settingsDraft.protectedPlayers.map((p,i)=>`<div class="protected-player"><span>${esc(leagueName(p.sport))} · ${esc(p.name)}</span><button data-unprotect="${i}" ${state.busy?'disabled':''}>Убрать</button></div>`).join('')||'<p class="empty-inline">Защищённых игроков пока нет.</p>';
  const chosenAccount=$('search-account').value;
  $('search-account').innerHTML=connectedAccounts().map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');if(connectedAccounts().some(a=>a.id===chosenAccount))$('search-account').value=chosenAccount;
  for(const id of ['save-settings','general-resilience','general-no-limit','max-packs','auto-list','pricing-mode','protected-card-ids','search-players','protect-owned-ufc','booster-all','booster-no-legendary'])$(id).disabled=state.busy||sending;
  $('protect-owned-ufc').disabled=state.busy||sending||!connectedAccounts().length;
  $('save-settings').disabled=state.busy||sending||!settingsDirty;
  $('settings-status').classList.toggle('dirty',settingsDirty);
  $('max-all').disabled=!connectedAccounts().length||!connectedAccounts().every(canMax);
  const chosen=state.accounts.filter(a=>selected.has(a.id));$('max-selected').disabled=!chosen.length||!chosen.every(canMax);
}
function renderBoosters(){
  if(!settingsDraft)return;
  const previous=$('booster-account').value;
  updateHTML('booster-account',connectedAccounts().map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join(''));
  if(connectedAccounts().some(a=>a.id===previous))$('booster-account').value=previous;
  const accountId=$('booster-account').value,sportFilter=$('booster-sport').value,query=$('booster-query').value.toLocaleLowerCase().trim();
  const configured=settingsDraft.boosterTargets||[];
  const matches=boosterOwned.filter(p=>p.accountId===accountId&&(!sportFilter||p.sport===sportFilter)&&(!query||(p.name+' '+p.position+' '+leagueName(p.sport)).toLocaleLowerCase().includes(query)));
  const rarityName=r=>({3:'Rare',4:'Epic',5:'Legendary'})[r]||'—';
  updateHTML('booster-owned',matches.length?matches.map(p=>{
    const index=configured.findIndex(t=>t.accountId===p.accountId&&t.sport===p.sport&&Number(t.entityId)===Number(p.entityId)),target=index>=0?configured[index]:null;
    return `<div class="player-result"><span><b>${esc(p.name)}</b><small>${esc(leagueName(p.sport))}${p.position?' · '+esc(p.position):''}</small></span><label><input type="checkbox" data-booster-toggle="${esc(p.sport)}:${p.entityId}" ${target?'checked':''} ${state.busy?'disabled':''}> Бустить</label><select data-booster-rarity="${esc(p.sport)}:${p.entityId}" ${!target||state.busy?'disabled':''}><option value="3" ${target?.desiredRarity===3?'selected':''}>Rare</option><option value="4" ${target?.desiredRarity===4?'selected':''}>Epic</option><option value="5" ${target?.desiredRarity===5?'selected':''}>Legendary</option></select></div>`;
  }).join(''):'<p class="empty-inline">Нет загруженных owned игроков по текущему фильтру.</p>');
  const selected=configured.filter(t=>t.accountId===accountId);
  updateHTML('booster-selected',selected.length?selected.slice(0,100).map(t=>`<div class="protected-player"><span>${esc(leagueName(t.sport))} · ${esc(t.name)}${t.position?' · '+esc(t.position):''}</span><span class="badge">${rarityName(t.desiredRarity)}</span></div>`).join(''):`<p class="empty-inline">${settingsDraft.boosterBoostAll?'Режим «Забустить всех» включён: отдельный список не обязателен.':'Игроки не выбраны.'}</p>`);
  $('booster-load').disabled=state.busy||sending||!accountId;
  $('booster-account').disabled=state.busy||sending||!connectedAccounts().length;
  $('booster-sport').disabled=state.busy||sending;
  $('booster-query').disabled=state.busy||sending;
  $('booster-run').disabled=state.busy||sending||settingsDirty||!usableBrowser()||!accountId||(!settingsDraft.boosterBoostAll&&!selected.length);
  $('booster-hint').textContent=settingsDirty?'Сохраните правила перед запуском.':!usableBrowser()?'Запустите служебный Chrome и войдите в Real.':settingsDraft.boosterBoostAll?'Будут взяты первые 25 owned игроков из Today\'s players.':'Будут обработаны первые 25 выбранных игроков, которые есть в Today\'s players.';
}
function renderPack(pack,key){
  const records=pack.listings||[],labels={queued:'В очереди Real',listed:'Выставлена',kept:'Оставлена',submitting:'Отправляется',cancelled:'Отменено',uncertain:'Проверьте в Real',error:'Ошибка'};
  return `<div class="pack-result"><details class="job-cards" data-detail-key="${esc(key)}"><summary>${esc(leagueName(pack.sport||'nfl'))} · ${pack.cardCount??pack.cards?.length??0} карт / бустеров · ${fmt(pack.cost??0)} Rax${pack.id?` · пак №${esc(pack.id)}`:''}</summary>${(pack.cards||[]).map(c=>{const listing=records.find(r=>r.cardId===c.id),protectedCard=state.settings?.protectedCardIds.includes(c.id);return `<div class="received-card"><span>${esc(c.rarity)} · ${esc(c.label)}${c.mint!=null?` · #${esc(c.mint)}`:''}${listing?`<br><span class="listing-state">${esc(labels[listing.status]||listing.status)}${listing.durationHours?' · 24ч':''}${listing.mode?` · ${esc(listing.mode)}`:''}${listing.price!=null?` · ${fmt(listing.price)} Rax`:listing.priceDisplay?` · ${esc(listing.priceDisplay)}`:''}${listing.message?` · ${esc(listing.message)}`:''}</span>`:''}</span><button class="card-protect" data-protect-card="${c.id}" ${state.busy?'disabled':''}>${protectedCard?'Снять защиту':'Защитить'}</button></div>`;}).join('')}${pack.listingError?`<p class="listing-error">${esc(pack.listingError)}</p>`:''}${pack.summaryText?`<p class="pack-summary">${esc(pack.summaryText)}</p>`:''}</details></div>`;
}

function renderRecovery(item,jobId){
  const warnings=item.generalProgress?.warnings||[];
  return warnings.length? `<details class="recovery-log" data-detail-key="${esc(jobId+':recovery:'+item.accountId)}"><summary>Сбои и восстановление · ${warnings.length}</summary>${warnings.map(w=>`<p><span class="mono">${esc(new Date(w.at).toLocaleTimeString('ru-RU'))}</span> ${esc(w.message)}</p>`).join('')}</details>` : '';
}
function generalProgressMarkup(job){
  if(!job)return '<p class="empty-inline">После запуска здесь появятся аккаунты, выбранные лиги и количество открытых паков.</p>';
  const leagues=job.type==='open'?[job.sport]:(job.settings?.priority||[]);
  const counts=item=>({confirmed:Math.max(item.generalProgress?.count||0,item.packs?.length||(item.pack?1:0)),unknown:item.generalProgress?.unknown||0});
  const completed=item=>item.generalProgress?.completed===true&&['success','warning'].includes(item.status)&&leagues.every(s=>item.generalProgress.leagues?.[s]?.state==='done');
  const totals=job.items.reduce((n,i)=>{const c=counts(i);return {confirmed:n.confirmed+c.confirmed,unknown:n.unknown+c.unknown,completed:n.completed+Number(completed(i))};},{confirmed:0,unknown:0,completed:0});
  const status={queued:'В очереди',running:'Выполняется',done:'Завершён',cancelled:'Остановлен',error:'Требуется действие',interrupted:'Прерван перезапуском'};
  const cells=(item,s)=>{
    const p=item.generalProgress?.leagues?.[s];
    if(!p){const confirmed=(item.packs||[]).filter(pack=>pack.sport===s).length;return `<td class="league-cell"><span class="mono">${confirmed||'—'}</span></td>`;}
    const label=p.state==='done'?(p.evidence==='balance'?'Недостаточно Rax':p.evidence==='Real UI'?'Лимит Real':'Недоступно в Real'):p.state==='running'?'Открытие / проверка':'В очереди';
    const confirmed=Math.max(p.count||0,(item.packs||[]).filter(pack=>pack.sport===s).length);
    return `<td class="league-cell ${esc(p.state)}" title="${esc(p.reason||label)}"><b class="mono">${fmt(confirmed)}</b>${p.unknown?`<span class="unknown-count"> + ${fmt(p.unknown)} ?</span>`:''}<small>${esc(label)}</small></td>`;
  };
  return `<div class="general-run-stats"><span class="run-label ${esc(job.status)}">${esc(status[job.status]||job.status)}</span><span>Открыто <b class="mono">${fmt(totals.confirmed)}</b></span><span>Аккаунтов <b class="mono">${totals.completed} / ${job.items.length}</b></span>${totals.unknown?`<span class="unknown-count">Неизвестно <b class="mono">${fmt(totals.unknown)}</b></span>`:''}<span class="muted">${job.settings?.autoList?'Quick list · '+esc(job.settings.pricingMode)+' · 24ч':'Автолистинг выключен'}</span></div>${job.message?`<p class="listing-error">${esc(job.message)}</p>`:''}<div class="table-wrap"><table class="general-progress-table"><thead><tr><th>Аккаунт</th>${leagues.map(s=>`<th>${esc(leagueName(s))}</th>`).join('')}<th>Всего</th><th>Состояние</th></tr></thead><tbody>${job.items.map(item=>{
    const p=item.generalProgress||{},c=counts(item),done=completed(item),retry=p.retryAt&&item.status==='running';
    const phase=done?'Завершён':retry?'Восстановление':item.status==='queued'?'В очереди':item.status==='running'?(p.phase||'Открытие паков'):item.status==='cancelled'?'Остановлен':['error','uncertain'].includes(item.status)?'Требуется действие':item.status==='warning'?'Завершён с предупреждениями':'Завершён (предыдущая версия)';
    const detail=retry?`Повтор через ${Math.max(0,Math.ceil((p.retryAt-Date.now())/1000))} с. · ${p.lastError||''}`:done?(c.unknown?`${c.unknown} открытий без подтверждения. Карты могли остаться без листинга.`:p.warnings?.length?'Сбои восстановлены. Подробности в журнале.':'Все выбранные лиги проверены'):['error','cancelled','uncertain','warning'].includes(item.status)?item.message||'':p.currentSport?leagueName(p.currentSport):'';
    return `<tr class="${done?'account-complete':item.status==='running'?'account-active':''}"><td><b>${esc(item.accountName)}</b></td>${leagues.map(s=>cells(item,s)).join('')}<td class="mono">${fmt(c.confirmed)}${c.unknown?`<small class="unknown-count">${fmt(c.unknown)} неизвестно</small>`:''}</td><td class="progress-phase"><span class="run-label ${done?'done':esc(item.status)}">${esc(phase)}</span>${detail?`<small title="${esc(detail)}">${esc(detail)}</small>`:''}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function renderGeneralProgress(){
  const jobs=state.jobs.filter(j=>['max','open'].includes(j.type));
  if(!jobs.some(j=>j.id===generalJobId))generalJobId=jobs[0]?.id||null;
  updateHTML('general-run-choice',jobs.map(j=>`<option value="${esc(j.id)}">${esc(new Date(j.createdAt).toLocaleString('ru-RU'))} · ${j.items.length} акк.</option>`).join(''));
  $('general-run-choice').value=generalJobId||'';$('general-run-choice').disabled=!jobs.length;
  updateHTML('general-progress',generalProgressMarkup(jobs.find(j=>j.id===generalJobId)));
  const selectedIds=state.accounts.filter(a=>selected.has(a.id));
  $('select-all').disabled=state.busy||sending;
  $('general-launch-hint').textContent=state.busy?'Задача выполняется. Панель можно закрыть; остановка — в верхней панели.':settingsDirty?'Сохраните правила перед запуском.':!usableBrowser()?'Запустите служебный браузер и войдите в Real.':!selectedIds.length?'Выберите аккаунты или запустите на всех подключённых.':'Будет израсходован весь доступный баланс. Приоритет: '+(state.settings?.priority||[]).map(leagueName).join(' → ')+'.';
}
$('general-run-choice').addEventListener('change',()=>{generalJobId=$('general-run-choice').value;renderGeneralProgress();});
function renderSelection() {
  const chosen = state.accounts.filter(a => selected.has(a.id));
  $('selected-count').textContent = `${chosen.length} выбрано`;
  $('purchase-count').textContent = chosen.length;
  $('select-all').checked = !!connectedAccounts().length && chosen.length === connectedAccounts().length;
  $('select-all').indeterminate = chosen.length > 0 && chosen.length < connectedAccounts().length;
  const known = chosen.length > 0 && chosen.every(a => a.packs?.[sport] && a.status === 'ready');
  const costs = known ? chosen.map(a => a.packs[sport].cost) : [];
  $('price-label').textContent = known ? new Set(costs).size === 1 ? `${fmt(costs[0])} Rax / аккаунт` : 'Индивидуальные цены' : 'Обновите цены';
  $('total-cost').textContent = known ? `${fmt(costs.reduce((a, b) => a + b, 0))} Rax` : '—';
  const ready = chosen.length > 0 && chosen.every(a => canBuy(a));
  $('open-selected').disabled = !ready;
  $('open-selected').textContent = state.busy || sending ? 'Выполняется задача…' : `Открыть ${sport.toUpperCase()} в выбранных`;
  $('purchase-hint').textContent = state.busy ? 'Операции выполняются последовательно. Панель можно закрыть.'
    : !chosen.length ? 'Выберите один или несколько аккаунтов в списке.'
    : settingsDirty ? 'Сохраните изменённые правила кнопкой в верхней панели.'
    : !usableBrowser() ? 'Запустите служебный браузер и выполните вход в разделе «Приложение».'
    : state.settings?.generalResilience ? 'Один пак на аккаунт. Цена и баланс проверяются перед покупкой. Сбои не блокируют остальные аккаунты; неизвестное открытие считается попыткой.'
    : chosen.some(a=>a.purchaseHold) ? 'Есть неизвестный результат покупки. Проверьте его в Real, затем подтвердите проверку в разделе «Аккаунты».'
    : chosen.some(a=>a.status!=='ready'||!a.packs?.[sport]) ? 'Обновите выбранные аккаунты: нужны актуальные сессии и цены.'
    : chosen.some(a=>a.packs[sport].disabled) ? 'Real ограничил пак в одном из выбранных аккаунтов. Выберите другую лигу или аккаунт.'
    : chosen.some(a=>a.balance===null||a.balance<a.packs[sport].cost) ? 'В одном из выбранных аккаунтов недостаточно Rax. Измените выбор.'
    : ready ? `Будет открыт 1 ${leagueName(sport)} General Pack в каждом выбранном аккаунте. Нажатие списывает указанную сумму Rax.`
    : 'Дождитесь завершения текущего действия.';
  document.querySelectorAll('.account-card').forEach(card => {
    card.classList.toggle('selected', selected.has(card.dataset.id));
    card.querySelector('input').checked = selected.has(card.dataset.id);
  });
  if(state.settings){const chosen=state.accounts.filter(a=>selected.has(a.id));$('max-selected').disabled=!chosen.length||!chosen.every(canMax);}
  renderGeneralProgress();
}

function renderOwnedBrowser(){
  const owned=state.browser?.owned||{};
  $('owned-status').textContent=owned.extensionRequired&&owned.running?'Окно Chrome открыто · установите расширение Real Manager из '+owned.extensionPath:owned.manualLogin?'Войдите в обычном Chrome. Окно не закрывайте; нажмите «Готово» в разделе «Аккаунты».':owned.starting?'Открывается отдельное окно Real…':owned.running?'Окно Real открыто · '+(owned.loggedIn?'Real готов':owned.error||'Ожидается вход / ручная проверка Real'):owned.error||'Окно Real откроется при запуске задачи';
  $('visibility-hint').textContent='Все задачи выполняются в отдельном видимом окне Chrome. Держать Real в Helium не нужно. Не закрывайте окно Real во время задачи; при ручной проверке очередь остановится.';
  for(const id of ['owned-start','owned-login','owned-stop'])$(id).disabled=state.busy||sending||state.recorder?.active||owned.starting||(id==='owned-stop'&&!owned.running);
  for(const id of ['add-account','empty-add-account','finish-accounts'])$(id).disabled=state.busy||sending||owned.starting;
  $('finish-accounts').hidden=!owned.addingAccounts;
  const captured=owned.accountCapture||{};
  $('account-login-status').textContent=captured.error|| (owned.addingAccounts?'Войдите в один аккаунт в обычном Chrome. Не закрывайте окно; дождитесь имени и нажмите «Готово». Для следующего аккаунта используйте Switch account → Add account.':'Подключено через браузер: '+connectedAccounts().length+' из '+state.accounts.length+'.')+(captured.lastName?' Последний подтверждённый вход: '+captured.lastName+'.':'');
  $('diagnostic-export').disabled=sending||owned.starting||!owned.running;
  $('connect-browser').disabled=state.busy||sending||owned.running||owned.starting;
}
function renderRecorder(){
  const recorder=state.recorder||{active:false};
  const owned=state.browser?.owned||{};
  const mismatch=state.runtimeVersion!==UI_VERSION;
  $('recorder-status').textContent=mismatch?`Backend ${state.runtimeVersion?'v'+state.runtimeVersion:'не определён'}; для Recorder нужен полный перезапуск Real Manager до v${UI_VERSION}.`:recorder.active?`Запись идёт: ${recorder.name} · с ${new Date(recorder.startedAt).toLocaleTimeString('ru-RU')}. Выполните сценарий вручную в окне Real.`:'Запись не запущена.';
  $('recorder-name').disabled=mismatch||recorder.active||state.busy||sending;
  $('recorder-start').disabled=mismatch||recorder.active||state.busy||sending||!state.browser?.connected||!state.browser?.loggedIn||owned.starting;
  $('recorder-stop').disabled=mismatch||!recorder.active||sending;
}
function render() {
  $('browser-status').textContent=state.browser?.mode==='owned'?'Выбран служебный браузер. Helium не используется.':state.browser?.connected?'Подключён · действия выполняются в обычной вкладке Real':state.browser?.version?'Обновите расширение до версии 0.3.9 и подключите заново':'Расширение не подключено';
  for (const id of selected) if (!connectedAccounts().some(a => a.id === id)) selected.delete(id);
  $('account-count').textContent = state.accounts.length;
  $('count-badge').textContent = state.accounts.length;
  const balances = state.accounts.filter(a => a.balance !== null);
  $('balance-total').innerHTML = `${fmt(balances.reduce((sum, a) => sum + a.balance, 0))} <small>Rax</small>`;
  $('pack-count').textContent = state.jobs.reduce((sum, j) => sum + (['open','max','player'].includes(j.type)?j.items.reduce((n,i)=>n+(i.packs?.length??(i.pack?1:0)),0):0),0);
  $('empty').hidden = state.accounts.length > 0;
  $('refresh-all').disabled = state.busy || sending || state.recorder?.active || !connectedAccounts().length;
  renderAccounts();renderGeneralAccounts();renderBoosters();
  $('connection-dot').classList.toggle('connected',!!state.browser?.connected);
  $('connection-label').textContent=state.browser?.connected?(state.browser.mode==='owned'?'Браузер бота подключён':'Helium подключён'):'Нет подключения';
  renderOwnedBrowser();
  $('runtime-version').textContent=state.runtimeVersion?`backend v${state.runtimeVersion}${state.runtimeVersion===UI_VERSION?'':' · нужен перезапуск'}`:'backend ? · нужен перезапуск';
  renderRecorder();
  $('run-state').textContent=state.busy?'Задача выполняется':sending?'Отправка…':'Ожидание';
  $('run-state').classList.toggle('busy',state.busy||sending);
  const labels = { queued: 'В очереди', running: 'Выполняется', success: 'Готово', error: 'Ошибка', uncertain: 'Неизвестно', warning: 'Предупреждения', cancelled: 'Отменено' };
  const filter=$('job-filter').value;
  const jobs=state.jobs.filter(j=>filter==='all'||filter==='packs'&&['open','max','player','boosters'].includes(j.type)||filter==='errors'&&(j.status==='error'||j.status==='uncertain'||j.items.some(i=>['error','uncertain','warning'].includes(i.status))));
  const openedDetails=[...$('jobs').querySelectorAll('details[open]')].map(e=>e.dataset.detailKey);
  updateHTML('jobs',jobs.length ? jobs.map(job => {
    const title = job.type==='boosters'?'Бустеры · первые 25':job.type==='player-check'?`${leagueName(job.sport)} · Проверка Player packs без покупки`:job.type==='player'?`${leagueName(job.sport)} · Player packs · все карты сохраняются`:job.type==='max'?`Максимум · ${job.settings.priority.map(leagueName).join(' → ')}`:job.type === 'open' ? `${leagueName(job.sport)} · General Pack` : job.type==='check'?`Проверка ${leagueName(job.sport)} · без покупки`:'Обновление аккаунтов';
    const date = new Date(job.createdAt).toLocaleString('ru-RU');
    return `<div class="job"><div class="job-head"><b>${esc(title)}</b><small>${esc(date)}</small></div>${job.message ? `<p class="card-error">${esc(job.message)}</p>` : ''}${job.items.map(item => `<div class="job-item"><span class="job-state ${esc(item.status)}">${esc(labels[item.status] || item.status)}</span><div><b>${esc(item.accountName)}</b> ${esc(item.message || '')}${renderRecovery(item,job.id)}${(item.packs||(item.pack?[item.pack]:[])).map((pack,i)=>renderPack(pack,job.id+':'+item.accountName+':'+i)).join('')}</div></div>`).join('')}</div>`;
  }).join('') : '<p class="empty-inline">Нет операций для выбранного фильтра.</p>');
  $('jobs').querySelectorAll('details').forEach(detail=>{if(openedDetails.includes(detail.dataset.detailKey))detail.open=true;});
  $('cancel-job').hidden = !state.busy || !state.jobs.some(j => ['running','queued'].includes(j.status));
  if (!state.busy && $('notice').textContent === 'Проверяем сессии, баланс и цены паков.' && state.jobs[0]?.type === 'refresh' && state.jobs[0].status === 'done') {
    const ok = state.jobs[0].items.filter(i => i.status === 'success').length;
    notice(`Обновление завершено: ${ok} из ${state.jobs[0].items.length} аккаунтов проверено.`, ok !== state.jobs[0].items.length);
  }
  renderSelection();
  renderRules();
  renderPlayerPacks();
}

async function sync() {
  if (stopped) return;
  clearTimeout(timer);
  try {
    const [next,health]=await Promise.all([
      api('state'),
      fetch('/health',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null),
    ]);
    next.runtimeVersion=health?.version||next.version||null;
    state=next;render();
  }
  catch { notice('Нет связи с приложением. Запустите его через «Запустить Real Manager.cmd».', true); }
  timer = setTimeout(sync, state.busy||state.browser?.owned?.addingAccounts ? 2000 : 30000);
}

async function startJob(type, ids, league = sport) {
  if (sending || state.busy) return;
  sending = true; render();
  try {
    const costs = Object.fromEntries(ids.map(id => [id, state.accounts.find(a => a.id === id)?.packs?.[league]?.cost]));
    const budgets=Object.fromEntries(ids.map(id=>[id,state.accounts.find(a=>a.id===id)?.balance]));
    const result=await api('jobs', { type, accountIds: ids, sport: league, costs,budgets, requestId: crypto.randomUUID() });
    if(['max','open'].includes(type)){generalJobId=result.job.id;navigate('general');}
    if(type!=='refresh'&&state.browser?.mode!=='owned')wakeBrowser();
    notice(type==='max'?`Максимальное открытие запущено для ${ids.length} аккаунтов. Правила зафиксированы; баланс проверяется перед каждым паком.`:type === 'open' ? `Открытие ${leagueName(league)} запущено для ${ids.length} аккаунтов. Результаты появятся в истории.` : type==='check'?`Проверяем интерфейс ${leagueName(league)} без активации и покупки пака.`:'Проверяем сессии, баланс и цены паков.');
  } catch (e) { notice(e.message, true); }
  finally { sending = false; await sync(); }
}

$('general-accounts').addEventListener('change', event => {
  const id = event.target.dataset.select;
  if (!id) return;
  if (event.target.checked) selected.add(id); else selected.delete(id);
  renderSelection();
});
for(const id of ['pp-account','pp-sport'])$(id).addEventListener('change',()=>{ppQuote=null;ppResults=[];$('pp-results').innerHTML='';$('pp-price').textContent='Проверьте цены для выбранного аккаунта и спорта.';renderPlayerPacks();});
async function loadPackPlayers(search){
  if(state.busy||sending)return;sending=true;render();
  try{const params=new URLSearchParams({accountId:$('pp-account').value,sport:$('pp-sport').value,...(search?{query:$('pp-query').value}:{})});ppResults=(await api((search?'players?':'player-pack-players?')+params)).players.filter(p=>p.entityType==='player');
    $('pp-results').innerHTML=ppResults.length?ppResults.map((p,i)=>`<div class="player-result"><span>${esc(p.name)}</span><button data-pp-add="${i}">Добавить</button></div>`).join(''):'<p class="muted">Игроков не найдено.</p>';
  }catch(e){notice(e.message,true);}finally{sending=false;await sync();}
}
$('pp-owned').addEventListener('click',()=>loadPackPlayers(false));$('pp-search').addEventListener('click',()=>loadPackPlayers(true));
$('pp-results').addEventListener('click',e=>{const b=e.target.closest('[data-pp-add]');if(!b||state.busy||sending)return;const p=ppResults[Number(b.dataset.ppAdd)],accountId=$('pp-account').value;if(!p||p.sport!==$('pp-sport').value)return;settingsDraft.playerPacks??=[];if(!settingsDraft.playerPacks.some(v=>v.accountId===accountId&&v.sport===p.sport&&v.id===p.id))settingsDraft.playerPacks.push({accountId,sport:p.sport,id:p.id,name:p.name,count:1});editSettings();});
$('pp-selected').addEventListener('click',e=>{const b=e.target.closest('[data-pp-remove]');if(!b||state.busy)return;settingsDraft.playerPacks.splice(Number(b.dataset.ppRemove),1);editSettings();});
$('pp-selected').addEventListener('input',e=>{if(e.target.dataset.ppCount===undefined||state.busy||sending)return;settingsDraft.playerPacks[Number(e.target.dataset.ppCount)].count=Number(e.target.value);editSettings();});
$('pp-quote').addEventListener('click',async()=>{if(state.busy||sending||settingsDirty)return;sending=true;render();
  try{const accountId=$('pp-account').value,sport=$('pp-sport').value;ppQuote={...await api('player-pack-quote?'+new URLSearchParams({accountId,sport})),accountId,sport};$('pp-price').textContent=`${ppQuote.targets.map(p=>`${p.name}: ${p.count} × ${fmt(p.cost)} Rax`).join('; ')}. Итого: ${fmt(ppQuote.total)} Rax. Все карты сохраняются.${!ppQuote.canAfford?` Недостаточно баланса (${ppQuote.balance===null?'неизвестен':fmt(ppQuote.balance)+' Rax'}). Проверка без покупки доступна.`:''}`;}catch(e){ppQuote=null;notice(e.message,true);}finally{sending=false;await sync();}});
$('pp-open').addEventListener('click',async()=>{if(state.busy||sending||settingsDirty||!ppQuote)return;const q=ppQuote;sending=true;render();
  try{await api('jobs',{type:'player',accountIds:[q.accountId],sport:q.sport,quoteId:q.quoteId,requestId:crypto.randomUUID()});ppQuote=null;wakeBrowser();notice('Запущено открытие Player packs. Все карты будут сохранены.');}catch(e){notice(e.message,true);}finally{sending=false;await sync();}});
$('pp-check').addEventListener('click',async()=>{if(state.busy||sending||settingsDirty||!ppQuote)return;const q=ppQuote;sending=true;render();try{await api('jobs',{type:'player-check',accountIds:[q.accountId],sport:q.sport,quoteId:q.quoteId,requestId:crypto.randomUUID()});wakeBrowser();notice('Проверяем переход к Player packs без активации и покупки.');}catch(e){notice(e.message,true);}finally{sending=false;await sync();}});
async function handleAccountAction(event) {
  const button = event.target.closest('button'); if (!button) return;
  if(button.disabled)return;
  if(button.dataset.accountPlayer){$('pp-account').value=button.dataset.accountPlayer;ppQuote=null;ppResults=[];$('pp-results').innerHTML='<p class="empty-inline">Загрузите owned игроков или найдите игрока по имени.</p>';$('pp-price').textContent='Проверьте цены для выбранного аккаунта и спорта.';renderPlayerPacks();navigate('player');return;}
  if(button.dataset.accountGeneral){selected.clear();selected.add(button.dataset.accountGeneral);renderGeneralAccounts();renderSelection();navigate('general');return;}
  if (button.dataset.refresh) return startJob('refresh', [button.dataset.refresh]);
  if (button.dataset.check) return startJob('check', [button.dataset.check]);
  if (button.dataset.max) return startMaximum([button.dataset.max]);
  if (button.dataset.open) return startJob('open', [button.dataset.account], button.dataset.open);
  if (button.dataset.ack) {
    try { await api('acknowledge', { accountId: button.dataset.ack }); notice('Блокировка повторной покупки снята после вашей проверки.'); await sync(); }
    catch (e) { notice(e.message, true); }
  }
}
$('accounts').addEventListener('click',handleAccountAction);
$('general-accounts').addEventListener('click',handleAccountAction);
$('select-all').addEventListener('change', event => {
  selected.clear(); if (event.target.checked) connectedAccounts().forEach(a => selected.add(a.id)); renderSelection();
});
$('single-sport').addEventListener('change', () => {
  sport = $('single-sport').value;
  $('art-sport').textContent = leagueName(sport); $('pack-art').className = sport === 'ufc' ? 'pack-art ufc' : 'pack-art';
  $('pack-name').textContent = `${leagueName(sport)} General Pack`;
  $('season-label').textContent = sport === 'ufc' ? 'All-time' : 'Текущий сезон Real';
  renderGeneralAccounts();renderSelection();
  document.querySelectorAll('[data-check]').forEach(button=>{const a=state.accounts.find(a=>a.id===button.dataset.check);button.textContent='Проверить';button.title=`Проверить ${sport.toUpperCase()} без покупки`;button.disabled=!a||!canBuy(a,sport,true);});
});

async function startMaximum(ids){
  const accounts=state.accounts.filter(a=>ids.includes(a.id));if(!accounts.length||!accounts.every(canMax))return;
  const s=state.settings;
  if(!confirm(`Открыть максимум General packs?\nАккаунты: ${accounts.map(a=>a.name).join(', ')}\nЛиги: ${s.priority.map(leagueName).join(' → ')}\nВесь доступный баланс, включая новые поступления Rax. Без лимита количества.\nКаждый аккаунт завершается перед следующим. После временных сбоев — обновление и продолжение.\nАвтолистинг: ${s.autoList?`${s.pricingMode}, 24 часа; защищённые карты остаются`:'выключен'}. Карты без подтверждённой сводки могут остаться без листинга.`))return;
  await startJob('max',ids);
}
$('max-all').addEventListener('click',()=>startMaximum(connectedAccounts().map(a=>a.id)));
$('max-selected').addEventListener('click',()=>startMaximum([...selected]));
$('priority-list').addEventListener('change',e=>{const s=e.target.dataset.priority;if(!s)return;settingsDraft.priority=settingsDraft.priority.filter(p=>p!==s);if(e.target.checked)settingsDraft.priority.push(s);editSettings();});
$('priority-list').addEventListener('click',e=>{const b=e.target.closest('[data-move]');if(!b)return;const i=settingsDraft.priority.indexOf(b.dataset.move),j=i+Number(b.dataset.direction);if(j<0||j>=settingsDraft.priority.length)return;[settingsDraft.priority[i],settingsDraft.priority[j]]=[settingsDraft.priority[j],settingsDraft.priority[i]];editSettings();});
for(const id of ['general-resilience','general-no-limit'])$(id).addEventListener('change',()=>{settingsDraft[id==='general-resilience'?'generalResilience':'generalNoLimit']=$(id).checked;editSettings();});
$('auto-list').addEventListener('change',()=>{settingsDraft.autoList=$('auto-list').checked;editSettings();});
$('pricing-mode').addEventListener('change',()=>{settingsDraft.pricingMode=$('pricing-mode').value;editSettings();});
$('max-packs').addEventListener('input',()=>{settingsDraft.maxPacks=Number($('max-packs').value);editSettings();});
$('protected-card-ids').addEventListener('input',()=>{settingsDraft.protectedCardIds=$('protected-card-ids').value.split(/[,;\s]+/).filter(Boolean).map(Number);editSettings();});
$('save-settings').addEventListener('click',async()=>{
  try{await api('settings',settingsDraft);settingsDirty=false;$('settings-status').textContent='Правила сохранены. Применяются к следующим задачам.';await sync();}catch(e){notice(e.message,true);}
});
$('protected-players').addEventListener('click',e=>{const b=e.target.closest('[data-unprotect]');if(!b)return;settingsDraft.protectedPlayers.splice(Number(b.dataset.unprotect),1);editSettings();});
$('protect-owned-ufc').addEventListener('click',async()=>{
  if(state.busy||sending||!state.accounts.length)return;
  sending=true;render();notice('Читаем owned UFC-бойцов со всех аккаунтов. Покупки и листинг не выполняются.');
  try{
    const result=await api('owned-ufc',{});let added=0;
    for(const p of result.players)if(!settingsDraft.protectedPlayers.some(v=>v.id===p.id&&v.sport===p.sport&&v.entityType===p.entityType)){settingsDraft.protectedPlayers.push(p);added++;}
    editSettings();notice(`Добавлено ${added} бойцов. Проверено ${result.checked} из ${result.total} аккаунтов. Нажмите «Сохранить правила».${result.errors.length?' Ошибки: '+result.errors.map(e=>`${e.accountName}: ${e.message}`).join('; '):''}`,result.errors.length>0);
  }catch(e){notice(e.message,true);}finally{sending=false;await sync();}
});
$('search-players').addEventListener('click',async()=>{
  $('search-players').disabled=true;
  try{const params=new URLSearchParams({accountId:$('search-account').value,sport:$('search-sport').value,query:$('player-query').value});searchResults=(await api('players?'+params)).players;
    $('player-results').innerHTML=searchResults.length?searchResults.map((p,i)=>`<div class="player-result"><span>${esc(p.name)}</span><button data-reserve="${i}">Защитить</button></div>`).join(''):'<p class="muted">Ничего не найдено.</p>';
  }catch(e){notice(e.message,true);}finally{$('search-players').disabled=state.busy;}
});
$('player-results').addEventListener('click',e=>{const b=e.target.closest('[data-reserve]');if(!b||state.busy)return;const p=searchResults[Number(b.dataset.reserve)];if(!p)return;if(!settingsDraft.protectedPlayers.some(v=>v.id===p.id&&v.sport===p.sport&&v.entityType===p.entityType))settingsDraft.protectedPlayers.push(p);editSettings();});
$('jobs').addEventListener('click',async e=>{
  const b=e.target.closest('[data-protect-card]');if(!b||state.busy)return;
  const id=Number(b.dataset.protectCard),ids=settingsDraft.protectedCardIds;
  settingsDraft.protectedCardIds=ids.includes(id)?ids.filter(v=>v!==id):[...ids,id];$('protected-card-ids').value=settingsDraft.protectedCardIds.join(', ');editSettings();
  notice('Защита добавлена в правила: нажмите «Сохранить правила». Уже созданные листинги не отменяются.');
});
$('refresh-all').addEventListener('click', () => startJob('refresh', connectedAccounts().map(a => a.id)));
$('open-selected').addEventListener('click', () => startJob('open', state.accounts.filter(a => selected.has(a.id)).map(a => a.id)));
$('cancel-job').addEventListener('click', async () => {
  const job = state.jobs.find(j => ['running','queued'].includes(j.status)); if (!job) return;
  try { await api('cancel', { jobId: job.id }); notice('Очередь остановлена. Активная команда отменена; если покупка уже была отправлена в Real, она будет отмечена как непроверенная.'); await sync(); } catch(e) { notice(e.message,true); }
});
for(const id of ['add-account','empty-add-account'])$(id).addEventListener('click',()=>controlOwned('add-accounts'));
$('finish-accounts').addEventListener('click',()=>controlOwned('finish-accounts'));
async function controlOwned(action,extra={}){
  if(sending)return;sending=true;render();
  try{const result=await api('owned-browser',{action,...extra});if(state.browser){state.browser.owned=result.owned;state.browser.mode='owned';}
    notice(action==='add-accounts'?'Войдите в обычном Chrome с расширением. Не закрывайте окно; дождитесь подтверждённого имени и нажмите «Готово».':action==='finish-accounts'?'Аккаунт добавлен. Real работает в обычном Chrome. Обновите цены перед запуском.':action==='stop'?'Служебный браузер остановлен.':result.owned.extensionRequired?'Один раз установите расширение из папки chrome-extension и обновите Real и локальную вкладку подключения в этом Chrome.':result.owned.loggedIn?'Служебный браузер готов. Можно запускать задачи.':'Окно Real открыто. Завершите вход / ручную проверку сайта.');
  }catch(error){notice(error.message,true);}finally{sending=false;await sync();}
}
$('owned-start').addEventListener('click',()=>controlOwned('visible'));
$('owned-login').addEventListener('click',()=>controlOwned('visible'));
$('owned-stop').addEventListener('click',()=>controlOwned('stop'));
$('recorder-start').addEventListener('click',async()=>{
  if(sending||state.busy||state.recorder?.active)return;
  const name=$('recorder-name').value.trim();if(!name){notice('Введите название сценария.',true);return;}
  sending=true;render();
  try{await api('recorder/start',{name});notice('Запись началась. Перейдите в окно Real и вручную выполните только нужный сценарий.');}
  catch(error){notice(error.message,true);}
  finally{sending=false;await sync();}
});
$('recorder-stop').addEventListener('click',async()=>{
  if(sending||!state.recorder?.active)return;
  sending=true;render();
  try{
    const response=await fetch('/api/recorder/stop',{method:'POST',headers:{'x-local-token':token,'content-type':'application/json'},body:'{}'});
    if(!response.ok)throw new Error((await response.json()).error||'Не удалось завершить запись.');
    const disposition=response.headers.get('content-disposition')||'',match=disposition.match(/filename="([^"]+)"/i);
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=match?.[1]||('real-manager-scenario-'+Date.now()+'.zip');link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    notice('Сценарий записан и сохранён в ZIP. Перед отправкой можно открыть scenario.json и проверить содержимое.');
  }catch(error){notice(error.message,true);}
  finally{sending=false;await sync();}
});
$('diagnostic-export').addEventListener('click',async()=>{
  if(sending)return;sending=true;render();
  try{const response=await fetch('/api/owned-diagnostics',{method:'POST',headers:{'x-local-token':token,'content-type':'application/json'},body:'{}'});
    if(!response.ok)throw new Error((await response.json()).error||'Не удалось собрать диагностику.');
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='real-manager-diagnostic-'+Date.now()+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    notice('Диагностика сохранена локально. Проверьте файл перед передачей; автоматической отправки нет.');
  }catch(error){notice(error.message,true);}finally{sending=false;await sync();}
});
$('connect-browser').addEventListener('click',()=>{
  notice('Подключаем Helium и проверяем вкладку Real…');
  window.postMessage({source:'real-manager-panel',type:'CONNECT',token},location.origin);
  clearTimeout(connectTimer);
  connectTimer=setTimeout(()=>notice('Не получили ответ расширения. Проверьте его в chrome://extensions, обновите панель в Helium и повторите подключение.',true),45000);
});
$('stop-server').addEventListener('click', async () => {
  if(state.busy&&!confirm('Остановить приложение и отменить очередь? Активная команда будет прервана локально; уже отправленная покупка может завершиться в Real.'))return;
  try { await api('shutdown', {}); stopped = true; clearTimeout(timer); document.querySelectorAll('button').forEach(b => b.disabled = true); notice('Приложение завершает текущий запрос и останавливается. Для запуска откройте .cmd.'); }
  catch(e) { notice(e.message,true); }
});
sync();
