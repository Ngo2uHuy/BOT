import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

test('due sources respect owner, pause, cutoff, ordering and explicit rescan',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());
  s.ensureUser(1,1);s.ensureUser(2,2);
  const groups=Array.from({length:5},(_,i)=>s.addGroup(i===4?2:1,`https://www.facebook.com/groups/${i}`).group);
  s.recordScanError(groups[1].id,'',100);
  s.recordScanError(groups[2].id,'',300);
  s.setPaused(1,groups[3].id,true);
  assert.deepEqual(s.dueGroups([1],200).map(g=>g.id),[groups[0].id,groups[1].id]);
  assert.deepEqual(s.dueGroups([],200),[]);
  s.requestScan(1,groups[2].id);
  assert.deepEqual(s.dueGroups([1],200).map(g=>g.id),[groups[0].id,groups[2].id,groups[1].id]);
});

test('indexed queues retain order, owner checks and reactivated delivery updates',t=>{
  const s=new Store(':memory:');t.after(()=>s.close());
  s.ensureUser(1,1);s.ensureUser(2,2);
  const g=s.addJoinedGroup(1,{url:'https://www.facebook.com/groups/a'}).group;
  const post=id=>({id,url:`https://www.facebook.com/groups/a/posts/${id}`,text:id});
  const options={render:(_g,p)=>p.text,matches:()=>true,metricWindowMs:60000};
  s.observe(g,[post('1'),post('2')],options);
  for(let i=0;i<2;i++) s.delivered(s.nextDelivery(Date.now(),[1]),100+i);
  assert.equal(s.nextDelivery(Date.now(),[1]),undefined);
  s.observe(g,[{...post('1'),text:'changed'}],options);
  assert.equal(s.nextDelivery(Date.now(),[1]).post_id,'1');
  assert.equal(s.nextDelivery(Date.now(),[2]),undefined);
  s.queueCommentList(1,g.id,['2','1','2'],['hello']);
  const first=s.nextComment([1]);assert.equal(first.post_id,'2');
  s.commentState(first.id,'sent');assert.equal(s.nextComment([1]).post_id,'1');
  assert.equal(s.nextComment([2]),undefined);
  s.setPaused(1,g.id,true);assert.equal(s.nextComment([1]),undefined);
});
