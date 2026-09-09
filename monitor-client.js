(() => {
  const localSave=saveMonitoredFeeds;
  let ready=false,queue=Promise.resolve();
  const endpoint=()=>'/api/monitor?project='+encodeURIComponent(currentProject?.id||'default');
  const note=document.querySelector('.monitor-note');
  const tgStatus=document.querySelector('#telegramConnectionStatus');
  const tgConnect=document.querySelector('#connectTelegram');
  const tgConfirm=document.querySelector('#confirmTelegram');
  const tgDisconnect=document.querySelector('#disconnectTelegram');
  const tgLink=document.querySelector('#telegramConnectLink');
  let candidate=null;
  async function telegramRequest(method='GET',body){
    const response=await fetch('/api/telegram-link?project='+encodeURIComponent(currentProject.id),{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Не удалось подключить Telegram');return result;
  }
  async function telegramRefresh(){
    if(!currentProject)return;
    try{
      const state=await telegramRequest();candidate=state.candidate;
      tgConfirm.hidden=!candidate;tgDisconnect.hidden=!state.connected && !candidate;
      tgConnect.disabled=state.configured===false;
      tgConnect.textContent=state.connected?'Изменить получателя':'Подключить Telegram';
      tgStatus.textContent=candidate?`Подтвердите аккаунт: ${candidate.name}${candidate.username?' (@'+candidate.username+')':''}`:state.connected?`Подключён: ${state.connected.name}`:state.configured?'Не подключён':'Бот ещё не настроен администратором';
    }catch(error){tgStatus.textContent=error.message;}
  }
  tgConnect.addEventListener('click',async()=>{
    tgConnect.disabled=true;
    try{const result=await telegramRequest('POST',{});tgLink.href=result.url;tgLink.hidden=false;tgStatus.textContent='Откройте бота, нажмите Start и вернитесь сюда. Ссылка действует 10 минут.';}
    catch(error){tgStatus.textContent=error.message;}finally{tgConnect.disabled=false;}
  });
  tgConfirm.addEventListener('click',async()=>{
    if(!candidate)return;tgConfirm.disabled=true;
    try{await telegramRequest('POST',{confirmationId:candidate.confirmationId});tgLink.hidden=true;await telegramRefresh();showToast('Telegram подключён к проекту');}
    catch(error){tgStatus.textContent=error.message;}finally{tgConfirm.disabled=false;}
  });
  tgDisconnect.addEventListener('click',async()=>{
    if(!confirm('Отключить Telegram от этого проекта?'))return;
    try{await telegramRequest('DELETE');tgLink.hidden=true;await telegramRefresh();}catch(error){tgStatus.textContent=error.message;}
  });
  document.querySelector('[data-nav="feeds"]').addEventListener('click',telegramRefresh);
  setInterval(()=>{if(activePage==='feeds'&&!document.hidden)telegramRefresh();},5000);
  async function request(method='GET',body){
    const response=await fetch(endpoint(),{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();if(!response.ok)throw Error(result.error||`HTTP ${response.status}`);return result;
  }
  async function refresh(){
    if(!currentProject)return;
    try{
      await queue;
      let result=await request();
      if(!ready&& !result.feeds.length && readMonitoredFeeds().length)result=await request('PUT',{feeds:readMonitoredFeeds()});
      ready=true;localSave(result.feeds);renderFeedsList();
      note.textContent='';
    }catch(error){note.textContent=error.message;}
  }
  saveMonitoredFeeds=function(feeds){
    localSave(feeds);
    queue=queue.then(async()=>{
      const result=await request('PUT',{feeds});ready=true;localSave(result.feeds);renderFeedsList();
    }).catch(error=>{note.textContent='Не удалось сохранить на сервере: '+error.message;showToast('Изменения мониторинга пока сохранены только в браузере');});
  };
  checkSavedFeeds=async function(id=''){
    const button=document.querySelector('#checkFeedsBtn');button.disabled=true;
    try{await queue;const result=await request('POST',{id});localSave(result.feeds);renderFeedsList();showToast('Серверная проверка завершена');}
    catch(error){showToast(error.message);}finally{button.disabled=false;}
  };
  document.querySelector('[data-nav="feeds"]').addEventListener('click',refresh);
  document.querySelector('#feedsPanel .panel-caption').textContent='Добавьте ссылки: сервер будет проверять все фиды проекта каждые 12 часов и сообщать о новых ошибках.';
  setInterval(()=>{if(activePage==='feeds')refresh();},30000);
})();
