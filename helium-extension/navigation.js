// Identify the public desktop navigation column independently of the avatar renderer.
globalThis.RealManagerNavigation = {
  column(records) {
    const icons=records.filter(r=>r.w>=18&&r.w<=28&&r.h>=18&&r.h<=30);
    const columns=new Map();
    for(const anchor of icons){
      const column=icons.filter(r=>Math.abs(r.x+r.w/2-anchor.x-anchor.w/2)<4).sort((a,b)=>a.y-b.y);
      if(column.length<9||column[0].w>22)continue;
      const deltas=column.slice(1).map((r,i)=>r.y-column[i].y);
      // Logo -> Home is 44px; other rows are 56px. The non-SVG avatar leaves a 112px gap before Settings.
      if(Math.abs(deltas[0]-44)>8||deltas.slice(1).some((d,i)=>Math.abs(d-(i+2===column.length-2?112:56))>8))continue;
      columns.set(column.map(r=>records.indexOf(r)).join(','),column);
    }
    if(columns.size!==1)throw new Error('Не удалось определить навигацию Real. Дождитесь загрузки страницы; покупка не отправлена.');
    return [...columns.values()][0];
  },
  logoutName(value){
    return String(value).trim().match(/^Log out\s+(@?[^\s]+)$/)?.[1]?.replace(/^@/,'')||null;
  },
};
