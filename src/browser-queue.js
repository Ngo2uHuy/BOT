// Bound concurrent browser jobs within a lane; priority jobs take the next slot.
export class BrowserQueue {
  pending = [];
  running = new Set();
  closed = false;

  constructor(concurrency = 1) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid browser concurrency');
    this.concurrency = concurrency;
  }

  enqueue(work, priority = false) {
    if (this.closed) return Promise.reject(new Error('Facebook collector đã đóng.'));
    const result = new Promise((resolve,reject) => {
      this.pending.push({work,priority,resolve,reject});
    });
    this.drain();
    return result;
  }

  drain() {
    if (this.closed || this.running.size >= this.concurrency || !this.pending.length) return;
    const index = this.pending.findIndex(item => item.priority);
    const item = this.pending.splice(index < 0 ? 0 : index,1)[0];
    const task = Promise.resolve().then(item.work).then(item.resolve,item.reject).finally(() => {
      this.running.delete(task);
      this.drain();
    });
    this.running.add(task);
    this.drain();
  }

  async close() {
    this.closed = true;
    for (const item of this.pending.splice(0)) item.reject(new Error('Facebook collector đã đóng.'));
    await Promise.allSettled([...this.running]);
  }
}
