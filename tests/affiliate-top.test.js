import test from 'node:test';
import assert from 'node:assert/strict';
import { ShopeeAffiliate, parseTopOptions, rankOffers } from '../src/affiliate.js';
import { Store } from '../src/store.js';
import { createBot } from '../src/bot.js';

const config={ownerId:1,appId:'123',secret:'test-secret'};
const offer=(id,rate,amount,extra={})=>({productName:`Product ${id}`,productLink:`https://shopee.vn/product/1/${id}`,offerLink:`https://s.shopee.vn/item${id}`,commissionRate:String(rate),commission:String(amount),periodStartTime:1,periodEndTime:4102444800,...extra});
const page=(nodes,more=false)=>new Response(JSON.stringify({data:{productOfferV2:{nodes,pageInfo:{hasNextPage:more}}}}));

test('top options validate counts, default to rate, and preserve keyword text',()=>{
  assert.deepEqual(parseTopOptions('5'),{count:5,rank:'rate',keyword:''});
  assert.deepEqual(parseTopOptions('3 amount đồ gia dụng'),{count:3,rank:'amount',keyword:'đồ gia dụng'});
  for(const text of ['0','21','-1','5.5','abc',`5 rate ${'x'.repeat(201)}`]) assert.throws(()=>parseTopOptions(text));
});

test('offers rank numerically and exclude duplicate, expired, future, invalid and zero-commission items',()=>{
  const rows=[offer(1,.5,9),offer(2,.1,100),offer(3,.3,20),
    offer(1,.5,9,{productLink:'https://shopee.vn/name-i.1.1?tracking=abc',offerLink:'https://s.shopee.vn/duplicate'}),
    offer(4,.9,999,{periodEndTime:2}),offer(5,.9,999,{periodStartTime:4102444800}),
    offer(6,.9,999,{offerLink:'https://evil.com/x'}),offer(7,0,0),offer(8,.9,999,{commission:'unknown'}),
    offer(9,.9,999,{periodEndTime:null})];
  assert.deepEqual(rankOffers(rows,'rate').map(o=>o.amount),[9,20,100]);
  assert.deepEqual(rankOffers(rows,'amount').map(o=>o.amount),[100,20,9]);
});

test('top fetches signed account offers across pages, preserves affiliate link and limits scan to 250',async()=>{
  const queries=[];
  const api=new ShopeeAffiliate(config,async(_url,request)=>{
    queries.push(JSON.parse(request.body).query);
    assert.match(request.headers.Authorization,/Credential=123/);
    return queries.length===1?page([offer(1,.5,10)],true):page([offer(2,.1,100)]);
  });
  const result=await api.topOffers(1,{count:1,rank:'amount',keyword:'áo "đẹp"'});
  assert.equal(result.offers[0].affiliateUrl,'https://s.shopee.vn/item2');
  assert.equal(result.scanned,2);
  assert.equal(result.limited,false);
  assert.match(queries[0],/sortType: 5, page: 1, limit: 50/);
  assert.ok(queries[0].includes('keyword: "áo \\"đẹp\\""'.replaceAll('\\\\','\\')));
  assert.match(queries[1],/page: 2/);
  const before=queries.length;
  await assert.rejects(api.topOffers(2,{count:1}));
  await assert.rejects(api.topOffers(1,{count:21}));
  assert.equal(queries.length,before);
  let pages=0;
  const many=new ShopeeAffiliate(config,async()=>{
    pages++;
    return page(Array.from({length:50},(_,i)=>offer(pages*100+i,.1,10)),true);
  });
  const limited=await many.topOffers(1,{count:5,rank:'amount'});
  assert.equal(pages,5);assert.equal(limited.scanned,250);assert.equal(limited.limited,true);
  assert.equal(limited.offers.length,5);
});

test('top commands preview only or queue exactly the requested number; callbacks check ownership',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  store.ensureUser(1,1);store.ensureUser(2,2);
  const {group}=store.addProfile(1,'https://www.facebook.com/alice');
  store.observe(group,[{id:'42',url:'https://www.facebook.com/reel/42',text:'hello'}],{render:()=> 'hello',matches:()=>true,metricWindowMs:60000});
  store.mapMessage(1,1,90,group.id,'42');
  let requests=0,fail=false;
  const affiliate=new ShopeeAffiliate(config,async()=>{requests++;return fail?new Response('{}',{status:500}):page([offer(1,.5,10),offer(2,.3,100),offer(3,.1,200)]);});
  const bot=createBot({token:'123:test',allowedUserIds:[1,2],store,affiliate});
  bot.botInfo={id:123,is_bot:true,first_name:'Bot',username:'test_bot'};
  const calls=[];let seq=100;
  bot.api.config.use(async(_prev,method,payload)=>{calls.push({method,payload,id:++seq});return {ok:true,result:method==='answerCallbackQuery'?true:{message_id:seq}};});
  const from=id=>({id,is_bot:false,first_name:'User'});
  const send=async(text,owner=1)=>bot.handleUpdate({update_id:++seq,message:{message_id:seq,date:1,chat:{id:owner,type:'private'},from:from(owner),text,entities:[{type:'bot_command',offset:0,length:text.split(/\s/)[0].length}]}});
  const click=async(data,messageId=90,owner=1)=>bot.handleUpdate({update_id:++seq,callback_query:{id:String(seq),chat_instance:'test',from:from(owner),data,message:{message_id:messageId,date:1,chat:{id:owner,type:'private'}}}});
  await send('/affiliatetop 2 amount');
  assert.equal(store.listComments(1).length,0);
  assert.ok(calls.some(c=>c.payload.text?.includes('200 đ/đơn')));
  await send(`/affiliatetopcomment ${group.id} missing 2`);
  await send(`/affiliatetopcomment ${group.id} 42 2`,2);
  assert.equal(requests,1);
  await send(`/affiliatetopcomment ${group.id} 42 2 rate`);
  assert.deepEqual(store.listComments(1).map(c=>c.body),['https://s.shopee.vn/item2','https://s.shopee.vn/item1']);
  await send(`/affiliatetopcomment ${group.id} 42 2 rate`);
  assert.equal(store.listComments(1).length,2);
  await click('post:affiliatetop');
  const picker=calls.at(-1);
  assert.equal(picker.payload.reply_markup.inline_keyboard[0].length,4);
  await click('afftop:1:amount',picker.id,2);
  assert.equal(calls.at(-1).payload.show_alert,true);
  await click('afftop:1:amount',picker.id);
  assert.equal(store.listComments(1).length,3);
  fail=true;
  await send(`/affiliatetopcomment ${group.id} 42 5`);
  assert.equal(store.listComments(1).length,3);
  assert.match(calls.at(-1).payload.text,/Chưa xếp bình luận/);
});

test('failed later page rejects the whole selection instead of queuing a partial top',async()=>{
  let calls=0;
  const api=new ShopeeAffiliate(config,async()=>++calls===1?page([offer(1,.5,10)],true):new Response(JSON.stringify({errors:[{message:'private-secret'}]})));
  await assert.rejects(api.topOffers(1,{count:5}),error=>!error.message.includes('private-secret'));
});
