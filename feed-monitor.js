const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });
const imageUrls = value => {
  const found = [];
  const visit = (node, key = '') => {
    if (Array.isArray(node)) return node.forEach(item => visit(item, key));
    if (!node || typeof node !== 'object') {
      if (/image|photo|картин|изображ/i.test(key)) {
        const match = String(node || '').match(/https?:\/\/[^\s<>"']+/i);
        if (match) found.push(match[0]);
      }
      return;
    }
    for (const [childKey, child] of Object.entries(node)) visit(child, `${key}.${childKey}`);
  };
  visit(value);
  return [...new Set(found)].slice(0, 3);
};
function listingCount(parsed) {
  const values = [parsed?.Ads?.Ad, parsed?.['realty-feed']?.offer, parsed?.feed?.object, parsed?.DomclickFeed?.Offer, parsed?.Feed?.Offer];
  const listing = values.find(value => value !== undefined);
  return listing === undefined ? 0 : Array.isArray(listing) ? listing.length : 1;
}

function validateContent(xml, parsed=null) {
  parsed ||= new XMLParser({ignoreAttributes:false,trimValues:true}).parse(xml);
  const ads=parsed?.Ads?.Ad;
  if(ads){
    const items=Array.isArray(ads)?ads:[ads];
    const missing=items.filter(item=>!String(item?.Description||'').trim()).length;
    if(missing)throw Error(`Авито: не заполнено поле Description у ${missing} объектов`);
  }
  const offers=parsed?.['realty-feed']?.offer;
  if(offers){
    const items=Array.isArray(offers)?offers:[offers];
    const missing=items.filter(item=>!String(item?.description||'').trim()).length;
    if(missing)throw Error(`Яндекс: не заполнено поле description у ${missing} объектов`);
  }
}

function publicAddress(address) {
  if(net.isIP(address)!==4)return false;
  const [a,b]=address.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || (a===100&&b>=64&&b<=127) || (a===198&&(b===18||b===19)));
}
async function downloadResource(url, { redirects=0, maxBytes=20*1024*1024, binary=false, timeoutMs=20000 }={}) {
  const target=new URL(url);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw Error('Нужна HTTP(S)-ссылка без логина и пароля');
  const addresses=await dns.lookup(target.hostname,{all:true,family:4});
  const localOrigin=process.env.PUBLIC_BASE_URL;
  const ownLocal=localOrigin && target.origin===new URL(localOrigin).origin && ['localhost','127.0.0.1'].includes(target.hostname);
  if(!addresses.length||(!ownLocal&&addresses.some(a=>!publicAddress(a.address))))throw Error('Адрес внутренней сети недоступен для мониторинга');
  return new Promise((resolve,reject)=>{
    const request=(target.protocol==='https:'?https:http).get(target, {agent: target.protocol === 'https:' ? httpsAgent : httpAgent, lookup:(_host,options,callback)=>options.all?callback(null,[addresses[0]]):callback(null,addresses[0].address,4)}, response=>{
      if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){response.resume();if(redirects>=3)return reject(Error('Слишком много перенаправлений'));resolve(downloadResource(new URL(response.headers.location,target).href,{redirects:redirects+1,maxBytes,binary,timeoutMs}));return;}
      if(response.statusCode!==200){response.resume();reject(Error(`HTTP ${response.statusCode}`));return;}
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)request.destroy(Error('Удалённый файл превышает допустимый размер'));else chunks.push(chunk);});
      response.on('end',()=>{const body=Buffer.concat(chunks);resolve(binary?{body,contentType:String(response.headers['content-type']||'')}:body.toString('utf8'));});response.on('error',reject);
    });
    const deadline=setTimeout(()=>request.destroy(Error(`Источник не ответил за ${Math.round(timeoutMs/1000)} секунд`)),timeoutMs);
    request.on('close',()=>clearTimeout(deadline));request.on('error',reject);
  });
}
// XML-фиды застройщиков могут быть десятки мегабайт. Держим лимит выше,
// но оставляем отдельный небольшой лимит для изображений через downloadBuffer.
const download=url=>downloadResource(url,{maxBytes:100*1024*1024,timeoutMs:120000});
const downloadBuffer=(url,maxBytes)=>downloadResource(url,{maxBytes,binary:true});
function createMonitor({file,notify=async()=>{},load=download,loadImage=downloadBuffer,intervalMs=3600000}) {
  let busy=false;
  // The monitor state is read by every API request and by the scheduler. Keep a
  // small mtime-aware cache so repeated reads do not parse the same JSON over
  // and over again, while still picking up changes made by another process.
  let cachedData=null;
  let cachedStamp='';
  const stamp=()=>{try{const stat=fs.statSync(file);return `${stat.mtimeMs}:${stat.size}`;}catch{return 'missing';}};
  const read=()=>{
    const currentStamp=stamp();
    if(cachedData&&cachedStamp===currentStamp)return cachedData;
    if(currentStamp==='missing'){cachedData={};cachedStamp=currentStamp;return cachedData;}
    try{cachedData=JSON.parse(fs.readFileSync(file,'utf8'));}
    catch{cachedData={};}
    cachedStamp=currentStamp;
    return cachedData;
  };
  const write=data=>{
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temporary=`${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(data),{mode:0o600});
    fs.renameSync(temporary,file);
    try{fs.chmodSync(file,0o600);}catch{}
    cachedData=data;
    cachedStamp=stamp();
  };
  function replace(project,feeds,{maxFeeds=80}={}){
    const limit=Number(maxFeeds)===-1?Infinity:Math.max(1,Number(maxFeeds)||80);
    if(!Array.isArray(feeds)||feeds.length>limit)throw Error(`Допускается до ${limit} фидов`);
    const data=read(),old=data[project]||[];
    data[project]=feeds.map(f=>{
      const url=new URL(String(f.url));if(!['http:','https:'].includes(url.protocol))throw Error('Нужна HTTP(S)-ссылка');
      const previous=old.find(o=>o.id===f.id&&o.url===url.href);
      return {...previous,id:String(f.id).slice(0,150),url:url.href,name:String(f.name||'Фид').slice(0,200),projectName:String(f.projectName||'Проект без названия').slice(0,200),platform:String(f.platform||''),telegramEnabled:f.telegramEnabled!==false,telegramChatId:String(f.telegramChatId||'').trim().slice(0,100),emailEnabled:false,emailTo:'',status:previous?.status||'pending'};
    });write(data);return data[project];
  }
  async function run(project=null,id=null,force=false){
    if(busy)throw Error('Проверка уже выполняется');busy=true;
    let changedChecks=false;
    try{
      const data=read();
      for(const [key,feeds] of Object.entries(data)){
        if(project!==null&&key!==project)continue;
        for(const feed of feeds){
          if(id&&feed.id!==id)continue;
          if(!force&&Date.now()-Date.parse(feed.lastChecked||0)<intervalMs)continue;
          const checked={...feed,lastChecked:new Date().toISOString(),status:'ok',error:'',warnings:[]};
          try{
            const xml=await load(feed.url);const result=XMLValidator.validate(xml);if(result!==true||!xml.trim().startsWith('<')||/<html[\s>]/i.test(xml))throw Error('Ответ не является корректным XML-фидом');
            // Parse once per feed. Validation and object counting previously
            // performed two full XML parses, which was noticeable for large
            // source feeds.
            const parsed=new XMLParser({ignoreAttributes:false,trimValues:true}).parse(xml);validateContent(xml,parsed);const count=listingCount(parsed);
            checked.objectCount=count;checked.baselineObjectCount=Number(feed.baselineObjectCount||count);
            if(feed.baselineObjectCount&&count>0&&count<Number(feed.baselineObjectCount)*0.5)checked.warnings.push(`Количество объявлений снизилось с ${feed.baselineObjectCount} до ${count}`);
            const urls=imageUrls(parsed);const failed=[];
            await Promise.all(urls.map(async url=>{try{const image=await loadImage(url,5*1024*1024);if(!String(image.contentType||'').toLowerCase().startsWith('image/'))failed.push(url);}catch{failed.push(url);}}));
            if(failed.length)checked.warnings.push(`Не удалось проверить изображения: ${failed.length} из ${urls.length}`);
            checked.status=checked.warnings.length?'warning':'ok';checked.lastSuccessAt=checked.lastChecked;
          }
          catch(error){checked.status='bad';checked.error=error.message;}
          const record=data[key]?.find(f=>f.id===feed.id&&f.url===feed.url);if(!record)continue;
          const changed=checked.status!==record.status||checked.error!==record.error||JSON.stringify(checked.warnings)!==JSON.stringify(record.warnings||[]);
          if(checked.status!=='ok'&&record.telegramEnabled&&changed){
            try{
              const notification=await notify({...checked,...record,status:checked.status,error:checked.error,projectId:key});
              if(notification?.telegramSent)checked.telegramNotifiedAt=new Date().toISOString();
              checked.notificationError=notification?.errors?.join(' ')||'';
            }catch(error){checked.notificationError=error.message;}
          }
          Object.assign(record,{status:checked.status,error:checked.error,warnings:checked.warnings,objectCount:checked.objectCount||record.objectCount,baselineObjectCount:checked.baselineObjectCount||record.baselineObjectCount,lastSuccessAt:checked.lastSuccessAt||record.lastSuccessAt,lastChecked:checked.lastChecked,telegramNotifiedAt:checked.telegramNotifiedAt,notificationError:checked.notificationError,emailEnabled:false,emailTo:''});
          changedChecks=true;
        }
      }
      // Persist all checks in one atomic write instead of parsing and rewriting
      // the JSON state after every feed.
      // Avoid touching mtime when every feed is still inside its interval;
      // scheduled ticks happen every minute and should remain read-only in
      // that common case.
      if(changedChecks)write(data);
    }finally{busy=false;}
  }
  return {read,replace,run};
}
module.exports={createMonitor,publicAddress,validateContent,download,downloadBuffer};
