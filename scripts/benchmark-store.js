// Synthetic, in-memory workload. Never opens the live database or calls external APIs.
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.js';

const store=new Store(':memory:');
try {
  store.ensureUser(1,1);
  const group=store.addGroup(1,'https://www.facebook.com/groups/benchmark').group;
  const now=Date.now();
  store.db.exec('BEGIN');
  const post=store.db.prepare('INSERT INTO posts VALUES(?,?,?,?,?,?,?)');
  const delivery=store.db.prepare('INSERT INTO deliveries(group_id,post_id,body,sent_body) VALUES(?,?,?,?)');
  const comment=store.db.prepare("INSERT INTO comments(group_id,post_id,body,source,state,created_at) VALUES(?,?,?,'manual','sent',?)");
  for(let i=0;i<20000;i++) {
    const id=String(i),body=JSON.stringify({id,url:`https://www.facebook.com/groups/benchmark/posts/${id}`,text:'Kitchen product '.repeat(50),publishedAt:new Date(now).toISOString()});
    post.run(group.id,id,body,now,now,now,1);
    delivery.run(group.id,id,'delivered','delivered');
    comment.run(group.id,id,'sent',now);
  }
  store.db.exec('COMMIT');
  const result={posts:20000};
  function measure(name,count,fn) {
    for(let i=0;i<5;i++) fn(i);
    const samples=[];
    for(let round=0;round<3;round++) {
      const start=performance.now();
      for(let i=0;i<count;i++) fn(i);
      samples.push(performance.now()-start);
    }
    result[name]={operations:count,medianMs:Number(samples.sort((a,b)=>a-b)[1].toFixed(2))};
  }
  measure('idleQueuePoll',100,()=>{store.nextComment([1]);store.nextDelivery(now,[1]);});
  measure('selectOnePost',50,i=>store.queueCommentList(1,group.id,[String(i)],['benchmark']));
  measure('listPosts',100,()=>store.listPosts(1,group.id));
  measure('lookupPost',1000,()=>store.getSavedPost(1,group.id,'100'));
  console.log(JSON.stringify(result,null,2));
} finally {store.close();}
