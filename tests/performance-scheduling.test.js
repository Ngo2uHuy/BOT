import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { RequestLimiter } from '../src/facebook-graphql.js';

test('lazy scan selection preserves owner, pause, schedule and caller eligibility', () => {
  const store = new Store(':memory:');
  try {
    store.ensureUser(1, 1);
    store.ensureUser(2, 2);
    const groups = Array.from({length: 8}, (_, i) => store.addGroup(i === 0 ? 2 : 1, `https://www.facebook.com/groups/test${i}`).group);
    store.setPaused(1, groups[1].id, true);
    store.prepare('UPDATE groups SET last_scan_at=100,next_scan_at=9999 WHERE id=?').run(groups[2].id);
    const accept = group => group.id !== groups[3].id;
    const expected = store.dueGroups([1], 500, 1000).find(accept);
    let visited = 0;
    const result = store.dueGroups([1], 500, 1000, group => { visited++; return accept(group); });
    assert.equal(result[0].id, expected.id);
    assert.equal(visited, 2);
    assert.deepEqual(store.dueGroups([], 500, 1000, accept), []);
    assert.deepEqual(store.dueGroups([1], 500, 1000, () => false), []);
    // The early-returning SQLite iterator must release its statement.
    store.prepare('UPDATE groups SET last_scan_at=200 WHERE id=?').run(expected.id);
  } finally { store.close(); }
});

test('actions overtake waiting scans without starving scans or bypassing pacing/caps', async () => {
  let now = 0, release;
  const order = [], starts = [];
  const limiter = new RequestLimiter({ minDelayMs: 10, maxDelayMs: 10, maxPerHour: 8,
    now: () => now, sleep: async ms => { now += ms; } });
  const first = limiter.run(1, async () => {
    order.push('active'); starts.push(now);
    await new Promise(resolve => { release = resolve; });
  });
  const enqueue = (name, priority = false) => limiter.run(1, async () => { order.push(name); starts.push(now); }, { priority });
  const pending = [enqueue('scan1'), enqueue('scan2'), ...Array.from({length: 5}, (_, i) => enqueue(`action${i}`, true))];
  release();
  await Promise.all([first, ...pending]);
  assert.deepEqual(order, ['active','action0','action1','action2','scan1','action3','action4','scan2']);
  assert.deepEqual(starts, [0,10,20,30,40,50,60,70]);
  await assert.rejects(enqueue('over cap', true), { code: 'SCAN_DEFERRED' });
});
