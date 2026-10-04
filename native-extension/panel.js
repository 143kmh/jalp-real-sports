(() => {
  // This executes only in the app-opened loopback pairing tab, not on Real.
  if(location.origin!=='http://127.0.0.1:5127'||new URL(location.href).searchParams.get('native-bridge')!=='1')return;
  async function connect(){
    const token=document.querySelector('meta[name="local-token"]')?.content;
    try{const result=await chrome.runtime.sendMessage({type:'CONNECT',token});if(result?.ok)document.title='Chrome подключён · Real Manager';else document.title='Подключение Chrome: '+(result?.error||'ожидание');}catch{}
  }
  connect();
})();
