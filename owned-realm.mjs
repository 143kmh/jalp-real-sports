import crypto from 'node:crypto';
import {OperationError} from './core.mjs';

export const REAL_URL='https://realsports.io/';
export function isRealUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&['realsports.io','www.realsports.io'].includes(u.hostname)&&!u.port&&!u.username&&!u.password;}catch{return false;}}
export function buildRealmSource(sources,bindingName){
  // This runs in an isolated world, like an extension content script. The website
  // cannot read the bridge, command IDs or local authorization token.
  return `(() => {
    if(window.top!==window||!/^https:\\/\\/(?:www\\.)?realsports\\.io\\//.test(location.href)||globalThis.__rmDispatch)return;
    const requests=new Map();let serial=0,listener;
    globalThis.__rmReply=(id,result)=>{const request=requests.get(id);if(request){requests.delete(id);clearTimeout(request.timer);request.resolve(result);}};
    globalThis.chrome={runtime:{id:'real-manager-owned',onMessage:{addListener:fn=>listener=fn},sendMessage:message=>new Promise(resolve=>{
      const id=String(++serial),timer=setTimeout(()=>{requests.delete(id);resolve({ok:false,error:'Нет подтверждения приложения.'});},60000);
      requests.set(id,{resolve,timer});globalThis[${JSON.stringify(bindingName)}](JSON.stringify({id,message}));
    })}};
    globalThis.__rmDispatch=message=>new Promise((resolve,reject)=>{
      if(message.type==='DIAGNOSTIC'){resolve(globalThis.__rmDiagnostic());return;}
      if(!listener){reject(new Error('Адаптер Real не загрузился.'));return;}
      let settled=false;const reply=result=>{if(!settled){settled=true;resolve(result);}};
      const async=listener(message,{id:'real-manager-owned'},reply);
      if(async!==true&&!settled)reject(new Error('Real не обработал команду.'));
    });
    ${sources.join('\n;\n')}
    globalThis.__rmDiagnostic=()=>{
      const shown=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
      const editable=[...document.querySelectorAll('input,textarea,[contenteditable]')].filter(shown);
      const sensitive=editable.some(e=>e.type==='password'||!['checkbox','radio','button','submit'].includes(e.type)&&(e.value||e.textContent||'').trim());
      const rect=e=>{const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};};
      const elements=[...document.querySelectorAll('body *')].filter(e=>shown(e)&&!e.matches('input,textarea,script,style,iframe,[contenteditable]')&&!e.closest('input,textarea,script,style,iframe,[contenteditable]')).slice(0,1600),indexes=new Map(elements.map((e,i)=>[e,i]));
      return {url:location.origin+location.pathname,title:document.title,sensitiveFieldsVisible:Boolean(sensitive),viewport:{w:innerWidth,h:innerHeight},nodes:elements.map(e=>({parent:indexes.get(e.parentElement)??null,tag:e.tagName,id:e.id||null,visual:{opacity:getComputedStyle(e).opacity,background:getComputedStyle(e).backgroundColor,fill:getComputedStyle(e).fill},role:e.getAttribute('role'),className:typeof e.className==='string'?e.className.slice(0,200):'',ariaLabel:e.getAttribute('aria-label'),disabled:e.getAttribute('aria-disabled'),selected:e.getAttribute('aria-selected'),tabIndex:e.getAttribute('tabindex'),text:e.children.length?'':(e.textContent||'').trim().slice(0,250),rect:rect(e)}))};
    };
  })();`;
}

export class OwnedRealm{
  constructor(page,sources,authorize){this.page=page;this.sources=sources;this.authorize=authorize;this.world='real-manager-'+crypto.randomUUID();this.binding='rm_'+crypto.randomBytes(12).toString('hex');this.contexts=new Map();this.inflight=null;}
  async install(){
    this.session=await this.page.createCDPSession();
    this.session.on('Runtime.executionContextCreated',({context})=>this.contexts.set(context.id,context));
    this.session.on('Runtime.executionContextDestroyed',({executionContextId})=>this.contexts.delete(executionContextId));
    this.session.on('Runtime.executionContextsCleared',()=>this.contexts.clear());
    this.session.on('Runtime.bindingCalled',event=>{this.handleBinding(event).catch(()=>{});});
    await this.session.send('Runtime.enable');await this.session.send('Page.enable');
    await this.session.send('Runtime.addBinding',{name:this.binding,executionContextName:this.world});
    await this.session.send('Page.addScriptToEvaluateOnNewDocument',{worldName:this.world,source:buildRealmSource(this.sources,this.binding)});
  }
  async context(){
    if(!isRealUrl(this.page.url()))throw Object.assign(new OperationError('Служебный браузер не на сайте Real. Откройте окно для входа.'),{requiresAttention:true});
    const {frameTree}=await this.session.send('Page.getFrameTree');
    const context=[...this.contexts.values()].find(c=>c.name===this.world&&c.auxData?.frameId===frameTree.frame.id);
    if(!context)throw new OperationError('Служебная страница Real ещё загружается.');
    return context.id;
  }
  async message(message){
    const contextId=await this.context();
    const reply=await this.session.send('Runtime.evaluate',{contextId,expression:`globalThis.__rmDispatch(${JSON.stringify(message)})`,awaitPromise:true,returnByValue:true});
    if(reply.exceptionDetails)throw new OperationError('Страница Real прервала действие. Результат проверьте в журнале.');
    return reply.result?.value;
  }
  async handleBinding(event){
    if(event.name!==this.binding)return;
    const context=this.contexts.get(event.executionContextId);
    if(!context||context.name!==this.world||event.executionContextId!==await this.context())return;
    let request;try{request=JSON.parse(event.payload);}catch{return;}
    if(typeof request.id!=='string'||request.id.length>40)return;
    const message=request.message,command=this.inflight;
    let result;
    if(!command||message?.commandId!==command.id||!['AUTHORIZE_PURCHASE','AUTHORIZE_LISTING'].includes(message?.type)||message.type!==(command.action==='open'?'AUTHORIZE_PURCHASE':'AUTHORIZE_LISTING')||!['open','list'].includes(command.action)){
      result={ok:false,error:'Команда покупки / листинга не активна.'};
    }else try{result=await this.authorize(message.type==='AUTHORIZE_PURCHASE'?'authorize':'authorize-listing',{commandId:command.id});}
    catch(error){result={ok:false,error:error instanceof OperationError?error.message:'Приложение не подтвердило действие.',requiresAttention:Boolean(error.requiresAttention)};}
    await this.session.send('Runtime.evaluate',{contextId:event.executionContextId,expression:`globalThis.__rmReply(${JSON.stringify(request.id)},${JSON.stringify(result)})`,returnByValue:true});
  }
}
