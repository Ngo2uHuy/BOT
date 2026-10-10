import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserQueue } from '../src/browser-queue.js';
import { Monitor } from '../src/monitor.js';

test('four browser slots run concurrently and waiting comments take the next slot',async()=>{
  const queue=new BrowserQueue(4), releases=[], started=[];
  const jobs=Array.from({length:4},(_,i)=>queue.enqueue(async()=>{
    started.push(i);
    await new Promise(resolve=>releases.push(resolve));
  }));
  await Promise.resolve();
  assert.deepEqual(started,[0,1,2,3]);
  const scan=queue.enqueue(()=>started.push('scan'));
  const comment=queue.enqueue(()=>started.push('comment'),true);
  assert.equal(started.length,4);
  releases[0]();
  await comment;
  assert.equal(started[4],'comment');
  releases.slice(1).forEach(resolve=>resolve());
  await Promise.all([...jobs,scan]);
  await queue.close();
});

test('four scan workers claim distinct groups and release claims on failure',async()=>{
  const groups=Array.from({length:5},(_,i)=>({id:i+1,ownerId:1,url:String(i+1),lastScanAt:null}));
  const releases=[], started=[], errors=[];
  const monitor=new Monitor({config:{allowedUserIds:[1],pollIntervalMs:60000},log:()=>{},
    store:{dueGroups:()=>groups,recordScanError:(id)=>errors.push(id),observe:()=>{}},
    collector:{collect:async(owner,url)=>{started.push(url);return new Promise((resolve,reject)=>releases.push(()=>reject(new Error('test'))));}},
  });
  const workers=Array.from({length:4},()=>monitor.scanLoop());
  assert.deepEqual(started,['1','2','3','4']);
  assert.equal(monitor.scanning.size,4);
  monitor.abort.abort();
  releases.forEach(release=>release());
  await Promise.all(workers);
  assert.equal(monitor.scanning.size,0);
  assert.equal(errors.length,4);
});

test('comments run ahead of waiting scans without overlapping active work', async () => {
  const queue=new BrowserQueue(), order=[];
  let release;
  const active=queue.enqueue(async()=>{order.push('active');await new Promise(r=>release=r);});
  await Promise.resolve();
  const scan=queue.enqueue(()=>order.push('scan'));
  const comment=queue.enqueue(()=>order.push('comment'),true);
  assert.deepEqual(order,['active']);
  release();
  await Promise.all([active,scan,comment]);
  assert.deepEqual(order,['active','comment','scan']);
  await queue.close();
  await assert.rejects(queue.enqueue(()=>{}));
});

test('failed browser work does not block later comments',async()=>{
  const queue=new BrowserQueue();
  await assert.rejects(queue.enqueue(()=>{throw new Error('failed');}));
  assert.equal(await queue.enqueue(()=>42,true),42);
  await queue.close();
});

test('idle comment worker wakes on new posts and shutdown, or an existing queue',async()=>{
  let pending=false;
  const monitor=new Monitor({store:{nextComment:()=>pending},config:{allowedUserIds:[1]}});
  const wait=monitor.waitForComments();
  assert.equal(typeof monitor.commentWake,'function');
  monitor.commentWake();
  await wait;
  assert.equal(monitor.commentWake,null);
  pending=true;
  await monitor.waitForComments();
  pending=false;
  const stopping=monitor.waitForComments();
  monitor.abort.abort();
  await stopping;
  assert.equal(monitor.commentWake,null);
});
