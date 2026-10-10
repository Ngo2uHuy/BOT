import { setTimeout as sleep } from 'node:timers/promises';
import { matchesKeywords } from './input.js';
import { formatPost } from './format.js';
import { matchesDateRange } from './dates.js';
import { postButtons } from './post-buttons.js';

// Never include HTTP request URLs in diagnostics: Telegram embeds its token there.
export function safeError(error) {
  const text = error?.description || error?.message || 'Lỗi không xác định';
  return String(text).replace(/\d{5,}:[A-Za-z0-9_-]+/g, '[TOKEN]').slice(0,error?.scanDiagnostic ? 1600 : 500);
}

export class Monitor {
  constructor({store,collector,api,config,tiktokAffiliate,log=console.warn}) {
    Object.assign(this,{store,collector,api,config,tiktokAffiliate,log});
    this.allowed = new Set(config.allowedUserIds);
    this.failures = new Map();
    this.abort = new AbortController();
    this.lastSent = new Map();
    this.scanning = new Set();
    this.historyScans = new Map();
  }
  async wait(ms) {
    await sleep(ms,undefined,{signal:this.abort.signal}).catch(error => {
      if (error.name !== 'AbortError') throw error;
    });
  }
  start() {
    this.running = Promise.all([
      ...Array.from({length:this.config.scanWorkers ?? 4},()=>this.scanLoop()),
      this.deliveryLoop(),this.commentLoop(),this.backgroundLoop(),
      ...(this.tiktokAffiliate?[this.tikTokAutoLoop()]:[]),
    ]);
    return this.running;
  }
  options(metricOnly=false) {
    return {metricWindowMs:this.config.metricWindowMs,render:formatPost,matches:matchesKeywords,metricOnly};
  }
  canScan(ownerId, probe = true) {
    return this.collector?.canScan?.(ownerId, probe) ?? true;
  }
  activeFacebookOwners() {
    return this.config.allowedUserIds.filter(ownerId => this.canScan(ownerId, false));
  }
  scanOptions(group, background = false) {
    return {
      contentType: group.contentType,
      latest: !background && group.initialized, background,
      shouldContinue: () => {
        const current = this.store.getGroup(group.id);
        return !this.abort.signal.aborted && current && !current.paused && current.contentType === group.contentType && JSON.stringify(current.dateRange) === JSON.stringify(group.dateRange);
      },
      onPosts: async posts => {
        if (this.abort.signal.aborted) return;
        this.store.observe(group,posts,{...this.options(),finalize:false});
        this.commentWake?.();
        await Promise.resolve();
      },
    };
  }
  async scanLoop() {
    while (!this.abort.signal.aborted) {
      const now = Date.now();
      const group = this.store.dueGroups(this.config.allowedUserIds,now-this.config.pollIntervalMs).find(group => {
        const failure = this.failures.get(group.id);
        return this.canScan(group.ownerId) && !this.scanning.has(group.id) && (!failure || group.lastScanAt === null || now >= failure.retryAt);
      });
      if (group) {
        this.scanning.add(group.id);
        try {
          const posts = await this.collector.collect(group.ownerId,group.url,null,this.scanOptions(group));
          if (!posts.length) throw new Error('Không đọc được bài nào; cần kiểm tra quyền truy cập hoặc bộ đọc Facebook.');
          this.store.observe(group,posts,this.options());
          this.commentWake?.();
          // Give the awakened worker a turn to enqueue its priority browser job.
          await Promise.resolve();
          this.failures.delete(group.id);
        } catch (error) {
          if (error.code === 'FACEBOOK_COOLDOWN') continue;
          const message = safeError(error);
          const attempts = (this.failures.get(group.id)?.attempts || 0)+1;
          this.failures.set(group.id,{attempts,retryAt:Date.now()+Math.min(3600000,this.config.pollIntervalMs*2**Math.min(attempts-1,6))});
          this.store.recordScanError(group.id,message);
          this.log(`\n[QUÉT NHÓM #${group.id}] ${group.url}\n  ${message}\n  Lần lỗi liên tiếp: ${attempts}`);
        } finally {
          this.scanning.delete(group.id);
        }
      }
      if (this.abort.signal.aborted) break;
      await this.wait(group ? 250 : 1000);
    }
  }
  async backgroundLoop() {
    while (!this.abort.signal.aborted) {
      const now = Date.now();
      const group = this.store.allActiveGroups().filter(group => {
        const previous = this.historyScans.get(group.id);
        return this.canScan(group.ownerId, false) && group.initialized && this.allowed.has(group.ownerId) && (!previous || previous.range !== JSON.stringify(group.dateRange)
          || now-previous.at >= (this.config.historyIntervalMs ?? 600000));
      }).sort((a,b) => (this.historyScans.get(a.id)?.at ?? 0)-(this.historyScans.get(b.id)?.at ?? 0))[0];
      if (group) {
        try {
          const posts = await this.collector.collect(group.ownerId,group.url,group.dateRange,this.scanOptions(group,true));
          this.store.observe(group,posts,{...this.options(),finalize:false});
          this.commentWake?.();
        } catch (error) {
          this.log(`\n[QUÉT LỊCH SỬ #${group.id}] ${group.url}\n  ${safeError(error)}`);
        } finally {
          this.historyScans.set(group.id,{at:Date.now(),range:JSON.stringify(group.dateRange)});
        }
      }
      if (this.abort.signal.aborted) break;
      const candidate = this.store.metricCandidate(Date.now(),this.config.metricWindowMs,this.config.metricRefreshMs,this.activeFacebookOwners());
      if (candidate) {
        this.store.markMetricAttempt(candidate.group.id,candidate.post.id);
        try {
          const post = await this.collector.collectPost(candidate.group.ownerId,candidate.post.url);
          if (post) this.store.observe(candidate.group,[post],this.options(true));
        } catch (error) {
          this.log(`\n[CẬP NHẬT BÀI | NHÓM #${candidate.group.id}] ${candidate.post.url}\n  ${safeError(error)}`);
        }
      }
      await this.wait(group || candidate ? 250 : 1000);
    }
  }
  async deliverOne() {
    const item = this.store.nextDelivery(Date.now(),this.config.allowedUserIds);
    if (!item) return false;
    const group = this.store.getGroup(item.group_id);
    const post = JSON.parse(item.data_json);
    const keywords = group ? this.store.effectiveKeywords(group) : [];
    if (!group || !matchesKeywords(post.text,keywords) || !matchesDateRange(post,group.dateRange)) {
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
      this.store.deliveryFailed(item,throttle);
      return true;
    }
    try {
      let messageId = item.message_id;
      if (messageId) {
        await this.api.editMessageText(item.chat_id,messageId,item.body,{link_preview_options:{is_disabled:true},reply_markup:postButtons(post)});
      } else {
        const sent = await this.api.sendMessage(item.chat_id,item.body,{link_preview_options:{is_disabled:true},reply_markup:postButtons(post)});
        messageId = sent.message_id;
      }
      this.store.delivered(item,messageId);
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
  async deliverMedia() {
    const item = this.store.nextMedia(this.config.allowedUserIds);
    if (!item) return false;
    const group = this.store.getGroup(item.group_id), post = JSON.parse(item.post_json);
    if (!group || !matchesKeywords(post.text,this.store.effectiveKeywords(group)) || !matchesDateRange(post,group.dateRange)) {
      this.store.mediaState(item,'cancelled'); return true;
    }
    if (Date.now()-(this.lastSent.get(item.chat_id) || 0) < 1100) return false;
    const media = JSON.parse(item.data_json);
    const options = {caption:`${media.type === 'video' ? '🎬 Video' : '📷 Ảnh'} · bài ${item.post_id}\n${post.url}\nReply tin này để bình luận bài Facebook.`,reply_parameters:{message_id:item.message_id,allow_sending_without_reply:true}};
    options.reply_markup = postButtons(post);
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
    const item = this.store.nextComment(this.activeFacebookOwners());
    if (!item) return false;
    if (!this.store.canComment(item)) { this.store.commentState(item.id,'cancelled'); return true; }
    this.store.commentState(item.id,'sending');
    let message;
    try {
      await this.collector.comment(item.owner_id,JSON.parse(item.data_json).url,item.body,
        () => !this.abort.signal.aborted && this.store.canComment(item));
      this.store.commentState(item.id,'sent');
      message = `Đã đăng bình luận #${item.id} vào bài ${item.post_id}.`;
    } catch(error) {
      if (error.code === 'FACEBOOK_COOLDOWN' || (error.code === 'RATE_LIMITED' && error.commentSubmitted === false)) {
        this.store.commentState(item.id,'pending');
        return false;
      }
      const state = error.commentSubmitted === false ? 'failed' : 'uncertain';
      this.store.commentState(item.id,state,safeError(error));
      message = `Bình luận #${item.id} vào bài ${item.post_id}: ${state === 'failed' ? 'chưa gửi được' : 'chưa xác nhận đã đăng'}. Bot không tự gửi lại. Kiểm tra Facebook và /comments.\n${safeError(error)}`;
    }
    try { await this.api.sendMessage(item.chat_id,message); } catch { /* Status remains available through /comments. */ }
    return true;
  }
  async commentLoop() {
    while (!this.abort.signal.aborted) {
      const worked = await this.commentOne();
      if (worked) await this.wait(30000);
      else await this.waitForComments();
    }
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
      message=`TikTok tự động · nguồn #${job.group_id} · bài ${job.post_id}: chưa xếp bình luận. Kiểm tra /tiktok check. Thử lại thủ công: /tiktoktopcomment ${job.group_id} ${job.post_id} ${options.count} ${options.rank}.`;
    }
    try {await this.api.sendMessage(job.chat_id,message);} catch { /* Avoid retrying already persisted comments. */ }
    return true;
  }
  async tikTokAutoLoop() {
    while(!this.abort.signal.aborted) {
      const worked=await this.tikTokAutoOne();
      await this.wait(worked?30000:2000);
    }
  }
  waitForComments() {
    if (this.abort.signal.aborted) return Promise.resolve();
    // Cover an enqueue between the empty check and installing the listener.
    if (this.store.nextComment(this.activeFacebookOwners())) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort',done);
        this.commentWake = null;
        resolve();
      };
      const timer = setTimeout(done,2000); // Also picks up manual Telegram requests.
      this.commentWake = done;
      this.abort.signal.addEventListener('abort',done,{once:true});
    });
  }
  async deliveryLoop() {
    while (!this.abort.signal.aborted) {
      const worked = await this.deliverOne();
      await this.deliverMedia();
      await this.wait(worked ? 100 : 1000);
    }
  }
}
