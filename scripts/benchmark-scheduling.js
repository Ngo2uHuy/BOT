// Synthetic local benchmark: no production DB, credentials or external requests.
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.js';

const store = new Store(':memory:');
try {
  store.ensureUser(1, 1);
  for (let i = 0; i < 95; i++) store.addGroup(1, `https://www.facebook.com/groups/benchmark${i}`);
  const now = Date.now(), accept = group => group.id > 4;
  const before = () => store.dueGroups([1], now, now).find(accept);
  const after = () => store.dueGroups([1], now, now, accept)[0];
  if (before().id !== after().id) throw new Error('Selection mismatch');
  for (let i = 0; i < 100; i++) { before(); after(); }
  const samples = { before: [], after: [] }, operations = 1000;
  const measure = (name, fn) => {
    const start = performance.now();
    for (let i = 0; i < operations; i++) fn();
    samples[name].push(performance.now() - start);
  };
  for (let round = 0; round < 5; round++) {
    if (round % 2) { measure('after', after); measure('before', before); }
    else { measure('before', before); measure('after', after); }
  }
  const median = list => list.sort((a,b) => a-b)[2];
  const beforeMs = median(samples.before), afterMs = median(samples.after);
  console.log(JSON.stringify({ workload: '95 due groups, first 4 ineligible; local in-memory SQLite only', operations,
    beforeMs: +beforeMs.toFixed(2), afterMs: +afterMs.toFixed(2), speedup: +(beforeMs / afterMs).toFixed(2),
    reductionPercent: +((1 - afterMs / beforeMs) * 100).toFixed(1) }, null, 2));
} finally { store.close(); }
