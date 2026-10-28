const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

function validateContent(xml) {
  const parsed=new XMLParser({ignoreAttributes:false,trimValues:true}).parse(xml);
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

function adBlocks(xml) {
  return String(xml || "").match(/<Ad\b[^>]*>[\s\S]*?<\/Ad>/gi) || [];
}

function adId(ad) {
  return ad.match(/<Id\b[^>]*>([^<]+)<\/Id>/i)?.[1]?.trim() || "";
}

function xmlTagValue(ad, tag) {
  const value = ad.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1]?.trim() || "";
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function imagesBlock(ad) {
  return ad.match(/<Images\b[^>]*>[\s\S]*?<\/Images>/i)?.[0] || "";
}

function escapeXmlText(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const manualFieldTags = {
  description: "Description",
  address: "Address",
  phone: "ContactPhone",
  price: "Price",
  latitude: "Latitude",
  longitude: "Longitude",
  balconyOrLoggia: "BalconyOrLoggiaMulti",
  houseType: "HouseType",
  floor: "Floor",
  floorsCount: "Floors",
  rooms: "Rooms",
  totalArea: "Square",
  livingArea: "LivingSpace",
  kitchenArea: "KitchenSpace",
  flatNumber: "ApartmentNumber",
  isApartments: "Status",
  bathroomType: "BathroomMulti",
  ceilingHeight: "CeilingHeight",
  avitoNewDevelopmentId: "NewDevelopmentId",
  avitoBuildingName: "DevelopmentsBuildingName",
  decoration: "Decoration"
};

function normalizeManualValue(field, value) {
  const text = String(value ?? "").trim();
  if (field === "phone") {
    const digits = text.replace(/\D/g, "").replace(/^8(?=\d{10}$)/, "7");
    return digits ? `+${digits.length === 10 ? `7${digits}` : digits}` : "";
  }
  if (field === "isApartments") return text.toLowerCase() === "true" ? "Апартаменты" : "Квартира";
  if (field === "decoration") {
    return ({
      rough: "Черновая", preFine: "Предчистовая", fine: "Чистовая", without: "Без отделки",
      repair: "Ремонт", repairBeige: "Ремонт бежевый", repairGray: "Ремонт серый"
    })[text] || text;
  }
  return text;
}

function multiValueXml(tag, value) {
  const options = String(value || "").split(",").map(item => item.trim()).filter(Boolean);
  if (!options.length) return "";
  return `<${tag}>\n${options.map(option => `      <Option>${escapeXmlText(option)}</Option>`).join("\n")}\n    </${tag}>`;
}

function replaceXmlElement(xml, tag, value) {
  const pattern = new RegExp(`(<${tag}\\b[^>]*>)[\\s\\S]*?(</${tag}>)`, "i");
  const escaped = escapeXmlText(value);
  if (pattern.test(xml)) {
    return value === "" ? xml.replace(pattern, "") : xml.replace(pattern, `$1${escaped}$2`);
  }
  if (value === "") return xml;
  return xml.replace(/<\/Ad>\s*$/i, `\n    <${tag}>${escaped}</${tag}>\n  </Ad>`);
}

function applyManualOverrides(ad, overrides = {}) {
  let result = ad;
  for (const [field, rawValue] of Object.entries(overrides || {})) {
    const normalizedField = field === "HouseType" ? "houseType" : field;
    const tag = manualFieldTags[normalizedField];
    if (!tag || rawValue === null || rawValue === undefined) continue;
    const value = normalizeManualValue(normalizedField, rawValue);
    if (["balconyOrLoggia", "bathroomType"].includes(normalizedField)) {
      const block = multiValueXml(tag, value);
      const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "i");
      result = block ? (pattern.test(result) ? result.replace(pattern, block) : result.replace(/<\/Ad>\s*$/i, `\n    ${block}\n  </Ad>`)) : result.replace(pattern, "");
      continue;
    }
    result = replaceXmlElement(result, tag, value);
  }
  return result;
}

function mergeFeedXml(sourceXml, currentXml, manualOverrides = {}) {
  const currentAds = new Map();
  const currentImages = new Map();
  for (const ad of adBlocks(currentXml)) {
    const id = adId(ad);
    const images = imagesBlock(ad);
    if (id) currentAds.set(id, ad);
    if (id && images) currentImages.set(id, images);
  }

  let matched = 0;
  const xml = String(sourceXml || "").replace(/<Ad\b[^>]*>[\s\S]*?<\/Ad>/gi, ad => {
    const id = adId(ad);
    const images = currentImages.get(id);
    let result = ad;
    if (images && imagesBlock(ad)) {
      matched += 1;
      result = result.replace(/<Images\b[^>]*>[\s\S]*?<\/Images>/i, images);
    }
    const explicitOverride = manualOverrides?.[id];
    const currentAd = currentAds.get(id);
    const currentHouseType = currentAd ? xmlTagValue(currentAd, "HouseType") : "";
    const sourceHouseType = xmlTagValue(ad, "HouseType");
    const inferredOverride = !explicitOverride && currentHouseType && currentHouseType !== sourceHouseType
      ? { HouseType: currentHouseType }
      : explicitOverride;
    return applyManualOverrides(result, inferredOverride);
  });
  return { xml, matched, sourceObjects: adBlocks(sourceXml).length };
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
      return {...previous,id:String(f.id).slice(0,150),url:url.href,name:String(f.name||'Фид').slice(0,200),projectName:String(f.projectName||'Проект без названия').slice(0,200),platform:String(f.platform||''),telegramEnabled:f.telegramEnabled===true,telegramChatId:String(f.telegramChatId||'').trim().slice(0,100),emailEnabled:f.emailEnabled===true,emailTo:String(f.emailTo||'').trim().slice(0,320),status:previous?.status||'pending'};
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
          try{const xml=await load(feed.url);const result=XMLValidator.validate(xml);if(result!==true||!xml.trim().startsWith('<')||/<html[\s>]/i.test(xml))throw Error('Ответ не является корректным XML-фидом');validateContent(xml);}
          catch(error){checked.status='bad';checked.error=error.message;}
          const latest=read(),record=latest[key]?.find(f=>f.id===feed.id&&f.url===feed.url);if(!record)continue;
          if(checked.status==='bad'&&(record.telegramEnabled||record.emailEnabled)&&(record.status!=='bad'||record.error!==checked.error)){
            try{
              const notification=await notify({...checked,...record,status:checked.status,error:checked.error,projectId:key});
              if(notification?.telegramSent)checked.telegramNotifiedAt=new Date().toISOString();
              if(notification?.emailSent)checked.emailNotifiedAt=new Date().toISOString();
              checked.notificationError=notification?.errors?.join(' ')||'';
            }catch(error){checked.notificationError=error.message;}
          }
          Object.assign(record,{status:checked.status,error:checked.error,lastChecked:checked.lastChecked,telegramNotifiedAt:checked.telegramNotifiedAt,emailNotifiedAt:checked.emailNotifiedAt,notificationError:checked.notificationError});write(latest);
        }
      }
    }finally{busy=false;}
  }
  return {read,replace,run};
}
module.exports={createMonitor,publicAddress,validateContent,download,mergeFeedXml};
