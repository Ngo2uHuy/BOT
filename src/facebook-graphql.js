import { setTimeout as delay } from 'node:timers/promises';
import { rateLimitError } from './facebook-cooldown.js';
import { parseGraphQLStream, extractPageInfo, graphQLLines, extractPostsFromGraphQLPayload } from './facebook-api.js';
import { normalizeProfilePostUrl } from './profile.js';

// Gọi lại truy vấn feed nhóm của chính trang Facebook (GraphQL nội bộ) bằng phiên của bot,
// thay cho việc render và cuộn trang. Template (doc_id, fb_dtsg, ...) chỉ giữ trong bộ nhớ.

export const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';
const HOUR = 3600000;
const TEMPLATE_HEADERS = ['x-fb-friendly-name', 'x-fb-lsd', 'x-asbd-id'];
const RATE_LIMIT_CODES = new Set([368, 1357004, 1390008, 1675004]);
const LOGIN_CODES = new Set([1357001]);

export function schemaError(detail) {
  const error = new Error(`[GRAPHQL_SCHEMA] ${detail}`);
  error.code = 'GRAPHQL_SCHEMA';
  return error;
}

export function transientError(detail) {
  const error = new Error(`[GRAPHQL_TRANSIENT] ${detail}`);
  error.code = 'GRAPHQL_TRANSIENT';
  return error;
}

export function deferredError(retryAt) {
  const error = new Error(`[SCAN_DEFERRED] Đã chạm trần request/giờ của tài khoản; hoãn tới ${new Date(retryAt).toISOString()}.`);
  error.code = 'SCAN_DEFERRED';
  error.retryAt = retryAt;
  return error;
}

export function groupIdFromUrl(value) {
  try { return new URL(value).pathname.match(/^\/groups\/(\d{5,25})\/?$/)?.[1] || null; } catch { return null; }
}

function graphQLRequest({ method, url, postData, headers }) {
  if (String(method).toUpperCase() !== 'POST' || !/^https:\/\/www\.facebook\.com\/api\/graphql\/?(?:[?#]|$)/.test(String(url)) || !postData) return null;
  const form = Object.fromEntries(new URLSearchParams(postData));
  if (!/^\d+$/.test(form.doc_id || '')) return null;
  const lower = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  let variables = null;
  try { variables = JSON.parse(form.variables); } catch {}
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) variables = null;
  return { form, lower, variables, friendlyName: form.fb_api_req_friendly_name || lower['x-fb-friendly-name'] || '' };
}

const templateHeaders = lower => Object.fromEntries(TEMPLATE_HEADERS.filter(key => lower[key]).map(key => [key, lower[key]]));

export function captureFeedTemplate(raw, now = Date.now()) {
  const request = graphQLRequest(raw);
  if (!request || !/GroupsCometFeed/.test(request.friendlyName) || !request.variables) return null;
  const { form, variables, friendlyName } = request;
  const idKey = ['id', 'groupID'].find(key => /^\d{5,25}$/.test(String(variables[key] ?? '')));
  if (!idKey || !('cursor' in variables || 'count' in variables)) return null;
  return { form, variables, idKey, groupId: String(variables[idKey]), friendlyName, capturedAt: now, headers: templateHeaders(request.lower) };
}

// Only names and variable keys: never values, which may carry user IDs or tokens.
export function describeGraphQLRequest(raw) {
  const request = graphQLRequest(raw);
  return request && { friendlyName: request.friendlyName || '?', docId: request.form.doc_id, keys: Object.keys(request.variables || {}).sort() };
}

const CURSOR_KEYS = ['cursor', 'after', 'commentsAfterCursor', 'afterCursor', 'before', 'commentsBeforeCursor'];
const COUNT_KEYS = ['count', 'first', 'commentsAfterCount', 'last', 'commentsBeforeCount'];
// Facebook rotates query names, so patterns are lenient and ordered best-first; only paginated queries qualify.
export const QUERY_KINDS = {
  profile: { names: [/^ProfileComet.*Timeline.*(?:Feed|Refetch|Pagination)/], idKeys: ['id', 'userID'] },
  reels: { names: [/^ProfileComet.*Reels?.*(?:Pagination|Refetch)/, /Reels?.*(?:Tab|Collection|Grid).*(?:Pagination|Refetch)/, /^ProfileCometAppCollection.*(?:Pagination|Refetch)/], idKeys: ['id', 'userID', 'profileID'] },
  comments: { names: [/^(?!.*(?:Depth[1-9]|Repl)).*Comment.*(?:Pagination|Refetch|List)/], idKeys: ['id', 'feedbackID', 'feedbackTargetID'], feedback: true },
  joinedGroups: { names: [/^GroupsComet.*Joined.*(?:Pagination|Refetch)|JoinedGroups.*(?:Pagination|Refetch)/, /^GroupsComet.*(?:Joins|Joined)|JoinedGroups/, /GroupsCometLeftRail|GroupsLeftRail/], idKeys: [] },
};

const decodeBase64 = value => { try { return Buffer.from(String(value ?? ''), 'base64').toString('utf8'); } catch { return ''; } };
export const feedbackPostId = value => decodeBase64(value).match(/^feedback:(\d+)$/)?.[1] || null;
export function feedbackId(postId, unpadded = false) {
  const value = Buffer.from(`feedback:${postId}`).toString('base64');
  return unpadded ? value.replace(/=+$/, '') : value;
}

export function captureQueryTemplate(kind, raw, now = Date.now()) {
  const spec = QUERY_KINDS[kind];
  const request = spec && graphQLRequest(raw);
  if (!request?.variables || /Mutation$/.test(request.friendlyName)) return null;
  const priority = spec.names.findIndex(pattern => pattern.test(request.friendlyName));
  const cursorKey = CURSOR_KEYS.find(key => key in request.variables);
  if (priority < 0 || !cursorKey) return null;
  let idKey = null, targetId = null;
  for (const key of spec.idKeys) {
    const value = request.variables[key];
    targetId = spec.feedback ? feedbackPostId(value) : /^\d{5,25}$/.test(String(value ?? '')) ? String(value) : null;
    if (targetId) { idKey = key; break; }
  }
  if (spec.feedback && !idKey) return null;
  return {
    kind, form: request.form, variables: request.variables, idKey, targetId, cursorKey,
    countKey: COUNT_KEYS.find(key => key in request.variables) || null,
    unpadded: Boolean(idKey) && String(request.variables[idKey]).length % 4 !== 0,
    friendlyName: request.friendlyName, priority, capturedAt: now, headers: templateHeaders(request.lower),
  };
}

// Replays the captured variables verbatim; only the cursor, page size and target ID change.
export function queryRequest(template, { cursor = null, count = null, targetId = null } = {}) {
  const variables = template.cursorKey ? { ...template.variables, [template.cursorKey]: cursor } : { ...template.variables };
  if (count && template.countKey) variables[template.countKey] = count;
  if (targetId && template.idKey) variables[template.idKey] = template.kind === 'comments' ? feedbackId(targetId, template.unpadded) : String(targetId);
  return { form: { ...template.form, variables: JSON.stringify(variables) }, headers: { ...template.headers } };
}

// doc_id + variables as Facebook's own web client sent them (capture of 2026-10-16). Facebook rotates doc_ids
// on deploys, so these only seed the API lane until a browser visit captures a live template; a schema
// failure parks them for a while instead of retrying every scan.
const FEED_PROVIDERS = {
  __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: true,
  __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
  __relay_internal__pv__CometFeedStory_enable_reactor_facepilerelayprovider: false,
  __relay_internal__pv__CometFeedStory_enable_social_bubblesrelayprovider: false,
  __relay_internal__pv__CometFeedStory_enable_post_permalink_white_space_clickrelayprovider: false,
  __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
  __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
  __relay_internal__pv__IsWorkUserrelayprovider: false,
  __relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider: false,
  __relay_internal__pv__FBReels_deprecate_short_form_video_context_gkrelayprovider: true,
  __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: true,
  __relay_internal__pv__FBReels_enable_view_dubbed_audio_type_gkrelayprovider: true,
  __relay_internal__pv__CometFeedShareMedia_shouldPrefetchShareImagerelayprovider: false,
  __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider: false,
  __relay_internal__pv__WorkCometIsEmployeeGKProviderrelayprovider: false,
  __relay_internal__pv__IsMergQAPollsrelayprovider: false,
  __relay_internal__pv__FBReelsMediaFooter_comet_enable_reels_ads_gkrelayprovider: true,
  __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
  __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'AUTO_TRANSLATE',
  __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
  __relay_internal__pv__CometUFISingleLineUFIrelayprovider: true,
  __relay_internal__pv__relay_provider_comet_ufi_ssr_seo_deferrelayprovider: true,
  __relay_internal__pv__FBReelsIFUTileContent_reelsIFUPlayOnHoverrelayprovider: true,
  __relay_internal__pv__GroupsCometGYSJFeedItemHeightrelayprovider: 206,
  __relay_internal__pv__StoriesShouldEnablePhotosensitiveContentWarningrelayprovider: false,
  __relay_internal__pv__ShouldEnableBakedInTextStoriesrelayprovider: false,
  __relay_internal__pv__StoriesShouldIncludeFbNotesrelayprovider: true,
};
export const BUILTIN_QUERIES = {
  // Captured 2026-10-17: All notifications, no seen/read-state mutation or old cache IDs.
  notifications: { friendlyName:'CometNotificationsListPaginationQuery', docId:'28368359382859755',
    variables:{count:15,cursor:null,environment:'MAIN_SURFACE',filter_tokens:['Cg8CZnQPA2FsbAE='],notif_cache_ids:[],notif_query_flags:['IS_COMET'],scale:1} },
  feed: { friendlyName: 'GroupsCometFeedRegularStoriesPaginationQuery', docId: '28582874464673959', variables: {
    count: 3, cursor: null, feedLocation: 'GROUP', feedType: 'DISCUSSION', feedbackSource: 0, filterTopicId: null, focusCommentID: null,
    privacySelectorRenderLocation: 'COMET_STREAM', referringStoryRenderLocation: null, renderLocation: 'group', scale: 1,
    sortingSetting: 'CHRONOLOGICAL', stream_initial_count: 1, useDefaultActor: false, youthIntegrityHostID: null, id: null, ...FEED_PROVIDERS,
  } },
  joinedGroups: { friendlyName: 'GroupsCometAllJoinedGroupsSectionPaginationQuery', docId: '9974006939348139',
    variables: { count: 20, cursor: null, ordering: ['name'], scale: 1 } },
  // Captured 2026-10-19: the first comment page as the post dialog opens it (top-level comments, oldest first).
  // Its pagination query was not captured, so this has no cursor: callers read one page and report it as partial.
  comments: { friendlyName: 'CommentListComponentsRootQuery', docId: '29409681848615704', variables: {
    commentsIntentToken: 'CHRONOLOGICAL_UNFILTERED_INTENT_V1', feedLocation: 'POST_PERMALINK_DIALOG', feedbackSource: 2, focusCommentID: null,
    scale: 1, useDefaultActor: false, id: null,
    __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: 'AUTO_TRANSLATE',
    __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
    __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
    __relay_internal__pv__IsWorkUserrelayprovider: false,
  } },
  // Home "Feeds > Groups > Most recent": every joined group in one strictly chronological stream.
  recentFeed: { friendlyName: 'CometNewsFeedPaginationQuery', docId: '28751052257839818', variables: {
    RELAY_INCREMENTAL_DELIVERY: true, clientSession: null, connectionClass: 'EXCELLENT', count: 10, cursor: null, experimentalValues: null,
    feedLocation: 'NEWSFEED', feedStyle: 'MOST_RECENT_GROUPS_FEED', feedbackSource: 1, focusCommentID: null, orderby: ['MOST_RECENT'],
    privacySelectorRenderLocation: 'COMET_STREAM', recentVPVs: [], referringStoryRenderLocation: null, refreshMode: 'MANUAL',
    renderLocation: 'homepage_stream', scale: 1, shouldChangeBRSLabelFieldName: false, shouldObfuscateCategoryField: true,
    shouldUseBRSLabelFieldNameV1: false, shouldUseBRSLabelFieldNameV2: false, useDefaultActor: false,
    __relay_internal__pv__GHLShouldChangeSponsoredAuctionDistanceFieldNamerelayprovider: true,
    __relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV1relayprovider: true,
    __relay_internal__pv__GHLShouldUseSponsoredAuctionLabelFieldNameV2relayprovider: false,
    __relay_internal__pv__CometAdsSlotFillLoggingEnabledrelayprovider: true, ...FEED_PROVIDERS,
  } },
};
const DEFAULT_ASBD_ID = '359341';
const SESSION_SKIP = new Set(['doc_id', 'variables', 'fb_api_req_friendly_name', 'fb_api_analytics_tags', 'qpl_active_flow_ids']);
const jazoest = token => `2${[...token].reduce((sum, char) => sum + char.charCodeAt(0), 0)}`;

// Session = the per-account form fields every GraphQL POST carries (fb_dtsg, lsd, __user, revision...).
export function sessionFromForm(form, headers = {}, now = Date.now()) {
  if (!form?.fb_dtsg || !/^[1-9]\d{0,24}$/.test(String(form.__user || ''))) return null;
  const sessionForm = Object.fromEntries(Object.entries(form).filter(([key]) => !SESSION_SKIP.has(key)));
  return { form: sessionForm, headers: { ...(form.lsd ? { 'x-fb-lsd': form.lsd } : {}), 'x-asbd-id': headers['x-asbd-id'] || DEFAULT_ASBD_ID }, capturedAt: now };
}

export function captureSession(raw, now = Date.now()) {
  const request = graphQLRequest(raw);
  return request && sessionFromForm(request.form, request.lower, now);
}

const htmlToken = (html, patterns) => {
  for (const pattern of patterns) {
    const value = html.match(pattern)?.[1];
    if (value) return value;
  }
  return null;
};

// Tokens Facebook inlines into every logged-in page, read from one plain HTML GET (no render, no scroll).
export function extractSessionFromHtml(html, now = Date.now()) {
  const text = String(html || '');
  const dtsg = htmlToken(text, [/"DTSGInitialData",\[\],\{"token":"([^"]+)"/, /"DTSGInitData",\[\],\{"token":"([^"]+)"/, /name="fb_dtsg" value="([^"]+)"/, /"dtsg":\{"token":"([^"]+)"/]);
  const user = htmlToken(text, [/"USER_ID":"(\d{5,25})"/, /"actorID":"(\d{5,25})"/, /"userID":"(\d{5,25})"/]);
  if (!dtsg || !user) return null;
  const lsd = htmlToken(text, [/"LSD",\[\],\{"token":"([^"]+)"/, /name="lsd" value="([^"]+)"/]);
  const rev = htmlToken(text, [/"__spin_r":(\d+)/, /"server_revision":(\d+)/, /"client_revision":(\d+)/]);
  const optional = {
    lsd, __rev: rev, __spin_r: rev, __spin_b: htmlToken(text, [/"__spin_b":"([^"]+)"/]), __spin_t: htmlToken(text, [/"__spin_t":(\d+)/]),
    __hs: htmlToken(text, [/"haste_session":"([^"]+)"/]), __hsi: htmlToken(text, [/"hsi":"(\d+)"/]),
  };
  const form = {
    av: user, __aaid: '0', __user: user, __a: '1', __req: '1', dpr: '1', __ccg: 'GOOD', __comet_req: '15',
    fb_dtsg: dtsg, jazoest: jazoest(dtsg), ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value)),
    fb_api_caller_class: 'RelayModern', server_timestamps: 'true',
  };
  return sessionFromForm(form, {}, now);
}

// Same shapes as captureFeedTemplate/captureQueryTemplate so the replay code cannot tell them apart.
export function builtinTemplate(kind, session) {
  const spec = BUILTIN_QUERIES[kind];
  if (!spec || !session) return null;
  const base = {
    form: { ...session.form, fb_api_req_friendly_name: spec.friendlyName, doc_id: spec.docId, variables: JSON.stringify(spec.variables) },
    variables: { ...spec.variables }, friendlyName: spec.friendlyName, capturedAt: session.capturedAt,
    headers: { 'x-fb-friendly-name': spec.friendlyName, ...session.headers }, builtin: true,
  };
  return kind === 'feed' ? { ...base, idKey: 'id', groupId: null }
    : kind === 'comments' ? { ...base, kind, idKey: 'id', targetId: null, cursorKey: null, countKey: null, unpadded: false, priority: 0 }
    : { ...base, kind, idKey: null, targetId: null, cursorKey: 'cursor', countKey: 'count', unpadded: false, priority: 0 };
}

export function feedRequest(template, { groupId, cursor = null, count = 10 }) {
  const variables = { ...template.variables, [template.idKey]: String(groupId), cursor, count };
  // The UI repeats the group ID here; replaying another group's value would mismatch the target.
  if ('youthIntegrityHostID' in variables) variables.youthIntegrityHostID = String(groupId);
  if ('sortingSetting' in variables) variables.sortingSetting = 'CHRONOLOGICAL';
  return { form: { ...template.form, variables: JSON.stringify(variables) }, headers: { ...template.headers } };
}

export function classifyGraphQLResponse({ status, headers = {}, text = '' }) {
  if (status === 429) return 'rate_limited';
  if (status >= 300 && status < 400) {
    const location = String(headers.location || '');
    return /checkpoint/i.test(location) ? 'rate_limited' : /login/i.test(location) ? 'login' : 'schema';
  }
  // Facebook trả trang HTML (checkpoint/chặn tạm thời) thay vì JSON khi hạn chế tài khoản.
  if (/^\s*</.test(text)) return 'rate_limited';
  // Server errors and empty bodies are outages, not a stale query: they must not drop the template.
  if (status >= 500) return 'transient';
  if (status >= 400) return 'schema';
  if (!String(text).trim()) return 'transient';
  const values = graphQLLines(text).filter(value => value && typeof value === 'object');
  if (!values.length) return 'schema';
  for (const value of values) {
    const errors = [value, ...(Array.isArray(value.errors) ? value.errors : [])];
    const codes = errors.flatMap(item => [item.error, item.code, item.api_error_code]).map(Number).filter(Number.isFinite);
    const messages = errors.flatMap(item => [item.errorSummary, item.errorDescription, item.message, item.description]).filter(item => typeof item === 'string').join(' ');
    if (codes.some(code => RATE_LIMIT_CODES.has(code)) || /rate limit|temporarily blocked|checkpoint/i.test(messages)) return 'rate_limited';
    if (codes.some(code => LOGIN_CODES.has(code)) || /not logged in/i.test(messages)) return 'login';
  }
  return values.some(value => value.data && typeof value.data === 'object') ? 'ok' : 'schema';
}

// Dừng khi gặp `stopAfterOld` bài cũ liên tiếp (không dừng ở bài cũ đầu tiên vì bài ghim/được đẩy lên).
export async function paginateFeed(fetchPage, { cutoff = null, maxPages = 1, stopAfterOld = 3, latest = false, onPage = null, shouldContinue = null } = {}) {
  const posts = new Map();
  let cursor = null, oldStreak = 0, pages = 0;
  while (pages < maxPages) {
    if (shouldContinue && !shouldContinue()) break;
    let page;
    try { page = await fetchPage(cursor, pages); }
    catch (error) {
      if (error.code === 'SCAN_DEFERRED' && pages) break;
      throw error;
    }
    pages++;
    let fresh = 0;
    for (const post of page.posts) {
      posts.set(post.id, post);
      const time = Date.parse(post.publishedAt);
      if (!Number.isFinite(time)) continue;
      if (cutoff !== null && time <= cutoff) oldStreak++;
      else { oldStreak = 0; fresh++; }
    }
    if (onPage) await onPage(page.posts);
    if (oldStreak >= stopAfterOld || !page.hasNextPage || !page.endCursor || (latest && !fresh)) break;
    cursor = page.endCursor;
  }
  return { posts: [...posts.values()], pages };
}

const LOW_BUDGET_SHARE = 0.75;
export class RequestLimiter {
  #owners = new Map();
  constructor({ concurrency = 1, minDelayMs = 3000, maxDelayMs = 8000, maxPerHour = 400, now = Date.now, sleep = ms => delay(ms), random = Math.random, onSlowdown = null } = {}) {
    Object.assign(this, { concurrency, minDelayMs, maxDelayMs: Math.max(minDelayMs, maxDelayMs), maxPerHour, now, sleep, random, onSlowdown });
  }

  // Protective backoff, never faster than configured: a rate limit doubles the spacing between requests
  // (up to 8x), a response far slower than usual stretches it 1.5x, and each normal response recovers 5%.
  #adapt(ownerId, state, outcome, latencyMs = 0) {
    const before = state.slow;
    if (outcome === 'ok') {
      if (state.latency && latencyMs > Math.max(5000, 3 * state.latency)) state.slow = Math.min(8, state.slow * 1.5);
      else state.slow = Math.max(1, state.slow - 0.05);
      state.latency = state.latency ? state.latency * 0.9 + latencyMs * 0.1 : latencyMs;
    } else state.slow = Math.min(8, state.slow * 2);
    if (state.slow > before && Math.round(state.slow * 10) !== Math.round(before * 10)) this.onSlowdown?.(ownerId, state.slow, outcome === 'ok' ? 'phản hồi chậm bất thường' : 'Facebook báo giới hạn');
    else if (state.slow === 1 && before > 1) this.onSlowdown?.(ownerId, 1, 'đã ổn định lại');
  }

  slowdown(ownerId) { return this.#state(ownerId).slow; }

  #state(ownerId) {
    const key = String(ownerId);
    if (!this.#owners.has(key)) this.#owners.set(key, { active: 0, waiters: [], readyAt: 0, sent: [], priorityStreak: 0, slow: 1, latency: 0 });
    return this.#owners.get(key);
  }

  #prune(state) {
    const since = this.now() - HOUR;
    while (state.sent.length && state.sent[0] <= since) state.sent.shift();
  }

  // Every API call passes through run(), so this is the real request count of the last hour.
  usedLastHour(ownerId) {
    const state = this.#state(ownerId);
    this.#prune(state);
    return state.sent.length;
  }

  // Thời điểm sớm nhất tài khoản được gửi request tiếp theo theo trần/giờ.
  availableAt(ownerId) {
    const state = this.#state(ownerId);
    this.#prune(state);
    return state.sent.length < this.maxPerHour ? this.now() : state.sent[0] + HOUR;
  }

  // Khi ngân sách nền (phần dành cho việc ưu tiên thấp) đã cạn: thời điểm được dùng lại, ngược lại null.
  lowBudgetUntil(ownerId) {
    const state = this.#state(ownerId), used = this.usedLastHour(ownerId), cap = Math.ceil(LOW_BUDGET_SHARE * this.maxPerHour);
    return used >= cap ? state.sent[used - cap] + HOUR : null;
  }

  // Low-priority work reserves the last quarter of the hourly budget for reads
  // and interactive actions. Defer explicitly instead of occupying a worker for an hour.
  async run(ownerId, work, { priority = false, low = false } = {}) {
    const state = this.#state(ownerId);
    const checkLowBudget = () => {
      if (!low) return;
      const used = this.usedLastHour(ownerId), cap = Math.ceil(LOW_BUDGET_SHARE * this.maxPerHour);
      if (used >= cap) throw deferredError(state.sent[used-cap] + HOUR);
    };
    checkLowBudget();
    while (state.active >= this.concurrency) await new Promise(resolve => state.waiters.push({ resolve, priority, low }));
    state.active++;
    try {
      checkLowBudget();
      const availableAt = this.availableAt(ownerId);
      if (availableAt > this.now()) throw deferredError(availableAt);
      const wait = state.readyAt - this.now();
      if (wait > 0) await this.sleep(wait);
      state.sent.push(this.now());
      const started = this.now();
      // Spacing runs start-to-start so the configured delay alone sets the hourly pace, not delay + latency.
      const spacing = this.minDelayMs + this.random() * (this.maxDelayMs - this.minDelayMs);
      state.readyAt = started + Math.round(spacing * state.slow);
      try {
        const result = await work();
        this.#adapt(ownerId, state, 'ok', this.now() - started);
        return result;
      } catch (error) {
        if (error?.code === 'RATE_LIMITED') this.#adapt(ownerId, state, 'limited');
        throw error;
      } finally { state.readyAt = Math.max(state.readyAt, started + Math.round(spacing * state.slow)); }
    } finally {
      state.active--;
      if (state.waiters.length) {
        // Give outbound actions the next slot, with a read slot after three actions.
        const wantPriority = state.priorityStreak < 3;
        let preferred = state.waiters.findIndex(waiter => !waiter.low && waiter.priority === wantPriority);
        if (preferred < 0) preferred = state.waiters.findIndex(waiter => !waiter.low);
        const waiter = state.waiters.splice(preferred < 0 ? 0 : preferred, 1)[0];
        state.priorityStreak = waiter.priority ? state.priorityStreak + 1 : 0;
        waiter.resolve();
      }
    }
  }
}

export class GraphQLFeedClient {
  #templates = new Map();
  #sessions = new Map();
  #parked = new Map();
  constructor({ ttlMs = 6 * HOUR, limiter = new RequestLimiter(), now = Date.now, builtins = BUILTIN_QUERIES, parkMs = 2 * HOUR } = {}) {
    Object.assign(this, { ttlMs, limiter, now, builtins, parkMs });
  }

  // Templates are keyed per account and, besides the group feed, per query kind/target (`scope`).
  #key(ownerId, scope) { return scope ? `${ownerId}
${scope}` : String(ownerId); }

  remember(ownerId, template, scope = '') {
    const current = this.#templates.get(this.#key(ownerId, scope));
    const fresh = !current || this.now() - current.capturedAt >= this.ttlMs;
    for (const [key, item] of this.#templates) if (this.now() - item.capturedAt >= this.ttlMs) this.#templates.delete(key);
    this.#templates.set(this.#key(ownerId, scope), template);
    this.#parked.delete(this.#key(ownerId, scope));
    // A captured query carries a full session, which unlocks the built-in queries of the other scopes.
    if (!this.session(ownerId)) this.rememberSession(ownerId, sessionFromForm(template.form, template.headers, template.capturedAt));
    return fresh;
  }

  session(ownerId) {
    const session = this.#sessions.get(String(ownerId));
    if (session && this.now() - session.capturedAt < this.ttlMs) return session;
    this.#sessions.delete(String(ownerId));
    return null;
  }

  // Seeds built-in queries for scopes without a captured template; true when the account had no session.
  rememberSession(ownerId, session) {
    if (!session) return false;
    const fresh = !this.session(ownerId);
    this.#sessions.set(String(ownerId), session);
    for (const kind of Object.keys(this.builtins)) {
      const scope = kind === 'feed' ? '' : kind, key = this.#key(ownerId, scope);
      const current = this.template(ownerId, scope);
      if ((current && !current.builtin) || this.now() - (this.#parked.get(key) ?? -Infinity) < this.parkMs) continue;
      this.#templates.set(key, builtinTemplate(kind, session));
    }
    return fresh;
  }

  template(ownerId, scope = '') {
    const key = this.#key(ownerId, scope);
    const template = this.#templates.get(key);
    if (template && this.now() - template.capturedAt < this.ttlMs) return template;
    this.#templates.delete(key);
    // rememberSession only runs when an account has no session, so a parked built-in is re-seeded here from
    // the session it still has once the park ends; otherwise that lane stays dead until the session expires.
    const kind = scope || 'feed';
    const session = scope !== 'feed' && this.builtins[kind] && this.now() - (this.#parked.get(key) ?? -Infinity) >= this.parkMs && this.session(ownerId);
    if (!session) return null;
    const seeded = builtinTemplate(kind, session);
    this.#templates.set(key, seeded);
    return seeded;
  }

  invalidate(ownerId, scope = '') {
    const key = this.#key(ownerId, scope);
    // Parked either way: the built-in is re-seeded only after parkMs, not right after a failed query.
    this.#parked.set(key, this.now());
    this.#templates.delete(key);
  }

  async #post(request, ownerId, scope, build, referer, missing, low = false) {
    const template = this.template(ownerId, scope);
    if (!template) throw schemaError(missing);
    const { form, headers } = build(template);
    return this.limiter.run(ownerId, async () => {
      const response = await request.post(GRAPHQL_URL, {
        form, headers: { ...headers, origin: 'https://www.facebook.com', referer },
        maxRedirects: 0, timeout: 30000, failOnStatusCode: false,
      });
      const text = await response.text();
      const kind = classifyGraphQLResponse({ status: response.status(), headers: response.headers(), text });
      if (kind === 'rate_limited') throw rateLimitError();
      if (kind === 'login') throw new Error('Phiên Facebook đã hết hạn. Dừng bot và đăng nhập lại bằng npm run login -- --user-id ID.');
      if (kind === 'transient') throw transientError(`Facebook tạm thời không trả dữ liệu GraphQL (HTTP ${response.status()}).`);
      if (kind === 'schema') {
        this.invalidate(ownerId, scope);
        throw schemaError(`Phản hồi GraphQL không đọc được (HTTP ${response.status()}).`);
      }
      return text;
    }, { low });
  }

  async fetchPage(request, ownerId, { groupId, groupUrl, cursor = null, count = 10 }) {
    const text = await this.#post(request, ownerId, '', template => feedRequest(template, { groupId, cursor, count }),
      `${groupUrl}?sorting_setting=CHRONOLOGICAL`, 'Chưa có template truy vấn feed nhóm.');
    return { posts: parseGraphQLStream(text, groupUrl), ...extractPageInfo(text) };
  }

  // Raw response text of a captured non-feed query (profile, comments, joined groups); callers parse it.
  fetchQuery(request, ownerId, scope, { cursor = null, count = null, targetId = null, referer = 'https://www.facebook.com/', low = false } = {}) {
    return this.#post(request, ownerId, scope, template => queryRequest(template, { cursor, count, targetId }), referer, `Chưa có template truy vấn ${scope}.`, low);
  }
}

const URL_KEYS = ['wwwURL', 'url', 'permalink_url', 'shareable_url'];
const OWNER_KEYS = ['owner', 'video_owner', 'author', 'actors'];
const CONTAINER_KEYS = ['creation_story', 'short_form_video_context', 'video', 'story'];
const TIME_KEYS = ['creation_time', 'publish_time', 'created_time'];
const linkOf = (node, kind) => {
  for (const key of URL_KEYS) {
    const link = typeof node?.[key] === 'string' ? normalizeProfilePostUrl(node[key]) : null;
    if (link?.kind === kind) return link;
  }
  return null;
};
// Reel owner/time sit on the node itself or one of a few wrapper objects (video, creation_story, ...).
function reelField(node, read, depth = 2) {
  if (!node || typeof node !== 'object' || depth < 0) return null;
  const found = read(node);
  if (found) return found;
  for (const key of CONTAINER_KEYS) {
    const value = reelField(node[key], read, depth - 1);
    if (value) return value;
  }
  return null;
}
const reelOwner = node => OWNER_KEYS.flatMap(key => [node[key]].flat()).find(item => /^\d{5,25}$/.test(String(item?.id ?? ''))) || null;
const reelTime = node => TIME_KEYS.map(key => Number(node[key])).find(value => value > 0) || null;
function walkObjects(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walkObjects(item, visit); return; }
  visit(node);
  for (const key of Object.keys(node)) if (key !== 'feedback') walkObjects(node[key], visit);
}

// Permalinks go through the DOM lane's normalizer so post IDs stay identical across lanes; anything
// without a profile permalink or owner proof is dropped (the caller treats an empty page as suspicious).
export function extractProfileGraphQLPosts(text, kind, belongs) {
  const posts = new Map();
  for (const value of graphQLLines(text)) {
    if (kind === 'reels') {
      walkObjects(value, node => {
        const link = linkOf(node, 'reel');
        if (!link || posts.has(link.id)) return;
        const owner = reelField(node, reelOwner);
        const authorUrl = owner ? `https://www.facebook.com/profile.php?id=${owner.id}` : null;
        if (!authorUrl || !belongs(authorUrl)) return;
        const time = reelField(node, reelTime);
        posts.set(link.id, { id: link.id, url: link.url, kind: 'reel', text: String(node.message?.text || node.description?.text || '').slice(0, 30000),
          author: owner.name || null, authorUrl, media: [], publishedAt: time ? new Date(time * 1000).toISOString() : null });
      });
      continue;
    }
    const links = new Map();
    walkObjects(value, node => {
      const id = String(node.post_id ?? '');
      if (!id || links.has(id)) return;
      const link = linkOf(node, 'post') || linkOf(node.story, 'post') || linkOf(node.comet_sections?.content?.story, 'post');
      if (link) links.set(id, link);
    });
    for (const post of extractPostsFromGraphQLPayload(value)) {
      const link = links.get(post.id);
      if (!link || !belongs(link.groupUrl) || (post.authorUrl && !belongs(post.authorUrl)) || posts.has(link.id)) continue;
      posts.set(link.id, { id: link.id, url: link.url, kind: 'post', text: post.text, author: post.author, authorUrl: post.authorUrl, media: post.media, publishedAt: post.publishedAt });
    }
  }
  return [...posts.values()];
}
