(() => {
  const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';
  const text=e=>(e?.innerText||e?.textContent||'').trim();
  const clean=value=>String(value).replace(/\s+/g,' ').trim();
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const all=(selector,scope=document)=>[...scope.querySelectorAll(selector)].filter(visible);
  function exact(label,scope=document){
    const matches=all('div,span,button,a',scope).filter(e=>clean(text(e))===clean(label));
    return matches.filter(e=>!matches.some(child=>child!==e&&e.contains(child)));
  }
  async function wait(check,message,timeout=20000){
    const end=Date.now()+timeout;
    while(Date.now()<end){if(/extra verification is required|please turn off any adblock or script blockers/i.test(document.body.innerText||''))throw Object.assign(new Error('Real требует дополнительную ручную проверку. Завершите её в окне Real; очередь остановлена.'),{requiresAttention:true});const result=await check();if(result)return result;await pause(400);}
    const error=new Error(message);error.recoverable=true;throw error;
  }
  let lastAction=null;
  function click(e,label){
    label=label||clean(text(e)).slice(0,80)||'элемент интерфейса';
    lastAction={label,tag:e?.tagName||null,text:clean(text(e)).slice(0,120),disabled:Boolean(e?.closest('[aria-disabled="true"],:disabled'))};
    if(humanInterrupted)throw new Error('Вы взаимодействовали с вкладкой Real во время задачи. Действие остановлено.');
    if(!visible(e))throw new Error('Не удалось нажать «'+label+'»: элемент не отображается.');
    if(lastAction.disabled)throw new Error('Не удалось нажать «'+label+'»: Real пометил элемент как недоступный.');
    e.scrollIntoView({block:'nearest',inline:'nearest'});
    const target=typeof e.click==='function'?e:e.parentElement;
    if(typeof target?.click!=='function')throw new Error('Не найден обычный элемент для нажатия.');target.click();
  }
  function sidebar(){
    const records=all('svg').map(element=>{const r=element.getBoundingClientRect();return {element,x:r.x,y:r.y,w:r.width,h:r.height};});
    const column=RealManagerNavigation.column(records),icons=column.map(r=>r.element),settings=icons.at(-2),menu=icons.at(-1);
    let root=icons[0].parentElement;
    while(root&&root!==document.body&&!(root.contains(menu)&&root.getBoundingClientRect().width>=40&&root.getBoundingClientRect().width<=110))root=root.parentElement;
    if(!root||root===document.body)throw new Error('Не удалось определить контейнер навигации Real. Покупка не отправлена.');
    const settingsRect=settings.getBoundingClientRect(),profileY=settingsRect.y+settingsRect.height/2-56;
    const profiles=[...root.children].filter(e=>{const r=e.getBoundingClientRect();return visible(e)&&Math.abs(r.y+r.height/2-profileY)<8;});
    if(profiles.length!==1)throw new Error('Не удалось определить кнопку профиля Real. Покупка не отправлена.');
    const profile=profiles[0],avatar=all('img',profile)[0]||null;
    return {root,profile,avatar,icons,after:[settings,menu]};
  }
  let identity=null,identityAttempted=null,humanInterrupted=false;
  function avatarId(nav){return nav.avatar?.src.match(/\/([^/]+)_[^/]+\.(?:webp|png|jpg)(?:\?|$)/)?.[1]||null;}
  function profileMark(nav){return `${nav.avatar?.src||''}|${clean(text(nav.profile))}`;}
  function logoutName(){
    const labels=exact('Log out');if(labels.length!==1)return null;
    for(let e=labels[0].parentElement;e&&e!==document.body;e=e.parentElement){const name=RealManagerNavigation.logoutName(text(e));if(name)return name;}
    return null;
  }
  async function settings(){
    if(logoutName())return;
    click(sidebar().after[0],'Settings');
    await wait(()=>logoutName(),'Не удалось прочитать аккаунт в Settings Real. Покупка не отправлена.');
  }
  async function accountId(command){
    if(humanInterrupted)return null;
    const nav=sidebar();
    // Avatar URLs are presentation data and can be stale or unrelated to the
    // currently authenticated account. Only reuse an identity that this exact
    // command already confirmed from Settings / Log out.
    if(identity?.commandId===command.id)return identity.mark===profileMark(nav)?identity.id:null;
    if(identityAttempted===command.id)return null;
    identityAttempted=command.id;
    await settings();
    const name=logoutName();
    if(name!==command.accountName)return null;
    identity={commandId:command.id,id:command.accountId,name,mark:profileMark(sidebar())};
    return identity.id;
  }
  async function switchAccount(command){
    identity=null;identityAttempted=null;
    await settings();
    click(await wait(()=>exact('Switch account')[0],'В Real нет «Switch account». Добавьте аккаунты вручную.'));
    const name=await wait(()=>{const matches=[...exact(command.accountName),...exact('@'+command.accountName)];return matches.length===1?matches[0]:null;},'Аккаунт '+command.accountName+' не найден в переключателе Real.');
    click(name);
    await pause(700);
    await settings();
    await wait(()=>logoutName()===command.accountName,'Real не подтвердил выбранный аккаунт.',30000);
    identity={commandId:command.id,id:command.accountId,name:command.accountName,mark:profileMark(sidebar())};
  }
  let panel,packImage,count,summaryPanel,openContext;
  function imageMatches(e,source){try{return new URL(e.src).pathname.endsWith('/'+source.replace(/^\//,''));}catch{return false;}}
  function cardsPane(){
    const nav=sidebar(),right=nav.root.getBoundingClientRect().x+nav.root.getBoundingClientRect().width;
    const headers=exact('Cards').filter(e=>{const r=e.getBoundingClientRect();return r.x>=right&&r.x<right+160&&r.y<100;});
    if(headers.length!==1)return null;
    for(let e=headers[0].parentElement;e&&e!==document.body;e=e.parentElement){
      const r=e.getBoundingClientRect();
      // The Cards pane must be separate from the persistent feed to its right.
      if(r.x<right-4||r.width>1000)return null;
      if(r.width>=200&&r.height>=250)return e;
    }
    return null;
  }
  async function preparePack(command){
    panel=null;packImage=null;count=null;
    const leagueLabel=command.leagueLabel||command.sport.toUpperCase();
    if(!cardsPane())click(sidebar().icons[2],'Cards в боковой навигации');
    const shop=await wait(()=>cardsPane(),'Не удалось определить отдельный раздел Cards. Покупка не отправлена.');
    const targetImage=()=>all('img',shop).find(e=>imageMatches(e,command.packImage)&&e.getBoundingClientRect().width>=90);
    // A feed league is present even while Cards is still loading. Never use it as shop readiness.
    await wait(()=>targetImage()||exact(leagueLabel,shop).length,'Раздел Cards не загрузил пак или выбор лиги '+leagueLabel+'. Покупка не отправлена.',30000);
    if(!targetImage()){
      const league=exact(leagueLabel,shop);
      if(league.length!==1)throw new Error('Выбор лиги '+command.sport.toUpperCase()+' в Cards неоднозначен. Покупка не отправлена.');
      if(!league[0].closest('[aria-disabled="true"],:disabled'))click(league[0],leagueLabel+' в разделе Cards');
    }
    if(command.kind==='player'){
      if(!Number.isSafeInteger(command.playerId)||!command.playerName)throw new Error('Не указан игрок Player Pack.');
      const players=await wait(()=>exact('Players',shop).length===1?exact('Players',shop)[0]:null,'В Cards нет вкладки Players. Player Pack не куплен.');
      if(!players.closest('[aria-disabled="true"],:disabled'))click(players,'Players');
      // Owned passes are shown in a separate collection pane, not the left Cards navigation.
      const player=await wait(()=>{
        const targets=exact(command.playerName).map(label=>{
          for(let e=label;e&&e!==document.body;e=e.parentElement){
            if(e.matches('[role="button"],button,[tabindex="0"]')&&text(e).includes(command.accountName)&&/#[\d,]+/.test(text(e))&&text(e).includes('Player'))return e;
          }return null;
        }).filter(Boolean);
        return targets.length===1?targets[0]:null;
      },'Игрок '+command.playerName+' не найден среди видимых owned этого аккаунта. Player Pack не куплен.');
      click(player,command.playerName+' owned card');
    }
    const findImage=command.kind==='player'?()=>{
      const headers=exact(`${command.playerName} ${command.season}`);if(headers.length!==1)return [];
      for(let menu=headers[0].parentElement;menu&&menu!==document.body;menu=menu.parentElement){
        if(exact('Manage card',menu).length===1&&exact('Earnings',menu).length===1)return all('img',menu).filter(e=>imageMatches(e,command.packImage)&&e.getBoundingClientRect().width>=35);
      }return [];
    }:()=>targetImage()?[targetImage()]:[];
    const img=await wait(()=>{const found=findImage();return found.length===1?found[0]:null;},'Не найден однозначный пак выбранного типа и лиги.');
    // A limited pack can be disabled directly in the shop, without opening a
    // purchase drawer. Confirm the server's message beside this exact pack.
    if(command.inspectUnavailable&&command.unavailableMessage){
      for(let e=img.parentElement;e&&e!==shop&&e!==document.body;e=e.parentElement){
        const packs=all('img',e).filter(i=>/\/assets\/packs\//.test(i.src));
        if(packs.length!==1)break;
        if(exact(command.unavailableMessage,e).length)return {unavailable:true,message:command.unavailableMessage,sport:command.sport};
      }
    }
    click(img,command.sport.toUpperCase()+' '+(command.kind==='player'?'Player Pack':'General Pack'));
    const activate=await wait(()=>{
      if(command.inspectUnavailable&&command.unavailableMessage){
        const message=exact(command.unavailableMessage)[0];
        for(let e=message?.parentElement;e&&e!==document.body;e=e.parentElement){
          if(text(e).includes(command.description)&&all('img',e).some(i=>imageMatches(i,command.packImage))){panel=e;return {unavailable:true};}
        }
      }
      return exact(command.activateLabel)[0];
    },'Экран General Pack не загрузился.');
    if(activate.unavailable)return {unavailable:true,message:command.unavailableMessage,sport:command.sport};
    for(let e=activate.parentElement;e&&e!==document.body;e=e.parentElement){
      if(text(e).includes(command.description)&&all('img',e).some(i=>imageMatches(i,command.packImage))&&exact('Cancel',e).length){panel=e;break;}
    }
    if(!panel)throw new Error('Не удалось проверить окно покупки General Pack.');
    const prices=all('div,span',panel).filter(e=>{const t=clean(text(e)),size=parseFloat(getComputedStyle(e).fontSize);return size>=36&&size<=48&&/^(?:Free|[\d,\s]+)$/.test(t)&&!all('div,span',e).some(c=>clean(text(c))===t);}).map(e=>clean(text(e))==='Free'?0:Number(clean(text(e)).replace(/[,\s]/g,'')));
    if(prices.length!==1)throw new Error('Цена в окне Real не распознана. Покупка остановлена.');
    // Player identity was checked on the owned pass and its menu; the purchase dialog uses an abbreviated description.
    return {sport:command.sport,kind:command.kind||'general',cost:prices[0],...(command.kind==='player'?{playerId:command.playerId}:{})};
  }
  async function activate(command){
    const button=exact(command.activateLabel,panel);if(button.length!==1)throw new Error('Кнопка активации неоднозначна.');click(button[0]);
    await wait(()=>text(panel).includes(command.openLabel),'Real не активировал пак; покупка не отправлена.');
    packImage=all('img',panel).find(e=>imageMatches(e,command.packImage)&&e.getBoundingClientRect().width>=90);
    if(!packImage)throw new Error('Не найдено изображение активированного пака.');
  }
  async function finishCheck(command){
    const cancel=exact('Cancel',panel);
    if(cancel.length!==1||!exact(command.activateLabel,panel).length)throw new Error('Не удалось закрыть проверенное окно пака. Закройте его вручную. Покупка не отправлена.');
    click(cancel[0]);
    await wait(()=>!visible(panel)||!exact(command.activateLabel,panel).length,'Окно пака не закрылось. Покупка не отправлена.',6000);
  }
  async function authorize(command){
    const result=await chrome.runtime.sendMessage({type:'AUTHORIZE_PURCHASE',commandId:command.id});
    if(!result?.ok)throw Object.assign(new Error(result?.error||'Локальное приложение не подтвердило операцию.'),{requiresAttention:Boolean(result?.requiresAttention)});
  }
  async function purchaseOnce(command){
    if(Date.now()>=command.expiresAt||await accountId(command)!==command.accountId||!text(panel).includes(command.openLabel))throw new Error('Состояние Real изменилось. Проверьте результат вручную.');
    click(packImage);
  }
  async function revealSummary(command){
    // Never automatically accept mint warnings, security checks or confirmation dialogs.
    count=await wait(()=>{const m=document.body.innerText.match(/Card\s+\d+\s+of\s+(\d+)/i);return m?Number(m[1]):null;},'Нет подтверждения открытия. Проверьте вкладку Real и результат перед повторением.',45000);
    for(let i=0;i<3&&!exact('Pack summary').length;i++){
      const button=exact('Jump ahead')[0]||exact('Go to summary')[0]||exact('Summary')[0];
      if(!button)throw new Error('Не найден переход к сводке пака.');click(button);await pause(1200);
    }
    const heading=await wait(()=>exact('Pack summary')[0],'Нет сводки пака. Проверьте Real перед повторением.');
    let summary=heading.parentElement;
    while(summary.parentElement&&!exact('Done',summary).length&&summary!==document.body)summary=summary.parentElement;
    if(summary===document.body)throw new Error('Не удалось отделить сводку пака от страницы.');
    summaryPanel=summary;
    const summaryText=text(summary).slice(0,12000),done=exact('Done',summary);
    if(command.keepSummary)openContext={commandId:command.id,accountId:command.accountId,mark:profileMark(sidebar())};
    else if(done.length===1)click(done[0]);
    return {cardCount:count,summaryText};
  }
  function assertListContext(command){
    if(humanInterrupted||!openContext||openContext.commandId!==command.parentCommandId||openContext.accountId!==command.accountId||openContext.mark!==profileMark(sidebar())||!visible(summaryPanel)||Date.now()>=command.expiresAt)throw new Error('Сводка пака / аккаунт изменились. Quick list остановлен.');
  }
  const listingUi=RealManagerPackListing.create({all,exact,text,clean,visible,click,wait,getSummary:()=>summaryPanel,assertContext:assertListContext,authorize:async command=>{
    const result=await chrome.runtime.sendMessage({type:'AUTHORIZE_LISTING',commandId:command.id});if(!result?.ok)throw Object.assign(new Error(result?.error||'Панель не подтвердила листинг.'),{requiresAttention:Boolean(result?.requiresAttention)});assertListContext(command);
  }});
  function homePane(){
    const nav=sidebar(),right=nav.root.getBoundingClientRect().x+nav.root.getBoundingClientRect().width;
    const headers=exact('Home').filter(e=>{const r=e.getBoundingClientRect();return r.x>=right&&r.x<right+180&&r.y<110;});
    if(headers.length!==1)return null;
    for(let e=headers[0].parentElement;e&&e!==document.body;e=e.parentElement){
      const r=e.getBoundingClientRect();
      if(r.x<right-4||r.width>1000)return null;
      if(r.width>=240&&r.height>=300)return e;
    }
    return null;
  }
  function todayRows(accountName,scope=document){
    const pattern=/^(GENERAL|COMMON|UNCOMMON|RARE|EPIC|LEGENDARY)\s+(?:Player|Fighter|Team)\s+\S+\s+.+\s+#\d+\b/i;
    const matches=all('div,[role="button"],button',scope).filter(e=>{
      const value=clean(text(e));
      return pattern.test(value)&&value.includes(' '+accountName+' ')&&/#\d+\b/.test(value);
    });
    return matches.filter(e=>!matches.some(child=>child!==e&&e.contains(child)));
  }
  function parseTodayRow(element,accountName,sport){
    const value=clean(text(element)),mint=Number(value.match(/#(\d+)\b/)?.[1]);
    const head=value.match(/^(GENERAL|COMMON|UNCOMMON|RARE|EPIC|LEGENDARY)\s+(?:Player|Fighter|Team)\s+(\S+)\s+(.+)$/i);
    if(!head||!Number.isSafeInteger(mint))return null;
    const marker=' '+accountName+' ',at=head[3].indexOf(marker);if(at<1)return null;
    const before=head[3].slice(0,at).trim(),parts=before.split(/\s+/),position=parts.pop()||'',name=parts.join(' ').trim();
    if(!name)return null;
    return {sport,name,position,mint,rarity:head[1].toUpperCase(),text:value};
  }
  async function ensureBoostAccount(command){
    const current=await accountId(command);
    if(current!==command.accountId)await switchAccount(command);
    if(await accountId(command)!==command.accountId)throw Object.assign(new Error('Real не подтвердил аккаунт для бустеров.'),{requiresAttention:true});
  }
  async function openHomeSport(command){
    await ensureBoostAccount(command);
    if(!homePane())click(sidebar().icons[1],'Home в боковой навигации');
    const home=await wait(()=>homePane(),'Не удалось открыть Home Real.',30000);
    const leagueLabel=command.leagueLabel||command.sport.toUpperCase();
    const labels=exact(leagueLabel,home);
    if(labels.length!==1)throw Object.assign(new Error('Не найден раздел '+leagueLabel+' на Home.'),{recoverable:true});
    if(!labels[0].closest('[aria-disabled="true"],:disabled'))click(labels[0],leagueLabel+' на Home');
    await wait(()=>exact("Today's players",home).length||clean(text(home)).includes("Today's players"),'Real не загрузил Today\'s players для '+leagueLabel+'.',30000);
    return home;
  }
  async function expandedTodayRows(command){
    const home=await openHomeSport(command);
    let rows=todayRows(command.accountName,home);
    const headers=exact("Today's players",home);
    if(headers.length===1){
      let section=headers[0].parentElement;
      while(section&&section!==home&&section!==document.body){
        const views=exact('View more',section);
        if(views.length===1&&todayRows(command.accountName,section).length){click(views[0],"Today's players · View more");await pause(700);break;}
        section=section.parentElement;
      }
    }
    const expanded=await wait(()=>{
      const found=todayRows(command.accountName);
      return found.length>rows.length||exact('Plays today').length?found:null;
    },'Не удалось открыть полный список Today\'s players.',8000).catch(()=>todayRows(command.accountName,home));
    rows=expanded?.length?expanded:rows;
    return rows;
  }
  async function scanBoostPlayers(command){
    const rows=await expandedTodayRows(command),seen=new Set(),players=[];
    for(const row of rows){
      const parsed=parseTodayRow(row,command.accountName,command.sport);
      if(!parsed)continue;const key=parsed.name.toLocaleLowerCase()+'#'+parsed.mint;
      if(seen.has(key))continue;seen.add(key);players.push(parsed);
      if(players.length>=200)break;
    }
    return players;
  }
  function boosterPanel(command){
    const candidates=all('div,[role="dialog"]').filter(e=>{
      const value=clean(text(e));return value.includes('Press booster to apply.')&&value.includes(command.playerName)&&(!command.mint||value.includes('#'+command.mint));
    });
    return candidates.sort((a,b)=>clean(text(a)).length-clean(text(b)).length)[0]||null;
  }
  function boosterOptions(scope){
    const pattern=/^\d+x\s+.+\s+x\d+$/i;
    const matches=all('div,button,[role="button"]',scope).filter(e=>pattern.test(clean(text(e))));
    return matches.filter(e=>!matches.some(child=>child!==e&&e.contains(child)));
  }
  function boosterScore(value,priority){
    const normalized=' '+String(value).toUpperCase().replace(/[^A-Z0-9]+/g,' ')+' ';let score=0;
    (priority||[]).forEach((stat,index)=>{if(normalized.includes(' '+String(stat).toUpperCase()+' '))score=Math.max(score,1000-index*25);});
    const qty=Number(String(value).match(/\bx(\d+)\s*$/i)?.[1]||0);return score+Math.min(qty,20);
  }
  async function applyBoost(command){
    const rows=await expandedTodayRows(command);
    const matching=rows.filter(row=>{const parsed=parseTodayRow(row,command.accountName,command.sport);return parsed&&parsed.name===command.playerName&&(!command.mint||parsed.mint===command.mint);});
    if(matching.length!==1)throw new Error(matching.length?'Карточка игрока в Today\'s players неоднозначна.':'Игрок больше не находится в Today\'s players.');
    click(matching[0],command.playerName+' #'+command.mint);
    let boostPanel=await wait(()=>boosterPanel(command),'Не удалось открыть бустеры '+command.playerName+'.',20000);
    const labels={3:'Rare',4:'Epic',5:'Legendary'},fallback=Array.isArray(command.rarityFallback)?command.rarityFallback:[5,4,3];
    let selected=null,rarity=null;
    for(const level of fallback){
      const tab=exact(labels[level],boostPanel);
      if(tab.length!==1)continue;
      click(tab[0],labels[level]+' boosters');await pause(550);
      boostPanel=boosterPanel(command)||boostPanel;
      const options=boosterOptions(boostPanel).map(element=>({element,text:clean(text(element))})).filter(o=>Number(o.text.match(/\bx(\d+)\s*$/i)?.[1]||0)>0);
      if(!options.length)continue;
      options.sort((a,b)=>boosterScore(b.text,command.statPriority)-boosterScore(a.text,command.statPriority));
      selected=options[0];rarity=level;break;
    }
    if(!selected)return {ok:true,snapshot:{applied:false,skipped:true,reason:'Нет доступных бустеров выбранной редкости или ниже.',accountId:command.accountId,sport:command.sport,playerName:command.playerName,mint:command.mint}};
    const auth=await chrome.runtime.sendMessage({type:'AUTHORIZE_BOOSTER',commandId:command.id});
    if(!auth?.ok)throw Object.assign(new Error(auth?.error||'Панель не подтвердила применение бустера.'),{requiresAttention:Boolean(auth?.requiresAttention)});
    if(Date.now()>=command.expiresAt||await accountId(command)!==command.accountId)throw new Error('Аккаунт изменился перед применением бустера.');
    click(selected.element,selected.text.slice(0,80));
    try{await wait(()=>/Booster card applied/i.test(document.body.innerText||''),'Real не подтвердил применение бустера.',12000);}
    catch(error){error.uncertain=true;throw error;}
    return {ok:true,snapshot:{applied:true,accountId:command.accountId,sport:command.sport,playerName:command.playerName,mint:command.mint,rarity,rarityLabel:labels[rarity],boosterText:selected.text}};
  }

  function snapshot(){
    const body=document.body.innerText;
    let id=null,navPresent=false;try{sidebar();navPresent=true;id=identity?.id||null;}catch{}
    const controls=[...document.querySelectorAll('button,a,input,[role="button"],img,svg')].filter(visible).map(e=>{
      const r=e.getBoundingClientRect();
      return {tag:e.tagName,text:text(e).slice(0,150),title:e.getAttribute('title'),aria:e.getAttribute('aria-label'),src:e.getAttribute('src'),class:e.getAttribute('class'),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};
    });
    let shop=null;try{shop=cardsPane();}catch{}
    const shopLabels=shop?all('div,span,button,a',shop).filter(e=>!all('div,span,button,a',e).length).map(e=>({text:clean(text(e)).slice(0,160),disabled:Boolean(e.closest('[aria-disabled="true"],:disabled'))})).filter(e=>e.text).slice(0,100):[];
    const headings=exact('Pack summary'),packDetails=[];
    if(headings.length===1){let root=headings[0].parentElement;while(root.parentElement&&root!==document.body&&!exact('Done',root).length&&!all('[role="button"]',root).some(e=>/^Quick list \(/.test(clean(text(e)))))root=root.parentElement;
      if(root!==document.body){
        for(const marker of all('div,span',root).filter(e=>/^#\d+$/.test(clean(text(e)))&&!all('div,span',e).length)){
          const ancestors=[];for(let e=marker,i=0;e&&e!==root&&i++<12;e=e.parentElement){const r=e.getBoundingClientRect(),s=getComputedStyle(e);ancestors.push({tag:e.tagName,role:e.getAttribute('role'),text:clean(text(e)).slice(0,650),w:r.width,h:r.height,opacity:s.opacity,position:s.position,html:e.outerHTML?.slice(0,5000)});}packDetails.push({mint:clean(text(marker)),ancestors});
        }
      }
    }
    const packImages=all('img').filter(e=>/\/assets\/packs\//.test(e.src)).map(e=>{const r=e.getBoundingClientRect();return {src:e.src,w:r.width,h:r.height,context:text(e.parentElement?.parentElement).slice(0,1500)};}).slice(0,30);
    return {version:'0.4.5',url:location.href,loggedIn:navPresent&&!body.includes('The web app is available to Real Pro members.'),identityVerified:Boolean(id),accountId:id,accountName:identity?.name||null,lastAction,cardsPanePresent:Boolean(shop),shopText:shop?text(shop).slice(0,10000):null,shopLabels,text:body.slice(0,20000),packDetails,packImages,quickListOptions:listingUi.inspectOptions(),controls:controls.slice(0,150)};
  }
  let scenarioRecorder=null;
  function recorderElement(element){
    if(!element||typeof element.closest!=='function')return null;
    const target=element.closest('button,a,[role="button"],input,select,textarea,label,[tabindex]')||element;
    const rect=target.getBoundingClientRect(),ancestors=[];
    for(let node=target,depth=0;node&&node!==document.body&&depth++<6;node=node.parentElement){
      ancestors.push({
        tag:node.tagName,role:node.getAttribute('role'),aria:node.getAttribute('aria-label'),
        title:node.getAttribute('title'),text:clean(text(node)).slice(0,700),
        className:typeof node.className==='string'?node.className.slice(0,300):null,
      });
    }
    let href=null;
    if(target.tagName==='A'&&target.href){try{const u=new URL(target.href);href=u.origin===location.origin?u.pathname:u.origin+u.pathname;}catch{}}
    return {
      tag:target.tagName,role:target.getAttribute('role'),aria:target.getAttribute('aria-label'),
      title:target.getAttribute('title'),text:clean(text(target)).slice(0,500),href,
      rect:{x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)},
      disabled:Boolean(target.closest('[aria-disabled="true"],:disabled')),ancestors,
    };
  }
  function recorderView(){
    const body=clean(document.body?.innerText||'');
    const dialogs=all('[role="dialog"]').map(e=>clean(text(e)).slice(0,5000)).filter(Boolean).slice(0,5);
    const headings=all('h1,h2,h3').map(e=>clean(text(e)).slice(0,300)).filter(Boolean).slice(0,40);
    const controls=all('button,a,[role="button"],select,input').map(e=>({
      tag:e.tagName,role:e.getAttribute('role'),aria:e.getAttribute('aria-label'),title:e.getAttribute('title'),
      text:clean(text(e)).slice(0,300),disabled:Boolean(e.closest('[aria-disabled="true"],:disabled')),
    })).slice(0,160);
    return {at:new Date().toISOString(),url:location.origin+location.pathname,bodyText:body.slice(0,12000),dialogs,headings,controls};
  }
  function recordManualEvent(type,event){
    const recorder=scenarioRecorder;if(!recorder||!event.isTrusted)return;
    const item={index:recorder.events.length+1,type,at:new Date().toISOString(),target:recorderElement(event.target),before:recorderView()};
    recorder.events.push(item);if(recorder.events.length>300)recorder.events.shift();
    setTimeout(()=>{item.after=recorderView();},600);
    setTimeout(()=>{item.settled=recorderView();},1800);
  }

  let active=false;
  for(const eventName of ['pointerdown','keydown'])document.addEventListener(eventName,event=>{if(event.isTrusted){identity=null;identityAttempted=null;openContext=null;if(active)humanInterrupted=true;}},true);
  document.addEventListener('click',event=>recordManualEvent('click',event),true);
  document.addEventListener('change',event=>recordManualEvent('change',event),true);
  const results=new Map();
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id)return;
    if(message.type==='READY'){let ready=false;try{sidebar();ready=document.readyState!=='loading';}catch{}const body=document.body.innerText||'';const requiresAttention=/extra verification is required|please turn off any adblock or script blockers/i.test(body)||!ready&&/sign in|log in|the web app is available to real pro members|verify you are human|checking your browser/i.test(body);respond({version:'0.4.5',ready,active,requiresAttention});return;}
    if(message.type==='SNAPSHOT'){respond(snapshot());return;}
    if(message.type!=='EXECUTE')return;
    if(results.has(message.command.id)){respond(results.get(message.command.id));return;}
    if(active){respond({ok:false,uncertain:message.command.action==='open',message:'Вкладка уже выполняет действие.'});return;}
    active=true;
    humanInterrupted=false;identity=null;identityAttempted=null;lastAction=null;
    (async()=>{
      if(message.command.action==='snapshot')return {ok:true,snapshot:snapshot()};
      if(message.command.action==='record-start'){
        if(scenarioRecorder)throw new Error('Запись сценария уже идёт.');
        scenarioRecorder={name:String(message.command.name||'Scenario').slice(0,80),startedAt:new Date().toISOString(),initial:recorderView(),events:[]};
        return {ok:true,snapshot:{recording:true,name:scenarioRecorder.name,startedAt:scenarioRecorder.startedAt}};
      }
      if(message.command.action==='record-stop'){
        if(!scenarioRecorder)throw new Error('Запись сценария не запущена.');
        const finished={...scenarioRecorder,finishedAt:new Date().toISOString(),final:recorderView()};
        scenarioRecorder=null;
        return {ok:true,snapshot:{recording:false,scenario:finished}};
      }
      if(['prepare-account','verify-account'].includes(message.command.action)){
        const c=message.command,before=await accountId(c),switched=before!==c.accountId;
        if(switched&&c.action==='prepare-account')await switchAccount(c);
        if(await accountId(c)!==c.accountId)throw new Error('Real не подтвердил аккаунт после обновления.');
        return {ok:true,snapshot:{prepared:true,switched,accountId:c.accountId}};
      }
      if(message.command.action==='boost-scan'){
        const c=message.command,players=await scanBoostPlayers(c);
        return {ok:true,snapshot:{accountId:c.accountId,sport:c.sport,players}};
      }
      if(message.command.action==='boost')return applyBoost(message.command);
      if(message.command.action==='availability'){
        const c=message.command;if(await accountId(c)!==c.accountId)throw new Error('Лимит проверяется не на выбранном аккаунте.');
        const result=await preparePack({...c,inspectUnavailable:true});
        if(!result.unavailable)await finishCheck(c);
        return {ok:true,snapshot:{unavailable:result.unavailable===true,accountId:c.accountId,sport:c.sport,message:result.message||null}};
      }
      if(message.command.action==='check')return RealManagerWorkflow.check(message.command,{accountId,switchAccount,preparePack,finishCheck,interrupted:()=>humanInterrupted});
      if(message.command.action==='list')return RealManagerWorkflow.list(message.command,listingUi);
      if(message.command.action!=='open')return {ok:false,message:'Неизвестное действие.'};
      return RealManagerWorkflow.open(message.command,{accountId,switchAccount,preparePack,activate,authorize,purchaseOnce,revealSummary,interrupted:()=>humanInterrupted});
    })().then(result=>{results.set(message.command.id,result);if(results.size>100)results.delete(results.keys().next().value);respond(result);},e=>respond({ok:false,uncertain:Boolean(e.uncertain||message.command.action==='open'),recoverable:Boolean(e.recoverable),requiresAttention:Boolean(e.requiresAttention),message:e.message})).finally(()=>active=false);
    return true;
  });
})();
