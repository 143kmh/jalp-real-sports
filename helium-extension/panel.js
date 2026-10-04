(() => {
  if (location.origin !== 'http://127.0.0.1:5127') return;
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'real-manager-panel') return;
    if (!['CONNECT','WAKE','CHECK'].includes(event.data.type)) return;
    try {
      const result = await chrome.runtime.sendMessage({ type:event.data.type, token:event.data.token });
      window.postMessage({ source:'real-manager-extension', type:event.data.type, result },location.origin);
    } catch {
      window.postMessage({ source:'real-manager-extension', type:event.data.type, result:{ok:false,error:'Расширение отключено. Обновите страницу после его включения.'} },location.origin);
    }
  });
  window.postMessage({ source:'real-manager-extension', type:'AVAILABLE',result:{ok:true} },location.origin);
})();
