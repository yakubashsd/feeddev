(() => {
  const localSave=saveMonitoredFeeds;
  let ready=false,queue=Promise.resolve();
  const endpoint=()=>'/api/monitor?project='+encodeURIComponent(currentProject?.id||'default');
  const note=document.querySelector('.monitor-note');
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
      note.textContent='Сервер проверяет фиды проекта каждые 12 часов, даже если браузер закрыт. Уведомления отправляются в Telegram и на email, если каналы настроены на сервере.';
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
