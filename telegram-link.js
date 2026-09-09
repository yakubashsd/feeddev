const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Only hashes of short-lived link tokens are persisted. Telegram supplies identity;
// the authenticated browser must explicitly approve that identity afterwards.
function createTelegramLinks({file, now = Date.now}) {
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {projects:{}, offset:0};
  const write = data => {
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file+'.tmp', JSON.stringify(data), {mode:0o600});
    fs.renameSync(file+'.tmp', file);
  };
  const key = (owner, project) => crypto.createHash('sha256').update(JSON.stringify([owner,project])).digest('hex');
  const hash = token => crypto.createHash('sha256').update(token).digest('hex');
  function status(owner,project) {
    const entry = read().projects[key(owner,project)] || {};
    return {connected:entry.connected || null, candidate:entry.pending?.expiresAt > now() ? entry.pending.candidate || null : null};
  }
  function begin(owner,project) {
    const data=read(), id=key(owner,project), token=crypto.randomBytes(24).toString('base64url');
    const entry=data.projects[id] ||= {};
    if(entry.pending?.issuedAt > now()-5000) throw Error('Подождите несколько секунд перед созданием новой ссылки.');
    entry.pending={hash:hash(token), issuedAt:now(), expiresAt:now()+600000};
    write(data);return token;
  }
  function accept(update) {
    const data=read();
    if(!Number.isSafeInteger(update.update_id) || update.update_id < data.offset)return;
    data.offset=update.update_id+1;
    const message=update.message;
    const token=/^\/start(?:@\w+)? ([A-Za-z0-9_-]{32})$/.exec(message?.text || '')?.[1];
    if(token && message.chat?.type==='private' && message.from?.id===message.chat.id && !message.from.is_bot){
      const entry=Object.values(data.projects).find(item=>item.pending?.hash===hash(token) && item.pending.expiresAt>now() && !item.pending.candidate);
      if(entry){
        entry.pending.candidate={chatId:String(message.chat.id), name:String(message.from.first_name||'Telegram'), username:String(message.from.username||''), confirmationId:crypto.randomBytes(16).toString('hex')};
        delete entry.pending.hash;
      }
    }
    write(data);
  }
  function confirm(owner,project,confirmationId){
    const data=read(),entry=data.projects[key(owner,project)];
    if(!entry?.pending?.candidate || entry.pending.expiresAt<=now() || entry.pending.candidate.confirmationId!==confirmationId)throw Error('Подключение истекло или изменилось. Создайте новую ссылку.');
    entry.connected={...entry.pending.candidate};delete entry.connected.confirmationId;delete entry.pending;write(data);
    return status(owner,project);
  }
  function disconnect(owner,project){const data=read();delete data.projects[key(owner,project)];write(data);return status(owner,project);}
  return {status,begin,accept,confirm,disconnect,offset:()=>read().offset};
}
module.exports={createTelegramLinks};
