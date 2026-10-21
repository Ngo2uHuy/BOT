import { setTimeout as sleep } from 'node:timers/promises';
import { matchesKeywords } from './input.js';
import { formatPost } from './format.js';
import { spinText } from './comments.js';
import { matchesDateRange, isHistoricalDateRange } from './dates.js';
import { rejectedMarkup, postMarkup, notificationMarkup } from './post-buttons.js';
import { commenterBlockWaits, commenterProfiles,numericProfile, isNumericProfile, postAuthorProfile, commenterBlockPauseMs, COMMENTER_BLOCK_PAUSE_MIN_MS, COMMENTER_BLOCK_POLL_MS, COMMENTER_SCAN_PASSES, COMMENTER_NO_COMMENTS_TRIES, COMMENTER_NO_COMMENTS_RETRY_MS, COMMENTER_PROGRESS_TTL_MS } from './commenter-block.js';

// Never include HTTP request URLs in diagnostics: Telegram embeds its token there.
export function safeError(error) {
  const text = error?.description || error?.message || 'Lỗi không xác định';
  return String(text).replace(/\d{5,}:[A-Za-z0-9_-]+/g, '[TOKEN]').slice(0,error?.scanDiagnostic ? 1600 : 500);
}

const vnTime = time => new Date(time).toLocaleTimeString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'});
const isActionHold = error => error?.code === 'RATE_LIMITED' || error?.code === 'SCAN_DEFERRED';

// Water-filling: splits `budget` requests/hour in proportion to `weights`, but no group gets more than
// `maxRate` (SCAN_MIN) or less than `minRate` (SCAN_MAX). Capped groups hand their excess to the rest and
// floored groups are paid first, so the total always equals the budget whether there are 5 or 500 groups.
// The floor may take at most 75% of the budget (enough for ~300 groups at SCAN_MAX=600 with the default
// cap); beyond that it shrinks, so busy groups keep their priority and quiet ones exceed SCAN_MAX.
export function allocateScanRates(weights,budget,{minRate,maxRate}) {
  const rates = new Map();
  if (!weights.size) return rates;
  const floor = Math.min(minRate,budget*0.75/weights.size);
  let open = new Map(weights), left = budget;
  while (open.size) {
    const total = [...open.values()].reduce((sum,weight) => sum+weight,0);
    const share = weight => total > 0 ? left*weight/total : left/open.size;
    const capped = [...open].filter(([,weight]) => share(weight) > maxRate);
    const floored = capped.length ? [] : [...open].filter(([,weight]) => share(weight) < floor);
    const fixed = capped.length ? capped.map(([id]) => [id,maxRate]) : floored.map(([id]) => [id,floor]);
    if (!fixed.length) { for (const [id,weight] of open) rates.set(id,share(weight)); break; }
    for (const [id,rate] of fixed) { rates.set(id,rate); open.delete(id); left -= rate; }
    left = Math.max(0,left);
  }
  return rates;
}

// Sweep demand per group from its activity profile (see Store.activityProfile) at Vietnam hour `hour`:
//  - posts the groups feed already delivered count 10%, missed ones 100%, so the sweep hunts feed blind spots;
//  - the 7-day hour-of-day histogram (3-hour window, shrunk toward the group's average times the account-wide
//    hour profile) scales demand to the current hour.
// Returns the weights and `load`, the account-wide activity of this hour relative to an average hour.
export function sweepWeights(profile,hour) {
  const window = hours => hours[(hour+23)%24]+hours[hour]+hours[(hour+1)%24];
  const totals = Array(24).fill(0);
  for (const item of profile.values()) item.hours.forEach((count,index) => { totals[index] += count; });
  const all = totals.reduce((sum,count) => sum+count,0);
  const load = all ? (window(totals)/3+1)/(all/24+1) : 1;
  const weights = new Map();
  for (const [id,item] of profile) {
    const average = item.hours.reduce((sum,count) => sum+count,0)/168;
    const now = average > 0 ? (window(item.hours)+21*average*load)/42/average : load;
    weights.set(id,((item.missed+0.1*(item.recent-item.missed))/48)*now+1/48);
  }
  return {weights,load};
}

export class Monitor {
  constructor({store,collector,api,config,tiktokAffiliate,log=console.warn,onChange}) {
    Object.assign(this,{store,collector,api,config,tiktokAffiliate,log,onChange});
    this.allowed = new Set(config.allowedUserIds);
    this.failures = new Map();
    this.abort = new AbortController();
    this.lastSent = new Map();
    this.scanning = new Set();
    this.historyScans = new Map();
    this.deferredOwners = new Map();
    this.plans = new Map();
    this.feeds = new Map();
    this.notifications = new Map();
    this.actionBackoff = new Map();
    this.commenterProgress = new Map();
  }
  // Busy groups are polled most often: the account's hourly budget is split by post rate (plus a floor of
  // one post per two days) within SCAN_MIN/MAX. Refreshed every 5 minutes or when a group is added.
  scanPlan(ownerId,now=Date.now(),groupId=null) {
    const cached = this.plans.get(ownerId);
    if (cached && now-cached.at < 300000 && (groupId === null || cached.intervals.has(groupId))) return cached.intervals;
    const profile = this.store.activityProfile?.(ownerId,{now}) ?? new Map();
    const {weights,load} = sweepWeights(profile,new Date(now+7*3600000).getUTCHours());
    const feedPerHour = this.config.feedPollMs > 0 ? 3600000/this.config.feedPollMs : 0;
    const notificationPerHour = this.config.notificationPollMs > 0 ? 3600000/Math.max(60000,this.config.notificationPollMs) : 0;
    const minMs = this.config.scanMinIntervalMs ?? 120000, maxMs = this.config.scanMaxIntervalMs ?? 1800000;
    // Feed/notification polls and incremental history passes cost ~2 requests per run on average (caps 4/3/3
    // pages; most stop on the first page at an already seen post), so they are reserved before the sweep.
    const historyPerHour = profile.size*3600000/(this.config.historyIntervalMs ?? 600000);
    // The sweep spends the whole budget around the clock; 5% of the cap stays free for comments and other actions.
    // The hour-of-day load still shifts requests toward the groups that are active now.
    const budget = Math.max(60,(this.config.apiMaxRequestsPerHour ?? 400)*0.95-2*(feedPerHour+notificationPerHour+historyPerHour));
    const allocated = allocateScanRates(weights,budget,{minRate:3600000/maxMs,maxRate:3600000/minMs});
    const recent = [...profile.values()].reduce((sum,item) => sum+item.recent,0), missed = [...profile.values()].reduce((sum,item) => sum+item.missed,0);
    const intervals = new Map([...allocated].map(([id,rate]) => [id,Math.round(3600000/rate)]));
    this.plans.set(ownerId,{at:now,intervals,load});
    const sorted = [...intervals.values()].sort((a,b) => a-b);
    const used = [...allocated.values()].reduce((sum,rate) => sum+rate,0);
    if (sorted.length) this.log(`[LỊCH QUÉT | Tài khoản ${ownerId}] ${sorted.length} nhóm, hệ số giờ ${load.toFixed(2)}, feed phủ ${recent ? Math.round(100*(recent-missed)/recent) : 0}% bài 48h, dùng ${Math.round(used)}/${Math.round(budget)} request/giờ; sôi động nhất ${Math.round(sorted[0]/1000)}s, ở giữa ${Math.round(sorted[sorted.length>>1]/1000)}s, im lặng nhất ${Math.round(sorted.at(-1)/1000)}s.${sorted.at(-1) > maxMs ? ' Quá nhiều nhóm so với ngân sách: vượt SCAN_MAX, nên tăng API_MAX_REQUESTS_PER_HOUR hoặc bớt nhóm.' : ''}`);
    return intervals;
  }
  async wait(ms) {
    await sleep(ms,undefined,{signal:this.abort.signal}).catch(error => {
      if (error.name !== 'AbortError') throw error;
    });
  }
  start() {
    const scanWorkers = this.config.scanWorkers ?? 4;
    const commentWorkers = this.config.commentWorkers ?? 4;
    const directMessageWorkers = this.config.directMessageWorkers ?? 4;
    const friendWorkers = this.config.friendWorkers ?? 2;
    const blockWorkers = this.config.blockWorkers ?? 3;
    this.running = Promise.all([
      ...Array.from({length: scanWorkers}, (_, index) => this.staggeredScanLoop(index)),
      ...Array.from({length: commentWorkers}, () => this.commentLoop()),
      ...Array.from({length: directMessageWorkers}, () => this.directMessageLoop()),
      ...Array.from({length: friendWorkers}, () => this.friendLoop()),
      this.deliveryLoop(),
      this.backgroundLoop(),
      ...(this.config.feedPollMs > 0 && this.collector.recentGroupPosts ? this.config.allowedUserIds.map(ownerId => this.feedLoop(ownerId)) : []),
      ...(this.config.notificationPollMs > 0 && this.collector.notificationGroups ? this.config.allowedUserIds.map(ownerId => this.notificationLoop(ownerId)) : []),
      ...(this.tiktokAffiliate ? [this.tikTokAutoLoop()] : []),
      ...(this.collector.blockUser && this.collector.collectCommentContacts ? Array.from({length: blockWorkers}, () => this.commenterBlockLoop()) : []),
    ]);
    return this.running;
  }
  async staggeredScanLoop(index) {
    if (index > 0) await this.wait(index * 100);
    return this.scanLoop();
  }
  // Fast lane: one chronological "Most recent groups" request covers every joined group. Facebook folds
  // bursts from one group, so each group seen there is also rescanned directly to catch the folded posts.
  async feedOnce(ownerId) {
    const state = this.feeds.get(ownerId) ?? {watermark:null};
    this.feeds.set(ownerId,state);
    const started = Date.now();
    const posts = await this.collector.recentGroupPosts(ownerId,{watermark:state.watermark});
    const groups = new Map();
    for (const group of this.store.listGroups(ownerId)) {
      if (group.paused || group.sourceType === 'profile') continue;
      const slug = group.url.match(/\/groups\/([^/]+)/)?.[1]?.toLowerCase();
      if (slug) groups.set(slug,group);
      if (group.numericId) groups.set(String(group.numericId),group);
    }
    const byGroup = new Map();
    for (const post of posts) {
      const group = groups.get(post.url.match(/\/groups\/([^/]+)/)?.[1]?.toLowerCase());
      if (group) byGroup.set(group,[...(byGroup.get(group) ?? []),post]);
    }
    let created = 0;
    for (const [group,list] of byGroup) {
      const fresh = this.store.observe(group,list,{...this.options(),finalize:false,advanceWatermark:false,fromFeed:true}) || 0;
      created += fresh;
      if (fresh) this.store.scanSoon?.(group.id);
    }
    const newest = Math.max(...posts.map(post => Date.parse(post.publishedAt)).filter(Number.isFinite));
    if (Number.isFinite(newest)) state.watermark = Math.max(state.watermark ?? 0,Math.min(newest,Date.now()));
    if (created) { this.commentWake?.(); this.directMessageWake?.(); this.friendWake?.(); }
    this.log(`[FEED GẦN ĐÂY | Tài khoản ${ownerId}] ${posts.length} bài, ${created} bài mới${byGroup.size ? ` từ ${byGroup.size} nhóm` : ''} (${Date.now()-started} ms)`);
    return created;
  }
  async feedLoop(ownerId) {
    let failures=0;
    while (!this.abort.signal.aborted) {
      if (this.canScan(ownerId) && !((this.deferredOwners.get(ownerId) ?? 0) > Date.now())) {
        try { await this.feedOnce(ownerId); failures=0; }
        catch (error) {
          if (error?.code === 'SCAN_DEFERRED') this.deferredOwners.set(ownerId,error.retryAt);
          else { failures++; this.log(`[FEED GẦN ĐÂY | Tài khoản ${ownerId}] ${safeError(error)}`); }
        }
      }
      // A dead lane (no template, outage) backs off 1 min doubling to 30 min instead of logging every poll.
      await this.wait(failures ? Math.min(1800000,Math.max(60000,this.config.feedPollMs)*2**Math.min(failures-1,5)) : this.config.feedPollMs);
    }
  }

  async notificationOnce(ownerId, now=Date.now()) {
    if (!this.allowed.has(ownerId) || this.abort.signal.aborted) return 0;
    const previous = this.notifications.get(ownerId);
    const state = previous ?? {seen:new Set(),pending:new Map(),boosted:new Map(),unknown:new Set()};
    const groups = new Map(), byId = new Map(), owned = new Set();
    for (const group of this.store.listGroups(ownerId)) {
      const slug = group.url.match(/\/groups\/([^/]+)/)?.[1]?.toLowerCase();
      if (slug) owned.add(slug);
      if (group.numericId) owned.add(String(group.numericId));
      if (group.paused || group.sourceType === 'profile') continue;
      byId.set(group.id,group);
      if (slug) groups.set(slug,group);
      if (group.numericId) groups.set(String(group.numericId),group);
    }
    const keyOf = hint => `${groups.get(hint.groupKey)?.id ?? hint.groupKey}:${hint.postId}`;
    const hints = await this.collector.notificationGroups(ownerId,{maxPages:previous?3:1,isKnown:hint => state.seen.has(keyOf(hint))});
    if (this.abort.signal.aborted) return 0;
    this.notifications.set(ownerId,state);
    const interval = Math.max(60000,this.config.notificationPollMs || 120000);
    // Larger hourly budgets can afford more early scans per poll; 10% of the budget is the ceiling.
    const cap = Math.max(3,Math.round((this.config.apiMaxRequestsPerHour ?? 400)*0.1*interval/3600000));
    let fresh=0, boosted=0;
    const unknown = [];
    for (const hint of hints) {
      const group = groups.get(hint.groupKey);
      const key = keyOf(hint);
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      if (!previous) continue; // Baseline prevents old notifications replaying on restart.
      fresh++;
      if (group) state.pending.set(key,{groupId:group.id,postId:hint.postId,at:now});
      else if (!owned.has(hint.groupKey) && !state.unknown.has(hint.groupKey)) { state.unknown.add(hint.groupKey); unknown.push(hint.groupKey); }
    }
    while (state.unknown.size>500) state.unknown.delete(state.unknown.values().next().value);
    if (unknown.length) this.log(`[THÔNG BÁO | Tài khoản ${ownerId}] Có bài mới ở ${unknown.length} nhóm chưa thêm vào bot: ${unknown.slice(0,5).map(key => `facebook.com/groups/${key}`).join(', ')}${unknown.length>5?', ...':''}`);
    // Signals skipped by the per-poll cap, an in-flight scan or the group cooldown stay pending instead of being lost.
    for (const [key,item] of state.pending) {
      const group = byId.get(item.groupId);
      if (!group || now-item.at>1800000 || this.store.hasObservedPost(ownerId,group.id,item.postId)) { state.pending.delete(key); continue; }
      if (boosted>=cap || this.scanning.has(group.id) || now-(state.boosted.get(group.id) ?? -Infinity)<300000) continue;
      if (this.store.scanSoon(group.id)) {
        state.boosted.set(group.id,now);
        boosted++;
      }
      for (const [other,entry] of state.pending) if (entry.groupId === group.id) state.pending.delete(other);
    }
    while (state.seen.size>2000) state.seen.delete(state.seen.values().next().value);
    for (const [id,at] of state.boosted) if (now-at>=300000) state.boosted.delete(id);
    this.log(`[THÔNG BÁO | Tài khoản ${ownerId}] ${hints.length} link bài, ${fresh} tín hiệu mới, ưu tiên ${boosted} nhóm${state.pending.size?`, chờ ${state.pending.size}`:''}${previous?'':' (khởi tạo mốc, chưa ưu tiên)'}.`);
    return boosted;
  }

  async notificationLoop(ownerId) {
    const interval=Math.max(60000,this.config.notificationPollMs);
    let failures=0;
    while (!this.abort.signal.aborted) {
      if (this.canScan(ownerId) && !((this.deferredOwners.get(ownerId) ?? 0)>Date.now())) {
        try { await this.notificationOnce(ownerId); failures=0; }
        catch (error) {
          failures++;
          if (error.code==='SCAN_DEFERRED') this.deferredOwners.set(ownerId,error.retryAt);
          else this.log(`[THÔNG BÁO | Tài khoản ${ownerId}] Tạm hoãn đọc thông báo: ${safeError(error)}`);
        }
      }
      // Quiet hours poll less often, on the same hour-of-day load factor as the group scan plan.
      const load = Math.min(1,Math.max(0.3,this.plans.get(ownerId)?.load ?? 1));
      await this.wait(failures ? Math.min(1800000,Math.max(300000,interval)*2**Math.min(failures-1,3)) : Math.round(interval/load));
    }
  }
  options() {
    return {metricWindowMs:this.config.metricWindowMs,render:formatPost,matches:matchesKeywords};
  }
  canScan(ownerId, probe = true) {
    return this.collector?.canScan?.(ownerId, probe) ?? true;
  }
  activeFacebookOwners() {
    return this.config.allowedUserIds.filter(ownerId => this.canScan(ownerId, false));
  }
  // With FACEBOOK_COOLDOWN_MS=0 nothing else keeps a held action from retrying every 200 ms, so each account
  // and action kind backs off 1 min doubling to 30 min, never before the hourly cap's retryAt.
  actionOwners(kind, now = Date.now()) {
    return this.activeFacebookOwners().filter(ownerId => !((this.actionBackoff.get(`${kind}:${ownerId}`)?.until ?? 0) > now));
  }
  holdAction(kind, ownerId, error, now = Date.now()) {
    const key = `${kind}:${ownerId}`, previous = this.actionBackoff.get(key);
    const delay = previous ? Math.min(1800000, previous.delay*2) : 60000;
    const until = Math.max(now+delay, Number(error?.retryAt) || 0);
    this.actionBackoff.set(key, {delay, until});
    return until;
  }
  scanOptions(group, background = false, stats = {created:0}) {
    return {
      contentType: group.contentType,
      latest: !background && group.initialized, background,
      numericId: group.numericId, watermark: group.lastSeenTime ?? null,
      onGroupId: id => this.store.setNumericId?.(group.id,id),
      shouldContinue: () => {
        const current = this.store.getGroup(group.id);
        return !this.abort.signal.aborted && current && !current.paused && current.contentType === group.contentType && JSON.stringify(current.dateRange) === JSON.stringify(group.dateRange);
      },
      onPosts: async posts => {
        if (this.abort.signal.aborted) return;
        stats.created += this.store.observe(group,posts,{...this.options(),finalize:false}) || 0;
        this.commentWake?.();
        this.directMessageWake?.();
        this.friendWake?.();
        await Promise.resolve();
      },
    };
  }
  async scanLoop() {
    while (!this.abort.signal.aborted) {
      const now = Date.now();
      const eligible = group => {
        const failure = this.failures.get(group.id);
        return this.canScan(group.ownerId) && !this.scanning.has(group.id) && !((this.deferredOwners.get(group.ownerId) ?? 0) > now) && (!failure || group.lastScanAt === null || now >= failure.retryAt);
      };
      const group = this.store.dueGroups(this.config.allowedUserIds,now-this.config.pollIntervalMs,now,eligible).find(eligible);
      if (group) {
        this.scanning.add(group.id);
        try {
          const stats = {created:0}, started = Date.now();
          const posts = await this.collector.collect(group.ownerId,group.url,null,this.scanOptions(group,false,stats));
          if (!posts.length) throw new Error('Không đọc được bài nào; cần kiểm tra quyền truy cập hoặc bộ đọc Facebook.');
          stats.created += this.store.observe(group,posts,this.options()) || 0;
          this.log(`[QUÉT NHÓM #${group.id}] ${posts.length} bài, ${stats.created} bài mới (${Date.now()-started} ms)`);
          // Active groups are polled at the minimum interval; quiet ones back off up to the maximum.
          this.store.scheduleScan?.(group.id,stats.created > 0,{minMs:this.config.scanMinIntervalMs ?? 120000,maxMs:this.config.scanMaxIntervalMs ?? 1800000,
            plannedMs:this.scanPlan(group.ownerId,Date.now(),group.id).get(group.id) ?? null});
          this.commentWake?.();
          this.directMessageWake?.();
          this.friendWake?.();
          // Give the awakened worker a turn to enqueue its priority browser job.
          await Promise.resolve();
          this.failures.delete(group.id);
        } catch (error) {
          // The per-account request cap was reached: postpone that account, not an error.
          if (error?.code === 'SCAN_DEFERRED') {
            if (!((this.deferredOwners.get(group.ownerId) ?? 0) > Date.now())) this.log(`[TẠM HOÃN | Tài khoản ${group.ownerId}] Đã chạm trần API_MAX_REQUESTS_PER_HOUR; quét tiếp lúc ${vnTime(error.retryAt)}.`);
            this.deferredOwners.set(group.ownerId,error.retryAt);
            continue;
          }
          const message = safeError(error);
          const attempts = (this.failures.get(group.id)?.attempts || 0)+1;
          // An empty/private/left group stays empty for a while: back off up to SCAN_MAX, not every minute.
          const empty = error?.code === 'EMPTY_FEED';
          this.failures.set(group.id,{attempts,retryAt:Date.now()+Math.min(empty ? this.config.scanMaxIntervalMs ?? 1800000 : 60000,this.config.pollIntervalMs*2**Math.min(attempts-1,empty ? 10 : 3))});
          this.store.recordScanError(group.id,message);
          this.log(`\n[QUÉT NHÓM #${group.id}] ${group.url}\n  ${message}\n  Lần lỗi liên tiếp: ${attempts} (sẽ tự động gọi lại liên tục)`);
        } finally {
          this.scanning.delete(group.id);
        }
      }
      if (this.abort.signal.aborted) break;
      await this.wait(group ? 10 : 250);
    }
  }
  checkMemory() {
    try {
      const mem = process.memoryUsage();
      const heapMB = Math.round(mem.heapUsed / (1024 * 1024));
      if (heapMB > 1024) {
        this.log(`\n[BỘ NHỚ] Heap sử dụng cao (${heapMB} MB). Đang kích hoạt dọn dẹp và tái tạo trình duyệt...`);
        this.collector?.recycle?.().catch(() => {});
        if (typeof global.gc === 'function') {
          try { global.gc(); } catch {}
        }
      }
    } catch {}
  }
  async backgroundLoop() {
    let lastMemCheck = 0, lastPrune = 0;
    while (!this.abort.signal.aborted) {
      const now = Date.now();
      if (now - lastMemCheck >= 60000) {
        lastMemCheck = now;
        this.checkMemory();
      }
      // Keeps the posts table (scanned by activityProfile every 5 minutes) bounded.
      if (this.store.prunePosts && now - lastPrune >= 3600000) {
        lastPrune = now;
        try {
          const pruned = this.store.prunePosts(Math.max(this.config.metricWindowMs ?? 0,7*86400000),now);
          if (pruned) this.log(`[DỌN DỮ LIỆU] Đã xoá ${pruned} bài cũ không còn dùng.`);
        } catch (error) { this.log(`[DỌN DỮ LIỆU] ${safeError(error)}`); }
      }
      const group = this.store.allActiveGroups().filter(group => {
        const previous = this.historyScans.get(group.id);
        return this.canScan(group.ownerId, false) && !((this.deferredOwners.get(group.ownerId) ?? 0) > now) && group.initialized && this.allowed.has(group.ownerId) && (!previous || previous.range !== JSON.stringify(group.dateRange)
          || now-previous.at >= (this.config.historyIntervalMs ?? 600000));
      }).sort((a,b) => (this.historyScans.get(a.id)?.at ?? 0)-(this.historyScans.get(b.id)?.at ?? 0))[0];
      if (group) {
        const range = JSON.stringify(group.dateRange), previous = this.historyScans.get(group.id);
        // A closed range is paged back to its start once per range; later passes (and open ranges) are incremental.
        let backfilled = previous?.backfilled ?? null;
        const backfill = isHistoricalDateRange(group.dateRange) && backfilled !== range;
        try {
          const posts = await this.collector.collect(group.ownerId,group.url,group.dateRange,{...this.scanOptions(group,true),backfill});
          if (backfill) backfilled = range;
          this.store.observe(group,posts,{...this.options(),finalize:false});
          this.commentWake?.();
          this.directMessageWake?.();
          this.friendWake?.();
        } catch (error) {
          if (error?.code === 'SCAN_DEFERRED') this.deferredOwners.set(group.ownerId,error.retryAt);
          else this.log(`\n[QUÉT LỊCH SỬ #${group.id}] ${group.url}\n  ${safeError(error)}`);
        } finally {
          this.historyScans.set(group.id,{at:Date.now(),range,backfilled});
        }
      }
      // Post metrics/text are refreshed by store.observe when a feed scan sees the post again,
      // so no per-post permalink pass is needed.
      await this.wait(group ? 250 : 1000);
    }
  }
  async deliverOne() {
    const item = this.store.nextDelivery(Date.now(),this.config.allowedUserIds);
    if (!item) return false;
    const group = this.store.getGroup(item.group_id);
    const post = JSON.parse(item.data_json);
    const keywords = group ? this.store.effectiveKeywords(group) : [];
    const rejectKeywords = group ? this.store.effectiveRejectKeywords(group) : [];
    if (!group || !matchesKeywords(post.text,keywords,rejectKeywords) || !matchesDateRange(post,group.dateRange)) {
      this.store.cancelDelivery(item);
      return true;
    }
    const currentBody = formatPost(group,post,keywords);
    if (currentBody !== item.body) {
      this.store.replaceDeliveryBody(item,currentBody);
      item.body = currentBody;
    }
    if (item.body === item.sent_body) return true;
    const throttle = 1100-(Date.now()-(this.lastSent.get(item.chat_id) || 0));
    if (throttle > 0) {
      this.store.deferDelivery(item,throttle);
      return true;
    }
    try {
      let messageId = item.message_id;
      if (messageId) {
        await this.api.editMessageText(item.chat_id,messageId,item.body,{link_preview_options:{is_disabled:true},reply_markup:postMarkup(this.store,item.owner_id,post)});
      } else {
        const sent = await this.api.sendMessage(item.chat_id,item.body,{link_preview_options:{is_disabled:true},reply_markup:postMarkup(this.store,item.owner_id,post)});
        messageId = sent.message_id;
      }
      this.store.delivered(item,messageId);
      this.log(`[TELEGRAM] ${item.message_id ? 'Cập nhật' : 'Đã gửi'} bài ${item.post_id} · nhóm #${item.group_id}`);
      this.lastSent.set(item.chat_id,Date.now());
    } catch (error) {
      const description = String(error?.description || '');
      if (description.includes('message is not modified')) {
        this.store.delivered(item,item.message_id);
      } else if (item.message_id && /message to edit not found|message can't be edited/i.test(description)) {
        this.store.resetMessage(item);
        this.store.deliveryFailed(item,5000);
      } else {
        const retryAfter = Number(error?.parameters?.retry_after);
        const delay = retryAfter > 0 ? retryAfter*1000+1000 : Math.min(3600000,5000*2**Math.min(item.attempts,10));
        this.store.deliveryFailed(item,delay);
        if (error?.error_code === 429) await this.wait(delay);
        this.log(`Gửi Telegram thất bại (sẽ thử lại): ${safeError(error)}`);
      }
    }
    return true;
  }
  // Low priority: only runs when no normal delivery is due, so rejected-post notes never delay real posts.
  async deliverRejected() {
    const item = this.store.nextRejected(Date.now(),this.config.allowedUserIds);
    if (!item) return false;
    const throttle = 1100-(Date.now()-(this.lastSent.get(item.chat_id) || 0));
    if (throttle > 0) {
      this.store.deferRejected(item,throttle);
      return true;
    }
    try {
      const sent = await this.api.sendMessage(item.chat_id,item.body,{
        link_preview_options:{is_disabled:true},reply_markup:rejectedMarkup(this.store,item.owner_id,JSON.parse(item.data_json)),
      });
      this.store.mapMessage(item.owner_id,item.chat_id,sent.message_id,item.group_id,item.post_id,'rejected');
      this.store.rejectedSent(item);
      this.lastSent.set(item.chat_id,Date.now());
    } catch (error) {
      const retryAfter = Number(error?.parameters?.retry_after);
      const delay = retryAfter > 0 ? retryAfter*1000+1000 : Math.min(3600000,5000*2**Math.min(item.attempts,10));
      this.store.rejectedFailed(item,delay);
      if (error?.error_code === 429) await this.wait(delay);
      this.log(`Gửi thông báo bài bị loại thất bại: ${safeError(error)}`);
    }
    return true;
  }
  async deliverMedia() {
    const item = this.store.nextMedia(this.config.allowedUserIds);
    if (!item) return false;
    const group = this.store.getGroup(item.group_id), post = JSON.parse(item.post_json);
    if (!group || !matchesKeywords(post.text,this.store.effectiveKeywords(group),this.store.effectiveRejectKeywords(group)) || !matchesDateRange(post,group.dateRange)) {
      this.store.mediaState(item,'cancelled'); return true;
    }
    if (Date.now()-(this.lastSent.get(item.chat_id) || 0) < 1100) return false;
    const media = JSON.parse(item.data_json);
    const options = {caption:`${media.type === 'video' ? '🎬 Video' : '📷 Ảnh'} · bài ${item.post_id}\n${post.url}\nReply tin này để bình luận bài Facebook.`,reply_parameters:{message_id:item.message_id,allow_sending_without_reply:true}};
    options.reply_markup = postMarkup(this.store,item.owner_id,post);
    this.store.mediaState(item,'sending');
    try {
      let sent;
      try {
        if (media.type === 'video' && media.url) sent = await this.api.sendVideo(item.chat_id,media.url,options);
        else if (media.url || media.preview) sent = await this.api.sendPhoto(item.chat_id,media.url || media.preview,
          {...options,caption:media.type === 'video' ? `${options.caption}\nẢnh xem trước; mở link để xem video.` : options.caption});
        else sent = await this.api.sendMessage(item.chat_id,`🎬 Video không có đường dẫn phát trực tiếp. Xem tại: ${post.url}`,{reply_parameters:options.reply_parameters,reply_markup:options.reply_markup});
      } catch(error) {
        if (error.error_code !== 400) throw error;
        sent = await this.api.sendMessage(item.chat_id,`Không tải được ${media.type === 'video' ? 'video' : 'ảnh'} vào Telegram. Xem trong bài: ${post.url}`,{reply_parameters:options.reply_parameters,reply_markup:options.reply_markup});
      }
      this.store.mapMessage(item.owner_id,item.chat_id,sent.message_id,item.group_id,item.post_id);
      this.store.mediaState(item,'sent');
    } catch(error) {
      this.store.mediaState(item,'failed');
      this.log(`Không gửi được media bài ${item.post_id}: ${safeError(error)}`);
    }
    this.lastSent.set(item.chat_id,Date.now());
    return true;
  }
  async commentOne() {
    const item = this.store.nextComment(this.actionOwners('comment'));
    if (!item) return false;
    if (!this.store.canComment(item)) { this.store.commentState(item.id,'cancelled'); return true; }
    this.store.commentState(item.id,'sending');
    this.log(`[BÌNH LUẬN #${item.id}] Đang gửi vào bài ${item.post_id} · nhóm #${item.group_id}`);
    let message;
    try {
      await this.collector.comment(item.owner_id,JSON.parse(item.data_json).url,spinText(item.body) || item.body,
        () => !this.abort.signal.aborted && this.store.canComment(item));
      this.store.commentState(item.id,'sent');
      this.actionBackoff.delete(`comment:${item.owner_id}`);
      message = `Đã đăng bình luận #${item.id} vào bài ${item.post_id}.`;
      this.log(`[BÌNH LUẬN #${item.id}] ${message}`);
    } catch(error) {
      // The hourly cap throws SCAN_DEFERRED before any request is sent.
      if (error.code === 'FACEBOOK_COOLDOWN' || error.code === 'SCAN_DEFERRED' || (error.code === 'RATE_LIMITED' && error.commentSubmitted === false)) {
        this.store.commentState(item.id,'pending');
        this.log(`\n[BÌNH LUẬN #${item.id}] Gặp giới hạn tần suất Facebook; giữ trạng thái pending${isActionHold(error) ? `, thử lại lúc ${vnTime(this.holdAction('comment',item.owner_id,error))}` : ''}.`);
        return false;
      }
      if (isActionHold(error)) this.holdAction('comment',item.owner_id,error);
      const state = error.commentSubmitted === false ? 'failed' : 'uncertain';
      this.store.commentState(item.id,state,safeError(error));
      this.log(`\n[BÌNH LUẬN #${item.id}] ${state === 'failed' ? 'Chưa gửi được' : 'Chưa xác nhận đã đăng'}: ${safeError(error)}`);
    }
    // Telegram only reports successes; failures stay in the log and /comments.
    if (message) try { await this.api.sendMessage(item.chat_id,message); } catch { /* Status remains available through /comments. */ }
    return true;
  }
  async commentLoop() {
    const interval = this.config.commentIntervalMs ?? 200;
    while (!this.abort.signal.aborted) {
      const worked = await this.commentOne();
      if (worked) {
        if (interval > 0) await this.wait(interval);
      } else {
        if (this.store.nextComment(this.actionOwners('comment'))) await this.wait(200);
        await this.waitForComments();
      }
    }
  }
  async directMessageOne() {
    const item = this.store.nextDirectMessage(this.actionOwners('message'));
    if (!item) return false;
    if (!this.store.canDirectMessage(item)) {
      this.store.directMessageState(item.id, 'cancelled');
      return true;
    }
    this.store.directMessageState(item.id, 'sending');
    this.log(`[TIN NHẮN RIÊNG #${item.id}] Đang gửi cho ${item.recipient_name || 'người đăng'} (bài ${item.post_id})`);
    let message;
    try {
      const result = await this.collector.directMessage(item.owner_id, item.recipient_url, item.body,
        () => !this.abort.signal.aborted && this.store.canDirectMessage(item), { callAfter: true });
      const now = Date.now();
      this.store.directMessageState(item.id, 'sent', null, now);
      this.actionBackoff.delete(`message:${item.owner_id}`);
      const callNote = result?.called ? ' 📞 Đã nháy máy (3s).' : (result?.callNote ? ` (${result.callNote})` : '');
      this.log(`[TIN NHẮN RIÊNG #${item.id}] Đã gửi cho ${item.recipient_name || 'người đăng'}${callNote}`);
      message = `📩 Đã gửi tin nhắn riêng cho ${item.recipient_name || 'người đăng'} (bài #${item.post_id}):\n"${item.body.length > 150 ? item.body.slice(0, 147) + '...' : item.body}"${callNote}`;
    } catch(error) {
      if ((isActionHold(error) || error.code === 'FACEBOOK_COOLDOWN') && error.commentSubmitted !== true) {
        this.store.directMessageState(item.id, 'pending');
        this.log(`\n[TIN NHẮN RIÊNG #${item.id}] Gặp giới hạn tần suất Facebook; giữ trạng thái pending${isActionHold(error) ? `, thử lại lúc ${vnTime(this.holdAction('message', item.owner_id, error))}` : ''}.`);
        return false;
      }
      if (isActionHold(error)) this.holdAction('message', item.owner_id, error);
      // Only an explicit rejection is final; a send that may have reached Facebook must not be repeated.
      const state = error.commentSubmitted === false ? 'failed' : 'uncertain';
      this.store.directMessageState(item.id, state, safeError(error));
      this.log(`\n[TIN NHẮN RIÊNG #${item.id}] ${state === 'failed' ? 'Thất bại' : 'Chưa xác nhận đã gửi'} với ${item.recipient_name || 'người đăng'}: ${safeError(error)}`);
    }
    if (message) try { await this.api.sendMessage(item.chat_id, message); } catch { /* Ignore Telegram notification failures. */ }
    return true;
  }
  async directMessageLoop() {
    const interval = this.config.directMessageIntervalMs ?? 200;
    while (!this.abort.signal.aborted) {
      const worked = await this.directMessageOne();
      if (worked) {
        if (interval > 0) await this.wait(interval);
      } else {
        if (this.store.nextDirectMessage(this.actionOwners('message'))) await this.wait(200);
        await this.waitForDirectMessages();
      }
    }
  }
  #directMessageWakers = new Set();
  waitForDirectMessages() {
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.store.nextDirectMessage(this.actionOwners('message'))) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', done);
        this.#directMessageWakers.delete(done);
        if (this.#directMessageWakers.size === 0) this.directMessageWake = null;
        resolve();
      };
      this.#directMessageWakers.add(done);
      this.directMessageWake = () => {
        for (const wake of [...this.#directMessageWakers]) wake();
        this.#directMessageWakers.clear();
        this.directMessageWake = null;
      };
      const timer = setTimeout(done, 500);
      this.abort.signal.addEventListener('abort', done, { once: true });
    });
  }
  async friendOne() {
    const item = this.store.nextFriendRequest(this.actionOwners('friend'));
    if (!item) return false;
    if (!this.store.canFriendRequest(item)) {
      this.store.friendRequestState(item.id, 'cancelled');
      return true;
    }
    this.store.friendRequestState(item.id, 'sending');
    this.log(`[KẾT BẠN #${item.id}] Đang xử lý ${item.recipient_name || 'người đăng'} (bài ${item.post_id})`);
    let message;
    try {
      const result = await this.collector.friendRequest(item.owner_id, item.recipient_url,
        () => !this.abort.signal.aborted && this.store.canFriendRequest(item));
      const now = Date.now();
      this.store.friendRequestState(item.id, 'sent', null, now);
      this.actionBackoff.delete(`friend:${item.owner_id}`);
      const note = result?.note ? ` (${result.note})` : '';
      const actionDesc = result?.state === 'accepted' ? 'Đã chấp nhận kết bạn với'
        : result?.state === 'already_friends' ? 'Đã là bạn bè với'
        : result?.state === 'already_requested' ? 'Đã có lời mời kết bạn từ trước với'
        : 'Đã gửi lời mời kết bạn tới';
      this.log(`[KẾT BẠN #${item.id}] ${actionDesc} ${item.recipient_name || 'người đăng'}${note}`);
      message = `🤝 ${actionDesc} ${item.recipient_name || 'người đăng'} (bài #${item.post_id}):\nTrang cá nhân: ${item.recipient_url}${note}`;
    } catch(error) {
      if ((isActionHold(error) || error.code === 'FACEBOOK_COOLDOWN') && error.commentSubmitted !== true) {
        this.store.friendRequestState(item.id, 'pending');
        this.log(`\n[KẾT BẠN #${item.id}] Gặp giới hạn tần suất Facebook; giữ trạng thái pending${isActionHold(error) ? `, thử lại lúc ${vnTime(this.holdAction('friend', item.owner_id, error))}` : ''}.`);
        return false;
      }
      if (isActionHold(error)) this.holdAction('friend', item.owner_id, error);
      const state = error.commentSubmitted === false ? 'failed' : 'uncertain';
      this.store.friendRequestState(item.id, state, safeError(error));
      this.log(`\n[KẾT BẠN #${item.id}] ${state === 'failed' ? 'Thất bại' : 'Chưa xác nhận đã gửi'} với ${item.recipient_name || 'người đăng'}: ${safeError(error)}`);
    }
    if (message) try { await this.api.sendMessage(item.chat_id, message); } catch { /* Ignore Telegram notification failures. */ }
    return true;
  }
  async friendLoop() {
    const interval = this.config.friendIntervalMs ?? 200;
    while (!this.abort.signal.aborted) {
      const worked = await this.friendOne();
      if (worked) {
        if (interval > 0) await this.wait(interval);
      } else {
        if (this.store.nextFriendRequest(this.actionOwners('friend'))) await this.wait(200);
        await this.waitForFriendRequests();
      }
    }
  }
  #friendWakers = new Set();
  waitForFriendRequests() {
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.store.nextFriendRequest(this.actionOwners('friend'))) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', done);
        this.#friendWakers.delete(done);
        if (this.#friendWakers.size === 0) this.friendWake = null;
        resolve();
      };
      this.#friendWakers.add(done);
      this.friendWake = () => {
        for (const wake of [...this.#friendWakers]) wake();
        this.#friendWakers.clear();
        this.friendWake = null;
      };
      const timer = setTimeout(done, 500);
      this.abort.signal.addEventListener('abort', done, { once: true });
    });
  }
  async tikTokAutoOne() {
    const job=this.store.nextTikTokJob(this.config.allowedUserIds);
    if(!job) return false;
    const options=JSON.parse(job.config_json),account=this.tiktokAffiliate?.accountKey(job.owner_id);
    if(!this.store.canTikTokJob(job) || account!==options.accountKey) {
      this.store.tikTokJobState(job,'cancelled');return true;
    }
    this.store.tikTokJobState(job,'working');
    let message;
    try {
      const result=await this.tiktokAffiliate.topOffers(job.owner_id,options);
      if(this.abort.signal.aborted) {this.store.tikTokJobState(job,'pending');return true;}
      const queued=this.store.finishTikTokJob(job,result.offers,account);
      if(queued===null) return true;
      this.commentWake?.();
      message=`TikTok tự động · nguồn #${job.group_id} · bài ${job.post_id}: đã xếp ${queued}/${options.count} bình luận từ top ${result.scanned} sản phẩm đọc được. /comments để xem; /tiktokauto ${job.group_id} off để tắt.`;
    } catch {
      this.store.tikTokJobState(job,'failed','Không lấy/xếp được link TikTok. Kiểm tra cấu hình và quyền API.');
      this.log(`\n[TIKTOK TỰ ĐỘNG] Nguồn #${job.group_id} · bài ${job.post_id}: chưa xếp bình luận.`);
    }
    if(message) try {await this.api.sendMessage(job.chat_id,message);} catch { /* Avoid retrying already persisted comments. */ }
    return true;
  }
  async tikTokAutoLoop() {
    while(!this.abort.signal.aborted) {
      const worked=await this.tikTokAutoOne();
      await this.wait(worked?30000:2000);
    }
  }
  // Single pass over the commenters readable at run time. Blocks go one by one; a rate limit, session problem
  // or 3 errors in a row end the job so the account is not hammered. Per-profile blocked_authors states make
  // re-pressing safe: profiles already blocked, in progress or unconfirmed are never submitted again.
  // In-memory only: the job row is written once at the end, so live progress never touches result_json.
  setCommenterProgress(id, patch) { this.commenterProgress.set(id, {...this.commenterProgress.get(id), ...patch, at: Date.now()}); this.onChange?.(); }
  commenterBlockProgress(id) { const value = this.commenterProgress.get(id); return value ? structuredClone(value) : null; }
  // Jobs of one owner with their queue position and wait reason; owners on hold/cooldown are skipped by the workers, so they leave the queue order.
  commenterBlockWaits(ownerId, {now = Date.now(), limit = 20, postUrl = null, jobs = null, stopped = false} = {}) {
    const limiter = this.collector?.graphql?.limiter;
    return commenterBlockWaits(this.store, ownerId, {now, limit, postUrl, jobs, stopped, workers: this.config.blockWorkers ?? 3, ownerIds: this.actionOwners('block', now),
      blocked: (owner, at) => {
        const hold = this.actionBackoff.get(`block:${owner}`)?.until ?? 0;
        if (!this.canScan(owner, false)) return {reason: 'cooldown', until: this.collector?.cooldown?.state?.(owner)?.retryAt ?? null};
        return hold > at ? {reason: 'hold', until: hold} : null;
      },
      budgetUntil: owner => limiter?.lowBudgetUntil?.(owner) ?? null});
  }
  // Several loops share this: nextCommenterBlockJob and the 'running' write below are synchronous (no await between), so no job is taken twice.
  async commenterBlockOne(now = Date.now()) {
    const job = this.store.nextCommenterBlockJob(now, this.actionOwners('block', now));
    if (!job) return false;
    const target = (job.messageId && this.store.replyTarget(job.ownerId, job.chatId, job.messageId)) || this.store.commenterBlockTarget(job);
    const post = target?.post.url === job.postUrl ? target.post : null;
    if (job.state === 'interrupted' || !post) {
      this.store.commenterBlockJobState(job.id, post ? 'stopped' : 'failed', job.result, post ? 'Bot dừng giữa chừng.' : 'Bài không còn trong dữ liệu.');
      if (post) await this.reportCommenterBlock(job, target, `⚠️ Bot đã dừng khi đang chặn người comment bài #${job.postId}. Người đang chặn dở được ghi "chưa xác nhận" và không bị gửi lại; bấm lại nút để chặn tiếp những người chưa xử lý.`);
      return true;
    }
    this.store.commenterBlockJobState(job.id, 'running');
    this.setCommenterProgress(job.id, {phase: 'reading', pages: 0, comments: 0});
    await this.reportCommenterBlock(job, target);
    const active = () => {
      const group = this.store.getGroup(job.groupId);
      return !this.abort.signal.aborted && group && !group.paused && (!job.repeatUntil || group.autoBlock) && this.store.commenterBlockJob(job.ownerId, job.postUrl)?.state === 'running';
    };
    const counts = {blocked: 0, skipped: 0, unknown: 0, unresolved: 0, uncertain: 0, failed: 0, pending: 0};
    const holds = error => isActionHold(error) || error?.code === 'FACEBOOK_COOLDOWN' || error?.code === 'FACEBOOK_SESSION';
    let stop = null, lastError = null, scanned = 0, incomplete = false;
    // A read deferred by the hourly cap saved its cursor and commenters; it is kept until a read ends otherwise.
    const resume = job.result?.progress?.at > Date.now() - COMMENTER_PROGRESS_TTL_MS ? job.result.progress : null;
    let progress = resume;
    this.log(`[CHẶN NGƯỜI COMMENT #${job.id}] Đang đọc bình luận bài ${job.postId}.`);
    try {
      let comments = [];
      // partial=false: a list cut short by a rate limit is never blocked as if it were complete. A list the reader
      // could not page past (complete: false) is blocked but the job stays unfinished and says so.
      try {
        const read = await this.collector.collectCommentContacts(job.ownerId, job.postUrl, {passes: COMMENTER_SCAN_PASSES, partial: false, low: true, canContinue: active, onProgress: ({pages, comments}) => this.setCommenterProgress(job.id, {phase: 'reading', pages, comments}), ...(resume ? {resume} : {})});
        comments = read.comments ?? []; incomplete = read.complete === false; progress = null;
      } catch (error) {
        if (error?.code !== 'NO_COMMENTS') { progress = error?.progress ?? progress; throw error; }
        progress = null;
      }
      scanned = comments.length;
      const accountId = scanned ? await this.collector.accountId?.(job.ownerId, {low: true}) : null;
      const {profiles, unknown} = scanned ? commenterProfiles(comments, {post, accountId}) : {profiles: [], unknown: 0};
      counts.unknown = unknown;
      this.setCommenterProgress(job.id, {phase: 'blocking', total: profiles.length, index: 0, counts: {...counts}});
      // Vanity URLs (the author's too) resolve lazily, one request right before use, so a stopped job wastes none;
      // the author and self checks are repeated on the resolved IDs.
      const author = postAuthorProfile(post), self = numericProfile(accountId), seen = new Set();
      if (profiles.length && !self) throw new Error('Chưa xác định được tài khoản bot; dừng để tránh chặn nhầm.');
      const resolve = async url => this.collector.resolveProfileId ? numericProfile(await this.collector.resolveProfileId(job.ownerId, url, {low: true})) : null;
      let authorId = isNumericProfile(author) ? author : null, authorPending = Boolean(author) && !authorId;
      if (profiles.length && !author) throw new Error('Chưa xác định được người đăng bài; dừng để tránh chặn nhầm.');
      let errors = 0, attempted = false;
      for (const [index, candidate] of profiles.entries()) {
        if (attempted) {
          const pause = commenterBlockPauseMs(this.random, this.config.blockIntervalMs ?? COMMENTER_BLOCK_PAUSE_MIN_MS);
          this.setCommenterProgress(job.id, {phase: 'waiting', waitUntil: Date.now() + pause, index, counts: {...counts}});
          await this.wait(pause);
        }
        attempted = false;
        this.setCommenterProgress(job.id, {phase: 'blocking', waitUntil: null, index, counts: {...counts}});
        if (stop || !active()) { counts.pending = profiles.length - index; break; }
        let profile = candidate;
        try {
          if (!isNumericProfile(profile)) {
            attempted = Boolean(this.collector.resolveProfileId);
            if (!(profile = await resolve(candidate))) { counts.unresolved++; continue; }
          }
          if (authorPending) { attempted = true; authorId = await resolve(author); authorPending = false; }
          if (!authorId) { stop = new Error('Không lấy được ID người đăng bài; dừng để tránh chặn nhầm.'); counts.pending = profiles.length-index; break; }
        } catch (error) {
          lastError = error;
          if (isActionHold(error)) this.holdAction('block', job.ownerId, error);
          if (holds(error)) { stop = error; counts.pending = profiles.length - index; break; }
          counts.unresolved++;
          if (++errors >= 3) stop = error;
          continue;
        }
        if (profile === authorId || profile === self || seen.has(profile)) continue;
        seen.add(profile);
        if (!this.store.claimAuthorBlock(job.ownerId, profile)) {
          // An unconfirmed block is not "already done"; an in-flight one belongs to a parallel job that reports its own result (restart turns stale 'sending' into 'uncertain').
          counts[this.store.authorBlockState(job.ownerId, profile) === 'uncertain' ? 'uncertain' : 'skipped']++;
          continue;
        }
        attempted = true;
        try {
          const result = await this.collector.blockUser(job.ownerId, profile, active, {low: true});
          if (result?.success !== true || result.state !== 'blocked') throw new Error('API chưa xác nhận chặn người comment.');
          this.store.setAuthorBlockState(job.ownerId, profile, 'blocked');
          counts.blocked++; errors = 0;
        } catch (error) {
          lastError = error;
          const state = error.commentSubmitted === false ? 'failed' : 'uncertain';
          this.store.setAuthorBlockState(job.ownerId, profile, state);
          counts[state]++;
          if (isActionHold(error)) this.holdAction('block', job.ownerId, error);
          if (holds(error) || ++errors >= 3) stop = error;
        }
      }
    } catch (error) {
      if (isActionHold(error)) this.holdAction('block', job.ownerId, error);
      stop = error;
    }
    // Legacy repeat_until identifies auto jobs; each job runs only once.
    const repeatUntil = this.store.commenterBlockJob(job.ownerId, job.postUrl)?.repeatUntil, auto = Boolean(repeatUntil);
    const total = (job.result?.blocked ?? 0) + counts.blocked;
    const aborted = !active(), done = !stop && !aborted && !counts.pending && !counts.failed && !counts.uncertain && !counts.unresolved && scanned > 0 && !incomplete;
    const reason = stop || lastError;
    const result = {...counts, ...(auto ? {blocked: total} : {}), scanned, ...(incomplete ? {incomplete} : {}), ...(scanned ? {} : {noComments: !stop}), ...(reason ? {lastError:safeError(reason)} : {})};
    // Hourly-cap deferral, a paused source and a not-yet-commented auto post wait as pending instead of failing.
    const retries = job.result?.retries ?? 0;
    const deferred = stop?.code === 'SCAN_DEFERRED' && !aborted, paused = aborted && !this.abort.signal.aborted && Boolean(this.store.getGroup(job.groupId)?.paused);
    const idle = auto && result.noComments && !aborted;
    let state = done ? 'done' : aborted ? 'stopped' : 'failed', runAt = null, error = reason ? safeError(reason) : null;
    const quiet = deferred || paused || idle;
    if (deferred) { state = 'pending'; runAt = Number(stop.retryAt) || Date.now() + COMMENTER_NO_COMMENTS_RETRY_MS; }
    else if (paused) { state = 'pending'; runAt = Date.now(); }
    else if (idle) {
      if (retries + 1 < COMMENTER_NO_COMMENTS_TRIES) { state = 'pending'; runAt = Date.now() + COMMENTER_NO_COMMENTS_RETRY_MS; }
      else { state = 'done'; error = 'Không có comment.'; }
    }
    if (state === 'pending' || idle) result.retries = idle ? retries + 1 : retries;
    if (state === 'pending' && progress) result.progress = {...progress, at: progress.at ?? Date.now()};
    this.store.finishCommenterBlockJob(job.id, state, result, error, runAt);
    this.commenterProgress.delete(job.id);
    this.onChange?.();
    if (reason) this.log(`[CHẶN NGƯỜI COMMENT #${job.id}] ${safeError(reason)}`);
    this.log(`[CHẶN NGƯỜI COMMENT | Tài khoản ${job.ownerId}] Bài ${job.postId}: chặn ${counts.blocked}, bỏ qua ${counts.skipped + counts.unknown}, không lấy được ID ${counts.unresolved}, chưa xác nhận ${counts.uncertain}, lỗi ${counts.failed}, chưa xử lý ${counts.pending}.`);
    const text = !scanned && !stop ? `💬 Bài #${job.postId} chưa có comment nào đọc được (hoặc không xem được phần bình luận); chưa chặn ai. Bấm lại nút để quét lại.`
      : [`🚫 Chặn người comment bài #${job.postId} (đọc ${scanned} comment${incomplete ? ', chưa quét hết' : ''}):`,
        `Đã chặn: ${counts.blocked}`, `Bỏ qua: ${counts.skipped + counts.unknown} (đã chặn/đang xử lý trước đó ${counts.skipped}; ẩn danh hoặc không có link ${counts.unknown})`,
        ...(counts.unresolved ? [`Không lấy được ID số từ link tên: ${counts.unresolved}`] : []),
        `Chưa xác nhận: ${counts.uncertain}`, `Lỗi: ${counts.failed}`, ...(counts.pending ? [`Chưa xử lý: ${counts.pending}`] : []),
        ...(stop ? [`Dừng sớm: ${safeError(stop)}`] : []),
        ...(!stop && lastError ? [`Lỗi gần nhất: ${safeError(lastError)}`] : []),
        ...(incomplete ? ['Chưa đọc hết bình luận: truy vấn chưa hỗ trợ trang tiếp, đã chạm giới hạn đọc hoặc phân trang không tiến triển. Chỉ xử lý được người có trong dữ liệu đã đọc.'] : []),
        ...(counts.uncertain ? ['Người "chưa xác nhận" không được gửi lại tự động; kiểm tra trên Facebook.'] : []),
        ...(done ? ['Chỉ quét một lần; comment đến sau không được tính.'] : ['Bấm lại nút để chặn tiếp những người chưa xử lý.'])].join('\n');
    const changedIssue = reason || incomplete || counts.failed || counts.uncertain || counts.unresolved || !scanned;
    await this.reportCommenterBlock(job, target, quiet || auto && !counts.blocked && !(changedIssue && JSON.stringify(job.result) !== JSON.stringify(result)) ? null : text);
    return true;
  }
  async reportCommenterBlock(job, target, text = null) {
    if (text) try {
      await this.api.sendMessage(job.chatId, text, {...(job.messageId ? {reply_parameters: {message_id: job.messageId, allow_sending_without_reply: true}} : {}), link_preview_options: {is_disabled: true}});
    } catch (error) { this.log(`Gửi kết quả chặn người comment thất bại: ${safeError(error)}`); }
    if (!job.messageId) return;
    try { await this.api.editMessageReplyMarkup(job.chatId, job.messageId, {reply_markup: notificationMarkup(this.store, job.ownerId, target.post, target.replyMode)}); }
    catch { /* The notification may be deleted or unchanged; the report above carries the result. */ }
  }
  async commenterBlockLoop() {
    while (!this.abort.signal.aborted) await this.wait(await this.commenterBlockOne() ? 1000 : COMMENTER_BLOCK_POLL_MS);
  }
  #commentWakers = new Set();
  waitForComments() {
    if (this.abort.signal.aborted) return Promise.resolve();
    // Cover an enqueue between the empty check and installing the listener.
    if (this.store.nextComment(this.actionOwners('comment'))) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', done);
        this.#commentWakers.delete(done);
        if (this.#commentWakers.size === 0) this.commentWake = null;
        resolve();
      };
      this.#commentWakers.add(done);
      this.commentWake = () => {
        for (const wake of [...this.#commentWakers]) wake();
        this.#commentWakers.clear();
        this.commentWake = null;
      };
      const timer = setTimeout(done, 500); // Also picks up manual Telegram requests.
      this.abort.signal.addEventListener('abort', done, { once: true });
    });
  }
  async deliveryLoop() {
    while (!this.abort.signal.aborted) {
      const worked = await this.deliverOne() || await this.deliverRejected();
      await this.deliverMedia();
      await this.wait(worked ? 50 : 300);
    }
  }
}
