const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createTelegramLinks}=require('./telegram-link');
test('one-use expiring links require owner and project confirmation; disconnect persists',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'telegram-links-'));
  try{
    let time=1000000;
    const file=path.join(dir,'links.json'), links=createTelegramLinks({file,now:()=>time});
    const token=links.begin('alice','project-a');
    assert.ok(!fs.readFileSync(file,'utf8').includes(token));
    links.accept({update_id:1,message:{text:'/start '+token,chat:{id:123,type:'private'},from:{id:123,first_name:'Alice'}}});
    const candidate=links.status('alice','project-a').candidate;
    assert.ok(candidate);assert.equal(links.status('alice','project-a').connected,null);
    assert.throws(()=>links.confirm('bob','project-a',candidate.confirmationId));
    assert.throws(()=>links.confirm('alice','project-b',candidate.confirmationId));
    links.accept({update_id:2,message:{text:'/start '+token,chat:{id:456,type:'private'},from:{id:456}}});
    assert.equal(links.status('alice','project-a').candidate.chatId,'123');
    links.confirm('alice','project-a',candidate.confirmationId);
    assert.equal(createTelegramLinks({file}).status('alice','project-a').connected.chatId,'123');
    assert.throws(()=>links.confirm('alice','project-a',candidate.confirmationId));
    links.disconnect('alice','project-a');assert.equal(links.status('alice','project-a').connected,null);
    const expired=links.begin('alice','project-b');time+=600001;
    links.accept({update_id:3,message:{text:'/start '+expired,chat:{id:123,type:'private'},from:{id:123}}});
    assert.equal(links.status('alice','project-b').candidate,null);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
