import {zipSync,strToU8} from 'fflate';

export function networkRecord(url,method,status,type,durationMs=null){
  let parsed;try{parsed=new URL(url);}catch{return null;}
  if(parsed.protocol!=='https:'||!['web.realapp.com','realsports.io','www.realsports.io'].includes(parsed.hostname)||!['xhr','fetch'].includes(type))return null;
  return {at:new Date().toISOString(),origin:parsed.origin,path:scrubDiagnostics(parsed.pathname),queryKeys:[...new Set(parsed.searchParams.keys())].filter(k=>!/auth|token|cookie|password|secret|code/i.test(k)),method:String(method),status:Number.isInteger(status)?status:null,durationMs};
}

export function scrubDiagnostics(value,secrets=[]){
  if(typeof value==='string'){
    let clean=value;
    for(const secret of secrets.filter(v=>typeof v==='string'&&v.length>=8).sort((a,b)=>b.length-a.length))clean=clean.split(secret).join('[REDACTED]');
    return clean.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[EMAIL]').replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[TOKEN]');
  }
  if(Array.isArray(value))return value.map(v=>scrubDiagnostics(v,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/cookie|authorization|password|secret|token|headers|real-auth/i.test(k)).map(([k,v])=>[k,scrubDiagnostics(v,secrets)]));
  return value;
}
export function diagnosticArchive(payload,png,secrets=[]){
  const files={'diagnostic.json':strToU8(JSON.stringify(scrubDiagnostics(payload,secrets),null,2)),
    'README.txt':strToU8('Real Manager diagnostic export\nContains interface structure, account names/IDs, card information, recent errors and API route/status metadata. Request/response bodies, query values, cookies, session headers, input values and local authorization tokens are NOT exported. Screenshot is omitted on login and when populated editable fields are visible. Review before sharing; this file is not uploaded automatically.\n')};
  if(png)files['real-screen.png']=new Uint8Array(png);
  return zipSync(files,{level:3});
}


export function scenarioArchive(payload,secrets=[]){
  const safe=scrubDiagnostics(payload,secrets);
  const files={
    'scenario.json':strToU8(JSON.stringify(safe,null,2)),
    'README.txt':strToU8(
      'Real Manager scenario recording\n'+
      'Contains the visible Real UI states around manual actions plus network METHOD/PATH/STATUS metadata.\n'+
      'It does NOT include request/response bodies, cookies, authorization/session headers, challenge tokens, passwords, or input values.\n'+
      'Visible page text can contain account names, player/card names and other Real content. Review scenario.json before sharing.\n'
    ),
  };
  return zipSync(files,{level:3});
}
