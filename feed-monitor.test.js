const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createMonitor,publicAddress}=require('./feed-monitor');
test('persistent schedule, XML errors, recovery and one alert per failure',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feed-monitor-test-'));
  try{
    let xml='<feed><offer/></feed>',calls=0,alerts=0;
    const options={file:path.join(dir,'state.json'),load:async()=>{calls++;return xml;},notify:async()=>{alerts++;}};
    const monitor=createMonitor(options);
    monitor.replace('test',[{id:'a',url:'https://example.com/feed',telegramEnabled:true}]);
    await monitor.run();assert.equal(monitor.read().test[0].status,'ok');
    await createMonitor(options).run();assert.equal(calls,1,'restart must honor last check');
    xml='<feed><broken></feed>';await monitor.run('test',null,true);assert.equal(monitor.read().test[0].status,'bad');assert.equal(alerts,1);
    await monitor.run('test',null,true);assert.equal(alerts,1);
    xml='<feed/>';await monitor.run('test',null,true);assert.equal(monitor.read().test[0].status,'ok');
    xml='<html><body>Login</body></html>';await monitor.run('test',null,true);assert.equal(alerts,2);
    monitor.replace('test',[]);assert.deepEqual(monitor.read().test,[]);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('internal addresses are not accepted',()=>{
  for(const ip of ['127.0.0.1','10.1.1.1','169.254.169.254','192.168.1.1','172.20.1.1','::1'])assert.equal(publicAddress(ip),false);
  assert.equal(publicAddress('8.8.8.8'),true);
});
