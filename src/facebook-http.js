import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyGraphQLResponse, feedbackId } from './facebook-graphql.js';
import { rateLimitError } from './facebook-cooldown.js';

export function sessionFile(dataDir, ownerId) {
  if (!/^[1-9]\d{0,19}$/.test(String(ownerId))) throw new Error('Telegram user ID không hợp lệ.');
  return path.join(dataDir, 'sessions', `${ownerId}.json`);
}

export function validateSession(value) {
  const cookies = Array.isArray(value) ? value : value?.cookies;
  if (!Array.isArray(cookies)) throw new Error('Phiên HTTP cần cookies dạng JSON.');
  const selected = cookies.filter(cookie => /^\.?facebook\.com$/.test(cookie.domain || '') && typeof cookie.name === 'string' && typeof cookie.value === 'string');
  if (!selected.some(cookie => cookie.name === 'c_user' && /^[1-9]\d+$/.test(cookie.value)) || !selected.some(cookie => cookie.name === 'xs' && cookie.value)) {
    throw new Error('Phiên HTTP thiếu cookie c_user hoặc xs.');
  }
  const userAgent = typeof value?.userAgent === 'string' && /^Mozilla\/5\.0 [^\r\n]{10,400}$/.test(value.userAgent) ? value.userAgent : null;
  return { cookies: selected, origins: [], ...(userAgent ? { userAgent } : {}) };
}

// Used only for cookie files imported without the browser's User-Agent; a fresh login records the real one.
const PAGE_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-user': '?1', 'upgrade-insecure-requests': '1',
};
const XHR_HEADERS = { accept: '*/*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };
const FALLBACK_USER_AGENT ='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Atomic 0600 write: the file holds the login cookies (c_user/xs) the HTTP-only lane runs on.
export async function saveHttpSession(dataDir, ownerId, value) {
  const state = validateSession(value);
  const target = sessionFile(dataDir, ownerId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, target);
  return state;
}

// Logs in with the installed Google Chrome so Facebook sees a regular browser; Playwright's bundled
// Chromium is only the fallback when Chrome is not installed.
export async function launchLoginBrowser(chromium, profile, options = {}) {
  const settings = { headless: false, viewport: { width: 1280, height: 900 }, acceptDownloads: false, serviceWorkers: 'block', timeout: 30000, ...options };
  try { return await chromium.launchPersistentContext(profile, { ...settings, channel: 'chrome' }); }
  catch { return chromium.launchPersistentContext(profile, settings); }
}

// Standalone HTTP client: no Browser, BrowserContext, Page, or Chromium process.
export async function loadHttpSession(dataDir, ownerId) {
  try { return validateSession(JSON.parse(await readFile(sessionFile(dataDir, ownerId), 'utf8'))); }
  catch { throw new Error(`Chưa có phiên HTTP hợp lệ. Nhập file cookie JSON bằng: npm run login -- --user-id ${ownerId} --cookies-file DUONG_DAN_JSON`); }
}

export async function openHttpContext(dataDir, ownerId, { log = null } = {}) {
  const { userAgent, ...storageState } = await loadHttpSession(dataDir, ownerId);
  const { request } = await import('playwright');
  // Playwright's default "Playwright/x node/y" agent next to cookies minted in Chrome gets the session
  // logged out by Facebook, so requests reuse the agent of the browser that logged in.
  const client = await request.newContext({ storageState, timeout: 30000, userAgent: userAgent || FALLBACK_USER_AGENT,
    extraHTTPHeaders: { 'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' } });
  // Playwright retains response buffers until dispose; release each response immediately.
  const call = async (method, url, options) => {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://www.facebook.com') throw new Error('HTTP chỉ cho phép www.facebook.com.');
    // With a Chrome agent Facebook expects Chrome's fetch metadata: page GETs without it get HTTP 400,
    // GraphQL POSTs without it get an empty payload.
    // Only the operation name or path is logged, never query strings, form values or cookies.
    const label = `${method.toUpperCase()} ${options?.form?.fb_api_req_friendly_name || parsed.pathname}`;
    const started = Date.now();
    let response;
    try { response = await client[method](url, { ...options, headers: { ...(method === 'get' ? PAGE_HEADERS : XHR_HEADERS), ...options?.headers }, maxRedirects: 0 }); }
    catch (error) {
      log?.(`[API | Tài khoản ${ownerId}] ${label} → lỗi mạng: ${String(error.message).split('\n')[0].slice(0, 200)} (${Date.now() - started} ms)`);
      throw error;
    }
    try {
      const status = response.status(), headers = response.headers(), body = await response.text();
      const result = parsed.pathname === '/api/graphql/' ? ` ${classifyGraphQLResponse({ status, headers, text: body })}` : '';
      log?.(`[API | Tài khoản ${ownerId}] ${label} → HTTP ${status}${result} (${Date.now() - started} ms, ${Math.round(body.length / 1024)} KB)`);
      return { status: () => status, headers: () => headers, text: async () => body };
    } finally { await response.dispose(); }
  };
  let closing;
  return { request: { get: (url, options) => call('get', url, options), post: (url, options) => call('post', url, options) }, close: () => closing ??= client.dispose() };
}

export function browserUnavailable() {
  const error = new Error('Chế độ HTTP-only: chức năng này chưa có API/template hợp lệ; không mở trình duyệt.');
  error.code = 'HTTP_ONLY_UNSUPPORTED';
  return error;
}

// Captured operations from 2026-10-16. IDs may expire; no DOM fallback or mutation retry.
export async function submitHttpAction({ request, session, kind, target, text, canSubmit = () => true }) {
  if (!session) throw new Error('Không lấy được phiên GraphQL qua HTTP; cần cập nhật cookie.');
  if (!/^\d+$/.test(String(target))) throw new Error('HTTP API cần ID số của bài viết/người nhận.');
  const actor = session.form.__user;
  if (kind !== 'comment' && String(target) === actor) throw new Error('Không thể gửi cho chính tài khoản bot.');
  const mutationId = randomUUID();
  let form, endpoint = 'https://www.facebook.com/api/graphql/';
  if (kind === 'block') {
    // Variables recovered from requests-facebook-19976-1792250187700.json.
    // Use the active session/target, never the account IDs from the capture.
    form = { ...session.form, fb_api_req_friendly_name: 'ProfileCometActionBlockUserMutation',
      doc_id: '27871511059188774', variables: JSON.stringify({
        collectionID:null,hasCollectionAndSectionID:false,
        input:{blocksource:'PROFILE',should_apply_to_later_created_profiles:false,
          user_id:String(target),actor_id:actor,client_mutation_id:mutationId},
        scale:1,sectionID:null,isPrivacyCheckupContext:false,
        __relay_internal__pv__FBProfile_enable_perf_improv_gkrelayprovider:true,
      }) };
  } else if (kind === 'message') {
    const id = String((BigInt(Date.now()) << 22n) | BigInt(Math.floor(Math.random() * 4194304)));
    endpoint = 'https://www.facebook.com/messaging/send/';
    form = { ...session.form, client: 'mercury', action_type: 'ma-type:user-generated-message',
      author: `fbid:${actor}`, body: text, timestamp: String(Date.now()), other_user_fbid: String(target),
      offline_threading_id: id, message_id: id, 'specific_to_list[0]': `fbid:${target}`,
      'specific_to_list[1]': `fbid:${actor}`, has_attachment: 'false', source: 'source:chat:web' };
  } else {
    const comment = kind === 'comment';
    if (!comment && kind !== 'friend') throw new Error('Thao tác HTTP không hợp lệ.');
    const name = comment ? 'useCometUFICreateCommentMutation' : 'FriendingCometFriendRequestSendMutation';
    const input = comment
      ? { actor_id: actor, client_mutation_id: mutationId, feedback_id: feedbackId(target),
          message: { text, ranges: [] }, attachments: [], idempotence_token: mutationId, session_id: randomUUID() }
      : { actor_id: actor, client_mutation_id: mutationId, friend_requestee_ids: [String(target)],
          friending_channel: 'PROFILE_BUTTON', warn_ack_for_ids: [], click_correlation_id: mutationId, click_proof_validation_result: null };
    form = { ...session.form, fb_api_req_friendly_name: name,
      doc_id: comment ? '28884687701196649' : '28400389149651601',
      variables: JSON.stringify({ input, scale: 1, ...(comment ? { feedLocation: 'GROUP', feedbackSource: 0, renderLocation: 'group', useDefaultActor: false } : {}) }) };
  }
  if (!await canSubmit()) {
    const error = new Error('Đã hủy thao tác trước khi gửi.');
    error.commentSubmitted = false;
    throw error;
  }
  // Once POST starts, an unconfirmed response must never trigger an automatic resend.
  let response, raw;
  try {
    response = await request.post(endpoint, { form, headers: session.headers, maxRedirects: 0, timeout: 30000 });
    raw = await response.text();
  } catch { throw new Error('Đã gọi API nhưng chưa xác nhận kết quả; kiểm tra Facebook trước khi gửi lại.'); }
  const status = classifyGraphQLResponse({ status: response.status(), headers: response.headers(), text: raw });
  if (status === 'rate_limited' && (response.status() === 429 || /^\s*(?:for\s*\(;;\);?\s*)?\{/.test(raw))) throw rateLimitError();
  let entries;
  try { entries = raw.replace(/^\s*for\s*\(;;\);?\s*/, '').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { throw new Error('API trả dữ liệu không đọc được; chưa xác nhận thao tác, không tự gửi lại.'); }
  if (response.status() < 200 || response.status() >= 300) {
    throw new Error(`Facebook không xác nhận thao tác API (HTTP ${response.status()}); kiểm tra quyền, phiên hoặc doc_id. Không tự gửi lại.`);
  }
  // Successful mutations often carry non-fatal field errors next to the result, so a confirmation wins over errors.
  for (const entry of entries) {
    if (kind === 'block') {
      const user = entry.data?.user_block?.blocked_user;
      if (String(user?.id) === String(target)) return {success:true,state:'blocked',id:String(target)};
    }
    const created = entry.data?.comment_create;
    const comment = created?.comment || created?.feedback_comment_edge?.node;
    if (kind === 'comment' && comment?.id) return comment;
    if (kind === 'friend') {
      const user = entry.data?.friend_request_send?.friend_requestees?.find(user => String(user.id) === String(target));
      if (user?.friendship_status === 'ARE_FRIENDS') return { state: 'already_friends', success: true };
      if (user?.friendship_status === 'OUTGOING_REQUEST') return { state: 'sent', success: true };
    }
    const actions = entry.payload?.actions || entry.actions;
    if (kind === 'message' && Array.isArray(actions) && actions.some(action => action.message_id && String(action.offline_threading_id) === form.offline_threading_id)) {
      return { success: true, called: false, callNote: 'HTTP-only không hỗ trợ nháy máy.' };
    }
  }
  const errors = entries.flatMap(entry => [...(entry.error ? [entry] : []), ...(entry.errors || [])]);
  // The browser's own block (capture 2026-10-19, same variables) is answered with only {user_block:{viewer:{}}}:
  // a non-null payload without errors is Facebook's confirmation; a different blocked user is not.
  if (kind === 'block' && !errors.length && entries.some(entry => entry.data?.user_block && typeof entry.data.user_block === 'object'
    && (entry.data.user_block.blocked_user?.id == null || String(entry.data.user_block.blocked_user.id) === String(target)))) {
    return {success:true,state:'blocked',id:String(target)};
  }
  // A null user_block with field errors is ambiguous, even if a previous request
  // with similar errors happened to apply. Never label it confirmed or retry it.
  // Our request omits some relay provider variables, so Facebook creates the comment but fails to render the
  // returned fields with only missing_required_variable_value; comments answered this way were verified posted.
  if (kind === 'comment' && errors.length && entries.some(entry => entry.data && 'comment_create' in entry.data)
    && errors.every(error => /missing_required_variable_value/.test(error.summary || error.description || error.message || ''))) {
    return { id: null, note: 'Facebook đã nhận bình luận nhưng không trả ID (thiếu biến phụ trong phản hồi).' };
  }
  if (errors.length) {
    const reason = errors.map(error => error.summary || error.description || error.message || error.error).filter(Boolean).join('; ').slice(0, 200);
    throw new Error(`Facebook không xác nhận thao tác API${reason ? ` (${reason})` : ''}; kiểm tra quyền, phiên hoặc doc_id. Không tự gửi lại.`);
  }
  throw new Error('API chưa trả xác nhận phù hợp; kiểm tra Facebook trước khi gửi lại.');
}
