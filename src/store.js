import { DatabaseSync } from 'node:sqlite';
import { matchesDateRange } from './dates.js';
import { matchesKeywords } from './input.js';
import { commentText } from './comments.js';
import { normalizeMedia } from './media.js';
import { normalizeProfileUrl } from './profile.js';
import { validateTopOptions } from './affiliate.js';

const decodeGroup = row => row && ({
  id: row.id, ownerId: row.owner_id, url: row.url, label: row.name || `Nhóm Facebook ${row.url.split('/')[4]}`,
  paused: Boolean(row.paused), initialized: Boolean(row.initialized),
  lastScanAt: row.last_scan_at, lastError: row.last_error,
  keywords: row.keywords_json === null ? null : JSON.parse(row.keywords_json),
  dateRange: row.date_range_json ? JSON.parse(row.date_range_json) : null,
  autoReply: row.auto_reply, autoReplySince: row.auto_reply_since,
  tiktokAuto: row.tiktok_auto_json ? JSON.parse(row.tiktok_auto_json) : null,
  sourceType: row.source_type || 'group', contentType: row.content_type || 'all',
});

export class Store {
  #statements = new Map();
  prepare(sql) {
    let statement=this.#statements.get(sql);
    if(!statement) {
      statement=this.db.prepare(sql);
      // Dynamic allowlist lengths must not grow the cache indefinitely.
      if(this.#statements.size>=256) this.#statements.delete(this.#statements.keys().next().value);
      this.#statements.set(sql,statement);
    }
    return statement;
  }
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        owner_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL,
        keywords_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS affiliate_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(owner_id),
        account_key TEXT NOT NULL, origin_url TEXT NOT NULL, affiliate_url TEXT NOT NULL,
        updated_at INTEGER NOT NULL, UNIQUE(owner_id,account_key,origin_url)
      );
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(owner_id), url TEXT NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0, initialized INTEGER NOT NULL DEFAULT 0,
        last_scan_at INTEGER, last_error TEXT, keywords_json TEXT,
        UNIQUE(owner_id,url)
      );
      CREATE TABLE IF NOT EXISTS posts (
        group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        post_id TEXT NOT NULL, data_json TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL, last_metric_at INTEGER NOT NULL,
        eligible INTEGER NOT NULL, PRIMARY KEY(group_id,post_id)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        group_id INTEGER NOT NULL, post_id TEXT NOT NULL, body TEXT NOT NULL,
        sent_body TEXT, message_id INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(group_id,post_id),
        FOREIGN KEY(group_id,post_id) REFERENCES posts(group_id,post_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS delivery_due ON deliveries(next_attempt_at);
    `);
    const columns = this.prepare('PRAGMA table_info(groups)').all().map(column => column.name);
    for (const [name,type] of [['date_range_json','TEXT'],['name','TEXT'],['auto_reply','TEXT'],['auto_reply_since','INTEGER'],['tiktok_auto_json','TEXT'],['source_type',"TEXT NOT NULL DEFAULT 'group'"],['content_type',"TEXT NOT NULL DEFAULT 'all'"]]) {
      if (!columns.includes(name)) this.db.exec(`ALTER TABLE groups ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_posts (
        owner_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL, post_id TEXT NOT NULL,
        PRIMARY KEY(chat_id,message_id),
        FOREIGN KEY(group_id,post_id) REFERENCES posts(group_id,post_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS media_deliveries (
        group_id INTEGER NOT NULL, post_id TEXT NOT NULL, position INTEGER NOT NULL,
        data_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY(group_id,post_id,position),
        FOREIGN KEY(group_id,post_id) REFERENCES posts(group_id,post_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, post_id TEXT NOT NULL,
        body TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, error TEXT,
        UNIQUE(group_id,post_id,body),
        FOREIGN KEY(group_id,post_id) REFERENCES posts(group_id,post_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tiktok_auto_jobs (
        group_id INTEGER NOT NULL, post_id TEXT NOT NULL, config_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', error TEXT,
        PRIMARY KEY(group_id,post_id),
        FOREIGN KEY(group_id,post_id) REFERENCES posts(group_id,post_id) ON DELETE CASCADE
      );
      UPDATE tiktok_auto_jobs SET state='pending' WHERE state='working';
      UPDATE comments SET state='uncertain',error='Bot dừng trong lúc gửi; kiểm tra Facebook trước khi thao tác lại.' WHERE state='sending';
      UPDATE comments SET state='failed' WHERE state='uncertain' AND error IN
        ('Không xác định duy nhất bài viết để bình luận.','Không tìm thấy ô bình luận chính; bài có thể đã khóa bình luận.');
      UPDATE media_deliveries SET state='failed' WHERE state='sending';
    `);
    if (!this.prepare('PRAGMA table_info(message_posts)').all().some(column=>column.name==='reply_mode')) {
      this.db.exec("ALTER TABLE message_posts ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'single'");
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS pending_comments ON comments(id,group_id) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS pending_deliveries ON deliveries(next_attempt_at,group_id,post_id)
        WHERE sent_body IS NULL OR sent_body<>body;
      CREATE INDEX IF NOT EXISTS pending_media ON media_deliveries(group_id,post_id,position) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS tiktok_jobs_state ON tiktok_auto_jobs(state);
      CREATE INDEX IF NOT EXISTS posts_by_source_date ON posts(group_id,first_seen_at DESC,post_id);
      CREATE INDEX IF NOT EXISTS posts_by_date ON posts(first_seen_at DESC,group_id,post_id);
      CREATE INDEX IF NOT EXISTS active_sources ON groups(COALESCE(last_scan_at,0),id) WHERE paused=0;
      CREATE INDEX IF NOT EXISTS affiliate_recent ON affiliate_links(owner_id,account_key,updated_at DESC,id DESC);
    `);
  }
  mapMessage(ownerId,chatId,messageId,groupId,postId,replyMode='single') {
    this.prepare('INSERT OR REPLACE INTO message_posts(owner_id,chat_id,message_id,group_id,post_id,reply_mode) VALUES(?,?,?,?,?,?)').run(ownerId,chatId,messageId,groupId,String(postId),replyMode);
  }
  replyTarget(ownerId,chatId,messageId) {
    const row = this.prepare(`SELECT p.*,g.owner_id,m.reply_mode FROM message_posts m JOIN posts p USING(group_id,post_id)
      JOIN groups g ON g.id=p.group_id WHERE m.owner_id=? AND m.chat_id=? AND m.message_id=? AND g.owner_id=?`).get(ownerId,chatId,messageId,ownerId)
      || this.prepare(`SELECT p.*,g.owner_id FROM deliveries d JOIN posts p USING(group_id,post_id)
        JOIN groups g ON g.id=p.group_id JOIN users u ON u.owner_id=g.owner_id
        WHERE g.owner_id=? AND u.chat_id=? AND d.message_id=?`).get(ownerId,chatId,messageId);
    return row && {groupId:row.group_id,postId:row.post_id,post:JSON.parse(row.data_json),replyMode:row.reply_mode || 'single'};
  }
  queueComments(ownerId,groupId,ids,text,source='manual',now=Date.now()) {
    return this.queueCommentList(ownerId,groupId,ids,[text],source,now);
  }
  queueCommentList(ownerId,groupId,ids,texts,source='manual',now=Date.now()) {
    const group = this.getGroup(groupId);
    if (!group || group.ownerId !== ownerId) throw new Error('Không tìm thấy nhóm của bạn.');
    if (!Array.isArray(texts) || !texts.length) throw new Error('Danh sách bình luận trống.');
    const bodies = texts.map(commentText);
    let selected;
    if(ids) {
      const lookup=this.prepare('SELECT post_id FROM posts WHERE group_id=? AND post_id=?');
      selected=[...new Set(ids)].map(id=>lookup.get(groupId,id));
      if(selected.some(row=>!row)) throw new Error('Có ID bài chưa được bot lưu trong nhóm này. Dùng /posts ID để xem.');
    } else {
      const keywords=this.effectiveKeywords(group);
      selected=this.prepare('SELECT post_id,data_json FROM posts WHERE group_id=?').all(groupId).filter(row=>{
        const post=JSON.parse(row.data_json);
        return matchesKeywords(post.text,keywords) && matchesDateRange(post,group.dateRange,now);
      });
    }
    let queued = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of selected) {
        for (const body of bodies) queued += this.enqueueComment(groupId,row.post_id,body,source,now);
      }
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    return {queued,skipped:selected.length*bodies.length-queued};
  }
  enqueueComment(groupId,postId,body,source,now) {
    return this.prepare(`INSERT INTO comments(group_id,post_id,body,source,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(group_id,post_id,body) DO UPDATE SET state='pending',error=NULL,source=excluded.source,created_at=excluded.created_at
      WHERE comments.state='failed' AND excluded.source='manual'`)
      .run(groupId,postId,body,source,now).changes;
  }
  setAutoReply(ownerId,groupId,text,now=Date.now()) {
    if (text !== null) text = commentText(text);
    const result = this.prepare('UPDATE groups SET auto_reply=?,auto_reply_since=? WHERE owner_id=? AND id=?').run(text,text ? now : null,ownerId,groupId);
    if (result.changes) this.prepare("UPDATE comments SET state='cancelled' WHERE group_id=? AND source='auto' AND state='pending'").run(groupId);
    return result.changes;
  }
  listPosts(ownerId,groupId,offset=0) {
    return this.prepare(`SELECT p.* FROM posts p JOIN groups g ON g.id=p.group_id WHERE g.owner_id=? AND g.id=?
      ORDER BY p.first_seen_at DESC,p.post_id LIMIT 20 OFFSET ?`).all(ownerId,groupId,offset).map(row => JSON.parse(row.data_json));
  }
  getSavedPost(ownerId,groupId,postId) {
    const row=this.prepare('SELECT p.data_json FROM posts p JOIN groups g ON g.id=p.group_id WHERE g.owner_id=? AND p.group_id=? AND p.post_id=?').get(ownerId,groupId,String(postId));
    return row ? JSON.parse(row.data_json) : null;
  }
  listAllPosts(ownerId,offset=0) {
    return this.prepare(`SELECT p.* FROM posts p JOIN groups g ON g.id=p.group_id WHERE g.owner_id=?
      ORDER BY p.first_seen_at DESC,p.group_id,p.post_id LIMIT 20 OFFSET ?`).all(ownerId,offset).map(row => JSON.parse(row.data_json));
  }
  listComments(ownerId) {
    return this.prepare(`SELECT c.* FROM comments c JOIN groups g ON g.id=c.group_id WHERE g.owner_id=? ORDER BY c.id DESC LIMIT 20`).all(ownerId);
  }
  cancelComments(ownerId,groupId) {
    this.prepare(`UPDATE tiktok_auto_jobs SET state='cancelled' WHERE state IN ('pending','working') AND group_id IN
      (SELECT id FROM groups WHERE owner_id=? AND (? IS NULL OR id=?))`).run(ownerId,groupId,groupId);
    return this.prepare(`UPDATE comments SET state='cancelled' WHERE state='pending' AND group_id IN
      (SELECT id FROM groups WHERE owner_id=? AND (? IS NULL OR id=?))`).run(ownerId,groupId,groupId).changes;
  }
  nextComment(allowed) {
    if (!allowed.length) return undefined;
    return this.prepare(`SELECT c.*,g.owner_id,u.chat_id,p.data_json FROM comments c INDEXED BY pending_comments JOIN groups g ON g.id=c.group_id
      JOIN users u ON u.owner_id=g.owner_id JOIN posts p ON p.group_id=c.group_id AND p.post_id=c.post_id
      WHERE c.state='pending' AND g.paused=0 AND g.owner_id IN (${allowed.map(()=>'?').join(',')}) ORDER BY c.id LIMIT 1`).get(...allowed);
  }
  commentState(id,state,error=null) { this.prepare('UPDATE comments SET state=?,error=? WHERE id=?').run(state,error,id); }
  canComment(item) {
    const group = this.getGroup(item.group_id);
    if(item.source==='tiktok-auto') {
      const job=this.prepare('SELECT * FROM tiktok_auto_jobs WHERE group_id=? AND post_id=?').get(item.group_id,item.post_id);
      return Boolean(job && this.canTikTokJob({...job,owner_id:item.owner_id}));
    }
    return Boolean(group && !group.paused && group.ownerId === item.owner_id &&
      (item.source !== 'auto' || group.autoReply === item.body && Date.parse(JSON.parse(item.data_json).publishedAt) >= group.autoReplySince
        && matchesKeywords(JSON.parse(item.data_json).text,this.effectiveKeywords(group)) && matchesDateRange(JSON.parse(item.data_json),group.dateRange)));
  }
  nextMedia(allowed) {
    if (!allowed.length) return undefined;
    return this.prepare(`SELECT m.*,g.owner_id,u.chat_id,d.message_id,p.data_json AS post_json FROM media_deliveries m INDEXED BY pending_media
      JOIN groups g ON g.id=m.group_id JOIN users u ON u.owner_id=g.owner_id
      JOIN deliveries d ON d.group_id=m.group_id AND d.post_id=m.post_id
      JOIN posts p ON p.group_id=m.group_id AND p.post_id=m.post_id
      WHERE m.state='pending' AND d.message_id IS NOT NULL AND g.paused=0
      AND g.owner_id IN (${allowed.map(()=>'?').join(',')}) ORDER BY m.group_id,m.post_id,m.position LIMIT 1`).get(...allowed);
  }
  mediaState(item,state) { this.prepare('UPDATE media_deliveries SET state=? WHERE group_id=? AND post_id=? AND position=?').run(state,item.group_id,item.post_id,item.position); }
  setDateRange(ownerId, id, range) {
    return this.prepare('UPDATE groups SET date_range_json=?,last_scan_at=NULL WHERE owner_id=? AND id=?')
      .run(range ? JSON.stringify(range) : null, ownerId, id).changes;
  }
  requestScan(ownerId,id) {
    return this.prepare('UPDATE groups SET last_scan_at=NULL WHERE owner_id=? AND id=?').run(ownerId,id).changes;
  }
  setTikTokAuto(ownerId,groupId,options,accountKey,now=Date.now()) {
    const group=this.getGroup(groupId);
    if(!group || group.ownerId!==ownerId) throw new Error('Không tìm thấy nguồn của bạn.');
    if(options) {validateTopOptions(options);if(!accountKey?.startsWith('tiktok:')) throw new Error('Chưa cấu hình tài khoản TikTok.');}
    const setting=options?{...options,accountKey,since:now}:null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.prepare('UPDATE groups SET tiktok_auto_json=? WHERE id=?').run(setting?JSON.stringify(setting):null,groupId);
      this.prepare("UPDATE tiktok_auto_jobs SET state='cancelled' WHERE group_id=? AND state IN ('pending','working')").run(groupId);
      this.prepare("UPDATE comments SET state='cancelled' WHERE group_id=? AND source='tiktok-auto' AND state='pending'").run(groupId);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  nextTikTokJob(allowed) {
    if(!allowed.length) return null;
    return this.prepare(`SELECT j.*,g.owner_id,u.chat_id FROM tiktok_auto_jobs j JOIN groups g ON g.id=j.group_id
      JOIN users u ON u.owner_id=g.owner_id WHERE j.state='pending' AND g.paused=0 AND g.owner_id IN (${allowed.map(()=>'?').join(',')})
      ORDER BY j.rowid LIMIT 1`).get(...allowed);
  }
  tikTokJobState(job,state,error=null) {
    this.prepare("UPDATE tiktok_auto_jobs SET state=?,error=? WHERE group_id=? AND post_id=? AND state IN ('pending','working')").run(state,error,job.group_id,job.post_id);
  }
  canTikTokJob(job) {
    const group=this.getGroup(job.group_id),post=this.getSavedPost(job.owner_id,job.group_id,job.post_id);
    const state=this.prepare('SELECT state FROM tiktok_auto_jobs WHERE group_id=? AND post_id=?').get(job.group_id,job.post_id)?.state;
    return Boolean(group && !group.paused && group.ownerId===job.owner_id && post && ['pending','working','done'].includes(state)
      && group.tiktokAuto && JSON.stringify(group.tiktokAuto)===job.config_json
      && Date.parse(post.publishedAt)>=group.tiktokAuto.since && Date.parse(post.publishedAt)<=Date.now()
      && matchesKeywords(post.text,this.effectiveKeywords(group)) && matchesDateRange(post,group.dateRange));
  }
  finishTikTokJob(job,offers,accountKey) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const group=this.getGroup(job.group_id), config=JSON.parse(job.config_json);
      if(!this.canTikTokJob(job) || config.accountKey!==accountKey) {
        this.tikTokJobState(job,group?.paused && JSON.stringify(group.tiktokAuto)===job.config_json?'pending':'cancelled');
        this.db.exec('COMMIT');return null;
      }
      if(this.prepare('SELECT state FROM tiktok_auto_jobs WHERE group_id=? AND post_id=?').get(job.group_id,job.post_id)?.state!=='working') {
        this.db.exec('COMMIT');return null;
      }
      let queued=0;
      for(const offer of offers.slice(0,config.count)) {
        const body=commentText(offer.affiliateUrl);
        this.saveAffiliateLink(job.owner_id,accountKey,offer.productUrl,body);
        queued+=this.enqueueComment(job.group_id,job.post_id,body,'tiktok-auto',Date.now());
      }
      this.tikTokJobState(job,'done');
      this.db.exec('COMMIT');return queued;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  close() { this.#statements.clear(); this.db.close(); }
  saveAffiliateLink(ownerId,accountKey,originUrl,affiliateUrl,now=Date.now()) {
    this.prepare(`INSERT INTO affiliate_links(owner_id,account_key,origin_url,affiliate_url,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(owner_id,account_key,origin_url) DO UPDATE SET affiliate_url=excluded.affiliate_url,updated_at=excluded.updated_at`)
      .run(ownerId,accountKey,originUrl,affiliateUrl,now);
    return this.prepare('SELECT * FROM affiliate_links WHERE owner_id=? AND account_key=? AND origin_url=?').get(ownerId,accountKey,originUrl);
  }
  listAffiliateLinks(ownerId,accountKey,offset=0) {
    return this.prepare('SELECT * FROM affiliate_links WHERE owner_id=? AND account_key=? ORDER BY updated_at DESC,id DESC LIMIT 10 OFFSET ?').all(ownerId,accountKey,offset);
  }
  affiliateLinksByIds(ownerId,accountKey,ids) {
    return ids.map(id=>{
      const link=this.prepare('SELECT * FROM affiliate_links WHERE owner_id=? AND account_key=? AND id=?').get(ownerId,accountKey,id);
      if(!link) throw new Error('Không tìm thấy link affiliate của tài khoản hiện tại.');
      return link;
    });
  }
  ensureUser(ownerId, chatId) {
    this.prepare(`INSERT INTO users(owner_id,chat_id) VALUES(?,?)
      ON CONFLICT(owner_id) DO UPDATE SET chat_id=excluded.chat_id`).run(ownerId, chatId);
  }
  addGroup(ownerId, url) {
    const result = this.prepare('INSERT OR IGNORE INTO groups(owner_id,url) VALUES(?,?)').run(ownerId,url);
    return { group: decodeGroup(this.prepare('SELECT * FROM groups WHERE owner_id=? AND url=?').get(ownerId,url)), created: result.changes > 0 };
  }
  addProfile(ownerId, value, contentType = 'all') {
    if (!['all','posts','reels'].includes(contentType)) throw new Error('Chọn all, posts hoặc reels.');
    const url = normalizeProfileUrl(value);
    const result = this.addGroup(ownerId,url);
    this.prepare("UPDATE groups SET source_type='profile',content_type=?,name=COALESCE(name,?),initialized=1,last_scan_at=NULL WHERE id=? AND owner_id=?")
      .run(contentType,`Trang cá nhân ${url.split('/').at(-1)}`,result.group.id,ownerId);
    return {...result,group:this.getGroup(result.group.id)};
  }
  addJoinedGroup(ownerId, item) {
    const result=this.addGroup(ownerId,item.url);
    if (result.created) {
      // Opt into delivering the first visible batch, unlike /add's silent baseline.
      this.prepare('UPDATE groups SET name=?,initialized=1 WHERE id=? AND owner_id=?').run(item.name || null,result.group.id,ownerId);
    }
    return result;
  }
  listGroups(ownerId) { return this.prepare('SELECT * FROM groups WHERE owner_id=? ORDER BY id').all(ownerId).map(decodeGroup); }
  allActiveGroups() { return this.prepare('SELECT * FROM groups WHERE paused=0 ORDER BY COALESCE(last_scan_at,0),id').all().map(decodeGroup); }
  dueGroups(allowed,cutoff) {
    if(!allowed.length) return [];
    return this.prepare(`SELECT * FROM groups WHERE paused=0 AND (last_scan_at IS NULL OR last_scan_at<=?)
      AND owner_id IN (${allowed.map(()=>'?').join(',')}) ORDER BY COALESCE(last_scan_at,0),id`)
      .all(cutoff,...allowed).map(decodeGroup);
  }
  getGroup(id) { return decodeGroup(this.prepare('SELECT * FROM groups WHERE id=?').get(id)); }
  removeGroup(ownerId,id) { return this.prepare('DELETE FROM groups WHERE owner_id=? AND id=?').run(ownerId,id).changes > 0; }
  setPaused(ownerId,id,paused) {
    return (id === null
      ? this.prepare('UPDATE groups SET paused=? WHERE owner_id=?').run(Number(paused),ownerId)
      : this.prepare('UPDATE groups SET paused=? WHERE owner_id=? AND id=?').run(Number(paused),ownerId,id)).changes;
  }
  setKeywords(ownerId,id,keywords) {
    return (id === null
      ? this.prepare('UPDATE users SET keywords_json=? WHERE owner_id=?').run(JSON.stringify(keywords),ownerId)
      : this.prepare('UPDATE groups SET keywords_json=? WHERE owner_id=? AND id=?').run(JSON.stringify(keywords),ownerId,id)).changes;
  }
  getKeywords(ownerId) { return JSON.parse(this.prepare('SELECT keywords_json FROM users WHERE owner_id=?').get(ownerId)?.keywords_json || '[]'); }
  effectiveKeywords(group) { return group.keywords ?? this.getKeywords(group.ownerId); }
  status(ownerId) {
    return this.prepare(`SELECT
      (SELECT COUNT(*) FROM groups WHERE owner_id=?) AS groups,
      (SELECT COUNT(*) FROM groups WHERE owner_id=? AND paused=0) AS active,
      (SELECT COUNT(*) FROM posts p JOIN groups g ON g.id=p.group_id WHERE g.owner_id=?) AS posts,
      (SELECT COUNT(*) FROM deliveries d JOIN groups g ON g.id=d.group_id
       WHERE g.owner_id=? AND (d.sent_body IS NULL OR d.sent_body<>d.body)) AS pending
    `).get(ownerId,ownerId,ownerId,ownerId);
  }
  recordScanError(id,message,now=Date.now()) {
    this.prepare('UPDATE groups SET last_scan_at=?,last_error=? WHERE id=?').run(now,message,id);
  }
  // Persist observation + outbox together. A restart cannot forget an unsent post.
  observe(group,posts,{now=Date.now(),metricWindowMs,render,matches,metricOnly=false,finalize=true}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getGroup(group.id);
      if (!current || current.paused) { this.db.exec('COMMIT'); return; }
      const keywords = this.effectiveKeywords(current);
      for (let post of posts) {
        if (!post.id || !post.url) continue;
        if (post.groupName && post.groupName!==current.label) {
          this.prepare('UPDATE groups SET name=? WHERE id=?').run(post.groupName,group.id);
          current.label = post.groupName;
        }
        const old = this.prepare('SELECT * FROM posts WHERE group_id=? AND post_id=?').get(group.id,String(post.id));
        if (!post.publishedAt && old) post = {...post,publishedAt:JSON.parse(old.data_json).publishedAt || null};
        if (metricOnly && !old) continue;
        const firstSeenAt = old?.first_seen_at ?? now;
        const eligible = current.dateRange ? 1 : old?.eligible ?? Number(current.initialized);
        this.prepare(`INSERT INTO posts VALUES(?,?,?,?,?,?,?) ON CONFLICT(group_id,post_id)
          DO UPDATE SET data_json=excluded.data_json,last_seen_at=excluded.last_seen_at,last_metric_at=excluded.last_metric_at,eligible=excluded.eligible`)
          .run(group.id,String(post.id),JSON.stringify(post),firstSeenAt,now,now,eligible);
        if (!eligible || (!current.dateRange && now-firstSeenAt > metricWindowMs) || !matches(post.text,keywords) || !matchesDateRange(post,current.dateRange,now)) continue;
        if (!old && !metricOnly && current.autoReply && Date.parse(post.publishedAt) >= current.autoReplySince && Date.parse(post.publishedAt) <= now) {
          this.enqueueComment(group.id,String(post.id),current.autoReply,'auto',now);
        }
        if(!old && !metricOnly && current.initialized && current.tiktokAuto && Date.parse(post.publishedAt)>=current.tiktokAuto.since && Date.parse(post.publishedAt)<=now) {
          this.prepare('INSERT OR IGNORE INTO tiktok_auto_jobs(group_id,post_id,config_json) VALUES(?,?,?)').run(group.id,String(post.id),JSON.stringify(current.tiktokAuto));
        }
        normalizeMedia(post.media).forEach((media,index) => this.prepare('INSERT OR IGNORE INTO media_deliveries(group_id,post_id,position,data_json) VALUES(?,?,?,?)')
          .run(group.id,String(post.id),index,JSON.stringify(media)));
        const body = render(current,post,keywords);
        this.prepare(`INSERT INTO deliveries(group_id,post_id,body) VALUES(?,?,?)
          ON CONFLICT(group_id,post_id) DO UPDATE SET body=excluded.body WHERE deliveries.body<>excluded.body`).run(group.id,String(post.id),body);
      }
      if (!metricOnly && finalize) this.prepare('UPDATE groups SET initialized=1,last_scan_at=?,last_error=NULL WHERE id=?').run(now,group.id);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  nextDelivery(now=Date.now(),allowedUserIds) {
    if (!allowedUserIds?.length) return undefined;
    return this.prepare(`SELECT d.*,g.owner_id,u.chat_id,p.data_json FROM deliveries d INDEXED BY pending_deliveries
      JOIN groups g ON g.id=d.group_id JOIN users u ON u.owner_id=g.owner_id
      JOIN posts p ON p.group_id=d.group_id AND p.post_id=d.post_id
      WHERE g.paused=0 AND (d.sent_body IS NULL OR d.sent_body<>d.body) AND d.next_attempt_at<=?
      AND g.owner_id IN (${allowedUserIds.map(() => '?').join(',')})
      ORDER BY d.next_attempt_at,d.group_id,d.post_id LIMIT 1`).get(now,...allowedUserIds);
  }
  delivered(item,messageId) {
    this.prepare(`UPDATE deliveries SET sent_body=?,message_id=?,attempts=0,next_attempt_at=0
      WHERE group_id=? AND post_id=?`).run(item.body,messageId,item.group_id,item.post_id);
    if (item.owner_id && item.chat_id) this.mapMessage(item.owner_id,item.chat_id,messageId,item.group_id,item.post_id);
  }
  deliveryFailed(item,delayMs,now=Date.now()) {
    this.prepare('UPDATE deliveries SET attempts=attempts+1,next_attempt_at=? WHERE group_id=? AND post_id=?')
      .run(now+delayMs,item.group_id,item.post_id);
  }
  resetMessage(item) {
    this.prepare('UPDATE deliveries SET message_id=NULL WHERE group_id=? AND post_id=?').run(item.group_id,item.post_id);
  }
  cancelDelivery(item) {
    if (item.sent_body === null) this.prepare('DELETE FROM deliveries WHERE group_id=? AND post_id=?').run(item.group_id,item.post_id);
    else this.prepare('UPDATE deliveries SET body=sent_body WHERE group_id=? AND post_id=?').run(item.group_id,item.post_id);
  }
  replaceDeliveryBody(item,body) {
    this.prepare('UPDATE deliveries SET body=? WHERE group_id=? AND post_id=?').run(body,item.group_id,item.post_id);
  }
  metricCandidate(now,windowMs,refreshMs,allowedUserIds) {
    if (!allowedUserIds?.length) return undefined;
    const row = this.prepare(`SELECT p.*,g.owner_id FROM posts p JOIN groups g ON g.id=p.group_id
      JOIN deliveries d ON d.group_id=p.group_id AND d.post_id=p.post_id
      WHERE g.paused=0 AND d.message_id IS NOT NULL AND p.first_seen_at>=? AND p.last_metric_at<=?
      AND g.owner_id IN (${allowedUserIds.map(() => '?').join(',')})
      ORDER BY p.last_metric_at LIMIT 1`).get(now-windowMs,now-refreshMs,...allowedUserIds);
    return row && {group:this.getGroup(row.group_id),post:JSON.parse(row.data_json)};
  }
  markMetricAttempt(groupId,postId,now=Date.now()) {
    this.prepare('UPDATE posts SET last_metric_at=? WHERE group_id=? AND post_id=?').run(now,groupId,String(postId));
  }
}
