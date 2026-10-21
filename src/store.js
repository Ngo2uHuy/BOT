import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { matchesDateRange } from './dates.js';
import { matchesKeywords, testKeywords, normalizeSearchText } from './input.js';
import { listQuery, likePattern, searchKey, pageInfo, fold } from './listing.js';
import { formatRejectedPost } from './format.js';
import { commentText } from './comments.js';
import { directMessageText, renderDirectMessage, isAnonymousAuthor } from './direct-messages.js';
import { normalizeAuthorUrl } from './facebook.js';
import { normalizeMedia } from './media.js';
import { normalizeProfileUrl } from './profile.js';
import { validateTopOptions } from './affiliate.js';
import { COMMENTER_AUTO_WINDOW_MS } from './commenter-block.js';

// Widening a filter can surface older posts for the first time; never auto-act on those past this age.
const AUTO_ACTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const decodeGroup = row => row && ({
  id: row.id, ownerId: row.owner_id, url: row.url, label: row.name || `Nhóm Facebook ${row.url.split('/')[4]}`,
  paused: Boolean(row.paused), initialized: Boolean(row.initialized),
  lastScanAt: row.last_scan_at, lastError: row.last_error,
  keywords: row.keywords_json === null ? null : JSON.parse(row.keywords_json),
  rejectKeywords: row.reject_keywords_json === null ? null : JSON.parse(row.reject_keywords_json),
  dateRange: row.date_range_json ? JSON.parse(row.date_range_json) : null,
  autoReply: row.auto_reply, autoReplySince: row.auto_reply_since,
  autoInbox: row.auto_inbox, autoInboxSince: row.auto_inbox_since,
  autoFriend: Boolean(row.auto_friend), autoFriendSince: row.auto_friend_since,
  autoBlock: Boolean(row.auto_block), autoBlockSince: row.auto_block_since,
  tiktokAuto: row.tiktok_auto_json ? JSON.parse(row.tiktok_auto_json) : null,
  sourceType: row.source_type || 'group', contentType: row.content_type || 'all',
  numericId: row.numeric_id ?? null, lastSeenTime: row.last_seen_time ?? null,
  nextScanAt: row.next_scan_at ?? null, scanIntervalMs: row.scan_interval_ms ?? null,
});

const decodeCommenterJob = row => row && ({
  id: row.id, ownerId: row.owner_id, chatId: row.chat_id, messageId: row.message_id, groupId: row.group_id, postId: row.post_id,
  postUrl: row.post_url, runAt: row.run_at, state: row.state, result: row.result_json ? JSON.parse(row.result_json) : null, error: row.error, repeatUntil: row.repeat_until ?? null,
});
const decodeCommenterRow = row => ({...decodeCommenterJob(row),
  sourceName:row.group_name || `Nhóm Facebook ${row.group_url.split('/')[4]}`,sourcePaused:Boolean(row.group_paused),auto:row.repeat_until!=null});
const decodePostRow = row => ({...JSON.parse(row.data_json),groupId:row.group_id,firstSeenAt:row.first_seen_at,sourceName:row.name,...(row.body != null ? {reason:row.body} : {})});

// Folded search/sort keys written with each row (SQL here only fills rows from before these columns existed, in batches
// after startup); the lists read the bare columns so indexes apply, and an old row is found once it is backfilled.
const postOf = (a,column) => `(SELECT x.${column} FROM posts x WHERE x.group_id=${a}group_id AND x.post_id=${a}post_id)`;
const KEYS = {
  posts:[['search',a => `search_key(json_extract(${a}data_json,'$.text'),json_extract(${a}data_json,'$.author'),json_extract(${a}data_json,'$.url'),json_extract(${a}data_json,'$.authorUrl'),${a}post_id)`],
    ['author_key',a => `search_key(json_extract(${a}data_json,'$.author'))`],['kind',a => `COALESCE(json_extract(${a}data_json,'$.kind'),'')`],
    ['published_at',a => `json_extract(${a}data_json,'$.publishedAt')`]],
  comments:[['search',a => `search_key(${a}body,${a}post_id,${a}error)`]],
  direct_messages:[['search',a => `search_key(${a}body,${a}recipient_name,${a}recipient_url,${a}post_id,${a}error)`],['name_key',a => `search_key(COALESCE(${a}recipient_name,${a}recipient_url))`]],
  friend_requests:[['search',a => `search_key(${a}recipient_name,${a}recipient_url,${a}post_id,${a}error)`],['name_key',a => `search_key(COALESCE(${a}recipient_name,${a}recipient_url))`]],
  // A rejected row carries its post's sort/filter values, so the list never reads posts row by row.
  rejected_deliveries:[['search',a => `search_key(${a}body,${postOf(a,'search')})`],['seen_at',a => postOf(a,'first_seen_at')],
    ['published_at',a => postOf(a,'published_at')],['author_key',a => postOf(a,'author_key')],['kind',a => postOf(a,'kind')]],
};

// Paged lists: WHERE/ORDER BY fragments come only from these maps (keys validated by listQuery); every value is bound.
// search: `keys` stored folded columns, `raw` ASCII columns (URLs/IDs, native LIKE), `text` rarely set columns folded on the fly,
// `group` matches the source name once through a subquery instead of per row.
// A sort is one expression or a list; with the group column next to it the owner check is answered from the same index.
const AUTO_ANY = '(auto_reply IS NOT NULL OR auto_inbox IS NOT NULL OR auto_friend=1 OR auto_block=1 OR tiktok_auto_json IS NOT NULL)';
// `t` holds the sort columns: the post itself, or the rejected row (copied from its post when it was recorded).
// `order` drives from that table so its sort index is walked in order; `rows` reads the page's full rows by key.
// `hidden`: rows removed from the list but kept for dedupe; shown only with the hidden:yes filter.
const postList = (t,seen,from,order,rows,select) => ({from,order,rows,select,key:`${t}.rowid`,owner:'g.owner_id=?',tie:[`${t}.rowid`],map:decodePostRow,hidden:`${t}.hidden_at`,
  search:{keys:[`${t}.search`],group:`${t}.group_id`},
  sorts:{seen:[`${t}.${seen}`,`${t}.group_id`],published:[`${t}.published_at`,`${t}.group_id`],author:[`${t}.author_key`,`${t}.group_id`],source:`${t}.group_id`},
  filters:{source:`${t}.group_id=?`,type:'g.source_type=?',kind:value => [value === 'reel' ? `${t}.kind='reel'` : `${t}.kind<>'reel'`],hidden:() => [`${t}.hidden_at IS NOT NULL`]}});
const queueList = (table,alias) => ({from:`${table} ${alias} JOIN groups g ON g.id=${alias}.group_id`,order:`${table} ${alias} CROSS JOIN groups g ON g.id=${alias}.group_id`,select:`${alias}.*,g.name AS source_name`,owner:'g.owner_id=?',key:`${alias}.id`,tie:[`${alias}.id`],hidden:`${alias}.hidden_at`,
  sorts:{id:`${alias}.id`,time:[`COALESCE(${alias}.sent_at,${alias}.created_at)`,`${alias}.group_id`],state:`${alias}.state`,source:`${alias}.group_id`,name:[`${alias}.name_key`,`${alias}.group_id`]},
  filters:{state:`${alias}.state=?`,source:`${alias}.group_id=?`,mode:`${alias}.source=?`},search:{keys:[`${alias}.search`],group:`${alias}.group_id`}});
const LIST_SQL = {
  comments:{...queueList('comments','c'),sorts:{id:'c.id',time:['c.created_at','c.group_id'],state:'c.state',source:'c.group_id'},
    filters:{state:'c.state=?',source:'c.group_id=?',mode:value => ['c.source=?',value === 'tiktok' ? 'tiktok-auto' : value]}},
  inboxes:queueList('direct_messages','d'),
  friends:queueList('friend_requests','f'),
  blocks:{from:'commenter_block_jobs j JOIN groups g ON g.id=j.group_id AND g.owner_id=j.owner_id',owner:'j.owner_id=?',key:'j.id',tie:['j.id'],map:decodeCommenterRow,
    select:'j.*,g.name AS group_name,g.url AS group_url,g.paused AS group_paused,g.auto_block',search:{raw:['j.post_url','j.post_id','g.url'],text:['j.error'],group:'j.group_id'},
    sorts:{id:'j.id',time:'j.run_at',state:'j.state',source:'j.group_id'},
    filters:{state:'j.state=?',source:'j.group_id=?',mode:value => [value === 'auto' ? 'j.repeat_until IS NOT NULL' : 'j.repeat_until IS NULL']}},
  posts:postList('p','first_seen_at','posts p JOIN groups g ON g.id=p.group_id','posts p CROSS JOIN groups g ON g.id=p.group_id',null,'p.group_id,p.data_json,p.first_seen_at,g.name'),
  rejected:postList('r','seen_at','rejected_deliveries r JOIN groups g ON g.id=r.group_id','rejected_deliveries r CROSS JOIN groups g ON g.id=r.group_id',
    'rejected_deliveries r CROSS JOIN posts p ON p.group_id=r.group_id AND p.post_id=r.post_id CROSS JOIN groups g ON g.id=r.group_id','r.group_id,r.body,p.data_json,p.first_seen_at,g.name'),
  links:{from:'affiliate_links',select:'*',owner:'owner_id=? AND account_key=?',key:'id',tie:['id'],search:{raw:['origin_url','affiliate_url','id']},
    sorts:{updated:'updated_at',id:'id',origin:'origin_url'},filters:{}},
  sources:{from:'groups',select:'*',owner:'owner_id=?',key:'id',tie:['id'],map:decodeGroup,search:{raw:['url','id','numeric_id'],text:['name']},
    sorts:{id:'id',name:'fold(COALESCE(name,url))',scan:'COALESCE(last_scan_at,0)',interval:'COALESCE(scan_interval_ms,0)'},
    filters:{type:'source_type=?',status:value => [{active:'paused=0 AND last_error IS NULL',paused:'paused=1',error:'paused=0 AND last_error IS NOT NULL'}[value]],
      auto:value => [value === 'on' ? AUTO_ANY : `NOT ${AUTO_ANY}`]}},
};
const LIKE = "LIKE ? ESCAPE '\\'";
// Folded text is matched with instr (a literal substring scan, several times faster than LIKE); ASCII columns keep a
// case-insensitive LIKE.
function searchSql({keys=[],raw=[],text=[],group}={},q,ownerId) {
  if (!q) return null;
  const needle = fold(q), pattern = likePattern(q);
  const folded = [...keys.map(key => `instr(${key},?)>0`),...text.map(column => `(${column} IS NOT NULL AND instr(fold(${column}),?)>0)`)];
  const parts = [...folded,...raw.map(column => `${column} ${LIKE}`)], params = [...folded.map(() => needle),...raw.map(() => pattern)];
  if (group) { parts.push(`${group} IN (SELECT id FROM groups WHERE owner_id=? AND instr(fold(COALESCE(name,'')),?)>0)`); params.push(ownerId,needle); }
  return {sql:`(${parts.join(' OR ')})`,params};
}

export class Store {
  #statements = new Map();
  prepare(sql) {
    let statement=this.#statements.get(sql);
    // Least recently used goes first: list filter/sort variants must not evict the hot statements.
    if(statement) this.#statements.delete(sql);
    else {
      statement=this.db.prepare(sql);
      // Dynamic allowlist lengths must not grow the cache indefinitely.
      if(this.#statements.size>=512) this.#statements.delete(this.#statements.keys().next().value);
    }
    this.#statements.set(sql,statement);
    return statement;
  }
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.function('fold',{deterministic:true},value => value == null ? null : normalizeSearchText(value));
    this.db.function('search_key',{deterministic:true,varargs:true},searchKey);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (
        owner_id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL,
        keywords_json TEXT NOT NULL DEFAULT '[]',
        reject_keywords_json TEXT NOT NULL DEFAULT '[]'
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
    const userColumns = this.prepare('PRAGMA table_info(users)').all().map(column => column.name);
    if (!userColumns.includes('reject_keywords_json')) {
      this.db.exec("ALTER TABLE users ADD COLUMN reject_keywords_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!userColumns.includes('rejected_notify_since')) this.db.exec('ALTER TABLE users ADD COLUMN rejected_notify_since INTEGER');
    // Set once a post was also delivered by the "Most recent groups" feed; the sweep favours groups it misses.
    if (!this.prepare('PRAGMA table_info(posts)').all().some(column => column.name === 'via_feed')) this.db.exec('ALTER TABLE posts ADD COLUMN via_feed INTEGER NOT NULL DEFAULT 0');
    const columns = this.prepare('PRAGMA table_info(groups)').all().map(column => column.name);
    for (const [name,type] of [['date_range_json','TEXT'],['name','TEXT'],['auto_reply','TEXT'],['auto_reply_since','INTEGER'],['auto_inbox','TEXT'],['auto_inbox_since','INTEGER'],['auto_friend','INTEGER NOT NULL DEFAULT 0'],['auto_friend_since','INTEGER'],['auto_block','INTEGER NOT NULL DEFAULT 0'],['auto_block_since','INTEGER'],['tiktok_auto_json','TEXT'],['source_type',"TEXT NOT NULL DEFAULT 'group'"],['content_type',"TEXT NOT NULL DEFAULT 'all'"],['reject_keywords_json','TEXT'],['numeric_id','TEXT'],['last_seen_time','INTEGER'],['next_scan_at','INTEGER'],['scan_interval_ms','INTEGER']]) {
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
      CREATE TABLE IF NOT EXISTS direct_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, post_id TEXT NOT NULL,
        recipient_url TEXT NOT NULL, recipient_name TEXT, body TEXT NOT NULL,
        source TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, sent_at INTEGER, error TEXT,
        UNIQUE(group_id,post_id,recipient_url,body),
        FOREIGN KEY(group_id,post_id) REFERENCES posts(group_id,post_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS friend_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, post_id TEXT NOT NULL,
        recipient_url TEXT NOT NULL, recipient_name TEXT,
        source TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, sent_at INTEGER, error TEXT,
        UNIQUE(group_id,post_id,recipient_url),
        FOREIGN KEY(group_id,post_id) REFERENCES posts(group_id,post_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tiktok_auto_jobs (
        group_id INTEGER NOT NULL, post_id TEXT NOT NULL, config_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', error TEXT,
        PRIMARY KEY(group_id,post_id),
        FOREIGN KEY(group_id,post_id) REFERENCES posts(group_id,post_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS rejected_deliveries (
        group_id INTEGER NOT NULL, post_id TEXT NOT NULL, body TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(group_id,post_id),
        FOREIGN KEY(group_id,post_id) REFERENCES posts(group_id,post_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS blocked_authors (
        owner_id INTEGER NOT NULL, profile TEXT NOT NULL, state TEXT NOT NULL,
        PRIMARY KEY(owner_id,profile)
      );
      CREATE TABLE IF NOT EXISTS commenter_block_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL, post_id TEXT NOT NULL, post_url TEXT NOT NULL, run_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', result_json TEXT, error TEXT, created_at INTEGER NOT NULL,
        UNIQUE(owner_id,post_url),
        FOREIGN KEY(group_id,post_id) REFERENCES posts(group_id,post_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS commenter_block_due ON commenter_block_jobs(run_at) WHERE state IN ('pending','interrupted');
      UPDATE blocked_authors SET state='uncertain' WHERE state='sending';
      -- Not resumed silently: the owner is told and presses again; per-profile states above prevent re-sends.
      UPDATE commenter_block_jobs SET state='interrupted' WHERE state='running';
      UPDATE tiktok_auto_jobs SET state='pending' WHERE state='working';
      UPDATE comments SET state='failed' WHERE state='uncertain' AND error IN
        ('Không xác định duy nhất bài viết để bình luận.','Không tìm thấy ô bình luận chính; bài có thể đã khóa bình luận.');
      UPDATE media_deliveries SET state='failed' WHERE state='sending';
    `);
    // Legacy auto-job marker retained for compatibility; no repeat is scheduled.
    if (!this.prepare('PRAGMA table_info(commenter_block_jobs)').all().some(column => column.name === 'repeat_until')) this.db.exec('ALTER TABLE commenter_block_jobs ADD COLUMN repeat_until INTEGER');
    // Discard repeat passes queued by older versions; preserve the previous result.
    this.db.exec("UPDATE commenter_block_jobs SET state='stopped' WHERE repeat_until IS NOT NULL AND state='pending' AND result_json IS NOT NULL AND result_json NOT LIKE '%\"retries\"%'");
    if (!this.prepare('PRAGMA table_info(message_posts)').all().some(column=>column.name==='reply_mode')) {
      this.db.exec("ALTER TABLE message_posts ADD COLUMN reply_mode TEXT NOT NULL DEFAULT 'single'");
    }
    const dmColumns = this.prepare('PRAGMA table_info(direct_messages)').all().map(column => column.name);
    for (const [name, type] of [['sent_at', 'INTEGER'], ['error', 'TEXT']]) {
      if (!dmColumns.includes(name)) this.db.exec(`ALTER TABLE direct_messages ADD COLUMN ${name} ${type}`);
    }
    const frColumns = this.prepare('PRAGMA table_info(friend_requests)').all().map(column => column.name);
    for (const [name, type] of [['sent_at', 'INTEGER'], ['error', 'TEXT']]) {
      if (!frColumns.includes(name)) this.db.exec(`ALTER TABLE friend_requests ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS pending_comments ON comments(id,group_id) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS pending_direct_messages ON direct_messages(id,group_id) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS sent_direct_messages ON direct_messages(sent_at,state) WHERE state='sent';
      CREATE INDEX IF NOT EXISTS dm_recipient_state ON direct_messages(recipient_url,state);
      CREATE INDEX IF NOT EXISTS pending_friend_requests ON friend_requests(id,group_id) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS sent_friend_requests ON friend_requests(sent_at,state) WHERE state='sent';
      CREATE INDEX IF NOT EXISTS fr_recipient_state ON friend_requests(recipient_url,state);
      CREATE INDEX IF NOT EXISTS comments_post_state ON comments(group_id,post_id,state);
      CREATE INDEX IF NOT EXISTS pending_deliveries ON deliveries(next_attempt_at,group_id,post_id)
        WHERE sent_body IS NULL OR sent_body<>body;
      CREATE INDEX IF NOT EXISTS pending_media ON media_deliveries(group_id,post_id,position) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS tiktok_jobs_state ON tiktok_auto_jobs(state);
      CREATE INDEX IF NOT EXISTS posts_by_source_date ON posts(group_id,first_seen_at DESC,post_id);
      CREATE INDEX IF NOT EXISTS posts_by_date ON posts(first_seen_at DESC,group_id,post_id);
      CREATE INDEX IF NOT EXISTS active_sources ON groups(COALESCE(last_scan_at,0),id) WHERE paused=0;
      CREATE INDEX IF NOT EXISTS affiliate_recent ON affiliate_links(owner_id,account_key,updated_at DESC,id DESC);
    `);
    for (const [table,columns] of Object.entries(KEYS)) {
      const existing = this.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
      for (const [name] of columns) if (!existing.includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT`);
      // Holds only rows still waiting for the backfill, so it stays empty once that is done.
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_key_pending ON ${table}(${columns[0][0]}) WHERE ${columns[0][0]} IS NULL`);
    }
    // The error is part of the search key, so the rows it changes are re-keyed by the backfill below.
    for (const table of ['comments','direct_messages','friend_requests']) {
      this.db.exec(`UPDATE ${table} SET state='uncertain',error='Bot dừng trong lúc gửi; kiểm tra Facebook trước khi thao tác lại.',search=NULL WHERE state='sending'`);
    }
    // Set when a row leaves its list but must stay as dedupe memory (removeListItem).
    for (const table of ['posts','rejected_deliveries','comments','direct_messages','friend_requests']) {
      if (!this.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'hidden_at')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN hidden_at INTEGER`);
    }
    // Sort columns of the paged lists (an index ends with the rowid, which is the tie-breaker). They hold visible rows only,
    // so a count or page never reads the table to skip hidden ones; copies from before hidden_at are rebuilt once.
    const LIST_INDEXES = [['posts_seen','posts(first_seen_at,group_id)'],['posts_published','posts(published_at,group_id)'],['posts_author','posts(author_key,group_id)'],
      // Covers kind filters and search counts without reading data_json.
      ['posts_group_search','posts(group_id,kind,search)'],['rejected_seen','rejected_deliveries(seen_at,group_id)'],['comments_created','comments(created_at,group_id)'],
      ['direct_messages_time','direct_messages(COALESCE(sent_at,created_at),group_id)'],['direct_messages_name','direct_messages(name_key,group_id)'],
      ['friend_requests_time','friend_requests(COALESCE(sent_at,created_at),group_id)'],['friend_requests_name','friend_requests(name_key,group_id)'],
      // Owner counts (by source) and state filters, answered from the index alone.
      ['rejected_visible','rejected_deliveries(group_id)'],['comments_visible','comments(group_id,state)'],['direct_messages_visible','direct_messages(group_id,state)'],['friend_requests_visible','friend_requests(group_id,state)']];
    for (const [name] of LIST_INDEXES) if (!this.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name)?.sql.includes('hidden_at')) this.db.exec(`DROP INDEX IF EXISTS ${name}`);
    for (const [name,on] of LIST_INDEXES) this.db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${on} WHERE hidden_at IS NULL`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS posts_hidden ON posts(hidden_at,group_id) WHERE hidden_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS rejected_hidden ON rejected_deliveries(hidden_at,group_id) WHERE hidden_at IS NOT NULL;
    `);
    if (filename !== ':memory:') {
      this.#configFile = path.join(path.dirname(path.resolve(filename)),'general-config.json');
      this.#restoreGeneralConfig();
    }
    if (!this.backfillKeys()) this.#scheduleBackfill();
    // Table statistics let the planner pick the small index for a plain count (bounded, cheap when nothing changed).
    this.db.exec('PRAGMA analysis_limit=400; PRAGMA optimize=0x10002;');
  }
  #backfillTimer = null;
  #scheduleBackfill() {
    this.#backfillTimer = setTimeout(() => { if (!this.backfillKeys(50)) this.#scheduleBackfill(); else this.#backfillTimer = null; },100);
    this.#backfillTimer.unref?.();
  }
  // Fills the search/sort keys of rows written before those columns existed, within `budgetMs`; true when nothing is left.
  backfillKeys(budgetMs=200) {
    const until = Date.now()+budgetMs;
    for (const [table,columns] of Object.entries(KEYS)) {
      const update = this.prepare(`UPDATE ${table} SET ${columns.map(([name,expr]) => `${name}=${expr(`${table}.`)}`).join(',')}
        WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${columns[0][0]} IS NULL LIMIT 2000)`);
      while (update.run().changes) if (Date.now() >= until) return false;
    }
    return true;
  }
  // Account-wide Accept/Reject keywords are mirrored to a JSON file beside the database, so a deleted or
  // recreated database gets them back. Per-group settings stay in the database only.
  #configFile = null;
  #restoreGeneralConfig() {
    let saved;
    try { saved = JSON.parse(readFileSync(this.#configFile,'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') { console.warn(`Bỏ qua ${this.#configFile}: ${error.message}`); return; }
    }
    for (const [ownerId,user] of Object.entries(saved?.users ?? {})) {
      if (!/^[1-9]\d*$/.test(ownerId) || !Number.isSafeInteger(Number(ownerId)) || !Number.isSafeInteger(user?.chatId)) continue;
      const keywords = Array.isArray(user.keywords) ? user.keywords : [], reject = Array.isArray(user.rejectKeywords) ? user.rejectKeywords : [];
      // Only fills a missing or empty account: the database stays the source of truth while it still has keywords.
      this.prepare(`INSERT INTO users(owner_id,chat_id,keywords_json,reject_keywords_json) VALUES(?,?,?,?)
        ON CONFLICT(owner_id) DO UPDATE SET keywords_json=excluded.keywords_json,reject_keywords_json=excluded.reject_keywords_json
        WHERE users.keywords_json='[]' AND users.reject_keywords_json='[]'`).run(Number(ownerId),user.chatId,JSON.stringify(keywords),JSON.stringify(reject));
    }
    this.#saveGeneralConfig();
  }
  #saveGeneralConfig() {
    if (!this.#configFile) return;
    const users = {};
    for (const row of this.prepare('SELECT owner_id,chat_id,keywords_json,reject_keywords_json FROM users ORDER BY owner_id').all()) {
      users[row.owner_id] = {chatId:row.chat_id,keywords:JSON.parse(row.keywords_json),rejectKeywords:JSON.parse(row.reject_keywords_json)};
    }
    const temporary = `${this.#configFile}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary,`${JSON.stringify({version:1,updatedAt:new Date().toISOString(),users},null,2)}\n`,{encoding:'utf8',mode:0o600});
      renameSync(temporary,this.#configFile);
    } catch (error) { console.warn(`Không lưu được ${this.#configFile}: ${error.message}`); }
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
      const rejectKeywords=this.effectiveRejectKeywords(group);
      selected=this.prepare('SELECT post_id,data_json FROM posts WHERE group_id=? AND hidden_at IS NULL').all(groupId).filter(row=>{
        const post=JSON.parse(row.data_json);
        return matchesKeywords(post.text,keywords,rejectKeywords) && matchesDateRange(post,group.dateRange,now);
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
    if (source === 'auto') {
      const already = this.prepare("SELECT 1 FROM comments WHERE group_id=? AND post_id=? AND state IN ('pending','sending','sent') AND source='auto'").get(groupId,String(postId));
      if (already) return 0;
    }
    return this.prepare(`INSERT INTO comments(group_id,post_id,body,source,created_at,search) VALUES(?,?,?,?,?,?)
      ON CONFLICT(group_id,post_id,body) DO UPDATE SET state='pending',error=NULL,search=excluded.search,source=excluded.source,created_at=excluded.created_at
      WHERE comments.state='failed' AND excluded.source='manual'`)
      .run(groupId,postId,body,source,now,searchKey(body,String(postId))).changes;
  }
  setAutoReply(ownerId,groupId,text,now=Date.now()) {
    if (text !== null) text = commentText(text);
    const result = this.prepare('UPDATE groups SET auto_reply=?,auto_reply_since=? WHERE owner_id=? AND id=?').run(text,text ? now : null,ownerId,groupId);
    if (result.changes) this.prepare("UPDATE comments SET state='cancelled' WHERE group_id=? AND source='auto' AND state='pending'").run(groupId);
    return result.changes;
  }
  setAutoInbox(ownerId,groupId,text,now=Date.now()) {
    if (text !== null) text = directMessageText(text);
    const result = this.prepare('UPDATE groups SET auto_inbox=?,auto_inbox_since=? WHERE owner_id=? AND id=?').run(text,text ? now : null,ownerId,groupId);
    if (result.changes) this.prepare("UPDATE direct_messages SET state='cancelled' WHERE group_id=? AND source='auto' AND state='pending'").run(groupId);
    return result.changes;
  }
  enqueueDirectMessage(groupId,postId,recipientUrl,recipientName,body,source,now) {
    const norm = normalizeAuthorUrl(recipientUrl) || recipientUrl;
    const ownerId = this.getGroup(groupId)?.ownerId;
    const already = this.prepare(`SELECT 1 FROM direct_messages d JOIN groups g ON g.id=d.group_id
      WHERE g.owner_id=? AND (d.recipient_url=? OR d.recipient_url=?)
      AND d.state IN ('pending','sending','sent','uncertain')`).get(ownerId,norm,recipientUrl);
    if (already) return 0;
    return this.prepare(`INSERT INTO direct_messages(group_id,post_id,recipient_url,recipient_name,body,source,created_at,search,name_key) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(group_id,post_id,recipient_url,body) DO UPDATE SET state='pending',error=NULL,search=excluded.search,source=excluded.source
      WHERE direct_messages.state IN ('failed','cancelled') AND excluded.source='manual'`)
      .run(groupId,String(postId),norm,recipientName || null,body,source,now,searchKey(body,recipientName || null,norm,String(postId)),searchKey(recipientName || norm)).changes;
  }
  queueDirectMessage(ownerId,groupId,postId,text,source='manual',now=Date.now()) {
    const group = this.getGroup(groupId);
    if (!group || group.ownerId !== ownerId) throw new Error('Không tìm thấy nguồn hoặc nguồn không thuộc quyền quản lý.');
    const post = this.getSavedPost(ownerId,groupId,postId);
    if (!post) throw new Error('Bài viết không tồn tại trong dữ liệu.');
    if (!post.authorUrl || isAnonymousAuthor(post.author)) throw new Error('Bài viết ẩn danh hoặc không xác định được link trang cá nhân của người đăng.');
    const body = renderDirectMessage(directMessageText(text), { name: post.author, post, link: post.url });
    const norm = normalizeAuthorUrl(post.authorUrl) || post.authorUrl;
    const existing = this.prepare("SELECT state FROM direct_messages WHERE group_id=? AND post_id=? AND (recipient_url=? OR recipient_url=?) AND body=?").get(groupId, String(postId), norm, post.authorUrl, body);
    if (existing?.state === 'sent' || existing?.state === 'uncertain') {
      throw new Error(`Đã gửi tin nhắn này tới ${post.author || 'người đăng'} từ trước rồi.`);
    }
    if (existing?.state === 'pending' || existing?.state === 'sending') {
      throw new Error(`Tin nhắn tới ${post.author || 'người đăng'} đang trong hàng đợi xử lý.`);
    }
    const queued = this.enqueueDirectMessage(groupId,String(postId),post.authorUrl,post.author,body,source,now);
    if (!queued) throw new Error('Không xếp thêm tin nhắn: người nhận đã có tin đang chờ, đã gửi hoặc chưa xác nhận trong dữ liệu bot. Chỉ gửi tin mở đầu.');
    return { queued, recipientName: post.author, recipientUrl: post.authorUrl, body };
  }
  listDirectMessages(ownerId) {
    return this.prepare(`SELECT d.* FROM direct_messages d JOIN groups g ON g.id=d.group_id WHERE g.owner_id=? ORDER BY d.id DESC LIMIT 20`).all(ownerId);
  }
  cancelDirectMessages(ownerId,groupId=null) {
    return this.prepare(`UPDATE direct_messages SET state='cancelled' WHERE state='pending' AND group_id IN
      (SELECT id FROM groups WHERE owner_id=? AND (? IS NULL OR id=?))`).run(ownerId,groupId,groupId).changes;
  }
  nextDirectMessage(allowed) {
    if (!allowed?.length) return undefined;
    for (const ownerId of allowed) {
      const item = this.prepare(`SELECT d.*,g.owner_id,u.chat_id,p.data_json FROM direct_messages d INDEXED BY pending_direct_messages
        JOIN groups g ON g.id=d.group_id JOIN users u ON u.owner_id=g.owner_id JOIN posts p ON p.group_id=d.group_id AND p.post_id=d.post_id
        WHERE d.state='pending' AND g.paused=0 AND g.owner_id=? ORDER BY d.id LIMIT 1`).get(ownerId);
      if (item) return item;
    }
    return undefined;
  }
  directMessageState(id,state,error=null,sentAt=null) {
    this.prepare('UPDATE direct_messages SET state=?,error=?,sent_at=COALESCE(?,sent_at) WHERE id=?').run(state,error,sentAt,id);
    this.rekey('direct_messages',id);
  }
  canDirectMessage(item) {
    if (!item) return false;
    const group = this.getGroup(item.group_id);
    if (!group || group.paused || group.ownerId !== item.owner_id) return false;
    // Applies to manual messages too, including jobs queued before this rule existed.
    const norm = normalizeAuthorUrl(item.recipient_url) || item.recipient_url;
    const duplicate = this.prepare(`SELECT 1 FROM direct_messages d JOIN groups g ON g.id=d.group_id
      WHERE g.owner_id=? AND (d.recipient_url=? OR d.recipient_url=?) AND d.id<>?
      AND (d.state IN ('sending','sent','uncertain') OR (d.state='pending' AND d.id<?))`)
      .get(group.ownerId,norm,item.recipient_url,item.id,item.id);
    if (duplicate) return false;
    if (item.source === 'manual') return true;
    if (item.source === 'auto') {
      if (!group.autoInbox) return false;
      const dataJson = item.data_json || this.prepare('SELECT data_json FROM posts WHERE group_id=? AND post_id=?').get(item.group_id,item.post_id)?.data_json;
      if (!dataJson) return false;
      const post = JSON.parse(dataJson);
      return Date.parse(post.publishedAt) >= group.autoInboxSince
        && matchesKeywords(post.text,this.effectiveKeywords(group),this.effectiveRejectKeywords(group))
        && matchesDateRange(post,group.dateRange);
    }
    return true;
  }
  setAutoBlock(ownerId,groupId,enabled,now=Date.now()) {
    const group = this.getGroup(groupId);
    if (!group || group.ownerId !== ownerId) return 0;
    const val = enabled ? 1 : 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.prepare('UPDATE groups SET auto_block=?,auto_block_since=? WHERE owner_id=? AND id=?').run(val,val ? group.autoBlockSince ?? now : null,ownerId,groupId);
      if (!val) this.prepare("UPDATE commenter_block_jobs SET repeat_until=NULL,state=CASE WHEN state IN ('pending','running','interrupted') THEN 'stopped' ELSE state END WHERE group_id=? AND repeat_until IS NOT NULL").run(groupId);
      else {
        const keywords = this.effectiveKeywords(group), reject = this.effectiveRejectKeywords(group);
        for (const row of this.prepare('SELECT post_id,data_json FROM posts WHERE group_id=? AND eligible=1').all(groupId)) {
          const post = JSON.parse(row.data_json);
          if (!post.url || !matchesKeywords(post.text,keywords,reject) || !matchesDateRange(post,group.dateRange,now)) continue;
          this.prepare("UPDATE commenter_block_jobs SET state='pending',run_at=?,repeat_until=?,error=NULL WHERE owner_id=? AND post_url=? AND state IN ('failed','stopped')").run(now,now+COMMENTER_AUTO_WINDOW_MS,ownerId,post.url);
          this.scheduleAcceptedCommenterBlock(group,row.post_id,post.url,now);
        }
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setAutoFriend(ownerId,groupId,enabled,now=Date.now()) {
    const val = enabled ? 1 : 0;
    const result = this.prepare('UPDATE groups SET auto_friend=?,auto_friend_since=? WHERE owner_id=? AND id=?').run(val,val ? now : null,ownerId,groupId);
    if (result.changes && !val) {
      this.prepare("UPDATE friend_requests SET state='cancelled' WHERE group_id=? AND source='auto' AND state='pending'").run(groupId);
    }
    return result.changes;
  }
  enqueueFriendRequest(groupId,postId,recipientUrl,recipientName,source,now) {
    const norm = normalizeAuthorUrl(recipientUrl) || recipientUrl;
    if (source === 'auto') {
      const already = this.prepare("SELECT 1 FROM friend_requests WHERE (recipient_url=? OR recipient_url=?) AND state IN ('pending','sending','sent','uncertain')").get(norm,recipientUrl);
      if (already) return 0;
    }
    return this.prepare(`INSERT INTO friend_requests(group_id,post_id,recipient_url,recipient_name,source,created_at,search,name_key) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(group_id,post_id,recipient_url) DO UPDATE SET state='pending',error=NULL,search=excluded.search,source=excluded.source,hidden_at=NULL
      WHERE friend_requests.state IN ('failed','cancelled','uncertain','sent') AND excluded.source='manual'`)
      .run(groupId,String(postId),norm,recipientName || null,source,now,searchKey(recipientName || null,norm,String(postId)),searchKey(recipientName || norm)).changes;
  }
  queueFriendRequest(ownerId,groupId,postId,source='manual',now=Date.now()) {
    const group = this.getGroup(groupId);
    if (!group || group.ownerId !== ownerId) throw new Error('Không tìm thấy nguồn hoặc nguồn không thuộc quyền quản lý.');
    const post = this.getSavedPost(ownerId,groupId,postId);
    if (!post) throw new Error('Bài viết không tồn tại trong dữ liệu.');
    if (!post.authorUrl || isAnonymousAuthor(post.author)) throw new Error('Bài viết ẩn danh hoặc không xác định được link trang cá nhân của người đăng.');
    const norm = normalizeAuthorUrl(post.authorUrl) || post.authorUrl;
    const existing = this.prepare("SELECT state, error FROM friend_requests WHERE group_id=? AND post_id=? AND (recipient_url=? OR recipient_url=?)").get(groupId, String(postId), norm, post.authorUrl);
    // 'sent' may be re-queued: older versions misread "Thêm bạn bè" as already friends,
    // and the profile check now reports a real existing request instead of resending.
    if (existing?.state === 'pending' || existing?.state === 'sending') {
      throw new Error(`Lời mời kết bạn tới ${post.author || 'người đăng'} đang trong hàng đợi xử lý.`);
    }
    const queued = this.enqueueFriendRequest(groupId,String(postId),post.authorUrl,post.author,source,now);
    return { queued, recipientName: post.author, recipientUrl: post.authorUrl };
  }
  listFriendRequests(ownerId) {
    return this.prepare(`SELECT f.* FROM friend_requests f JOIN groups g ON g.id=f.group_id WHERE g.owner_id=? ORDER BY f.id DESC LIMIT 20`).all(ownerId);
  }
  cancelFriendRequests(ownerId,groupId=null) {
    return this.prepare(`UPDATE friend_requests SET state='cancelled' WHERE state='pending' AND group_id IN
      (SELECT id FROM groups WHERE owner_id=? AND (? IS NULL OR id=?))`).run(ownerId,groupId,groupId).changes;
  }
  nextFriendRequest(allowed) {
    if (!allowed?.length) return undefined;
    for (const ownerId of allowed) {
      const item = this.prepare(`SELECT f.*,g.owner_id,u.chat_id,p.data_json FROM friend_requests f INDEXED BY pending_friend_requests
        JOIN groups g ON g.id=f.group_id JOIN users u ON u.owner_id=g.owner_id JOIN posts p ON p.group_id=f.group_id AND p.post_id=f.post_id
        WHERE f.state='pending' AND g.paused=0 AND g.owner_id=? ORDER BY f.id LIMIT 1`).get(ownerId);
      if (item) return item;
    }
    return undefined;
  }
  friendRequestState(id,state,error=null,sentAt=null) {
    this.prepare('UPDATE friend_requests SET state=?,error=?,sent_at=COALESCE(?,sent_at) WHERE id=?').run(state,error,sentAt,id);
    this.rekey('friend_requests',id);
  }
  canFriendRequest(item) {
    if (!item) return false;
    const group = this.getGroup(item.group_id);
    if (!group || group.paused || group.ownerId !== item.owner_id) return false;
    if (item.source === 'manual') return true;
    if (item.source === 'auto') {
      const norm = normalizeAuthorUrl(item.recipient_url) || item.recipient_url;
      const duplicateSent = this.prepare("SELECT 1 FROM friend_requests WHERE (recipient_url=? OR recipient_url=?) AND state IN ('sending','sent','uncertain') AND id<>?").get(norm,item.recipient_url,item.id);
      if (duplicateSent) return false;
      if (!group.autoFriend) return false;
      const dataJson = item.data_json || this.prepare('SELECT data_json FROM posts WHERE group_id=? AND post_id=?').get(item.group_id,item.post_id)?.data_json;
      if (!dataJson) return false;
      const post = JSON.parse(dataJson);
      return Date.parse(post.publishedAt) >= group.autoFriendSince
        && matchesKeywords(post.text,this.effectiveKeywords(group),this.effectiveRejectKeywords(group))
        && matchesDateRange(post,group.dateRange);
    }
    return true;
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
  commentState(id,state,error=null) { this.prepare('UPDATE comments SET state=?,error=? WHERE id=?').run(state,error,id); this.rekey('comments',id); }
  // Recomputes a row's search key after its error text changed.
  rekey(table,id) {
    this.prepare(`UPDATE ${table} SET ${KEYS[table].map(([name,expr]) => `${name}=${expr(`${table}.`)}`).join(',')} WHERE id=?`).run(id);
  }
  canComment(item) {
    if (!item) return false;
    const group = this.getGroup(item.group_id);
    if (item.source === 'auto') {
      const duplicateSent = this.prepare("SELECT 1 FROM comments WHERE group_id=? AND post_id=? AND state='sent' AND source='auto' AND id<>?").get(item.group_id,item.post_id,item.id);
      if (duplicateSent) return false;
    }
    if(item.source==='tiktok-auto') {
      const job=this.prepare('SELECT * FROM tiktok_auto_jobs WHERE group_id=? AND post_id=?').get(item.group_id,item.post_id);
      return Boolean(job && this.canTikTokJob({...job,owner_id:item.owner_id}));
    }
    const dataJson = item.data_json || (item.source === 'auto' ? this.prepare('SELECT data_json FROM posts WHERE group_id=? AND post_id=?').get(item.group_id,item.post_id)?.data_json : null);
    const post = dataJson ? JSON.parse(dataJson) : null;
    return Boolean(group && !group.paused && group.ownerId === item.owner_id &&
      (item.source !== 'auto' || (post && group.autoReply === item.body && Date.parse(post.publishedAt) >= group.autoReplySince
        && matchesKeywords(post.text,this.effectiveKeywords(group),this.effectiveRejectKeywords(group)) && matchesDateRange(post,group.dateRange))));
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
  initStartupDateRange(now = Date.now(), { all = true } = {}) {
    const rangeJson = JSON.stringify({ start: now, end: null });
    if (all) {
      return this.prepare('UPDATE groups SET date_range_json=?, last_scan_at=NULL').run(rangeJson).changes;
    }
    return this.prepare(`UPDATE groups SET date_range_json=?, last_scan_at=NULL
      WHERE date_range_json IS NULL OR json_extract(date_range_json, '$.end') IS NULL`).run(rangeJson).changes;
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
      && matchesKeywords(post.text,this.effectiveKeywords(group),this.effectiveRejectKeywords(group)) && matchesDateRange(post,group.dateRange));
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
  close() { clearTimeout(this.#backfillTimer); this.#statements.clear(); this.db.close(); }
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
    const {changes} = this.prepare(`INSERT INTO users(owner_id,chat_id) VALUES(?,?)
      ON CONFLICT(owner_id) DO UPDATE SET chat_id=excluded.chat_id WHERE users.chat_id<>excluded.chat_id`).run(ownerId, chatId);
    if (changes) this.#saveGeneralConfig();
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
    if (item.numericId) this.setNumericId(result.group.id,item.numericId);
    return result;
  }
  // Backfills numeric IDs of already-followed groups from a joined-groups listing; returns rows updated.
  setNumericIdsByUrl(ownerId, items) {
    let changed = 0;
    for (const item of items) {
      const id = item.numericId && this.prepare('SELECT id FROM groups WHERE owner_id=? AND url=?').get(ownerId,item.url)?.id;
      if (id) changed += this.setNumericId(id,item.numericId);
    }
    return changed;
  }
  listGroups(ownerId) { return this.prepare('SELECT * FROM groups WHERE owner_id=? ORDER BY id').all(ownerId).map(decodeGroup); }
  allActiveGroups() { return this.prepare('SELECT * FROM groups WHERE paused=0 ORDER BY COALESCE(last_scan_at,0),id').all().map(decodeGroup); }
  // An explicit rescan clears last_scan_at, so it bypasses the adaptive next_scan_at.
  dueGroups(allowed,cutoff,now=Date.now(),accept=null) {
    if(!allowed.length) return [];
    // Explicit rescans first, then the busiest groups (shortest planned interval) when several are due.
    const statement = this.prepare(`SELECT * FROM groups WHERE paused=0 AND (last_scan_at IS NULL OR (last_scan_at<=? AND COALESCE(next_scan_at,0)<=?))
      AND owner_id IN (${allowed.map(()=>'?').join(',')}) ORDER BY last_scan_at IS NOT NULL,COALESCE(scan_interval_ms,0),COALESCE(last_scan_at,0),id`);
    if (!accept) return statement.all(cutoff,now,...allowed).map(decodeGroup);
    // Decode only until the worker finds a runnable group, rather than every due row.
    for (const row of statement.iterate(cutoff,now,...allowed)) {
      const group = decodeGroup(row);
      if (accept(group)) return [group];
    }
    return [];
  }
  setNumericId(id,numericId) {
    if (!/^\d{5,25}$/.test(String(numericId ?? ''))) return 0;
    return this.prepare('UPDATE groups SET numeric_id=? WHERE id=? AND (numeric_id IS NULL OR numeric_id<>?)').run(String(numericId),id,String(numericId)).changes;
  }
  // Posts per hour each active group published within the window, from the stored publish times.
  activityRates(ownerId,windowMs=48*3600000,now=Date.now()) {
    const since = new Date(now-windowMs).toISOString();
    const rows = this.prepare(`SELECT g.id, COUNT(p.post_id) n FROM groups g LEFT JOIN posts p ON p.group_id=g.id
      AND json_extract(p.data_json,'$.publishedAt')>=? WHERE g.owner_id=? AND g.paused=0 GROUP BY g.id`).all(since,ownerId);
    return new Map(rows.map(row => [row.id,row.n*3600000/windowMs]));
  }
  // Per active group: useful posts published in the last `recentMs` (and how many of them the groups feed
  // missed) plus a 24-slot histogram of the last `historyMs` by Vietnam hour of day, for the scan planner.
  // "Useful" resists spam: only posts passing the group's Accept/Reject filter count, and each author at most
  // `perAuthor` times per window, so a few fake accounts flooding a group cannot make it look busy.
  activityProfile(ownerId,{recentMs=48*3600000,historyMs=7*86400000,now=Date.now(),matches=matchesKeywords,perAuthor=2}={}) {
    const groups = new Map(this.listGroups(ownerId).filter(group => !group.paused).map(group =>
      [group.id,{keywords:this.effectiveKeywords(group),reject:this.effectiveRejectKeywords(group)}]));
    const profile = new Map([...groups.keys()].map(id => [id,{recent:0,missed:0,total:0,hours:Array(24).fill(0)}]));
    const rows = this.prepare(`SELECT p.group_id id, p.data_json data, p.via_feed feed FROM posts p
      JOIN groups g ON g.id=p.group_id WHERE g.owner_id=? AND g.paused=0 AND json_extract(p.data_json,'$.publishedAt')>=?`)
      .all(ownerId,new Date(now-Math.max(recentMs,historyMs)).toISOString());
    const seen = new Map();
    for (const row of rows) {
      const item = profile.get(row.id), post = JSON.parse(row.data), time = Date.parse(post.publishedAt);
      if (!item || !Number.isFinite(time) || time > now) continue;
      if (time >= now-recentMs) item.total++;
      const filter = groups.get(row.id);
      if (!matches(post.text,filter.keywords,filter.reject)) continue;
      const author = `${row.id}
${post.authorUrl || post.author || post.id}`;
      const allow = key => { const count = (seen.get(key) || 0)+1; seen.set(key,count); return count <= perAuthor; };
      const local = new Date(time+7*3600000);
      if (time >= now-historyMs && allow(`${author}
${local.toISOString().slice(0,10)}`)) item.hours[local.getUTCHours()]++;
      if (time >= now-recentMs && allow(author)) { item.recent++; if (!row.feed) item.missed++; }
    }
    return profile;
  }
  // `plannedMs` (activity-based, already within budget) replaces the 1.5x backoff; a fresh post still rescans at minMs.
  scheduleScan(id,found,{minMs,maxMs,factor=1.5,plannedMs=null,now=Date.now()}) {
    const previous = this.prepare('SELECT scan_interval_ms FROM groups WHERE id=?').get(id)?.scan_interval_ms;
    const interval = found ? minMs : plannedMs ? Math.max(minMs,plannedMs)
      : !previous ? minMs : Math.min(maxMs,Math.max(minMs,Math.round(previous*factor)));
    this.prepare('UPDATE groups SET scan_interval_ms=?,next_scan_at=? WHERE id=?').run(interval,now+interval,id);
    return interval;
  }
  // Makes an already scanned group due now (its next_scan_at gate is lifted, the poll gap still applies).
  scanSoon(id) { return this.prepare('UPDATE groups SET next_scan_at=0 WHERE id=? AND paused=0').run(id).changes; }
  hasObservedPost(ownerId,groupId,postId) {
    return Boolean(this.prepare('SELECT 1 FROM posts p JOIN groups g ON g.id=p.group_id WHERE g.owner_id=? AND p.group_id=? AND p.post_id=?').get(ownerId,groupId,String(postId)));
  }
  // Drops posts no scan has returned for `keepMs`. Dedupe is by stored row, not the watermark, so a post still
  // on a scanned page keeps a fresh last_seen_at and is never re-delivered. Rows still needed are kept:
  // Telegram reply mapping, any comment/DM/friend history (recipient dedupe) and unfinished outbox work.
  prunePosts(keepMs,now=Date.now()) {
    const cutoff = now-keepMs;
    return Number(this.prepare(`DELETE FROM posts WHERE last_seen_at<? AND first_seen_at<?
      AND (group_id,post_id) NOT IN (SELECT group_id,post_id FROM message_posts)
      AND (group_id,post_id) NOT IN (SELECT group_id,post_id FROM comments)
      AND (group_id,post_id) NOT IN (SELECT group_id,post_id FROM direct_messages)
      AND (group_id,post_id) NOT IN (SELECT group_id,post_id FROM friend_requests)
      AND (group_id,post_id) NOT IN (SELECT group_id,post_id FROM deliveries WHERE sent_body IS NULL OR sent_body<>body)
      AND (group_id,post_id) NOT IN (SELECT group_id,post_id FROM rejected_deliveries WHERE sent=0)
      AND (group_id,post_id) NOT IN (SELECT group_id,post_id FROM media_deliveries WHERE state IN ('pending','sending'))
      AND (group_id,post_id) NOT IN (SELECT group_id,post_id FROM tiktok_auto_jobs WHERE state IN ('pending','working'))
      AND (group_id,post_id) NOT IN (SELECT group_id,post_id FROM commenter_block_jobs WHERE state IN ('pending','running','interrupted'))`).run(cutoff,cutoff).changes);
  }
  getGroup(id) { return decodeGroup(this.prepare('SELECT * FROM groups WHERE id=?').get(id)); }
  removeGroup(ownerId,id) { return this.prepare('DELETE FROM groups WHERE owner_id=? AND id=?').run(ownerId,id).changes > 0; }
  setPaused(ownerId,id,paused) {
    return (id === null
      ? this.prepare('UPDATE groups SET paused=? WHERE owner_id=?').run(Number(paused),ownerId)
      : this.prepare('UPDATE groups SET paused=? WHERE owner_id=? AND id=?').run(Number(paused),ownerId,id)).changes;
  }
  clearErrors(ownerId, id = null) {
    return (id === null
      ? this.prepare('UPDATE groups SET last_error=NULL,last_scan_at=NULL WHERE owner_id=?').run(ownerId)
      : this.prepare('UPDATE groups SET last_error=NULL,last_scan_at=NULL WHERE owner_id=? AND id=?').run(ownerId, id)).changes;
  }
  setKeywords(ownerId,id,keywords) {
    const {changes} = id === null
      ? this.prepare('UPDATE users SET keywords_json=? WHERE owner_id=?').run(JSON.stringify(keywords),ownerId)
      : this.prepare('UPDATE groups SET keywords_json=? WHERE owner_id=? AND id=?').run(JSON.stringify(keywords),ownerId,id);
    if (id === null && changes) this.#saveGeneralConfig();
    return changes;
  }
  getKeywords(ownerId) { return JSON.parse(this.prepare('SELECT keywords_json FROM users WHERE owner_id=?').get(ownerId)?.keywords_json || '[]'); }
  effectiveKeywords(group) { return group?.keywords ?? this.getKeywords(group?.ownerId); }
  setRejectKeywords(ownerId,id,keywords) {
    const {changes} = id === null
      ? this.prepare('UPDATE users SET reject_keywords_json=? WHERE owner_id=?').run(JSON.stringify(keywords),ownerId)
      : this.prepare('UPDATE groups SET reject_keywords_json=? WHERE owner_id=? AND id=?').run(JSON.stringify(keywords),ownerId,id);
    if (id === null && changes) this.#saveGeneralConfig();
    return changes;
  }
  getRejectKeywords(ownerId) { return JSON.parse(this.prepare('SELECT reject_keywords_json FROM users WHERE owner_id=?').get(ownerId)?.reject_keywords_json || '[]'); }
  effectiveRejectKeywords(group) { return group?.rejectKeywords ?? this.getRejectKeywords(group?.ownerId); }
  setAcceptKeywords(ownerId, id, keywords) { return this.setKeywords(ownerId, id, keywords); }
  getAcceptKeywords(ownerId) { return this.getKeywords(ownerId); }
  effectiveAcceptKeywords(group) { return this.effectiveKeywords(group); }
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
  // Returns how many posts were stored for the first time.
  observe(group,posts,{now=Date.now(),metricWindowMs,render,matches,finalize=true,advanceWatermark=true,fromFeed=false}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getGroup(group.id);
      if (!current || current.paused) { this.db.exec('COMMIT'); return 0; }
      let created = 0, newest = 0, ownerSince;
      const keywords = this.effectiveKeywords(current);
      const rejectKeywords = this.effectiveRejectKeywords(current);
      for (let post of posts) {
        if (!post.id || !post.url) continue;
        if (post.groupName && post.groupName!==current.label) {
          this.prepare('UPDATE groups SET name=? WHERE id=?').run(post.groupName,group.id);
          current.label = post.groupName;
        }
        const old = this.prepare('SELECT * FROM posts WHERE group_id=? AND post_id=?').get(group.id,String(post.id));
        if (!post.publishedAt && old) post = {...post,publishedAt:JSON.parse(old.data_json).publishedAt || null};
        if (!old) created++;
        // Clamp to now: one future timestamp must not freeze the incremental watermark.
        const published = Date.parse(post.publishedAt);
        if (Number.isFinite(published)) newest = Math.max(newest,Math.min(published,now));
        const firstSeenAt = old?.first_seen_at ?? now;
        const eligible = current.dateRange ? 1 : old?.eligible ?? Number(current.initialized);
        this.prepare(`INSERT INTO posts(group_id,post_id,data_json,first_seen_at,last_seen_at,last_metric_at,eligible,search,author_key,kind,published_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id,post_id)
          DO UPDATE SET data_json=excluded.data_json,search=excluded.search,author_key=excluded.author_key,kind=excluded.kind,published_at=excluded.published_at,last_seen_at=excluded.last_seen_at,last_metric_at=excluded.last_metric_at,eligible=excluded.eligible`)
          .run(group.id,String(post.id),JSON.stringify(post),firstSeenAt,now,now,eligible,searchKey(post.text,post.author,post.url,post.authorUrl,String(post.id)),searchKey(post.author),post.kind ?? '',post.publishedAt ?? null);
        if (fromFeed) this.prepare('UPDATE posts SET via_feed=1 WHERE group_id=? AND post_id=?').run(group.id,String(post.id));
        if (!eligible || (!current.dateRange && now-firstSeenAt > metricWindowMs) || !matchesDateRange(post,current.dateRange,now)) continue;
        if (!matches(post.text,keywords,rejectKeywords)) {
          if (ownerSince === undefined) ownerSince = this.prepare('SELECT rejected_notify_since AS since FROM users WHERE owner_id=?').get(current.ownerId)?.since ?? null;
          if (ownerSince !== null && firstSeenAt >= ownerSince) {
            const body = formatRejectedPost(current,post,testKeywords(post.text,keywords,rejectKeywords));
            this.prepare('INSERT OR IGNORE INTO rejected_deliveries(group_id,post_id,body,search,seen_at,published_at,author_key,kind) VALUES(?,?,?,?,?,?,?,?)')
              .run(group.id,String(post.id),body,searchKey(body,searchKey(post.text,post.author,post.url,post.authorUrl,String(post.id))),firstSeenAt,post.publishedAt ?? null,searchKey(post.author),post.kind ?? '');
          }
          continue;
        }
        if (current.autoBlock) this.scheduleAcceptedCommenterBlock(current,String(post.id),post.url,now);
        // Auto actions follow the first Telegram delivery, not the first sighting: a post seen before it
        // passed the filters must still be acted on once a filter change lets it through.
        const autoNew = !(old && this.prepare('SELECT 1 FROM deliveries WHERE group_id=? AND post_id=?').get(group.id,String(post.id)))
          && published >= now - AUTO_ACTION_MAX_AGE_MS;
        if (autoNew && current.autoReply && Date.parse(post.publishedAt) >= current.autoReplySince && Date.parse(post.publishedAt) <= now) {
          this.enqueueComment(group.id,String(post.id),current.autoReply,'auto',now);
        }
        if (autoNew && current.autoInbox && post.authorUrl && !isAnonymousAuthor(post.author) && Date.parse(post.publishedAt) >= current.autoInboxSince && Date.parse(post.publishedAt) <= now) {
          const body = renderDirectMessage(current.autoInbox, { name: post.author, post, link: post.url });
          this.enqueueDirectMessage(group.id,String(post.id),post.authorUrl,post.author,body,'auto',now);
        }
        if (autoNew && current.autoFriend && post.authorUrl && !isAnonymousAuthor(post.author) && Date.parse(post.publishedAt) >= current.autoFriendSince && Date.parse(post.publishedAt) <= now) {
          this.enqueueFriendRequest(group.id,String(post.id),post.authorUrl,post.author,'auto',now);
        }
        if(autoNew && current.initialized && current.tiktokAuto && Date.parse(post.publishedAt)>=current.tiktokAuto.since && Date.parse(post.publishedAt)<=now) {
          this.prepare('INSERT OR IGNORE INTO tiktok_auto_jobs(group_id,post_id,config_json) VALUES(?,?,?)').run(group.id,String(post.id),JSON.stringify(current.tiktokAuto));
        }
        normalizeMedia(post.media).forEach((media,index) => this.prepare('INSERT OR IGNORE INTO media_deliveries(group_id,post_id,position,data_json) VALUES(?,?,?,?)')
          .run(group.id,String(post.id),index,JSON.stringify(media)));
        const body = render(current,post,keywords);
        this.prepare(`INSERT INTO deliveries(group_id,post_id,body) VALUES(?,?,?)
          ON CONFLICT(group_id,post_id) DO UPDATE SET body=excluded.body WHERE deliveries.body<>excluded.body`).run(group.id,String(post.id),body);
      }
      if (newest && advanceWatermark) this.prepare('UPDATE groups SET last_seen_time=MAX(COALESCE(last_seen_time,0),?) WHERE id=?').run(newest,group.id);
      if (finalize) this.prepare('UPDATE groups SET initialized=1,last_scan_at=?,last_error=NULL WHERE id=?').run(now,group.id);
      this.db.exec('COMMIT');
      return created;
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
    this.prepare('UPDATE commenter_block_jobs SET message_id=? WHERE group_id=? AND post_id=? AND message_id=0').run(messageId,item.group_id,item.post_id);
  }
  deliveryFailed(item,delayMs,now=Date.now()) {
    this.prepare('UPDATE deliveries SET attempts=attempts+1,next_attempt_at=? WHERE group_id=? AND post_id=?')
      .run(now+delayMs,item.group_id,item.post_id);
  }
  // Local pacing (Telegram per-chat throttle) is not a failed send and must not grow the backoff exponent.
  deferDelivery(item,delayMs,now=Date.now()) {
    this.prepare('UPDATE deliveries SET next_attempt_at=? WHERE group_id=? AND post_id=?').run(now+delayMs,item.group_id,item.post_id);
  }
  resetMessage(item) {
    this.prepare('UPDATE deliveries SET message_id=NULL WHERE group_id=? AND post_id=?').run(item.group_id,item.post_id);
  }
  cancelDelivery(item) {
    if (item.sent_body === null) this.prepare('DELETE FROM deliveries WHERE group_id=? AND post_id=?').run(item.group_id,item.post_id);
    else this.prepare('UPDATE deliveries SET body=sent_body WHERE group_id=? AND post_id=?').run(item.group_id,item.post_id);
  }
  setRejectedNotify(ownerId,since) {
    const {changes} = this.prepare('UPDATE users SET rejected_notify_since=? WHERE owner_id=?').run(since,ownerId);
    if (since === null) this.prepare('DELETE FROM rejected_deliveries WHERE sent=0 AND group_id IN (SELECT id FROM groups WHERE owner_id=?)').run(ownerId);
    return changes;
  }
  getRejectedNotify(ownerId) { return this.prepare('SELECT rejected_notify_since AS since FROM users WHERE owner_id=?').get(ownerId)?.since ?? null; }
  claimAuthorBlock(ownerId,profile) {
    return this.prepare("INSERT INTO blocked_authors(owner_id,profile,state) VALUES(?,?,'sending') ON CONFLICT(owner_id,profile) DO UPDATE SET state='sending' WHERE blocked_authors.state='failed'").run(ownerId,profile).changes > 0;
  }
  authorBlockState(ownerId,profile) {
    return this.prepare('SELECT state FROM blocked_authors WHERE owner_id=? AND profile=?').get(ownerId,profile)?.state;
  }
  setAuthorBlockState(ownerId,profile,state) {
    this.prepare('UPDATE blocked_authors SET state=? WHERE owner_id=? AND profile=?').run(state,ownerId,profile);
  }
  // One job per owner and post; a finished-with-error or interrupted job is re-armed by pressing again.
  scheduleCommenterBlock(ownerId,chatId,messageId,groupId,postId,postUrl,runAt,now=Date.now()) {
    const {changes} = this.prepare(`INSERT INTO commenter_block_jobs(owner_id,chat_id,message_id,group_id,post_id,post_url,run_at,created_at)
      SELECT ?,?,?,g.id,?,?,?,? FROM groups g WHERE g.id=? AND g.owner_id=?
      ON CONFLICT(owner_id,post_url) DO UPDATE SET chat_id=excluded.chat_id,message_id=excluded.message_id,run_at=excluded.run_at,
        state='pending',result_json=NULL,error=NULL WHERE commenter_block_jobs.state IN ('failed','stopped')
        OR (commenter_block_jobs.state='pending' AND commenter_block_jobs.run_at>excluded.run_at)`)
      .run(ownerId,chatId,messageId,String(postId),postUrl,runAt,now,groupId,ownerId);
    return {scheduled:changes > 0,job:this.commenterBlockJob(ownerId,postUrl)};
  }
  // Never overrides an existing manual/auto job for the same post.
  scheduleAcceptedCommenterBlock(group,postId,postUrl,now=Date.now()) {
    const user = this.prepare('SELECT chat_id FROM users WHERE owner_id=?').get(group.ownerId);
    const delivery = this.prepare('SELECT message_id FROM deliveries WHERE group_id=? AND post_id=?').get(group.id,String(postId));
    this.scheduleAutoCommenterBlock(group.ownerId,user.chat_id,delivery?.message_id || 0,group.id,postId,postUrl,now,now+COMMENTER_AUTO_WINDOW_MS,now);
  }
  commenterBlockTarget(job) {
    const row = this.prepare('SELECT p.data_json FROM posts p JOIN groups g ON g.id=p.group_id WHERE g.owner_id=? AND p.group_id=? AND p.post_id=?').get(job.ownerId,job.groupId,job.postId);
    return row && {groupId:job.groupId,postId:job.postId,post:JSON.parse(row.data_json),replyMode:'single'};
  }
  scheduleAutoCommenterBlock(ownerId,chatId,messageId,groupId,postId,postUrl,runAt,repeatUntil,now=Date.now()) {
    this.prepare(`INSERT INTO commenter_block_jobs(owner_id,chat_id,message_id,group_id,post_id,post_url,run_at,repeat_until,created_at)
      SELECT ?,?,?,g.id,?,?,?,?,? FROM groups g WHERE g.id=? AND g.owner_id=?
      ON CONFLICT(owner_id,post_url) DO NOTHING`).run(ownerId,chatId,messageId,String(postId),postUrl,runAt,repeatUntil,now,groupId,ownerId);
  }
  commenterBlockJob(ownerId,postUrl) {
    return decodeCommenterJob(this.prepare('SELECT * FROM commenter_block_jobs WHERE owner_id=? AND post_url=?').get(ownerId,postUrl));
  }
  // The jobs of a page of posts in one query, shaped like listCommenterBlocks (for their queue position).
  commenterBlocksByUrls(ownerId,urls) {
    if (!urls.length) return [];
    return this.prepare(`SELECT j.*,g.name AS group_name,g.url AS group_url,g.paused AS group_paused,g.auto_block FROM commenter_block_jobs j JOIN groups g ON g.id=j.group_id AND g.owner_id=j.owner_id
      WHERE j.owner_id=? AND j.post_url IN (SELECT value FROM json_each(?))`).all(ownerId,JSON.stringify(urls)).map(decodeCommenterRow);
  }
  nextCommenterBlockJob(now=Date.now(),ownerIds) {
    if (!ownerIds?.length) return undefined;
    return decodeCommenterJob(this.prepare(`SELECT j.* FROM commenter_block_jobs j JOIN groups g ON g.id=j.group_id AND g.owner_id=j.owner_id
      WHERE g.paused=0 AND (j.state='interrupted' OR (j.state='pending' AND j.run_at<=?)) AND j.owner_id IN (${ownerIds.map(() => '?').join(',')})
      AND NOT EXISTS (SELECT 1 FROM commenter_block_jobs active WHERE active.owner_id=j.owner_id AND active.state='running')
      ORDER BY j.state='pending',j.run_at,j.id LIMIT 1`).get(now,...ownerIds));
  }
  // Same eligibility and order as nextCommenterBlockJob, so a position is exactly the turn the workers will take.
  commenterBlockQueue(now=Date.now(),ownerIds) {
    return this.prepare(`SELECT j.id,j.owner_id FROM commenter_block_jobs j JOIN groups g ON g.id=j.group_id AND g.owner_id=j.owner_id
      WHERE g.paused=0 AND (j.state='interrupted' OR (j.state='pending' AND j.run_at<=?))${ownerIds ? ` AND j.owner_id IN (${ownerIds.map(() => '?').join(',') || 'NULL'})` : ''}
      ORDER BY j.state='pending',j.run_at,j.id`).all(now,...(ownerIds ?? []));
  }
  retryCommenterBlocks(ownerId, id = null, now = Date.now()) {
    return this.prepare(`UPDATE commenter_block_jobs SET state='pending',run_at=?,error=NULL,
      result_json=CASE WHEN state='pending' THEN result_json ELSE NULL END
      WHERE owner_id=? AND (? IS NULL OR id=?)
      AND (state IN ('failed','stopped') OR (state='pending' AND run_at>?))`).run(now,ownerId,id,id,now).changes;
  }
  countRunningCommenterBlocks(ownerId = null) {
    return this.prepare("SELECT COUNT(*) n FROM commenter_block_jobs WHERE state='running' AND (? IS NULL OR owner_id=?)").get(ownerId,ownerId).n;
  }
  listCommenterBlocks(ownerId,limit=20,postUrl=null) {
    return this.prepare(`SELECT j.*,g.name AS group_name,g.url AS group_url,g.paused AS group_paused,g.auto_block FROM commenter_block_jobs j JOIN groups g ON g.id=j.group_id AND g.owner_id=j.owner_id
      WHERE j.owner_id=? AND (? IS NULL OR j.post_url=?) ORDER BY j.id DESC LIMIT ?`).all(ownerId,postUrl,postUrl,limit).map(decodeCommenterRow);
  }
  // {page,pageSize,q,filters,sort,dir} -> {items,total,page,pages,pageSize,hasMore}; the owner condition always comes first.
  pageList(kind,ownerParams,raw) {
    const def = LIST_SQL[kind], query = listQuery(kind,raw), where = [def.owner], params = [...ownerParams];
    if (def.hidden && !query.filters.hidden) where.push(`${def.hidden} IS NULL`);
    for (const [key,value] of Object.entries(query.filters)) {
      const filter = def.filters[key], [sql,...bound] = typeof filter === 'function' ? filter(value) : [filter,value];
      where.push(sql); params.push(...bound);
    }
    const search = searchSql(def.search,query.q,ownerParams[0]);
    if (search) { where.push(search.sql); params.push(...search.params); }
    const body = `FROM ${def.from} WHERE ${where.join(' AND ')}`, dir = query.dir === 'asc' ? 'ASC' : 'DESC';
    const {offset,...info} = pageInfo(this.prepare(`SELECT COUNT(*) n ${body}`).get(...params).n,query);
    if (!info.total) return {items:[],...info};
    // Only the row keys go through the sort; the page's full rows (data_json) are read afterwards by key.
    const sort = [def.sorts[query.sort]].flat(), order = [...sort,...def.tie.filter(expr => !sort.includes(expr))].map(expr => `${expr} ${dir}`).join(',');
    const keys = this.prepare(`SELECT ${def.key} AS row_key FROM ${def.order || def.from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params,query.pageSize,offset).map(row => row.row_key);
    const rows = new Map(this.prepare(`SELECT ${def.select},${def.key} AS row_key FROM ${def.rows || def.order || def.from} WHERE ${def.owner} AND ${def.key} IN (SELECT value FROM json_each(?))`)
      .all(...ownerParams,JSON.stringify(keys)).map(({row_key,...row}) => [row_key,row]));
    const items = keys.filter(key => rows.has(key)).map(key => rows.get(key));
    return {items:def.map ? items.map(def.map) : items,...info};
  }
  pageComments(ownerId,query) { return this.pageList('comments',[ownerId],query); }
  pageDirectMessages(ownerId,query) { return this.pageList('inboxes',[ownerId],query); }
  pageFriendRequests(ownerId,query) { return this.pageList('friends',[ownerId],query); }
  pageCommenterBlocks(ownerId,query) { return this.pageList('blocks',[ownerId],query); }
  pagePosts(ownerId,query) { return this.pageList('posts',[ownerId],query); }
  pageRejected(ownerId,query) { return this.pageList('rejected',[ownerId],query); }
  pageAffiliateLinks(ownerId,accountKey,query) { return this.pageList('links',[ownerId,accountKey],query); }
  pageGroups(ownerId,query) { return this.pageList('sources',[ownerId],query); }
  // One row of a paged list, owner-checked in each statement. Rows the monitor relies on to never repeat an action
  // (a sent/unconfirmed message, a seen post, a recorded rejection) are only hidden; nothing is undone on Facebook.
  removeListItem(kind,ownerId,key,{restore=false,now=Date.now()}={}) {
    const owned = 'group_id IN (SELECT id FROM groups WHERE owner_id=?)', missing = () => { throw new Error('Không tìm thấy bản ghi của bạn.'); };
    if (kind === 'posts' || kind === 'rejected') {
      const {changes} = this.prepare(`UPDATE ${kind === 'posts' ? 'posts' : 'rejected_deliveries'} SET hidden_at=? WHERE group_id=? AND post_id=? AND hidden_at IS ${restore ? 'NOT ' : ''}NULL AND ${owned}`)
        .run(restore ? null : now,key.groupId,String(key.postId),ownerId);
      return changes ? {action:restore ? 'restored' : 'hidden'} : missing();
    }
    if (restore) throw new Error('Chỉ bỏ ẩn được bài viết hoặc bài bị loại.');
    if (kind === 'sources') return this.removeGroup(ownerId,key) ? {action:'deleted'} : missing();
    if (kind === 'links') return this.prepare('DELETE FROM affiliate_links WHERE id=? AND owner_id=?').run(key,ownerId).changes ? {action:'deleted'} : missing();
    if (kind === 'blocks') {
      // A running job sees its row gone through active() and stops before the next block; its final update then matches nothing.
      const job = this.prepare('SELECT state FROM commenter_block_jobs WHERE id=? AND owner_id=?').get(key,ownerId);
      if (!job) return missing();
      this.prepare('DELETE FROM commenter_block_jobs WHERE id=? AND owner_id=?').run(key,ownerId);
      return {action:'deleted',...(job.state === 'running' ? {stopped:true} : {})};
    }
    const table = {comments:'comments',inboxes:'direct_messages',friends:'friend_requests'}[kind];
    if (!table) throw new Error('Danh sách không hỗ trợ xóa.');
    if (this.prepare(`DELETE FROM ${table} WHERE id=? AND state NOT IN ('sending','sent','uncertain') AND ${owned}`).run(key,ownerId).changes) return {action:'deleted'};
    // Sent rows are the per-post/per-recipient memory that blocks a repeat send (auto and manual), so they only leave the list.
    if (this.prepare(`UPDATE ${table} SET hidden_at=? WHERE id=? AND state IN ('sent','uncertain') AND hidden_at IS NULL AND ${owned}`).run(now,key,ownerId).changes) return {action:'hidden'};
    if (this.prepare(`SELECT 1 FROM ${table} WHERE id=? AND state='sending' AND ${owned}`).get(key,ownerId)) throw new Error('Đang gửi, thử lại sau.');
    return missing();
  }
  // A running job stops at its next block (active() sees the state change); auto jobs stay armed only through /autoblock.
  cancelCommenterBlocks(ownerId,groupId=null) {
    return this.prepare(`UPDATE commenter_block_jobs SET state='stopped',error='Đã hủy.' WHERE owner_id=? AND state IN ('pending','running','interrupted')
      AND (? IS NULL OR group_id=?)`).run(ownerId,groupId,groupId).changes;
  }
  commenterBlockJobState(id,state,result=null,error=null) {
    this.prepare('UPDATE commenter_block_jobs SET state=?,result_json=?,error=? WHERE id=?').run(state,result && JSON.stringify(result),error,id);
  }
  // Only a still-running job takes the final state, so an off/on or pause/resume during the run is not overwritten.
  finishCommenterBlockJob(id,state,result,error=null,runAt=null) {
    const json = JSON.stringify(result);
    const {changes} = this.prepare("UPDATE commenter_block_jobs SET state=?,result_json=?,error=?,run_at=COALESCE(?,run_at) WHERE id=? AND state='running'").run(state,json,error,runAt,id);
    if (!changes) this.prepare("UPDATE commenter_block_jobs SET result_json=?,error=? WHERE id=? AND state!='pending'").run(json,error,id);
    return changes > 0;
  }
  nextRejected(now=Date.now(),allowedUserIds) {
    if (!allowedUserIds?.length) return undefined;
    return this.prepare(`SELECT r.*,g.owner_id,u.chat_id,p.data_json FROM rejected_deliveries r
      JOIN groups g ON g.id=r.group_id JOIN users u ON u.owner_id=g.owner_id
      JOIN posts p ON p.group_id=r.group_id AND p.post_id=r.post_id
      WHERE r.sent=0 AND g.paused=0 AND r.next_attempt_at<=? AND u.rejected_notify_since IS NOT NULL
      AND g.owner_id IN (${allowedUserIds.map(() => '?').join(',')})
      ORDER BY r.next_attempt_at,r.group_id,r.post_id LIMIT 1`).get(now,...allowedUserIds);
  }
  rejectedSent(item) { this.prepare('UPDATE rejected_deliveries SET sent=1 WHERE group_id=? AND post_id=?').run(item.group_id,item.post_id); }
  // Informational only: give up after a few failures instead of retrying forever.
  rejectedFailed(item,delayMs,now=Date.now()) {
    if (item.attempts >= 4) return this.rejectedSent(item);
    this.prepare('UPDATE rejected_deliveries SET attempts=attempts+1,next_attempt_at=? WHERE group_id=? AND post_id=?').run(now+delayMs,item.group_id,item.post_id);
  }
  deferRejected(item,delayMs,now=Date.now()) {
    this.prepare('UPDATE rejected_deliveries SET next_attempt_at=? WHERE group_id=? AND post_id=?').run(now+delayMs,item.group_id,item.post_id);
  }
  replaceDeliveryBody(item,body) {
    this.prepare('UPDATE deliveries SET body=? WHERE group_id=? AND post_id=?').run(body,item.group_id,item.post_id);
  }
}
