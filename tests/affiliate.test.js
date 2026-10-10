import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ShopeeAffiliate, shopeeRequest, shopeeUrl, parseAffiliateUrls, readShopeeConfig, SHOPEE_API } from '../src/affiliate.js';
import { Store } from '../src/store.js';
import { createBot } from '../src/bot.js';

const credentials={ownerId:1,appId:'123',secret:'fixture-secret'};
const origin='https://shopee.vn/product/123/456?x=1&sub_id=a%2Fb';
const success=url=>new Response(JSON.stringify({data:{generateShortLink:{shortLink:url}}}),{status:200});

test('Shopee configuration is optional, complete and bound to one Telegram owner',()=>{
  assert.equal(readShopeeConfig({}),null);
  assert.deepEqual(readShopeeConfig({SHOPEE_AFFILIATE_OWNER_ID:'1',SHOPEE_AFFILIATE_APP_ID:'123',SHOPEE_AFFILIATE_SECRET:'fixture-secret'}),credentials);
  assert.throws(()=>readShopeeConfig({SHOPEE_AFFILIATE_SECRET:'sensitive'}),error=>!error.message.includes('sensitive'));
  assert.equal(new ShopeeAffiliate(credentials).accountKey(2),null);
});

test('link input rejects hostile or unsupported destinations and keeps queries intact',()=>{
  assert.equal(shopeeUrl(origin),origin);
  assert.deepEqual(parseAffiliateUrls(`${origin}\n${origin}\nhttps://s.shopee.vn/abc`),[origin,'https://s.shopee.vn/abc']);
  for(const value of ['https://shopee.vn.evil.com/a','https://user@shopee.vn/a','https://shopee.vn:443/a','http://shopee.vn/a','https://shopee.vn\\@evil.com/a','https://tiktok.com/product/1','https://shopee.vn/']) assert.throws(()=>shopeeUrl(value));
  assert.throws(()=>parseAffiliateUrls(''));
  assert.throws(()=>parseAffiliateUrls(Array(21).fill(origin).join('\n')));
});

test('request signs the exact UTF-8 JSON payload and only calls the official endpoint',async()=>{
  const request=shopeeRequest('123','fixture-secret',origin,1700000000000);
  const payload=JSON.stringify({query:`mutation { generateShortLink(input: { originUrl: "${origin}" }) { shortLink } }`});
  const expected=createHash('sha256').update('1231700000000'+payload+'fixture-secret').digest('hex');
  assert.equal(request.body,payload);
  assert.equal(request.headers.Authorization,`SHA256 Credential=123, Timestamp=1700000000, Signature=${expected}`);
  let called=0;
  const api=new ShopeeAffiliate(credentials,async(url,options)=>{
    called++;
    assert.equal(url,SHOPEE_API);
    assert.equal(options.redirect,'error');
    assert.equal(options.method,'POST');
    assert.ok(options.signal);
    assert.equal(options.body,payload);
    assert.ok(!options.headers.Authorization.includes('fixture-secret'));
    return success('https://s.shopee.vn/result');
  });
  await assert.rejects(api.convert(2,origin));
  assert.equal(called,0);
  assert.equal(await api.convert(1,origin),'https://s.shopee.vn/result');
});

test('API errors never become links or expose raw secrets; mixed GraphQL errors fail closed',async()=>{
  const cases=[
    async()=>{throw new Error('fixture-secret');},
    async()=>new Response('fixture-secret',{status:401}),
    async()=>new Response('fixture-secret',{status:429}),
    async()=>new Response(JSON.stringify({errors:[{message:'fixture-secret'}],data:{generateShortLink:{shortLink:'https://s.shopee.vn/a'}}})),
    async()=>success('https://evil.com/fixture-secret'),
    async()=>new Response('fixture-secret'),
    async()=>new Response('x'.repeat(65537)),
  ];
  for(const fetcher of cases) await assert.rejects(new ShopeeAffiliate(credentials,fetcher).convert(1,origin),error=>!error.message.includes('fixture-secret'));
});

test('saved affiliate links preserve IDs and isolate owners and affiliate accounts',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  store.ensureUser(1,1);store.ensureUser(2,2);
  const first=store.saveAffiliateLink(1,'account-a',origin,'https://s.shopee.vn/first');
  const updated=store.saveAffiliateLink(1,'account-a',origin,'https://s.shopee.vn/updated');
  assert.equal(updated.id,first.id);
  assert.equal(store.listAffiliateLinks(1,'account-a').length,1);
  assert.equal(store.listAffiliateLinks(2,'account-a').length,0);
  assert.equal(store.listAffiliateLinks(1,'account-b').length,0);
  assert.throws(()=>store.affiliateLinksByIds(2,'account-a',[first.id]));
  assert.throws(()=>store.affiliateLinksByIds(1,'account-b',[first.id]));
});

test('Telegram converts, reports partial failures and comments only explicitly selected link IDs',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  store.ensureUser(1,1);store.ensureUser(2,2);
  const {group}=store.addProfile(1,'https://www.facebook.com/alice');
  store.observe(group,[{id:'42',url:'https://www.facebook.com/reel/42',text:'hello'}],{render:()=> 'hello',matches:()=>true,metricWindowMs:60000});
  let requests=0;
  const affiliate=new ShopeeAffiliate(credentials,async()=>++requests===2?new Response('failure',{status:500}):success(`https://s.shopee.vn/link${requests}`));
  const bot=createBot({token:'123:test',allowedUserIds:[1,2],store,affiliate});
  bot.botInfo={id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  const replies=[];
  bot.api.config.use(async(_prev,_method,payload)=>{replies.push(payload.text);return {ok:true,result:{message_id:replies.length}};});
  const send=async(text,owner=1)=>bot.handleUpdate({update_id:replies.length+1,message:{message_id:1,date:1,chat:{id:owner,type:'private'},from:{id:owner,is_bot:false,first_name:'User'},text,entities:[{type:'bot_command',offset:0,length:text.split(/\s/)[0].length}]}});
  await send(`/affiliate shopee ${origin}`,2);
  assert.equal(requests,0);
  await send(`/affiliate shopee ${origin}\nhttps://evil.com/product`);
  assert.equal(requests,0);
  await send(`/affiliate shopee ${origin}\nhttps://shopee.vn/product/1/2\nhttps://shopee.vn/product/1/3`);
  assert.equal(requests,3);
  assert.equal(store.listComments(1).length,0);
  assert.match(replies.at(-1),/2\/3/);
  const links=store.listAffiliateLinks(1,affiliate.accountKey(1));
  await send(`/affiliatecomment ${group.id} 42 | ${links[0].id},99999`);
  assert.equal(store.listComments(1).length,0);
  await send(`/affiliatecomment ${group.id} 42 | ${links[1].id},${links[0].id}`);
  assert.deepEqual(store.listComments(1).map(c=>c.body),[links[0].affiliate_url,links[1].affiliate_url]);
  await send(`/affiliatecomment ${group.id} 42 | ${links[1].id},${links[0].id}`);
  assert.equal(store.listComments(1).length,2);
  await send('/affiliatelinks');
  assert.match(replies.at(-1),/Trang 1/);
});
