import test from 'node:test';
import assert from 'node:assert/strict';
import { TikTokAffiliate, readTikTokConfig, tiktokSignature, tiktokProductId, parseTikTokInput, rankTikTokOffers, preserveTikTokIds, TIKTOK_API, TIKTOK_PROFILE, TIKTOK_SEARCH } from '../src/tiktok-affiliate.js';
import { createBot } from '../src/bot.js';
import { Store } from '../src/store.js';

const creatorId='7495383576032499210',productId='1729432087292775344';
const config={ownerId:1,appKey:'app123',secret:'fixture-secret',accessToken:'fixture-token',creatorId,publisherId:'publisher-1',campaignId:''};
const json=data=>new Response(JSON.stringify({code:0,data}));
const profile=()=>json({creator_user_id:creatorId,selection_region:'VN',permissions:['ADD_AFFILIATE_PERMISSION']});
const product=(id=productId,rate=3000,amount='10000',extra={})=>({id,title:'Áo đẹp',has_inventory:true,sale_region:'VN',commission:{rate,amount,currency:'VND'},...extra});
const link=id=>`https://www.tiktok.com/t/share${id}`;

test('TikTok config stays disabled by default, requires publisher, and isolates account keys',()=>{
  assert.equal(readTikTokConfig({}),null);
  assert.throws(()=>readTikTokConfig({TIKTOK_AFFILIATE_ACCESS_TOKEN:'do-not-echo'}),e=>!e.message.includes('do-not-echo'));
  const env=Object.fromEntries(Object.entries({OWNER_ID:'1',APP_KEY:'app123',APP_SECRET:'fixture-secret',ACCESS_TOKEN:'fixture-token',CREATOR_ID:creatorId,PUBLISHER_ID:'publisher-1'}).map(([key,value])=>['TIKTOK_AFFILIATE_'+key,value]));
  assert.deepEqual(readTikTokConfig(env),config);
  assert.throws(()=>readTikTokConfig({...env,TIKTOK_AFFILIATE_PUBLISHER_ID:'..'}));
  const api=new TikTokAffiliate(config);
  assert.equal(api.accountKey(2),null);
  assert.match(api.accountKey(1),/^tiktok:/);
  assert.notEqual(api.accountKey(1),new TikTokAffiliate({...config,publisherId:'publisher-2'}).accountKey(1));
});

test('TikTok signing matches the official published test vector',()=>{
  assert.equal(tiktokSignature('/authorization/202309/shops',{timestamp:1623812664,app_key:'29a39d',sign:'ignored',access_token:'ignored'},'','e59af819cc'),
    'b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8');
  assert.notEqual(tiktokSignature('/path',{app_key:'a'},'{}','s'),tiktokSignature('/path',{app_key:'a'},'','s'));
  assert.equal(JSON.parse(`{"material_id":${productId}}`,preserveTikTokIds).material_id,productId);
});

test('TikTok inputs preserve large IDs, reject unrelated URLs, and retain distinct products',()=>{
  assert.equal(tiktokProductId(`https://shop.tiktok.com/view/product/${productId}?region=VN`),productId);
  assert.equal(tiktokProductId(`https://www.tiktok.com/shop/pdp/ao-dep/${productId}`),productId);
  assert.deepEqual(parseTikTokInput(`${productId}\n${productId}`),[productId]);
  for(const bad of ['https://evil.com/a','https://vt.tiktok.com:443/a','https://user@vt.tiktok.com/a','https://vt.tiktok.com.evil/a','https://www.tiktok.com/@user/video/123','https://www.tiktok.com/']) assert.throws(()=>parseTikTokInput(bad));
});

test('TikTok ranking uses basis points, rejects out-of-stock, foreign currency/region and malformed numbers',()=>{
  const rows=[product('1',1000,'100000'),product('2',3000,'50000'),product('2',3000,'50000'),product('3',8000,'999999',{has_inventory:false}),product('4',8000,'999999',{sale_region:'US'}),product('5',8000,'999999',{commission:{rate:8000,amount:'999999',currency:'USD'}}),product('6',5000,'NaN')];
  assert.deepEqual(rankTikTokOffers(rows).map(o=>o.id),['2','1']);
  assert.equal(rankTikTokOffers(rows)[0].rate,.3);
  assert.deepEqual(rankTikTokOffers(rows,'amount').map(o=>o.id),['1','2']);
});

test('TikTok top verifies creator, pages with official sorting, and maps publisher links by exact ID',async()=>{
  const calls=[];
  const api=new TikTokAffiliate(config,async(url,options)=>{
    const parsed=new URL(url);calls.push({parsed,options});
    assert.equal(parsed.origin,TIKTOK_API);
    assert.equal(options.headers['x-tts-access-token'],'fixture-token');
    assert.ok(!url.includes('fixture-token'));
    assert.equal(parsed.searchParams.get('sign'),tiktokSignature(parsed.pathname,Object.fromEntries(parsed.searchParams),options.body || '',config.secret));
    if(parsed.pathname===TIKTOK_PROFILE) return profile();
    if(parsed.pathname===TIKTOK_SEARCH) {
      assert.equal(parsed.searchParams.get('page_size'),'20');
      assert.equal(parsed.searchParams.get('sort_field'),'commission');
      assert.equal(parsed.searchParams.get('sort_order'),'DESC');
      assert.deepEqual(JSON.parse(options.body),{title_keywords:['áo đẹp']});
      return parsed.searchParams.has('page_token')?json({products:[product('2',2000,'20000')],next_page_token:''}):json({products:[product()],next_page_token:'next'});
    }
    assert.match(parsed.pathname,/publisher\/publisher-1\/generate_batch$/);
    assert.deepEqual(JSON.parse(options.body).material.ids,['2',productId]);
    return new Response(`{"code":0,"data":{"sharing_links":[{"material_id":${productId},"sharing_link":"${link(productId)}"},{"material_id":"2","sharing_link":"https://evil.com/bad"}],"failed_materials":[]}}`);
  });
  const result=await api.topOffers(1,{count:2,rank:'amount',keyword:'áo đẹp'});
  assert.equal(result.scanned,2);assert.equal(result.failed,1);assert.equal(result.limited,false);
  assert.equal(result.offers[0].id,productId);
  assert.equal(result.offers[0].affiliateUrl,link(productId));
  const before=calls.length;
  await assert.rejects(api.topOffers(2,{count:5}));
  assert.equal(calls.length,before);
});

test('wrong Creator fails before sharing; short URLs never forward API headers and block foreign redirects',async()=>{
  let count=0;
  const wrong=new TikTokAffiliate(config,async()=>{count++;return json({creator_user_id:'wrong',selection_region:'VN',permissions:['ADD_AFFILIATE_PERMISSION']});});
  await assert.rejects(wrong.convert(1,productId));assert.equal(count,1);
  const urls=[];
  const api=new TikTokAffiliate(config,async(url,options)=>{
    urls.push(url);
    if(new URL(url).pathname===TIKTOK_PROFILE) return profile();
    assert.equal(url,'https://vt.tiktok.com/abc');
    assert.deepEqual(options.headers,{});
    assert.equal(options.redirect,'manual');
    return new Response(null,{status:302,headers:{location:'https://evil.com/secret'}});
  });
  await assert.rejects(api.convert(1,'https://vt.tiktok.com/abc'));
  assert.equal(urls.length,2);
  const valid=new TikTokAffiliate(config,async(url)=>{
    if(new URL(url).pathname===TIKTOK_PROFILE) return profile();
    if(url==='https://vt.tiktok.com/abc') return new Response(null,{status:302,headers:{location:`https://shop.tiktok.com/view/product/${productId}`}});
    return json({sharing_links:[{material_id:productId,sharing_link:link(productId)}]});
  });
  assert.equal((await valid.convert(1,'https://vt.tiktok.com/abc')).affiliateUrl,link(productId));
});

test('TikTok API errors redact tokens and never turn product URLs into affiliate links',async()=>{
  for(const fetcher of [async()=>{throw new Error('fixture-token');},async()=>new Response('fixture-secret',{status:401}),async()=>json({}),async()=>new Response(JSON.stringify({code:105002,message:'fixture-token'}))]) {
    await assert.rejects(new TikTokAffiliate(config,fetcher).verify(1),e=>!e.message.includes('fixture-token')&&!e.message.includes('fixture-secret'));
  }
});

test('TikTok Telegram commands keep Shopee links isolated and enforce explicit Facebook targets',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());store.ensureUser(1,1);store.ensureUser(2,2);
  const {group}=store.addProfile(1,'https://www.facebook.com/alice');
  store.observe(group,[{id:'42',text:'hello',url:'https://www.facebook.com/reel/42'}],{render:()=> 'hello',matches:()=>true,metricWindowMs:60000});
  store.mapMessage(1,1,90,group.id,'42');
  let apiCalls=0;
  const affiliate=new TikTokAffiliate(config,async url=>{
    apiCalls++;
    if(new URL(url).pathname===TIKTOK_PROFILE) return profile();
    if(new URL(url).pathname===TIKTOK_SEARCH) return json({products:[product()],next_page_token:''});
    return json({sharing_links:[{material_id:productId,sharing_link:link(productId)}]});
  });
  const bot=createBot({token:'123:test',allowedUserIds:[1,2],store,tiktokAffiliate:affiliate});
  bot.botInfo={id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  let seq=100;const calls=[];
  bot.api.config.use(async(_prev,method,payload)=>{calls.push({method,payload,id:++seq});return {ok:true,result:method==='answerCallbackQuery'?true:{message_id:seq}};});
  const from=id=>({id,is_bot:false,first_name:'User'});
  const send=async(text,owner=1)=>bot.handleUpdate({update_id:++seq,message:{message_id:seq,date:1,chat:{id:owner,type:'private'},from:from(owner),text,entities:[{type:'bot_command',offset:0,length:text.split(/\s/)[0].length}]}});
  const click=async(data,messageId=90,owner=1)=>bot.handleUpdate({update_id:++seq,callback_query:{id:String(seq),chat_instance:'t',from:from(owner),data,message:{message_id:messageId,date:1,chat:{id:owner,type:'private'}}}});
  await send('/tiktoktop 5',2);assert.equal(apiCalls,0);
  await send('/tiktoktop 5');assert.equal(store.listComments(1).length,0);
  const saved=store.listAffiliateLinks(1,affiliate.accountKey(1))[0];
  const shopee=store.saveAffiliateLink(1,'shopee-account','https://shopee.vn/product/1/2','https://s.shopee.vn/test');
  await send(`/tiktokcomment ${group.id} 42 | ${shopee.id}`);
  assert.equal(store.listComments(1).length,0);
  await send(`/tiktokcomment ${group.id} 42 | ${saved.id}`);
  assert.equal(store.listComments(1).length,1);
  const before=apiCalls;
  await send(`/tiktoktopcomment ${group.id} missing 5`);assert.equal(apiCalls,before);
  await click('post:tiktoktop');const picker=calls.at(-1).id;
  await click('ttop:5:rate',picker,2);assert.equal(calls.at(-1).payload.show_alert,true);
  await click('ttop:5:rate',picker);assert.equal(store.listComments(1).length,1);
  await send(`/tiktokauto ${group.id} 3 amount áo`);
  assert.equal(store.getGroup(group.id).tiktokAuto.count,3);
  await send(`/tiktokauto ${group.id} off`);assert.equal(store.getGroup(group.id).tiktokAuto,null);
});
