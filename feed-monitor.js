const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { XMLValidator } = require('fast-xml-parser');

function publicAddress(address) {
  if(net.isIP(address)!==4)return false;
  const [a,b]=address.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || (a===100&&b>=64&&b<=127) || (a===198&&(b===18||b===19)));
}
async function download(url, redirects=0) {
  const target=new URL(url);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw Error('Нужна HTTP(S)-ссылка без логина и пароля');
  const addresses=await dns.lookup(target.hostname,{all:true,family:4});
  const localOrigin=process.env.PUBLIC_BASE_URL;
  const ownLocal=localOrigin && target.origin===new URL(localOrigin).origin && ['localhost','127.0.0.1'].includes(target.hostname);
  if(!addresses.length||(!ownLocal&&addresses.some(a=>!publicAddress(a.address))))throw Error('Адрес внутренней сети недоступен для мониторинга');
  return new Promise((resolve,reject)=>{
    const request=(target.protocol==='https:'?https:http).get(target, {lookup:(_host,options,callback)=>options.all?callback(null,[addresses[0]]):callback(null,addresses[0].address,4)}, response=>{
      if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){response.resume();if(redirects>=3)return reject(Error('Слишком много перенаправлений'));resolve(download(new URL(response.headers.location,target).href,redirects+1));return;}
      if(response.statusCode!==200){response.resume();reject(Error(`HTTP ${response.statusCode}`));return;}
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>20*1024*1024)request.destroy(Error('Фид превышает 20 МБ'));else chunks.push(chunk);});
      response.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));response.on('error',reject);
    });
    const deadline=setTimeout(()=>request.destroy(Error('Источник не ответил за 20 секунд')),20000);
    request.on('close',()=>clearTimeout(deadline));request.on('error',reject);
  });
}
function createMonitor({file,notify=async()=>{},load=download,intervalMs=3600000}) {
  let busy=false;
  const read=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const write=data=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(data));fs.renameSync(file+'.tmp',file);};
  function replace(project,feeds){
    if(!Array.isArray(feeds)||feeds.length>80)throw Error('Допускается до 80 фидов');
    const data=read(),old=data[project]||[];
    data[project]=feeds.map(f=>{
      const url=new URL(String(f.url));if(!['http:','https:'].includes(url.protocol))throw Error('Нужна HTTP(S)-ссылка');
      const previous=old.find(o=>o.id===f.id&&o.url===url.href);
      return {...previous,id:String(f.id).slice(0,150),url:url.href,name:String(f.name||'Фид').slice(0,200),platform:String(f.platform||''),telegramEnabled:f.telegramEnabled===true,status:previous?.status||'pending'};
    });write(data);return data[project];
  }
  async function run(project=null,id=null,force=false){
    if(busy)throw Error('Проверка уже выполняется');busy=true;
    try{
      const data=read();
      for(const [key,feeds] of Object.entries(data)){
        if(project!==null&&key!==project)continue;
        for(const feed of feeds){
          if(id&&feed.id!==id)continue;
          if(!force&&Date.now()-Date.parse(feed.lastChecked||0)<intervalMs)continue;
          const checked={...feed,lastChecked:new Date().toISOString(),status:'ok',error:''};
          try{const xml=await load(feed.url);const result=XMLValidator.validate(xml);if(result!==true||!xml.trim().startsWith('<')||/<html[\s>]/i.test(xml))throw Error('Ответ не является корректным XML-фидом');}
          catch(error){checked.status='bad';checked.error=error.message;}
          const latest=read(),record=latest[key]?.find(f=>f.id===feed.id&&f.url===feed.url);if(!record)continue;
          if(checked.status==='bad'&&record.telegramEnabled&&(record.status!=='bad'||record.error!==checked.error)){
            try{await notify(checked);checked.telegramNotifiedAt=new Date().toISOString();checked.notificationError='';}catch(error){checked.notificationError=error.message;}
          }
          Object.assign(record,{status:checked.status,error:checked.error,lastChecked:checked.lastChecked,telegramNotifiedAt:checked.telegramNotifiedAt,notificationError:checked.notificationError});write(latest);
        }
      }
    }finally{busy=false;}
  }
  return {read,replace,run};
}
module.exports={createMonitor,publicAddress};
