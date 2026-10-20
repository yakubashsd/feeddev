/* Canvas-first controls. Existing profile and image rendering remain the source of truth. */
(() => {
  const panel = document.querySelector('#layoutsPanel');
  const root = panel.querySelector('.layout-branding');
  const canvas = document.querySelector('#brandPreviewCanvas');
  const controls = panel.querySelector('.brand-controls');
  const textControls = panel.querySelector('.template-layer-editor');
  const toolbar = document.createElement('div');
  toolbar.className = 'le-toolbar';
  toolbar.innerHTML = `<strong>Редактор шаблона</strong><span class="le-save-state" aria-live="polite">Черновик сохраняется автоматически</span><button type="button" id="le-undo" disabled aria-label="Отменить изменение">↶ Отменить</button><button type="button" id="le-redo" disabled aria-label="Повторить изменение">↷</button><button type="button" id="le-preview">Крупнее</button>`;
  root.prepend(toolbar);
  const checkButton = document.createElement('button');
  checkButton.type='button';checkButton.textContent='Проверить на квартирах';toolbar.append(checkButton);
  const checkDialog=document.createElement('dialog');checkDialog.className='le-check-dialog';
  checkDialog.innerHTML='<div class="le-check-head"><strong>Проверка шаблона на разных квартирах</strong><button type="button">Закрыть</button></div><p class="le-hint">Предпросмотр не меняет изображения в объявлениях.</p><div class="le-check-grid"></div>';
  document.body.append(checkDialog);checkDialog.querySelector('button').onclick=()=>checkDialog.close();
  checkButton.onclick=async()=>{
    if(!brandPreviewImages){showToast('Сначала загрузите подложку и выберите планировку');return;}
    const grid=checkDialog.querySelector('.le-check-grid');grid.replaceChildren();checkDialog.showModal();
    const candidates=[...new Map(objects.filter(o=>sourceLayoutPhoto(o)).map(o=>[sourceLayoutPhoto(o),o])).values()].sort((a,b)=>Number(a.totalArea)-Number(b.totalArea));
    const samples=[...new Set([candidates[0],candidates[Math.floor(candidates.length/2)],candidates.at(-1)])].filter(Boolean);
    const config=brandConfig(),badge=brandPreviewImages.badgeImage;
    await Promise.all(samples.map(async item=>{
      const figure=document.createElement('figure'),c=document.createElement('canvas'),caption=document.createElement('figcaption');
      caption.textContent=`${item.totalArea || '—'} м² · ID ${item.externalId} · Загрузка…`;figure.append(c,caption);grid.append(figure);
      try {const img=await loadImageForCanvas(sourceLayoutPhoto(item));drawBrandedLayout(img,badge,c,config,item);caption.textContent=`${item.totalArea || '—'} м² · ID ${item.externalId}`;}catch(error){c.remove();caption.textContent=`ID ${item.externalId}: изображение недоступно`;}
    }));
  };
  const properties = document.createElement('aside');
  properties.className = 'le-properties';
  properties.innerHTML = `<h3>Элементы шаблона</h3><div class="le-layers"><button type="button" data-layer="background" aria-pressed="false">▧ Подложка</button><button type="button" data-layer="layout" aria-pressed="true">▣ Планировка</button><button type="button" data-layer="text" aria-pressed="false">Т Текст и данные</button></div><h3 id="le-property-title">Планировка</h3><p class="le-hint">Выберите элемент на холсте. Перетащите его или потяните за нижний правый угол.</p>`;
  root.append(properties);
  properties.append(controls, textControls);
  for(const pair of [['brandOffsetX','brandOffsetY'],['templateTextX','templateTextY']]){
    const detail=document.createElement('details'); detail.className='le-precise';
    detail.innerHTML='<summary>Точные настройки</summary><div></div>';
    const first=document.getElementById(pair[0]).closest('.field');first.before(detail);
    pair.forEach(id=>detail.lastElementChild.append(document.getElementById(id).closest('.field')));
  }
  const fields = document.createElement('div');
  fields.className = 'le-fields';
  fields.innerHTML = `<span class="le-hint">Вставить в выбранную строку:</span><button type="button" data-token="price">Цена</button><button type="button" data-token="area">Площадь</button><button type="button" data-token="rooms">Комнаты</button><button type="button" data-token="complex">ЖК</button>`;
  textControls.prepend(fields);
  const footer = document.createElement('div');
  footer.className = 'le-footer';
  footer.innerHTML = '<p>Черновик шаблона и готовые изображения сохраняются отдельно. Сформируйте изображения после проверки макета.</p>';
  footer.append(document.querySelector('#brandScope').closest('.field'), document.querySelector('#insertBrandPhotoBtn'));
  footer.querySelector('#insertBrandPhotoBtn').textContent = 'Сформировать изображения';
  root.append(footer);
  const fileControl = controls.querySelector('.layout-file-control');
  document.querySelector('#pickBrandBadgeBtn').textContent = 'Загрузить подложку';
  document.querySelector('label[for="brandSize"]').textContent = 'Размер, %';
  const stage = document.createElement('div');
  stage.className = 'le-stage';
  canvas.before(stage);
  stage.append(canvas);
  const outline = document.createElement('div');
  outline.className = 'le-selection';
  stage.append(outline);
  const safeOutline = document.createElement('div');
  safeOutline.className = 'le-safe-zone';
  safeOutline.innerHTML = '<span>Безопасная зона</span>';
  stage.append(safeOutline);
  canvas.setAttribute('aria-label', 'Макет: выберите планировку или текст, перемещайте мышью или стрелками');
  const search = document.createElement('input');
  search.id = 'le-search'; search.type = 'search'; search.placeholder = 'Найти образец по ЖК, площади или ID'; search.setAttribute('aria-label', search.placeholder);
  document.querySelector('#brandLayoutPicker').before(search);
  const filter = () => panel.querySelectorAll('.brand-layout-option').forEach(el => { el.hidden = !el.textContent.toLowerCase().includes(search.value.toLowerCase()); });
  search.addEventListener('input', filter);
  new MutationObserver(filter).observe(document.querySelector('#brandLayoutPicker'), {childList:true});
  let selected = 'layout', textTarget = document.querySelector('#templateHeadline'), drag = null;
  const ids = ['brandSize','brandOffsetX','brandOffsetY','brandSafeX','brandSafeY','brandSafeWidth','brandSafeHeight','templateHeadline','templateSubline','templateTextColor','templateTextSize','templateTextX','templateTextY'];
  const history = [], future = [];
  const snapshot = () => Object.fromEntries(ids.map(id => [id, document.getElementById(id).value]));
  let baseline = snapshot(), projectKey = '';
  function buttons() { document.querySelector('#le-undo').disabled = !history.length; document.querySelector('#le-redo').disabled = !future.length; }
  function commit() {
    const next = snapshot();
    if (JSON.stringify(next) !== JSON.stringify(baseline)) { history.push(baseline); if(history.length>80) history.shift(); future.length=0; baseline=next; }
    buttons(); persistActiveBrandProfile(); selectionBox();
    toolbar.querySelector('.le-save-state').textContent = 'Черновик сохранён · изображения требуют формирования';
  }
  function travel(from,to) { if(!from.length)return; to.push(snapshot()); baseline=from.pop(); Object.entries(baseline).forEach(([id,v])=>document.getElementById(id).value=v); drawBrandPreviewFrame(); persistActiveBrandProfile(); buttons(); selectionBox(); }
  function choose(layer) {
    selected=layer;
    properties.querySelectorAll('[data-layer]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.layer===layer)));
    document.querySelector('#le-property-title').textContent = {background:'Подложка',layout:'Планировка',text:'Текст и данные'}[layer];
    controls.hidden = layer==='text'; textControls.hidden=layer!=='text';
    [...controls.children].forEach(el=>{el.hidden = el===fileControl ? layer!=='background' : layer!=='layout';});
    selectionBox();
  }
  function bounds() {
    if (!brandPreviewImages) return null;
    if(selected==='background')return {x:0,y:0,width:canvas.width,height:canvas.height};
    if(selected==='layout')return brandedLayoutPlacement(brandPreviewImages.baseImage,brandPreviewImages.badgeImage);
    const c=brandConfig(); return {x:canvas.width*c.textXPercent/100,y:canvas.height*c.textYPercent/100,width:Math.max(40,canvas.width*(1-c.textXPercent/50)),height:c.textSize*(c.subline?1.9:1)};
  }
  function selectionBox() {
    const placement = brandPreviewImages ? brandedLayoutPlacement(brandPreviewImages.baseImage, brandPreviewImages.badgeImage) : null;
    const safe = placement?.safe;
    safeOutline.hidden = !safe;
    if (safe) {
      const r=canvas.getBoundingClientRect(), s=stage.getBoundingClientRect();
      Object.assign(safeOutline.style,{left:`${r.left-s.left+safe.x*r.width/canvas.width}px`,top:`${r.top-s.top+safe.y*r.height/canvas.height}px`,width:`${safe.width*r.width/canvas.width}px`,height:`${safe.height*r.height/canvas.height}px`});
    }
    const b=bounds(); outline.hidden=!b || selected==='background'; if(!b)return;
    const r=canvas.getBoundingClientRect(), s=stage.getBoundingClientRect();
    Object.assign(outline.style,{left:`${r.left-s.left+b.x*r.width/canvas.width}px`,top:`${r.top-s.top+b.y*r.height/canvas.height}px`,width:`${b.width*r.width/canvas.width}px`,height:`${b.height*r.height/canvas.height}px`});
  }
  properties.addEventListener('click', e=> {const b=e.target.closest('[data-layer]'); if(b)choose(b.dataset.layer);});
  ids.forEach(id=>{const el=document.getElementById(id); el.addEventListener('focus',()=>{if(!drag)baseline=snapshot();});el.addEventListener('input',selectionBox);el.addEventListener('change',commit);});
  ['templateHeadline','templateSubline'].forEach(id=>document.getElementById(id).addEventListener('focus',e=>textTarget=e.target));
  fields.addEventListener('click',e=>{ const b=e.target.closest('[data-token]'); if(!b)return; baseline=snapshot(); const token='{{'+b.dataset.token+'}}'+(b.dataset.token==='area'?' м²':''); const start=textTarget.selectionStart??textTarget.value.length, end=textTarget.selectionEnd??start; textTarget.setRangeText(token,start,end,'end'); textTarget.dispatchEvent(new Event('input')); commit(); textTarget.focus(); });
  document.querySelector('#le-undo').onclick=()=>travel(history,future);
  document.querySelector('#le-redo').onclick=()=>travel(future,history);
  document.querySelector('#le-preview').onclick=openBrandPreviewDialog;
  document.querySelector('#centerBrandLayoutBtn').addEventListener('click',()=>{document.querySelector('#brandPosition').value='center-right';document.querySelector('#brandOffsetX').value=0;document.querySelector('#brandOffsetY').value=0;drawBrandPreviewFrame();commit();});
  document.querySelector('#centerBrandLayoutBtn').textContent='В правую белую зону';
  // Replace the old whole-canvas drag with element hit testing and resize handles.
  canvas.removeEventListener('pointerdown',startBrandPreviewDrag);
  canvas.removeEventListener('pointermove',moveBrandPreviewDrag);
  canvas.removeEventListener('pointerup',endBrandPreviewDrag);
  canvas.removeEventListener('pointercancel',endBrandPreviewDrag);
  canvas.addEventListener('pointerdown',e=>{
    if(!brandPreviewImages)return;
    const r=canvas.getBoundingClientRect(), x=(e.clientX-r.left)*canvas.width/r.width,y=(e.clientY-r.top)*canvas.height/r.height;
    const prev=selected; choose('text');const t=bounds();choose(prev);
    let b=bounds();const resize=b && selected!=='background' && Math.hypot((x-b.x-b.width)*r.width/canvas.width,(y-b.y-b.height)*r.height/canvas.height)<16;
    if(!resize){const c=brandConfig();choose((c.headline||c.subline)&&x>=t.x&&x<=t.x+t.width&&y>=t.y&&y<=t.y+t.height?'text':'layout');}
    baseline=snapshot(); drag={x:e.clientX,y:e.clientY,config:brandConfig(),resize}; canvas.setPointerCapture(e.pointerId); canvas.focus();e.preventDefault();
  });
  canvas.addEventListener('pointermove',e=>{
    if(!drag)return;const r=canvas.getBoundingClientRect(),dx=(e.clientX-drag.x)/r.width*100,dy=(e.clientY-drag.y)/r.height*100,c=drag.config;
    const set=(id,v,min,max)=>document.getElementById(id).value=Math.round(Math.max(min,Math.min(max,v)));
    if(drag.resize){if(selected==='layout')set('brandSize',c.widthPercent+dx,20,95);else set('templateTextSize',c.textSize+dy*2,16,120);}
    else if(selected==='text'){set('templateTextX',c.textXPercent+dx,0,95);set('templateTextY',c.textYPercent+dy,0,95);}
    else setBrandOffsets(c.offsetXPercent+dx,c.offsetYPercent+dy);
    drawBrandPreviewFrame();selectionBox();
  });
  function finish(){if(!drag)return;drag=null;commit();}
  canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',finish);
  panel.addEventListener('keydown',e=>{
    if(e.target.matches('input,textarea,select'))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?travel(future,history):travel(history,future);return;}
    if(e.target!==canvas||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
    e.preventDefault();baseline=snapshot();const c=brandConfig(),step=e.shiftKey?1:.1,dx=e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,dy=e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0;
    if(selected==='text'){document.querySelector('#templateTextX').value=Math.max(0,Math.min(95,c.textXPercent+dx));document.querySelector('#templateTextY').value=Math.max(0,Math.min(95,c.textYPercent+dy));}else setBrandOffsets(c.offsetXPercent+dx*10,c.offsetYPercent+dy*10);
    drawBrandPreviewFrame();commit();
  });
  new ResizeObserver(selectionBox).observe(canvas);
  new MutationObserver(()=>{
    if(projectKey!==activeBrandProjectKey){projectKey=activeBrandProjectKey;history.length=0;future.length=0;baseline=snapshot();buttons();}
    selectionBox();
  }).observe(canvas,{attributes:true,attributeFilter:['width','height']});
  choose('layout');
})();
