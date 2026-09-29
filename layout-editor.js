/* Canvas-first controls. Existing profile and image rendering remain the source of truth. */
(() => {
  const panel = document.querySelector('#layoutsPanel');
  if (!panel) return;
  const root = panel.querySelector('.layout-branding');
  const canvas = document.querySelector('#brandPreviewCanvas');
  const controls = panel.querySelector('.brand-controls');
  const textControls = panel.querySelector('.template-layer-editor');
  const toolbar = document.createElement('div');
  toolbar.className = 'le-toolbar';
  toolbar.innerHTML = `<strong>Макет</strong><span class="le-save-state" aria-live="polite">Изменения сохраняются автоматически</span><button type="button" data-add-layer="text">＋ Текст</button><button type="button" data-add-layer="rect">▰ Фигура</button><span class="le-toolbar-divider"></span><button type="button" id="le-zoom-out" aria-label="Уменьшить масштаб">−</button><span class="le-zoom-value">100%</span><button type="button" id="le-zoom-in" aria-label="Увеличить масштаб">＋</button><button type="button" id="le-fit">По размеру</button><button type="button" id="le-grid" aria-pressed="false">Сетка</button><button type="button" id="le-undo" disabled aria-label="Отменить изменение">↶</button><button type="button" id="le-redo" disabled aria-label="Повторить изменение">↷</button><button type="button" id="le-preview">Предпросмотр</button>`;
  root.prepend(toolbar);
  const checkButton = document.createElement('button');
  checkButton.type='button';checkButton.textContent='Проверить на квартирах';toolbar.append(checkButton);
  const checkDialog=document.createElement('dialog');checkDialog.className='le-check-dialog';
  checkDialog.innerHTML='<div class="le-check-head"><strong>Проверка шаблона на разных квартирах</strong><button type="button">Закрыть</button></div><p class="le-hint">Предпросмотр не меняет изображения в объявлениях.</p><div class="le-check-grid"></div>';
  document.body.append(checkDialog);checkDialog.querySelector('button').onclick=()=>checkDialog.close();
  checkButton.onclick=async()=>{
    if(!brandPreviewImages){showToast('Сначала загрузите подложку и выберите планировку');return;}
    const grid=checkDialog.querySelector('.le-check-grid');grid.replaceChildren();checkDialog.showModal();
    const candidates=[...new Map(objects.filter(o=>o.layoutPhoto).map(o=>[o.layoutPhoto,o])).values()].sort((a,b)=>Number(a.totalArea)-Number(b.totalArea));
    const samples=[...new Set([candidates[0],candidates[Math.floor(candidates.length/2)],candidates.at(-1)])].filter(Boolean);
    const config=brandConfig(),badge=brandPreviewImages.badgeImage;
    await Promise.all(samples.map(async item=>{
      const figure=document.createElement('figure'),c=document.createElement('canvas'),caption=document.createElement('figcaption');
      caption.textContent=`${item.totalArea || '—'} м² · ID ${item.externalId} · Загрузка…`;figure.append(c,caption);grid.append(figure);
      try {const img=await loadImageForCanvas(item.layoutPhoto);drawBrandedLayout(img,badge,c,config,item);caption.textContent=`${item.totalArea || '—'} м² · ID ${item.externalId}`;}catch(error){c.remove();caption.textContent=`ID ${item.externalId}: изображение недоступно`;}
    }));
  };
  const properties = document.createElement('aside');
  properties.className = 'le-properties';
  properties.innerHTML = `<div class="le-section-title"><h3>Слои</h3><span class="le-layer-count">3 слоя</span></div><div class="le-layers"><button type="button" data-layer="background" aria-pressed="false"><span class="le-layer-icon">▧</span><span>Подложка</span></button><button type="button" data-layer="layout" aria-pressed="true"><span class="le-layer-icon">▣</span><span>Планировка</span></button><button type="button" data-layer="text" aria-pressed="false"><span class="le-layer-icon">T</span><span>Текст объявления</span></button></div><div class="le-user-layers"></div><h3 id="le-property-title">Планировка</h3><p class="le-hint">Выберите слой, двигайте мышью или задайте точную позицию и размер.</p><div class="le-inspector"></div>`;
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
  fields.innerHTML = `<span class="le-hint">Вставить в выбранную строку:</span><button type="button" data-token="price">Цена</button><button type="button" data-token="area">Площадь</button><button type="button" data-token="rooms">Комнаты</button><button type="button" data-token="complex">Проект</button>`;
  textControls.prepend(fields);
  const footer = document.createElement('div');
  footer.className = 'le-footer';
  footer.innerHTML = '<p>Черновик шаблона и готовые изображения сохраняются отдельно. Сформируйте изображения после проверки макета.</p>';
  footer.append(document.querySelector('#brandScope').closest('.field'), document.querySelector('#insertBrandPhotoBtn'));
  footer.querySelector('#insertBrandPhotoBtn').textContent = 'Сформировать изображения';
  root.append(footer);
  const fileControl = controls.querySelector('.layout-file-control');
  const removeBackdrop=document.createElement('button');removeBackdrop.type='button';removeBackdrop.id='le-remove-backdrop';removeBackdrop.textContent='Удалить подложку';fileControl.append(removeBackdrop);
  document.querySelector('#pickBrandBadgeBtn').textContent = 'Загрузить подложку';
  document.querySelector('label[for="brandSize"]').textContent = 'Размер, %';
  const stage = document.createElement('div');
  stage.className = 'le-stage';
  canvas.before(stage);
  stage.append(canvas);
  // The selection is drawn directly on the canvas by drawBrandPreviewFrame.
  // A second DOM outline used an old fixed 78% formula, drifted away from the
  // actual plan and also made the resize hit area misleading.
  canvas.setAttribute('aria-label', 'Макет: выберите планировку или текст, перемещайте мышью или стрелками');
  const search = document.createElement('input');
  search.id = 'le-search'; search.type = 'search'; search.placeholder = 'Найти образец по проекту, площади или ID'; search.setAttribute('aria-label', search.placeholder);
  document.querySelector('#brandLayoutPicker').before(search);
  const filter = () => panel.querySelectorAll('.brand-layout-option').forEach(el => { el.hidden = !el.textContent.toLowerCase().includes(search.value.toLowerCase()); });
  search.addEventListener('input', filter);
  new MutationObserver(filter).observe(document.querySelector('#brandLayoutPicker'), {childList:true});
  const grid=document.createElement('div');grid.className='le-grid-overlay';grid.hidden=true;stage.append(grid);
  const serializedLayers=document.createElement('textarea');serializedLayers.id='templateCanvasLayers';serializedLayers.hidden=true;root.append(serializedLayers);
  const layerState=document.createElement('input');layerState.id='templateCanvasColor';layerState.type='color';layerState.value='#ffffff';layerState.hidden=true;root.append(layerState);
  const opacityState=document.createElement('input');opacityState.id='templateCanvasOpacity';opacityState.type='hidden';opacityState.value='100';root.append(opacityState);
  const fontState=document.createElement('input');fontState.id='templateFontFamily';fontState.type='hidden';fontState.value='Circe';root.append(fontState);
  let selected = 'layout', selectedCustomId='', textTarget = document.querySelector('#templateHeadline'), drag = null, zoom=1;
  let spaceHeld=false,pan=null;
  let projectFonts=[];
  const ids = ['brandSize','brandOffsetX','brandOffsetY','templateHeadline','templateSubline','templateTextColor','templateTextSize','templateTextX','templateTextY','templateFontFamily','templateCanvasLayers','templateCanvasColor','templateCanvasOpacity'];
  const history = [], future = [];
  const snapshot = () => Object.fromEntries(ids.map(id => [id, document.getElementById(id)?.value ?? '']));
  let baseline = snapshot(), projectKey = '';
  let saveTimer;
  function buttons() { document.querySelector('#le-undo').disabled = !history.length; document.querySelector('#le-redo').disabled = !future.length; }
  function commit() {
    const next = snapshot();
    if (JSON.stringify(next) !== JSON.stringify(baseline)) { history.push(baseline); if(history.length>80) history.shift(); future.length=0; baseline=next; }
    buttons(); persistActiveBrandProfile(); selectionBox();
    toolbar.querySelector('.le-save-state').textContent = 'Черновик сохранён · изображения требуют формирования';
  }
  function travel(from,to) { if(!from.length)return; to.push(snapshot()); baseline=from.pop(); Object.entries(baseline).forEach(([id,v])=>{const el=document.getElementById(id);if(el)el.value=v}); if(activeCustom())chooseCustom(selectedCustomId);else choose('layout');redraw();persistActiveBrandProfile();buttons();selectionBox(); }
  const escapeAttr=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const escapeText=value=>String(value??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  function readLayers(){try{const layers=JSON.parse(serializedLayers.value||'[]');return Array.isArray(layers)?layers.slice(0,40):[]}catch{return []}}
  function writeLayers(layers){serializedLayers.value=JSON.stringify(layers);}
  function activeCustom(){return readLayers().find(layer=>layer.id===selectedCustomId)}
  const cleanFontName=value=>String(value||'').replace(/[^\p{L}\p{N} _.-]/gu,'').trim().slice(0,80);
  const fontStack=value=>`"${cleanFontName(value)||'Circe'}", Circe, Arial, sans-serif`;
  const fontOptions=current=>['Circe',...projectFonts.map(font=>font.name)].filter((name,index,all)=>all.indexOf(name)===index).map(name=>`<option value="${escapeAttr(name)}" ${name===current?'selected':''}>${escapeText(name)}</option>`).join('');
  async function registerProjectFont(font){const encoded=String(font.dataUrl||'').split(',')[1]||'',binary=atob(encoded),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);const face=new FontFace(font.name,bytes.buffer);await face.load();document.fonts.add(face);return font;}
  async function readProjectFonts(){if(!activeBrandProjectKey||activeBrandProjectKey==='all')return[];const db=await openBrandAssetsDb();return new Promise((resolve,reject)=>{const request=db.transaction('fonts','readonly').objectStore('fonts').get(activeBrandProjectKey);request.onsuccess=()=>resolve(Array.isArray(request.result)?request.result:[]);request.onerror=()=>reject(request.error||new Error('Не удалось загрузить шрифты проекта.'))}).finally(()=>db.close())}
  async function writeProjectFonts(fonts){if(!activeBrandProjectKey||activeBrandProjectKey==='all')return;const db=await openBrandAssetsDb();return new Promise((resolve,reject)=>{const request=db.transaction('fonts','readwrite').objectStore('fonts').put(fonts,activeBrandProjectKey);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error||new Error('Не удалось сохранить шрифт.'))}).finally(()=>db.close())}
  async function hydrateProjectFonts(){try{projectFonts=await readProjectFonts();await Promise.all(projectFonts.map(registerProjectFont));renderInspector();redraw()}catch(error){showToast(error.message||'Не удалось загрузить шрифты проекта')}}
  function renderLayerTree(){const target=properties.querySelector('.le-user-layers'),layers=readLayers();target.innerHTML=layers.map((layer,index)=>`<div class="le-user-layer ${layer.id===selectedCustomId?'selected':''}"><button type="button" data-select-custom="${escapeAttr(layer.id)}" title="Выбрать ${escapeAttr(layer.name)}"><span class="le-layer-icon">${layer.type==='text'?'T':'▰'}</span><span>${escapeText(layer.name)}</span></button><span class="le-layer-actions"><button type="button" data-layer-up="${escapeAttr(layer.id)}" aria-label="Переместить выше" ${index===layers.length-1?'disabled':''}>↑</button><button type="button" data-layer-down="${escapeAttr(layer.id)}" aria-label="Переместить ниже" ${index===0?'disabled':''}>↓</button><button type="button" data-layer-delete="${escapeAttr(layer.id)}" aria-label="Удалить слой">×</button></span></div>`).join('');const n=3+layers.length;properties.querySelector('.le-layer-count').textContent=`${n} ${n===1?'слой':n<5?'слоя':'слоёв'}`;}
  function redraw(){if(typeof brandPreviewImages==='undefined'||!brandPreviewImages){canvas.width=1200;canvas.height=800;const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.save();ctx.globalAlpha=Number(opacityState.value||100)/100;ctx.fillStyle=layerState.value||'#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.restore();ctx.strokeStyle='#d8dde5';ctx.strokeRect(.5,.5,canvas.width-1,canvas.height-1);ctx.fillStyle='#8a919e';ctx.font='500 24px Circe, Arial, sans-serif';ctx.textAlign='center';ctx.fillText('Загрузите планировку или подложку',canvas.width/2,canvas.height/2);ctx.textAlign='start';drawCustom(ctx,canvas.width,canvas.height);}else drawBrandPreviewFrame();selectionBox();}
  function drawCustom(ctx,w,h){for(const layer of readLayers()){const x=w*Number(layer.x||0)/100,y=h*Number(layer.y||0)/100,lw=w*Number(layer.width||30)/100,lh=h*Number(layer.height||12)/100;ctx.save();ctx.globalAlpha=Number(layer.opacity??100)/100;if(layer.type==='rect'){ctx.fillStyle=layer.fill||'#d5ff19';ctx.fillRect(x,y,lw,lh)}else{ctx.fillStyle=layer.color||'#11151a';ctx.textBaseline='top';ctx.font=`${layer.weight||700} ${Number(layer.fontSize)||36}px ${fontStack(layer.fontFamily)}`;String(layer.text||'Текст').split('\n').forEach((line,i)=>ctx.fillText(line,x,y+i*(Number(layer.fontSize)||36)*1.2,lw))}ctx.restore()}}
  function fontControls(current,custom=false){return `<div class="le-font-controls"><label class="le-field">Шрифт<select ${custom?'data-prop="fontFamily"':'id="le-base-font"'}>${fontOptions(current||'Circe')}</select></label><div class="le-font-upload"><input class="le-font-file" type="file" accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf" hidden><button type="button" data-upload-font>Загрузить шрифт</button><div class="le-font-requirements"><strong>Требования к файлу</strong><ul><li>Формат WOFF2 рекомендуется; также подходят WOFF, TTF и OTF.</li><li>Размер — не более 3 МБ. Один файл — одно начертание.</li><li>Шрифт должен содержать кириллицу и цифры.</li><li>Загружайте только шрифты, которые разрешено использовать в рекламе.</li></ul></div></div></div>`}
  function renderInspector(){const box=properties.querySelector('.le-inspector'),layer=activeCustom();if(selected==='background'){box.innerHTML=`<label class="le-field">Цвет основы<input id="le-bg-color" type="color" value="${layerState.value}"></label><label class="le-field">Непрозрачность<input id="le-bg-opacity" type="range" min="0" max="100" value="${opacityState.value}"><span>${opacityState.value}%</span></label><p class="le-hint">Цвет основы виден через прозрачные участки загруженной подложки. 100% создаёт сплошной фон.</p>`}else if(layer){box.innerHTML=`<label class="le-field">Имя слоя<input data-prop="name" value="${escapeAttr(layer.name)}"></label>${layer.type==='text'?`<label class="le-field">Текст<textarea data-prop="text" rows="3" maxlength="300">${escapeText(layer.text)}</textarea></label><div class="le-token-fields"><button type="button" data-custom-token="price">+ Цена</button><button type="button" data-custom-token="area">+ Площадь</button><button type="button" data-custom-token="rooms">+ Комнаты</button><button type="button" data-custom-token="complex">+ Проект</button></div>${fontControls(layer.fontFamily||'Circe',true)}<label class="le-field">Цвет текста<input data-prop="color" type="color" value="${layer.color||'#11151a'}"></label><label class="le-field">Кегль<input data-prop="fontSize" type="number" min="10" max="180" value="${layer.fontSize||36}"></label>`:`<label class="le-field">Заливка<input data-prop="fill" type="color" value="${layer.fill||'#d5ff19'}"></label>`}<div class="le-property-grid"><label class="le-field">X, %<input data-prop="x" type="number" min="0" max="100" value="${layer.x}"></label><label class="le-field">Y, %<input data-prop="y" type="number" min="0" max="100" value="${layer.y}"></label><label class="le-field">Ширина, %<input data-prop="width" type="number" min="1" max="100" value="${layer.width}"></label><label class="le-field">Высота, %<input data-prop="height" type="number" min="1" max="100" value="${layer.height}"></label></div><label class="le-field">Непрозрачность<input data-prop="opacity" type="range" min="0" max="100" value="${layer.opacity}"><span>${layer.opacity}%</span></label>`}else if(selected==='text'){box.innerHTML=`${fontControls(fontState.value)}<p class="le-hint">Данные объявления подставляются автоматически. Добавьте отдельный текстовый слой кнопкой «＋ Текст», чтобы свободно оформлять макет.</p>`}else{box.innerHTML=`<p class="le-hint">Перемещайте планировку на холсте. Размер, точное смещение и загрузка подложки находятся в свойствах слоя выше.</p>`}}
  function choose(layer) {
    selected=layer;
    selectedCustomId='';
    properties.querySelectorAll('[data-layer]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.layer===layer)));
    document.querySelector('#le-property-title').textContent = {background:'Основа',layout:'Планировка',text:'Текст объявления'}[layer];
    controls.hidden = layer==='text'; textControls.hidden=layer!=='text';
    [...controls.children].forEach(el=>{el.hidden = el===fileControl ? layer!=='background' : layer!=='layout';});
    if(layer==='background'){const file=fileControl;file.hidden=false;}
    renderInspector();selectionBox();renderLayerTree();
  }
  function chooseCustom(id){selected='custom';selectedCustomId=id;properties.querySelectorAll('[data-layer]').forEach(b=>b.setAttribute('aria-pressed','false'));controls.hidden=true;textControls.hidden=true;document.querySelector('#le-property-title').textContent=activeCustom()?.name||'Элемент';renderInspector();renderLayerTree();selectionBox();}
  function bounds() {
    if(selected==='custom'){const layer=activeCustom();return layer?{x:canvas.width*Number(layer.x||0)/100,y:canvas.height*Number(layer.y||0)/100,width:canvas.width*Number(layer.width||30)/100,height:canvas.height*Number(layer.height||12)/100}:null;}
    if (!brandPreviewImages) return selected==='background'?{x:0,y:0,width:canvas.width,height:canvas.height}:null;
    if(selected==='background')return {x:0,y:0,width:canvas.width,height:canvas.height};
    if(selected==='layout'){
      // drawBrandPreviewFrame stores the exact placement used to render the
      // plan. Reuse it for hit testing instead of reconstructing an approximate
      // rectangle, so dragging and the visible resize handle always agree.
      if(brandPreviewPlacement)return {...brandPreviewPlacement};
      if(brandPreviewImages.baseImage&&brandPreviewImages.badgeImage)return brandedLayoutPlacement(brandPreviewImages.baseImage,brandPreviewImages.badgeImage);
      const image=brandPreviewImages.baseImage;if(!image)return{x:0,y:0,width:canvas.width,height:canvas.height};
      const source=visibleImageBounds(image),size=Math.max(20,Math.min(95,Number(brandConfig().widthPercent)||78))/100,ratio=Math.min(canvas.width*size/source.sw,canvas.height*size/source.sh);
      return{x:(canvas.width-source.sw*ratio)/2+canvas.width*brandConfig().offsetXPercent/100,y:(canvas.height-source.sh*ratio)/2+canvas.height*brandConfig().offsetYPercent/100,width:source.sw*ratio,height:source.sh*ratio};
    }
    const c=brandConfig(); return {x:canvas.width*c.textXPercent/100,y:canvas.height*c.textYPercent/100,width:Math.max(40,canvas.width*(1-c.textXPercent/50)),height:c.textSize*(c.subline?1.9:1)};
  }
  function selectionBox() {
    // Kept as a small compatibility hook for resize/zoom observers. The only
    // selection frame is painted inside the canvas, next to the real image.
    return bounds();
  }
  properties.addEventListener('click', e=> {const b=e.target.closest('[data-layer]');if(b){choose(b.dataset.layer);return}const custom=e.target.closest('[data-select-custom]');if(custom){chooseCustom(custom.dataset.selectCustom);return}const del=e.target.closest('[data-layer-delete]');if(del){baseline=snapshot();writeLayers(readLayers().filter(layer=>layer.id!==del.dataset.layerDelete));selectedCustomId='';choose('layout');redraw();commit();return}const direction=e.target.closest('[data-layer-up],[data-layer-down]');if(direction){baseline=snapshot();const layers=readLayers(),i=layers.findIndex(layer=>layer.id===(direction.dataset.layerUp||direction.dataset.layerDown)),j=i+(direction.dataset.layerUp?1:-1);if(i>=0&&j>=0&&j<layers.length){[layers[i],layers[j]]=[layers[j],layers[i]];writeLayers(layers);renderLayerTree();redraw();commit();}}});
  properties.addEventListener('focusin',()=>{if(!drag)baseline=snapshot()});
  properties.addEventListener('input',e=>{if(e.target.id==='le-bg-color'){layerState.value=e.target.value;redraw()}else if(e.target.id==='le-bg-opacity'){opacityState.value=e.target.value;e.target.nextElementSibling.textContent=`${e.target.value}%`;redraw()}else{const field=e.target.closest('[data-prop]'),layer=activeCustom();if(!field||!layer)return;const prop=field.dataset.prop;let value=['x','y','width','height','fontSize','opacity'].includes(prop)?Number(field.value):field.value;const limits={x:[0,100],y:[0,100],width:[1,100],height:[1,100],fontSize:[10,180],opacity:[0,100]};if(limits[prop])value=Math.max(limits[prop][0],Math.min(limits[prop][1],Number.isFinite(value)?value:limits[prop][0]));const layers=readLayers().map(item=>item.id===layer.id?{...item,[prop]:value}:item);writeLayers(layers);document.querySelector('#le-property-title').textContent=layers.find(item=>item.id===layer.id)?.name||'Элемент';if(prop==='name')renderLayerTree();if(prop==='opacity'&&field.nextElementSibling)field.nextElementSibling.textContent=`${field.value}%`;redraw()}clearTimeout(saveTimer);saveTimer=setTimeout(()=>{persistActiveBrandProfile();toolbar.querySelector('.le-save-state').textContent='Черновик сохранён'},350)});
  properties.addEventListener('change',e=>{if(e.target.matches('[data-prop],#le-bg-color,#le-bg-opacity'))commit();});
  properties.addEventListener('change',e=>{if(e.target.id!=='le-base-font')return;baseline=snapshot();fontState.value=e.target.value;redraw();commit();});
  properties.addEventListener('click',e=>{const token=e.target.closest('[data-custom-token]'),layer=activeCustom();if(!token||!layer||layer.type!=='text')return;const textarea=properties.querySelector('[data-prop="text"]'),value=`{{${token.dataset.customToken}}}`;const start=textarea.selectionStart??textarea.value.length,end=textarea.selectionEnd??start;textarea.setRangeText(value,start,end,'end');textarea.dispatchEvent(new Event('input',{bubbles:true}));textarea.focus()});
  properties.addEventListener('click',e=>{const button=e.target.closest('[data-upload-font]');if(button)button.parentElement.querySelector('.le-font-file')?.click()});
  properties.addEventListener('change',async e=>{
    if(!e.target.matches('.le-font-file'))return;
    const file=e.target.files?.[0];if(!file)return;
    if(file.size>3*1024*1024){showToast('Файл шрифта должен быть не больше 3 МБ');e.target.value='';return}
    const extension=file.name.split('.').pop()?.toLowerCase();
    if(!['woff2','woff','ttf','otf'].includes(extension)){showToast('Поддерживаются WOFF2, WOFF, TTF и OTF');e.target.value='';return}
    const name=cleanFontName(file.name.replace(/\.(woff2?|ttf|otf)$/i,''));
    try{
      const dataUrl=await fileToDataUrl(file),font={name,dataUrl,fileName:file.name};
      await registerProjectFont(font);
      projectFonts=[...projectFonts.filter(item=>item.name!==name),font];
      await writeProjectFonts(projectFonts);
      if(activeCustom()){writeLayers(readLayers().map(layer=>layer.id===selectedCustomId?{...layer,fontFamily:name}:layer))}else fontState.value=name;
      renderInspector();redraw();commit();showToast(`Шрифт «${name}» добавлен в проект`);
    }catch(error){showToast(error.message||'Не удалось открыть файл шрифта')}
    e.target.value='';
  });
  ids.forEach(id=>{const el=document.getElementById(id); el.addEventListener('focus',()=>{if(!drag)baseline=snapshot();});el.addEventListener('input',()=>{selectionBox();if(id==='templateCanvasColor'||id==='templateCanvasOpacity')redraw();});el.addEventListener('change',commit);});
  ['templateHeadline','templateSubline'].forEach(id=>document.getElementById(id).addEventListener('focus',e=>textTarget=e.target));
  fields.addEventListener('click',e=>{ const b=e.target.closest('[data-token]'); if(!b)return; baseline=snapshot(); const token='{{'+b.dataset.token+'}}'+(b.dataset.token==='area'?' м²':''); const start=textTarget.selectionStart??textTarget.value.length, end=textTarget.selectionEnd??start; textTarget.setRangeText(token,start,end,'end'); textTarget.dispatchEvent(new Event('input')); commit(); textTarget.focus(); });
  document.querySelector('#le-undo').onclick=()=>travel(history,future);
  document.querySelector('#le-redo').onclick=()=>travel(future,history);
  document.querySelector('#le-preview').onclick=()=>brandPreviewImages?openBrandPreviewDialog():showToast('Добавьте планировку или графическую подложку для предпросмотра');
  removeBackdrop.addEventListener('click',async()=>{if(!brandBadgeDataUrl)return;try{await deleteBrandAsset(activeBrandProjectKey);brandBadgeDataUrl='';brandBadgeFileName='';document.querySelector('#brandBadgeFileInput').value='';document.querySelector('#brandBadgePickedFile').textContent='Подложка удалена';await persistActiveBrandProfile();await renderBrandPreview();showToast('Подложка удалена')}catch(error){brandStatus(`Не удалось удалить подложку: ${error.message}`)}});
  toolbar.addEventListener('click',e=>{const add=e.target.closest('[data-add-layer]');if(add){if(readLayers().length>=40){showToast('Достигнут предел: 40 дополнительных слоёв');return}baseline=snapshot();const type=add.dataset.addLayer,id=`layer-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,layers=readLayers();layers.push({id,type,name:type==='text'?`Текст ${layers.filter(x=>x.type==='text').length+1}`:`Фигура ${layers.filter(x=>x.type==='rect').length+1}`,text:'Новый текст',x:type==='text'?12:8,y:type==='text'?72:10,width:type==='text'?55:34,height:type==='text'?14:18,fontSize:36,color:'#11151a',fill:'#d5ff19',opacity:100,weight:700});writeLayers(layers);chooseCustom(id);redraw();commit();properties.querySelector('[data-prop="text"]')?.focus();return}if(e.target.closest('#le-zoom-in'))setZoom(zoom+.1);if(e.target.closest('#le-zoom-out'))setZoom(zoom-.1);if(e.target.closest('#le-fit'))fitCanvas();if(e.target.closest('#le-grid')){grid.hidden=!grid.hidden;e.target.closest('#le-grid').setAttribute('aria-pressed',String(!grid.hidden));stage.classList.toggle('show-grid',!grid.hidden)}if(e.target.closest('#le-export')){redraw();canvas.toBlob(blob=>{if(!blob)return;const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`listingflow-layout-${new Date().toISOString().slice(0,10)}.png`;a.click();URL.revokeObjectURL(a.href)},'image/png')}});
  function setZoom(value){zoom=Math.max(.25,Math.min(2,Math.round(value*100)/100));canvas.style.maxWidth='none';canvas.style.maxHeight='none';canvas.style.width=`${Math.round(canvas.width*zoom)}px`;canvas.style.height='auto';toolbar.querySelector('.le-zoom-value').textContent=`${Math.round(zoom*100)}%`;selectionBox()}
  function fitCanvas(){const available=Math.max(280,stage.clientWidth-32);setZoom(Math.min(1,available/canvas.width,480/canvas.height))}
  document.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.target.matches('input,textarea,select,button')){spaceHeld=true;e.preventDefault()}});
  document.addEventListener('keyup',e=>{if(e.code==='Space')spaceHeld=false});
  stage.addEventListener('pointerdown',e=>{if(e.button!==1&&!(spaceHeld&&e.button===0))return;pan={x:e.clientX,y:e.clientY,left:stage.scrollLeft,top:stage.scrollTop,pointer:e.pointerId};stage.setPointerCapture(e.pointerId);stage.classList.add('panning');e.preventDefault();e.stopPropagation()},true);
  stage.addEventListener('pointermove',e=>{if(!pan||pan.pointer!==e.pointerId)return;stage.scrollLeft=pan.left-(e.clientX-pan.x);stage.scrollTop=pan.top-(e.clientY-pan.y)});
  const endPan=e=>{if(!pan||pan.pointer!==e.pointerId)return;pan=null;stage.classList.remove('panning')};stage.addEventListener('pointerup',endPan);stage.addEventListener('pointercancel',endPan);
  toolbar.insertAdjacentHTML('beforeend','<button type="button" id="le-export">Экспорт PNG</button>');
  document.querySelector('#centerBrandLayoutBtn').addEventListener('click',()=>{document.querySelector('#brandOffsetX').value=0;document.querySelector('#brandOffsetY').value=0;drawBrandPreviewFrame();commit();});
  document.querySelector('#centerBrandLayoutBtn').textContent='По центру холста';
  // Replace the old whole-canvas drag with element hit testing and resize handles.
  canvas.removeEventListener('pointerdown',startBrandPreviewDrag);
  canvas.removeEventListener('pointermove',moveBrandPreviewDrag);
  canvas.removeEventListener('pointerup',endBrandPreviewDrag);
  canvas.removeEventListener('pointercancel',endBrandPreviewDrag);
  canvas.addEventListener('pointerdown',e=>{
    const r=canvas.getBoundingClientRect(), x=(e.clientX-r.left)*canvas.width/r.width,y=(e.clientY-r.top)*canvas.height/r.height;
    const layers=readLayers();let hit=null;for(let i=layers.length-1;i>=0;i--){const l=layers[i],lx=canvas.width*Number(l.x||0)/100,ly=canvas.height*Number(l.y||0)/100,lw=canvas.width*Number(l.width||30)/100,lh=canvas.height*Number(l.height||12)/100;if(x>=lx&&x<=lx+lw&&y>=ly&&y<=ly+lh){hit=l;break}}
    if(hit)chooseCustom(hit.id);else{
      const config=brandConfig(),textX=canvas.width*config.textXPercent/100,textY=canvas.height*config.textYPercent/100;
      const textWidth=Math.max(40,canvas.width*(1-config.textXPercent/50)),textHeight=config.textSize*(config.subline?1.9:1);
      if((config.headline||config.subline)&&x>=textX&&x<=textX+textWidth&&y>=textY&&y<=textY+textHeight)choose('text');else choose('layout');
    }
    if(selected==='background')return;
    const b=bounds();if(!b)return;
    const resize=Math.hypot((x-b.x-b.width)*r.width/canvas.width,(y-b.y-b.height)*r.height/canvas.height)<20;
    baseline=snapshot();drag={x:e.clientX,y:e.clientY,config:brandConfig(),resize,layer:activeCustom()?{...activeCustom()}:null};canvas.setPointerCapture(e.pointerId);canvas.focus();e.preventDefault();
  });
  canvas.addEventListener('pointermove',e=>{
    if(!drag)return;const r=canvas.getBoundingClientRect(),dx=(e.clientX-drag.x)/r.width*100,dy=(e.clientY-drag.y)/r.height*100,c=drag.config;
    const set=(id,v,min,max)=>document.getElementById(id).value=Math.round(Math.max(min,Math.min(max,v)));
    if(drag.layer){const start=drag.layer,layers=readLayers().map(layer=>layer.id===start.id?drag.resize?{...layer,width:Math.max(5,Math.min(100,start.width+dx)),height:Math.max(5,Math.min(100,start.height+dy))}:{...layer,x:Math.max(0,Math.min(100-start.width,start.x+dx)),y:Math.max(0,Math.min(100-start.height,start.y+dy))}:layer);writeLayers(layers);renderInspector();}
    else if(drag.resize){if(selected==='layout')set('brandSize',c.widthPercent+dx,20,95);else set('templateTextSize',c.textSize+dy*2,16,120);}
    else if(selected==='text'){set('templateTextX',c.textXPercent+dx,0,95);set('templateTextY',c.textYPercent+dy,0,95);}
    else setBrandOffsets(c.offsetXPercent+dx,c.offsetYPercent+dy);
    redraw();selectionBox();
  });
  function finish(){if(!drag)return;drag=null;commit();}
  canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',finish);
  panel.addEventListener('keydown',e=>{
    if(e.target.matches('input,textarea,select'))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?travel(future,history):travel(history,future);return;}
    if(e.target!==canvas||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;
    e.preventDefault();baseline=snapshot();const c=brandConfig(),step=e.shiftKey?1:.1,dx=e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0,dy=e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0;
    if(selected==='custom'){writeLayers(readLayers().map(layer=>layer.id===selectedCustomId?{...layer,x:Math.max(0,Math.min(100-layer.width,layer.x+dx)),y:Math.max(0,Math.min(100-layer.height,layer.y+dy))}:layer));renderInspector()}else if(selected==='text'){document.querySelector('#templateTextX').value=Math.max(0,Math.min(95,c.textXPercent+dx));document.querySelector('#templateTextY').value=Math.max(0,Math.min(95,c.textYPercent+dy));}else setBrandOffsets(c.offsetXPercent+dx*10,c.offsetYPercent+dy*10);
    redraw();commit();
  });
  new ResizeObserver(selectionBox).observe(canvas);
  new MutationObserver(()=>{
    if(projectKey!==activeBrandProjectKey){projectKey=activeBrandProjectKey;history.length=0;future.length=0;selectedCustomId='';selected='layout';baseline=snapshot();buttons();renderLayerTree();renderInspector();hydrateProjectFonts();if(zoom<=1)requestAnimationFrame(fitCanvas);}
    selectionBox();
  }).observe(canvas,{attributes:true,attributeFilter:['width','height']});
  choose('layout');renderLayerTree();hydrateProjectFonts();redraw();requestAnimationFrame(fitCanvas);new ResizeObserver(()=>{if(zoom<1)fitCanvas()}).observe(stage);
})();
