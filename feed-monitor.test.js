const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createMonitor,publicAddress,mergeFeedXml}=require('./feed-monitor');
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
test('Avito content errors are detected',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feed-monitor-content-'));
  try{
    const monitor=createMonitor({file:path.join(dir,'state.json'),load:async()=>'<Ads><Ad><Id>1</Id><Description></Description></Ad></Ads>'});
    monitor.replace('test',[{id:'a',url:'https://example.com/feed'}]);
    await monitor.run('test',null,true);
    assert.equal(monitor.read().test[0].status,'bad');
    assert.match(monitor.read().test[0].error,/Description у 1 объектов/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('source refresh keeps current branded images by object id',()=>{
  const source='<Ads><Ad><Id>1</Id><Price>200</Price><Images><Image url="source-plan.png"/></Images></Ad></Ads>';
  const current='<Ads><Ad><Id>1</Id><Price>100</Price><Images><Image url="safe-branded-plan.jpg"/><Image url="house.jpg"/></Images></Ad></Ads>';
  const result=mergeFeedXml(source,current);
  assert.equal(result.sourceObjects,1);
  assert.equal(result.matched,1);
  assert.match(result.xml,/200/);
  assert.match(result.xml,/safe-branded-plan\.jpg/);
  assert.match(result.xml,/house\.jpg/);
  assert.doesNotMatch(result.xml,/source-plan\.png/);
});
test('source refresh keeps manual HouseType overrides by object id',()=>{
  const source='<Ads><Ad><Id>1</Id><HouseType>монолитно-каркасный</HouseType><Images><Image url="source-plan.png"/></Images></Ad></Ads>';
  const current='<Ads><Ad><Id>1</Id><HouseType>монолитно-кирпичный</HouseType><Images><Image url="safe-branded-plan.jpg"/></Images></Ad></Ads>';
  const result=mergeFeedXml(source,current,{1:{HouseType:'монолитно-кирпичный'}});
  assert.match(result.xml,/<HouseType>монолитно-кирпичный<\/HouseType>/);
  assert.match(result.xml,/safe-branded-plan\.jpg/);
  assert.doesNotMatch(result.xml,/монолитно-каркасный/);
});
test('source refresh infers an existing HouseType override from the current feed',()=>{
  const source='<Ads><Ad><Id>1</Id><HouseType>монолитно-каркасный</HouseType></Ad></Ads>';
  const current='<Ads><Ad><Id>1</Id><HouseType>монолитно-кирпичный</HouseType></Ad></Ads>';
  const result=mergeFeedXml(source,current);
  assert.match(result.xml,/<HouseType>монолитно-кирпичный<\/HouseType>/);
  assert.doesNotMatch(result.xml,/монолитно-каркасный/);
});
test('source refresh keeps scalar and multi-value manual overrides',()=>{
  const source='<Ads><Ad><Id>1</Id><Description>Источник</Description><Price>5000000</Price><BathroomMulti><Option>Совмещенный</Option></BathroomMulti></Ad></Ads>';
  const current='<Ads><Ad><Id>1</Id><Description>Старая правка</Description><Price>5100000</Price></Ad></Ads>';
  const result=mergeFeedXml(source,current,{1:{description:'Новая правка',price:'5200000',bathroomType:'Раздельный'}});
  assert.match(result.xml,/<Description>Новая правка<\/Description>/);
  assert.match(result.xml,/<Price>5200000<\/Price>/);
  assert.match(result.xml,/<BathroomMulti>\s*<Option>Раздельный<\/Option>\s*<\/BathroomMulti>/);
  assert.doesNotMatch(result.xml,/Источник/);
});
