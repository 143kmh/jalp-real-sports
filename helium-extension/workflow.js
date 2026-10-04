// Mutations are performed only through the ordinary Real interface.
globalThis.RealManagerWorkflow = {
  async list(command,ui){
    let started=false;
    try{
      const plan=command.plan;
      if(!command.parentCommandId||!command.accountId||Date.now()>=command.expiresAt||!plan||!['default','min','max'].includes(plan.mode)||plan.durationHours!==24||!Array.isArray(plan.selectedIds)||new Set(plan.selectedIds).size!==plan.selectedIds.length)throw new Error('Неверные параметры Quick list.');
      if(!await ui.listContext(command))throw new Error('Сводка принадлежит другому открытию / аккаунту.');
      if(!plan.selectedIds.length){await ui.finishSummary(command);return {ok:true,listedCardIds:[],mode:plan.mode,durationHours:24};}
      const selection=await ui.prepareQuickList(command);
      if(selection.mode!==plan.mode||selection.durationHours!==24||selection.selectedIds.length!==plan.selectedIds.length||new Set(selection.selectedIds).size!==plan.selectedIds.length||selection.selectedIds.some(id=>!plan.selectedIds.includes(id)))throw new Error('Выбранные карты или правила не совпали.');
      if(Date.now()>=command.expiresAt||!await ui.listContext(command))throw new Error('Quick list устарел или аккаунт изменился.');
      await ui.authorizeListing(command);
      started=true;
      const result=await ui.submitQuickList(command);
      if(!Array.isArray(result?.listedCardIds)||result.listedCardIds.length!==plan.selectedIds.length||new Set(result.listedCardIds).size!==plan.selectedIds.length||result.listedCardIds.some(id=>!plan.selectedIds.includes(id)))throw new Error('Real не подтвердил все выбранные карты.');
      await ui.finishSummary(command);
      return {ok:true,listedCardIds:result.listedCardIds,mode:plan.mode,durationHours:24};
    }catch(error){return {ok:false,uncertain:started,requiresAttention:Boolean(error.requiresAttention),message:error.message||'Quick list остановлен. Проверьте Real.'};}
  },
  async check(command,ui){
    try{
      if(!['nfl','ufc','soccer','nba','wnba','nhl','mlb','ncaaf','ncaam','golf'].includes(command.sport)||!command.accountId||!Number.isFinite(command.cost)||command.cost<0||Date.now()>=command.expiresAt)throw new Error('Неверные параметры или проверка устарела.');
      if(await ui.accountId(command)!==command.accountId)await ui.switchAccount(command);
      if(await ui.accountId(command)!==command.accountId)throw new Error('Не подтверждён нужный аккаунт.');
      const info=await ui.preparePack(command);
      const kind=command.kind||'general';
      if(!['general','player'].includes(kind)||info.sport!==command.sport||info.kind!==kind||info.cost!==command.cost||kind==='player'&&info.playerId!==command.playerId)throw new Error('Цена, игрок, тип или лига в Real не совпадают с выбранными.');
      if(await ui.accountId(command)!==command.accountId)throw new Error('Аккаунт изменился.');
      await ui.finishCheck?.(command);
      return {ok:true,snapshot:{accountId:command.accountId,accountName:command.accountName,sport:info.sport,cost:info.cost,checked:true,...(kind==='player'?{playerId:info.playerId}:{})}};
    }catch(error){return {ok:false,uncertain:false,requiresAttention:Boolean(error.requiresAttention||ui.interrupted?.()),recoverable:error.recoverable===true&&!ui.interrupted?.(),message:error.message||'Проверка интерфейса остановлена.'};}
  },
  async open(command, ui) {
    let started = false;
    let activationReached = false;
    const fail = message => { throw new Error(message); };
    try {
      if (!['nfl','ufc','soccer','nba','wnba','nhl','mlb','ncaaf','ncaam','golf'].includes(command.sport) || !command.accountId || !Number.isFinite(command.cost) || command.cost < 0) fail('Неверные параметры открытия.');
      if (!(Date.now() < command.expiresAt)) fail('Команда устарела; покупка не отправлена.');
      if (await ui.accountId(command) !== command.accountId) await ui.switchAccount(command);
      if (await ui.accountId(command) !== command.accountId) fail('Не удалось подтвердить нужный аккаунт в Helium. Покупка остановлена.');
      const info = await ui.preparePack(command);
      const kind=command.kind||'general';
      if(kind==='player'&&(command.cost!==200||info.cost!==200))fail('Player packs разрешены только по 200 Rax.');
      if (!['general','player'].includes(kind)||kind==='player'&&(!Number.isSafeInteger(command.playerId)||command.playerId<=0||command.keepSummary)||info.sport !== command.sport || info.kind !== kind || info.cost !== command.cost || kind==='player'&&info.playerId!==command.playerId) fail('Лига, игрок, тип пака или цена в Real отличаются от выбранных. Покупка остановлена.');
      if (await ui.accountId(command) !== command.accountId) fail('Аккаунт изменился перед покупкой.');
      if (!(Date.now() < command.expiresAt)) fail('Команда устарела; покупка не отправлена.');
      activationReached = true;
      await ui.activate(command);
      await ui.authorize(command);
      started = true;
      await ui.purchaseOnce(command);
      const summary = await ui.revealSummary(command);
      if (!summary?.summaryText || !Number.isInteger(summary.cardCount) || summary.cardCount < 1 || summary.cardCount > 100) fail('Не удалось подтвердить сводку открытого пака.');
      return { ok: true, pack: { id: null, accountId: command.accountId, sport: command.sport, cost: command.cost, cards: [], ...summary } };
    } catch (error) {
      const interrupted=Boolean(ui.interrupted?.());
      // Once a purchase has been authorized, UI drift / a lost summary is recorded
      // as an unknown opening and the resilient queue may recover and continue.
      // Explicit Real verification/auth failures still require human attention.
      return { ok: false, uncertain: started, requiresAttention:Boolean(error.requiresAttention||!started&&interrupted), recoverable: !started && !activationReached && error.recoverable === true && !interrupted, message: error.message || 'Действие остановлено. Проверьте вкладку Real.' };
    }
  },
};
