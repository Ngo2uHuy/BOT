import { normalizeAuthorUrl } from './facebook.js';
import { resolveRecipientFbid, isAnonymousAuthor } from './direct-messages.js';

export async function sendFriendRequestAPI(page, recipientId, canSubmit = () => true) {
  if (!recipientId || !/^\d+$/.test(String(recipientId))) return null;
  if (typeof page?.evaluate !== 'function') return null;
  if (!await canSubmit()) throw new Error('Đã hủy gửi lời mời kết bạn trước khi thực hiện.');

  const result = await page.evaluate(async ({ recipientId }) => {
    let dtsg = window.DTSGInitialData?.token;
    if (!dtsg && typeof window.require === 'function') {
      try { dtsg = window.require('DTSGInitialData')?.token; } catch {}
    }
    if (!dtsg) {
      for (const s of document.scripts) {
        const txt = s.textContent || '';
        if (txt.includes('DTSGInit')) {
          const m = txt.match(/\["DTSGInit(?:ial)?Data",\[\],\{"token":"([^"]+)"/);
          if (m) { dtsg = m[1]; break; }
        }
      }
    }
    if (!dtsg) {
      const m = document.documentElement.innerHTML.slice(0, 500000).match(/\["DTSGInitData",\[\],\{"token":"([^"]+)"/);
      dtsg = m ? m[1] : null;
    }
    const cUser = document.cookie.match(/c_user=(\d+)/)?.[1];
    if (!dtsg || !cUser) return { ok: false, error: 'NO_SESSION' };
    if (String(recipientId) === String(cUser)) return { ok: false, error: 'SELF_TARGET' };

    let sum = 0;
    for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
    const jazoest = '2' + sum;

    // doc_id rotates with Facebook deploys, so a hardcoded fallback only yields
    // "document not found"; read it from the page's own Relay modules instead.
    const operation = 'FriendingCometFriendRequestSendMutation';
    const findDocId = () => {
      if (typeof window.require !== 'function') return null;
      try {
        const id = window.require(`${operation}_facebookRelayOperation`);
        if (/^\d+$/.test(String(id))) return String(id);
      } catch {}
      try {
        const request = window.require(operation);
        const id = request?.params?.id || request?.operation?.id;
        if (/^\d+$/.test(String(id))) return String(id);
      } catch {}
      return null;
    };
    let docId = findDocId();
    if (!docId && typeof window.require === 'function') {
      try {
        await new Promise(resolve => {
          setTimeout(resolve, 5000);
          window.require('Bootloader').loadModules([`${operation}_facebookRelayOperation`], resolve, 'FriendRequestBot');
        });
      } catch {}
      docId = findDocId();
    }
    if (!docId) {
      for (const s of document.scripts) {
        const txt = s.textContent || '';
        if (!txt.includes(operation)) continue;
        const m = txt.match(/"FriendingCometFriendRequestSendMutation(?:_facebookRelayOperation)?"\s*,\s*\[\],\s*\{"id":"(\d+)"/)
          || txt.match(/"FriendingCometFriendRequestSendMutation"[^}]+"id":"(\d+)"/);
        if (m) { docId = m[1]; break; }
      }
    }
    if (!docId) return { ok: false, error: 'Không lấy được doc_id GraphQL kết bạn từ trang Facebook.' };

    const body = new URLSearchParams({
      av: cUser,
      __user: cUser,
      __a: '1',
      fb_dtsg: dtsg,
      jazoest: jazoest,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'FriendingCometFriendRequestSendMutation',
      variables: JSON.stringify({
        input: {
          attribution_id_v2: 'ProfileCometTimelineListViewRoot.react,comet.profile.timeline.list,via_cold_start,' + Date.now() + ',0,,',
          click_correlation_id: String(Date.now()),
          click_proof_validation_result: null,
          friend_requestee_ids: [String(recipientId)],
          friending_channel: 'PROFILE_BUTTON',
          warn_ack_for_ids: [],
          actor_id: cUser,
          client_mutation_id: String(Date.now() % 1000)
        },
        scale: 1
      }),
      doc_id: docId
    });

    try {
      const res = await fetch('/api/graphql/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      // Facebook may prefix JSON with "for (;;);" and stream extra lines.
      const raw = (await res.text().catch(() => '')).replace(/^\s*for\s*\(;;\);?\s*/, '');
      let entries;
      try { entries = [JSON.parse(raw)]; } catch { entries = raw.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
      const data = entries.find(entry => entry?.data?.friend_request_send) || entries[0] || null;
      const errors = entries.flatMap(entry => entry?.errors || []);
      // From here on the request was sent: only an explicit rejection proves no invite exists.
      if (errors.length && !data?.data?.friend_request_send) {
        const msg = errors[0]?.message || errors[0]?.summary || errors[0]?.description || '';
        if (/already friend|đã là bạn|đã kết bạn/i.test(msg)) {
          return { ok: true, state: 'already_friends', note: msg || 'Đã là bạn bè từ trước.' };
        }
        if (/already sent|đã gửi/i.test(msg)) {
          return { ok: true, state: 'already_requested', note: msg || 'Đã gửi lời mời từ trước (đang chờ phản hồi).' };
        }
        if (/tạm chặn|bị chặn|hạn chế|temporarily blocked|action blocked|không thể thực hiện/i.test(msg)) {
          return { ok: false, sent: true, error: msg, blocked: true };
        }
        return { ok: false, sent: true, error: msg || 'API_FAILED' };
      }
      // A null mutation payload means nothing was sent.
      const sent = data?.data?.friend_request_send;
      if (res.ok && sent) {
        const recipient = sent.friend_requestees?.find(user => String(user.id) === String(recipientId));
        const status = recipient?.friendship_status;
        if (status === 'ARE_FRIENDS') return { ok: true, state: 'already_friends', note: 'Đã là bạn bè từ trước.' };
        if (status === 'OUTGOING_REQUEST') return { ok: true, data: data.data };
        if (status) return { ok: false, sent: true, error: `Facebook trả trạng thái ${status}` };
      }
      if (res.ok && data?.data && sent === null) return { ok: false, sent: true, error: 'Facebook không tạo lời mời kết bạn.' };
      return { ok: false, sent: true, uncertain: true, error: `HTTP ${res.status}: chưa thấy xác nhận lời mời` };
    } catch (e) {
      return { ok: false, sent: true, uncertain: true, error: e.message };
    }
  }, { recipientId })
    // An evaluate aborted by navigation cannot tell whether fetch already left.
    .catch(err => ({ ok: false, sent: true, uncertain: true, error: err?.message }));

  if (result?.ok) return result;
  if (result?.error === 'SELF_TARGET') {
    throw new Error('Không thể gửi lời mời kết bạn cho chính tài khoản Facebook của bot.');
  }
  if (result?.error && /tạm chặn|bị chặn|hạn chế tài khoản|temporarily blocked|action blocked/i.test(result.error)) {
    throw new Error('Facebook đang tạm chặn tính năng kết bạn của tài khoản bot.');
  }
  // A dispatched request is never retried through the profile button.
  if (result?.sent) {
    const reason = String(result.error || 'API_FAILED').slice(0, 150);
    throw Object.assign(new Error(result.uncertain
      ? `Đã gửi lời mời kết bạn qua API nhưng chưa xác nhận kết quả (${reason}); kiểm tra Facebook trước khi gửi lại.`
      : `Facebook từ chối lời mời kết bạn: ${reason}`), { commentSubmitted: !!result.uncertain });
  }
  return result?.error ? { ok: false, error: result.error } : null;
}

// Exact header labels only: "Thêm bạn bè" contains "bạn bè" and comment reply
// buttons read "Phản hồi", so substring matching misreads the friendship state.
export const FRIEND_LABELS = {
  self: ['chỉnh sửa trang cá nhân', 'edit profile'],
  friends: ['bạn bè', 'friends'],
  requested: ['hủy lời mời', 'hủy yêu cầu', 'cancel request'],
  incoming: ['phản hồi', 'respond'],
  add: ['thêm bạn bè', 'thêm bạn', 'add friend'],
};
const FRIEND_ACTION = '[data-bot-friend-action]';

// Self-contained for Playwright. Profile action buttons sit above the tab bar;
// suggestions ("Thêm bạn bè" for other people) and posts come after it.
export function profileFriendState(labels) {
  for (const el of document.querySelectorAll('[data-bot-friend-action]')) el.removeAttribute('data-bot-friend-action');
  const main = document.querySelector('[role="main"]');
  if (!main) return { state: 'unknown' };
  const tablist = main.querySelector('[role="tablist"]');
  for (const el of main.querySelectorAll('[role="button"]')) {
    if (tablist && !(el.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    if (el.closest('[role="article"], [role="dialog"], [role="navigation"], [role="feed"], [role="menu"]')) continue;
    if (!el.getClientRects().length) continue;
    const label = (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const state = Object.keys(labels).find(key => labels[key].includes(label));
    if (state) {
      el.setAttribute('data-bot-friend-action', state);
      return { state };
    }
  }
  return { state: 'unknown' };
}

async function readFriendState(page, timeout = 5000, done = state => state !== 'unknown') {
  if (typeof page?.evaluate !== 'function') return 'unknown';
  for (let waited = 0; ; waited += 500) {
    const state = (await page.evaluate(profileFriendState, FRIEND_LABELS).catch(() => null))?.state || 'unknown';
    if (done(state) || waited >= timeout) return state;
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(500);
  }
}

async function acceptIncoming(page, canSubmit, onSubmit) {
  if (!await canSubmit()) throw new Error('Đã hủy kết bạn trước khi thực hiện.');
  await page.locator(FRIEND_ACTION).first().click();
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(500);
  const confirmBtn = page.locator([
    '[role="menu"] [role="menuitem"]:has-text("Xác nhận")',
    '[role="menu"] [role="menuitem"]:has-text("Confirm")',
    'div[role="dialog"] div[role="button"]:has-text("Xác nhận")',
    'div[role="dialog"] div[role="button"]:has-text("Confirm")',
  ].join(', ')).first();
  if (!await confirmBtn.isVisible().catch(() => false)) {
    throw new Error('Người này đã gửi lời mời cho bot nhưng không tìm thấy nút Xác nhận.');
  }
  onSubmit();
  await confirmBtn.click();
  return { success: true, state: 'accepted', note: 'Người này đã gửi lời mời cho bạn, đã chấp nhận kết bạn thành công.' };
}

async function clickAddFriend(page, button, canSubmit, verify, onSubmit) {
  if (!await canSubmit()) throw new Error('Đã hủy kết bạn trước khi thực hiện.');
  onSubmit();
  await button.click();
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(600);

  // Confirm dialog if prompted
  const confirmDialogBtn = page.locator([
    'div[role="dialog"] div[role="button"]:has-text("Xác nhận")',
    'div[role="dialog"] div[role="button"]:has-text("Gửi lời mời")',
    'div[role="dialog"] div[role="button"]:has-text("Confirm")',
    'div[role="dialog"] div[role="button"]:has-text("Send")'
  ].join(', ')).first();
  if (await confirmDialogBtn.isVisible().catch(() => false)) {
    await confirmDialogBtn.click().catch(() => {});
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(400);
  }

  const dialogText = await page.locator('div[role="dialog"]').first().innerText().catch(() => '');
  if (/tạm chặn|bị chặn|hạn chế|không thể gửi lời mời|giới hạn|blocked|restricted|limit/i.test(dialogText)) {
    throw new Error(`Facebook báo lỗi: ${dialogText.slice(0, 150)}`);
  }

  // A click Facebook ignored leaves "Thêm bạn bè" in place; never report it as sent.
  if (verify && await readFriendState(page, 4000, state => state !== 'add' && state !== 'unknown') === 'add') {
    throw new Error('Đã bấm Thêm bạn bè nhưng Facebook chưa ghi nhận lời mời (nút vẫn là Thêm bạn bè).');
  }
  return { success: true, state: 'sent', note: 'Đã gửi lời mời kết bạn thành công.' };
}

export async function sendFriendRequest(page, authorUrl, canSubmit = () => true) {
  // After a submit click any error is ambiguous: callers must never retry automatically.
  let submitted = false;
  const onSubmit = () => { submitted = true; };
  try {
  const norm = normalizeAuthorUrl(authorUrl);
  if (!norm || isAnonymousAuthor(authorUrl)) {
    throw new Error('Link trang cá nhân không hợp lệ hoặc bài viết ẩn danh.');
  }

  // Navigate to profile if not already there
  const currentUrl = typeof page.url === 'function' ? page.url() : '';
  const cleanCurrent = currentUrl.replace(/\/$/, '');
  const cleanNorm = norm.replace(/\/$/, '');
  if (!cleanCurrent.includes(cleanNorm)) {
    await page.goto(norm, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  // Allow client-side rendering / hydration of action buttons
  if (typeof page.locator === 'function') {
    const mainEl = page.locator('[role="main"]').first();
    if (typeof mainEl.waitFor === 'function') {
      await mainEl.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    }
  }

  // Check if account blocked / restricted
  const bodyText = typeof page.innerText === 'function' ? await page.innerText('body').catch(() => '') : '';
  if (/tính năng này tạm thời bị chặn|you are temporarily blocked|hạn chế tài khoản|bạn tạm thời bị chặn/i.test(bodyText)) {
    throw new Error('Facebook đang tạm chặn tính năng kết bạn của tài khoản bot.');
  }

  const state = await readFriendState(page);
  if (state === 'self') throw new Error('Không thể gửi lời mời kết bạn cho chính tài khoản Facebook của bot.');
  if (state === 'friends') return { success: true, state: 'already_friends', note: 'Đã là bạn bè từ trước.' };
  if (state === 'requested') return { success: true, state: 'already_requested', note: 'Đã gửi lời mời kết bạn từ trước (đang chờ phản hồi).' };
  if (state === 'incoming') return await acceptIncoming(page, canSubmit, onSubmit);

  // GraphQL API first: it does not depend on how Facebook lays out the profile header.
  let apiError = '';
  try {
    const fbid = await resolveRecipientFbid(page, norm);
    if (!fbid) apiError = 'không xác định được ID Facebook của tác giả';
    const apiResult = fbid ? await sendFriendRequestAPI(page, fbid, canSubmit) : null;
    if (apiResult?.ok) {
      if (apiResult.state === 'already_friends') {
        return { success: true, state: 'already_friends', note: apiResult.note || 'Đã là bạn bè từ trước.' };
      }
      if (apiResult.state === 'already_requested') {
        return { success: true, state: 'already_requested', note: apiResult.note || 'Đã gửi lời mời kết bạn từ trước (đang chờ phản hồi).' };
      }
      return { success: true, state: 'sent', note: 'Đã gửi lời mời kết bạn thành công.' };
    }
    if (apiResult?.error) apiError = apiResult.error;
  } catch (err) {
    if (err?.commentSubmitted !== undefined || /tạm chặn|bị chặn|hạn chế tài khoản|chính tài khoản|Đã hủy/i.test(err?.message)) throw err;
    apiError = err?.message || '';
  }

  if (state === 'add') return await clickAddFriend(page, page.locator(FRIEND_ACTION).first(), canSubmit, true, onSubmit);

  // "Thêm bạn bè" may be hidden inside the "..." action menu on the profile header
  const moreBtn = page.locator([
    '[role="main"] div[aria-label="Xem thêm" i][role="button"]',
    '[role="main"] div[aria-label="Khác" i][role="button"]',
    '[role="main"] div[aria-label*="Hành động khác" i][role="button"]',
    '[role="main"] div[aria-label*="More actions" i][role="button"]',
    '[role="main"] div[aria-label="More" i][role="button"]',
  ].join(', ')).first();
  if (await moreBtn.isVisible().catch(() => false)) {
    await moreBtn.click().catch(() => {});
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(500);
    const menuAddFriend = page.locator('[role="menu"] [role="menuitem"]:has-text("Thêm bạn bè"), [role="menu"] [role="menuitem"]:has-text("Add friend")').first();
    if (await menuAddFriend.isVisible().catch(() => false)) {
      return await clickAddFriend(page, menuAddFriend, canSubmit, false, onSubmit);
    }
  }

  // The button labels the bot saw tell a changed Facebook layout apart from a profile that truly blocks requests.
  const seen = typeof page.evaluate === 'function' ? await page.evaluate(profileButtonLabels).catch(() => null) : null;
  const detail = Array.isArray(seen?.labels) ? ` [Nút thấy được: ${seen.labels.join(' | ') || 'không có'}${seen.tablist ? '' : '; không thấy thanh tab'}]` : '';
  const api = apiError ? ` [API: ${String(apiError).slice(0, 150)}]` : '';
  throw new Error(`Không tìm thấy nút Thêm bạn bè trên trang cá nhân (tác giả có thể đã chặn lời mời hoặc đạt giới hạn 5.000 bạn bè).${api}${detail}`);
  } catch (error) {
    // API errors already carry their own flag; UI errors before the submit click sent nothing.
    error.commentSubmitted ??= submitted;
    throw error;
  }
}

// Self-contained for Playwright: visible button labels above the profile tab bar.
export function profileButtonLabels() {
  const main = document.querySelector('[role="main"]');
  if (!main) return { labels: [], tablist: false };
  const tablist = main.querySelector('[role="tablist"]');
  const labels = [];
  for (const el of main.querySelectorAll('[role="button"]')) {
    if (tablist && !(el.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    if (!el.getClientRects().length) continue;
    const label = (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= 12) break;
  }
  return { labels, tablist: !!tablist };
}
