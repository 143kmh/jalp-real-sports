(() => {
  const normalize=value=>String(value).normalize('NFKC').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim().toUpperCase();
  function matchCards(plan,observed){
    const ordinary=plan.cards.filter(c=>Number.isSafeInteger(c.mint)&&c.mint>0);
    if(observed.length!==ordinary.length)throw new Error('Количество карт в сводке не совпало с проверенным паком.');
    const used=new Set(),matches=[];
    for(const card of ordinary){
      const candidates=observed.filter((o,i)=>!used.has(i)&&o.mint===card.mint&&card.names.length&&card.names.every(name=>normalize(o.text).includes(normalize(name))));
      if(candidates.length!==1)throw new Error('Не удалось однозначно распознать карту #'+card.mint+'. Листинг остановлен.');
      const entry=candidates[0];used.add(observed.indexOf(entry));matches.push({card,entry});
    }
    if(plan.selectedIds.some(id=>!matches.some(m=>m.card.id===id)))throw new Error('Выбранная карта не распознана в сводке.');
    return matches;
  }
  globalThis.RealManagerPackListing={matchCards,normalize,
    create({all,exact,text,clean,visible,click,wait,getSummary,assertContext,authorize}){
      function observedCards(){
        const root=getSummary();
        if(!visible(root))throw new Error('Сводка открытого пака закрыта.');
        const markers=all('div,span',root).filter(e=>/^#\d+$/.test(clean(text(e)))&&!all('div,span',e).some(c=>clean(text(c))===clean(text(e))));
        return markers.map(marker=>{
          const target=marker.closest('[role="button"],button,[tabindex="0"]');
          if(!target||!root.contains(target))throw new Error('Не найдена кнопка карты в сводке.');
          let wrapper=target;
          while(wrapper.parentElement&&wrapper.parentElement!==root){
            const parent=wrapper.parentElement,r=parent.getBoundingClientRect();
            const count=all('div,span',parent).filter(e=>/^#\d+$/.test(clean(text(e)))&&!all('div,span',e).some(c=>clean(text(c))===clean(text(e)))).length;
            if(count!==1||r.width>500)break;wrapper=parent;
          }
          const indicators=all('div',wrapper).filter(e=>{const s=getComputedStyle(e);return s.position==='absolute'&&parseFloat(s.width)===24&&parseFloat(s.height)===24&&all('svg',e).length===1;});
          if(indicators.length!==1)throw new Error('Не распознан индикатор выбора карты.');
          const opacity=Number(getComputedStyle(indicators[0]).opacity);
          if(opacity!==0&&opacity!==1)throw new Error('Выбор карты ещё не подтверждён Real.');
          return {mint:Number(clean(text(marker)).slice(1)),text:text(target),target,wrapper,selected:opacity===1,listed:exact('Listed',wrapper).length===1};
        });
      }
      function drawer(){
        const headings=exact('Quick list');
        for(const heading of headings){
          for(let e=heading.parentElement;e&&e!==document.body;e=e.parentElement){
            if(exact('Duration',e).length===1&&exact('Pricing',e).length===1&&exact('Cancel',e).length===1)return e;
          }
        }
        return null;
      }
      function option(panel,section,label){
        const headers=exact(section,panel);if(headers.length!==1)throw new Error('Настройка '+section+' неоднозначна.');
        // React Native Web marks the chosen option disabled and removes it from tab order.
        // It can have tabindex=-1 (or only aria-disabled), not role=button / tabindex=0.
        for(let row=headers[0].parentElement;row;row=row.parentElement){
          const labels=exact(label,row);if(labels.length===1){const button=labels[0].closest('[role="button"],button,[tabindex],[aria-disabled]');if(button&&row.contains(button))return button;}
          if(row===panel)break;
        }
        throw new Error('В Quick list не найден выбранный вариант '+section+': '+label);
      }
      const selected=e=>e.getAttribute('aria-disabled')==='true'||e.disabled===true;
      function verifyChoice(panel,section,wanted,labels){
        const available=labels.filter(label=>exact(label,panel).length);
        if(available.length<2||available.map(label=>option(panel,section,label)).filter(selected).length!==1||!selected(option(panel,section,wanted)))throw new Error('Real не подтвердил единственный выбранный вариант '+section+': '+wanted);
      }
      async function setOption(panel,section,label){
        let button=option(panel,section,label);
        if(!selected(button))click(button,section+': '+label);
        await wait(()=>{button=option(panel,section,label);return selected(button);},'Real не подтвердил '+section+': '+label,5000);
      }
      function verifyOptions(plan){
        const panel=drawer();if(!panel)throw new Error('Настройки Quick list закрыты.');
        verifyChoice(panel,'Duration',plan.durationLabel,['12h','24h','48h','72h']);
        verifyChoice(panel,'Pricing',plan.pricingLabel,['Min','Default','Max']);
        const buttons=exact(`Quick list (${plan.selectedIds.length})`,panel);
        if(buttons.length!==1||buttons[0].closest('[aria-disabled="true"],:disabled'))throw new Error('Количество карт в Quick list не подтверждено или Real не разрешает листинг.');
        return buttons[0];
      }
      return {
        listContext:async c=>{assertContext(c);return true;},
        async prepareQuickList(command){
          assertContext(command);const plan=command.plan;
          if(!plan.durationLabel||!plan.pricingLabel)throw new Error('Real не вернул названия выбранных настроек.');
          const root=getSummary(),buttons=exact('List',root);if(buttons.length!==1)throw new Error('Нижняя кнопка List в сводке неоднозначна.');
          click(buttons[0],'List в сводке пака');
          await wait(()=>all('div,span,button',root).some(e=>/^Quick list \(\d+\)$/.test(clean(text(e)))),'Real не включил выбор карт.');
          let matches=matchCards(plan,observedCards());
          for(const {card} of matches){
            assertContext(command);let entry=matchCards(plan,observedCards()).find(m=>m.card.id===card.id).entry;
            const desired=plan.selectedIds.includes(card.id);
            if(entry.selected!==desired){click(entry.target,'Выбор карты #'+card.mint);await wait(()=>matchCards(plan,observedCards()).find(m=>m.card.id===card.id).entry.selected===desired,'Real не подтвердил выбор карты #'+card.mint,5000);}
          }
          matches=matchCards(plan,observedCards());
          if(matches.some(m=>m.entry.selected!==plan.selectedIds.includes(m.card.id)))throw new Error('Защищённая карта осталась выбранной.');
          const open=exact(`Quick list (${plan.selectedIds.length})`,root);if(open.length!==1)throw new Error('Не подтверждено количество выбранных карт.');
          click(open[0],'Открыть настройки Quick list');
          const panel=await wait(drawer,'Не появилось окно настроек Quick list.');
          await setOption(panel,'Duration',plan.durationLabel);await setOption(panel,'Pricing',plan.pricingLabel);
          verifyOptions(plan);
          return {selectedIds:[...plan.selectedIds],mode:plan.mode,durationHours:24};
        },
        authorizeListing:authorize,
        async submitQuickList(command){
          assertContext(command);const plan=command.plan,button=verifyOptions(plan);
          click(button,'Подтвердить Quick list'); // Exactly one submission; never retry.
          await wait(()=>{if(drawer())return false;const matches=matchCards(plan,observedCards());return plan.selectedIds.every(id=>matches.find(m=>m.card.id===id)?.entry.listed);},'Real не подтвердил Quick list. Проверьте маркетплейс перед повторением.',30000);
          return {listedCardIds:[...plan.selectedIds]};
        },
        async finishSummary(command){
          assertContext(command);const root=getSummary(),done=exact('Done',root);if(done.length!==1)throw new Error('Не найдена кнопка Done после листинга.');click(done[0],'Done');
          await wait(()=>!exact('Pack summary').length,'Сводка пака не закрылась.',5000);
        },
        inspect:()=>({cards:observedCards().map(({mint,text,selected,listed})=>({mint,text,selected,listed})),drawer:drawer()?.outerHTML?.slice(0,45000)||null}),
        inspectOptions:()=>{
          const panel=drawer();if(!panel)return null;
          return [['Duration',['12h','24h','48h','72h']],['Pricing',['Min','Default','Max']]].flatMap(([section,labels])=>labels.filter(label=>exact(label,panel).length).map(label=>{try{const e=option(panel,section,label);return {section,label,found:true,selected:selected(e),role:e.getAttribute('role'),tabindex:e.getAttribute('tabindex'),ariaDisabled:e.getAttribute('aria-disabled')};}catch(error){return {section,label,found:false,error:error.message};}}));
        },
      };
    },
  };
})();
