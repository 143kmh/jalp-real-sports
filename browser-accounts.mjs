import {OperationError} from './core.mjs';

// Only a successful profile response from the app-owned Real tab can register
// a session. Login/password fields and third-party identity providers are ignored.
export function browserAccount({url,method,status,headers,user},now=new Date().toISOString()){
  let parsed;try{parsed=new URL(url);}catch{return null;}
  if(parsed.origin!=='https://web.realapp.com'||parsed.pathname!=='/user'||method!=='GET'||status!==200)return null;
  if(!user||typeof user.id!=='string'||!/^[a-zA-Z0-9]{1,80}$/.test(user.id))return null;
  const safeHeaders=browserSessionHeaders(headers);
  if(!safeHeaders)return null;
  return {id:user.id,name:String(user.userName||user.name||user.id).slice(0,100),balance:Number.isFinite(user.virtualCurrencyBalance)?user.virtualCurrencyBalance:null,
    sessionSource:'browser',lastSessionAt:now,checkedAt:now,observedAt:now,status:'ready',headers:safeHeaders,packs:{}};
}
export function browserSessionHeaders(headers){
  const safeHeaders={};
  for(const [key,value] of Object.entries(headers||{})){
    const name=key.toLowerCase();
    if((/^real-[a-z-]+$/.test(name)&&!['real-request-token','real-turnstile-token'].includes(name))||['authorization','user-agent'].includes(name)){
      if(typeof value!=='string'||value.length>16384||/[\r\n]/.test(value))return null;
      safeHeaders[name]=value;
    }
  }
  if(!safeHeaders['real-auth-info']||Object.keys(safeHeaders).length>30)return null;
  return safeHeaders;
}
export function hasBrowserSession(account){return account?.sessionSource==='browser'&&Boolean(account.headers?.['real-auth-info']);}
export function requireBrowserSession(account){if(!hasBrowserSession(account))throw new OperationError(`Войдите в ${account?.name||'аккаунт'} через «Добавить аккаунты». Сессия служебного браузера ещё не подключена.`);}
export function mergeBrowserAccount(previous,incoming){
  if(previous&&previous.id!==incoming.id)throw new Error('Account mismatch');
  if(!previous)return {...incoming,importedAt:incoming.lastSessionAt};
  // Keep object identity for in-flight read-only checks, and all pack/protection
  // history. A new login never acknowledges an uncertain purchase.
  const packs=previous.packs||{};Object.assign(previous,incoming,{packs,lastError:null});return previous;
}
