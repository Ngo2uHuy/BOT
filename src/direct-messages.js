import { normalizeAuthorUrl } from './facebook.js';

export function isAnonymousAuthor(name) {
  if (!name) return true;
  return /^(?:người (?:tham gia|đóng góp)|thành viên|anonymous)\s*(?:ẩn danh|member|participant|creator)?$/i.test(String(name).trim());
}

export function directMessageText(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 2000) throw new Error('Nội dung tin nhắn cần từ 1 đến 2000 ký tự.');
  return text;
}

export function renderDirectMessage(template, context = {}) {
  const raw = String(template ?? '').trim();
  if (!raw) return '';
  const name = context.name ? String(context.name).trim() : 'bạn';
  const link = context.link || context.post?.url || '';
  const id = context.post?.id || context.id || '';

  return raw
    .replace(/\{name\}|\{tên\}/gi, name)
    .replace(/\{link\}/gi, link)
    .replace(/\{id\}/gi, String(id));
}

export function profileIdOrUsername(value) {
  try {
    const url = new URL(value);
    if (url.searchParams.has('id')) {
      const id = url.searchParams.get('id');
      if (/^\d+$/.test(id)) return id;
    }
    const matchUser = url.pathname.match(/\/user\/(\d+)/);
    if (matchUser) return matchUser[1];

    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path && !path.includes('/') && !['profile.php', 'messages', 'groups'].includes(path.toLowerCase())) {
      return path;
    }
  } catch {}
  return null;
}

// Node-side twin of the in-page checks below, for HTML fetched without a browser: only IDs bound to this
// vanity (redirect to profile.php, app-link meta, userVanity/userID pair), never the viewer's own account.
export function profileIdFromHtml({ html = '', location = '', vanity, ownId = null }) {
  const text = String(html ?? '');
  const own = new Set([ownId, text.match(/"USER_ID":"(\d+)"/)?.[1]].filter(Boolean).map(String));
  const accept = id => (/^\d+$/.test(id || '') && !own.has(id) ? id : null);
  if (location) {
    try {
      const url = new URL(location, 'https://www.facebook.com/');
      if (/(^|\.)facebook\.com$/.test(url.hostname) && url.pathname === '/profile.php' && accept(url.searchParams.get('id'))) return url.searchParams.get('id');
    } catch { /* Unusable redirect. */ }
    return null;
  }
  for (const tag of text.match(/<meta\s[^>]*>/gi) || []) {
    if (!/\sproperty=["']al:(?:android|ios):url["']/i.test(tag)) continue;
    const id = accept(tag.match(/\scontent=["']fb:\/\/profile\/(\d+)["']/i)?.[1]);
    if (id) return id;
  }
  if (!/^[A-Za-z0-9.]+$/.test(String(vanity ?? ''))) return null;
  const escaped = vanity.replace(/\./g, '\\.');
  for (const pattern of [new RegExp(`"userVanity":"${escaped}","userID":"(\\d+)"`, 'gi'), new RegExp(`"userID":"(\\d+)","userVanity":"${escaped}"`, 'gi')]) {
    for (const match of text.matchAll(pattern)) if (accept(match[1])) return match[1];
  }
  return null;
}

export async function resolveRecipientFbid(page, authorUrl) {
  const norm = normalizeAuthorUrl(authorUrl);
  if (!norm) return null;
  const matchId = norm.match(/[?&]id=(\d+)/) || norm.match(/\/user\/(\d+)/);
  if (matchId) return matchId[1];
  if (typeof page?.evaluate !== 'function') return null;

  // Only IDs tied to this profile: a generic profile_id/entity_id in page scripts
  // can belong to anyone shown on the page, sending the action to a stranger.
  const vanity = profileIdOrUsername(norm);
  try {
    return await page.evaluate(vanity => {
      const cUser = document.cookie.match(/c_user=(\d+)/)?.[1];
      const accept = id => (id && id !== cUser ? id : null);
      if (location.pathname === '/profile.php' && accept(new URL(location.href).searchParams.get('id'))) {
        return new URL(location.href).searchParams.get('id');
      }
      for (const property of ['al:android:url', 'al:ios:url']) {
        const id = document.querySelector(`meta[property="${property}"]`)?.getAttribute('content')?.match(/fb:\/\/profile\/(\d+)/)?.[1];
        if (accept(id)) return id;
      }
      const escaped = String(vanity || '').replace(/\./g, '\\.');
      const patterns = escaped ? [
        new RegExp(`"userVanity":"${escaped}","userID":"(\\d+)"`, 'i'),
        new RegExp(`"userID":"(\\d+)","userVanity":"${escaped}"`, 'i'),
      ] : [];
      for (const s of document.scripts) {
        const text = s.textContent || '';
        if (!text.includes('"userID"')) continue;
        for (const pattern of patterns) {
          const id = text.match(pattern)?.[1];
          if (accept(id)) return id;
        }
      }
      return null;
    }, vanity);
  } catch {
    return null;
  }
}

export async function sendDirectMessageAPI(page, recipientId, text, canSubmit = () => true) {
  if (!recipientId || !/^\d+$/.test(String(recipientId))) return null;
  if (typeof page?.evaluate !== 'function') return null;
  if (!await canSubmit()) throw new Error('Đã hủy gửi tin nhắn trước khi thực hiện.');

  const result = await page.evaluate(async ({ recipientId, text }) => {
    let dtsg = window.DTSGInitialData?.token;
    if (!dtsg) {
      try {
        if (typeof window.require === 'function') {
          const mod = window.require('DTSGInitialData');
          if (mod?.token) dtsg = mod.token;
        }
      } catch {}
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
    const cUser = document.cookie.match(/c_user=(\d+)/)?.[1]
      || (typeof window.require === 'function' ? window.require('CurrentUserInitialData')?.ACCOUNT_ID : null);
    if (!dtsg || !cUser) return { ok: false, error: 'NO_SESSION' };

    let sum = 0;
    for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
    const jazoest = '2' + sum;

    const epochNow = Date.now();
    const msgId = String(epochNow) + String(Math.floor(Math.random() * 1000000));

    // Facebook prefixes JSON with "for (;;);" and may stream several JSON lines;
    // a missed acknowledgment would otherwise look like an unsent message.
    const readJson = async res => {
      const raw = (await res.text().catch(() => '')).replace(/^\s*for\s*\(;;\);?\s*/, '');
      try { return [JSON.parse(raw)]; } catch {}
      return raw.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    };
    // Once a send POST leaves, only an explicit Facebook rejection proves nothing
    // was delivered; anything else is uncertain and must not be resent.
    const uncertain = error => ({ ok: false, sent: true, uncertain: true, error });
    let lastError = 'API_FAILED';

    // 1. Thử gửi qua endpoint /messaging/send/
    const params = new URLSearchParams({
      client: 'mercury',
      action_type: 'ma-type:user-generated-message',
      author: 'fbid:' + cUser,
      timestamp: String(epochNow),
      timestamp_absolute: 'Today',
      timestamp_relative: 'Just now',
      timestamp_time_passed: '0',
      is_unread: 'false',
      is_cleared: 'false',
      is_forward: 'false',
      is_filtered_content: 'false',
      is_spoof_warning: 'false',
      source: 'source:chat:web',
      'source_tags[0]': 'source:chat',
      body: text,
      html_body: 'false',
      ui_push_phase: 'V3',
      status: '0',
      offline_threading_id: msgId,
      message_id: msgId,
      threading_id: '<' + msgId + ':' + epochNow + '-' + Math.random().toString(36).slice(2) + '@mail.projektitan.com>',
      ephemeral_ttl_mode: '0',
      manual_retry_cnt: '0',
      other_user_fbid: String(recipientId),
      has_attachment: 'false',
      fb_dtsg: dtsg,
      jazoest: jazoest
    });

    try {
      const res = await fetch('/messaging/send/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const entries = await readJson(res);
      const data = entries.find(entry => entry?.payload?.actions || entry?.actions) || entries.find(entry => entry?.error) || entries[0];
      const actions = data?.payload?.actions || data?.actions;
      if (res.ok && data && !data.error && Array.isArray(actions) && actions.some(action => action.message_id && String(action.offline_threading_id) === msgId)) {
        return { ok: true, data };
      }
      if (!data?.error || Array.isArray(actions)) return uncertain(`messaging/send HTTP ${res.status}: chưa thấy xác nhận tin nhắn`);
      lastError = data.errorSummary || data.errorDescription || 'Facebook báo lỗi gửi tin nhắn';
    } catch (err) {
      return uncertain(err?.message || 'messaging/send lỗi mạng');
    }

    // 2. Facebook explicitly rejected messaging/send, so GraphQL cannot duplicate it.
    try {
      // doc_id rotates with Facebook deploys, so read it from the page's own Relay
      // modules instead of sending a stale hardcoded id.
      const operation = 'useCometSendMessageMutation';
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
            window.require('Bootloader').loadModules([`${operation}_facebookRelayOperation`], resolve, 'DirectMessageBot');
          });
        } catch {}
        docId = findDocId();
      }
      if (!docId) {
        for (const s of document.scripts) {
          const txt = s.textContent || '';
          if (!txt.includes(operation)) continue;
          const m = txt.match(/"useCometSendMessageMutation(?:_facebookRelayOperation)?"\s*,\s*\[\],\s*\{"id":"(\d+)"/)
            || txt.match(/"useCometSendMessageMutation"[^}]+"id":"(\d+)"/);
          if (m) { docId = m[1]; break; }
        }
      }
      if (!docId) {
        return { ok: false, sent: true, error: `${lastError}; không lấy được doc_id GraphQL gửi tin nhắn từ trang Facebook.` };
      }

      const gqlBody = new URLSearchParams({
        av: cUser,
        __user: cUser,
        __a: '1',
        fb_dtsg: dtsg,
        jazoest: jazoest,
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: 'useCometSendMessageMutation',
        variables: JSON.stringify({
          input: {
            client_mutation_id: msgId,
            actor_id: cUser,
            thread_id: String(recipientId),
            message: { text: text },
            offline_threading_id: msgId
          }
        }),
        doc_id: docId
      });

      const resGql = await fetch('/api/graphql/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: gqlBody.toString()
      });
      const entriesGql = await readJson(resGql);
      const dataGql = entriesGql.find(entry => entry?.data?.message_send) || entriesGql[0];
      const errors = entriesGql.flatMap(entry => entry?.errors || []);
      const sentMessage = dataGql?.data?.message_send?.message;
      if (resGql.ok && !errors.length && sentMessage?.id) {
        return { ok: true, data: dataGql };
      }
      if (!errors.length || dataGql?.data?.message_send) return uncertain(`GraphQL HTTP ${resGql.status}: chưa thấy xác nhận tin nhắn`);
      const e = errors[0];
      return { ok: false, sent: true, error: e?.summary || e?.description || e?.message || lastError };
    } catch (err) {
      return uncertain(err?.message || 'GraphQL lỗi mạng');
    }
  }, { recipientId, text })
    // Session lookup is synchronous, so an aborted evaluate most likely died after fetch left.
    .catch(err => ({ ok: false, sent: true, uncertain: true, error: err?.message }));

  if (result?.ok) return result.data || { ok: true };
  if (result?.sent) {
    const reason = String(result.error || 'API_FAILED').slice(0, 150);
    throw Object.assign(new Error(result.uncertain
      ? `Đã gửi tin nhắn qua API nhưng chưa xác nhận kết quả (${reason}); kiểm tra Messenger trước khi gửi lại.`
      : `Facebook từ chối tin nhắn: ${reason}`), { commentSubmitted: !!result.uncertain });
  }
  // Nothing was sent: the failure is returned (not null) so the caller can fall back
  // to the Messenger UI and still report why the API path failed.
  return { ok: false, error: result?.error || 'API_FAILED' };
}

export async function sendDirectMessage(page, authorUrl, text, canSubmit = () => true, options = { callAfter: true }) {
  let submitted = false;
  try {
  const norm = normalizeAuthorUrl(authorUrl);
  if (!norm || isAnonymousAuthor(authorUrl)) throw new Error('Link trang cá nhân không hợp lệ hoặc bài viết ẩn danh.');
  const body = directMessageText(text);

  // If not already on the profile page or messenger page, navigate to profile
  const currentUrl = typeof page.url === 'function' ? page.url() : '';
  const cleanCurrent = currentUrl.replace(/\/$/, '');
  const cleanNorm = norm.replace(/\/$/, '');
  if (!cleanCurrent.includes(cleanNorm) && !currentUrl.includes('/messages/t/')) {
    await page.goto(norm, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  // Check if page displays restriction / blocked notice
  const bodyText = await page.innerText('body').catch(() => '');
  if (/tính năng này tạm thời bị chặn|you are temporarily blocked|hạn chế tài khoản/i.test(bodyText)) {
    throw new Error('Facebook đang tạm chặn tính năng gửi tin nhắn của tài khoản bot.');
  }

  // 1. Gửi trực tiếp qua Facebook Messaging API
  let apiError = '';
  const fbid = await resolveRecipientFbid(page, norm);
  if (fbid) {
    const apiResult = await sendDirectMessageAPI(page, fbid, body, canSubmit);
    if (apiResult && apiResult.ok !== false) {
      if (!options?.callAfter) return { success: true, text: body, called: false, callNote: null };
      // The API sends without opening the thread; the call button lives there.
      try {
        await page.goto(`https://www.facebook.com/messages/t/${fbid}`, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForTimeout(2500);
      } catch (error) {
        return { success: true, text: body, called: false, callNote: `Không mở được Messenger để nháy máy: ${error.message.split('\n')[0]}` };
      }
      return { success: true, text: body, ...await missedCall(page) };
    }
    if (apiResult?.error) apiError = apiResult.error;
  }

  // Look for "Nhắn tin" / "Message" button on profile (prioritize [role="main"] to avoid top global header)
  const messageButtons = page.locator([
    '[role="main"] [aria-label="Nhắn tin" i]',
    '[role="main"] [aria-label="Message" i]',
    '[role="main"] div[role="button"]:has-text("Nhắn tin")',
    '[role="main"] div[role="button"]:has-text("Message")',
    '[role="main"] a[href*="/messages/t/"]',
    '[aria-label="Nhắn tin" i][role="button"]',
    '[aria-label="Message" i][role="button"]',
    'div[role="button"]:has-text("Nhắn tin")',
    'div[role="button"]:has-text("Message")',
    'a[href*="/messages/t/"]',
  ].join(', '));

  let editor = null;
  let activeChatTab = null;

  const btnCount = await messageButtons.count();
  for (let i = 0; i < btnCount; i++) {
    const btn = messageButtons.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(400);
      break;
    }
  }

  // 1. Check for floating chat tab at bottom-right
  const chatTabCandidates = page.locator([
    '[data-pagelet="ChatTab"]',
    'div:has(> div [aria-label*="Đóng đoạn chat" i])',
    'div:has([aria-label*="Đóng đoạn chat" i])',
    'div:has([aria-label*="Close chat" i])',
    'div:has([aria-label*="Đóng cuộc trò chuyện" i])',
    'div[aria-label*="Đoạn chat với" i]',
    'div[aria-label*="Chat with" i]',
  ].join(', '));

  for (let i = 0; i < await chatTabCandidates.count(); i++) {
    const tab = chatTabCandidates.nth(i);
    if (await tab.isVisible().catch(() => false)) {
      const insideEditor = tab.locator([
        'div[role="textbox"]',
        'div[contenteditable="true"]',
        'div[aria-label="Tin nhắn" i]',
        'div[aria-label="Message" i]',
        'div[aria-placeholder="Aa" i]',
        '[data-lexical-editor="true"]',
      ].join(', ')).first();
      if (await insideEditor.isVisible().catch(() => false)) {
        editor = insideEditor;
        activeChatTab = tab;
        break;
      }
    }
  }

  // 2. Check for message-specific textbox (never match generic comment boxes)
  if (!editor) {
    const directCandidates = page.locator([
      'div[aria-label="Tin nhắn" i][role="textbox"]',
      'div[aria-label="Message" i][role="textbox"]',
      'div[aria-label="Tin nhắn" i][contenteditable="true"]',
      'div[aria-label="Message" i][contenteditable="true"]',
      'div[aria-label="Tin nhắn" i]',
      'div[aria-label="Message" i]',
      'div[aria-placeholder="Aa" i]',
    ].join(', '));

    for (let i = 0; i < await directCandidates.count(); i++) {
      const cand = directCandidates.nth(i);
      if (await cand.isVisible().catch(() => false)) {
        editor = cand;
        break;
      }
    }
  }

  // 3. Fallback: navigate directly to full Messenger URL
  if (!editor) {
    const idOrUser = profileIdOrUsername(norm);
    if (idOrUser) {
      await page.goto(`https://www.facebook.com/messages/t/${idOrUser}`, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(2500);

      const msgBodyText = await page.innerText('body').catch(() => '');
      if (/không thể gửi tin nhắn|không thể nhắn tin|you can't message|tài khoản này hiện không thể nhận tin|người này hiện không có mặt trên messenger/i.test(msgBodyText)) {
        throw new Error('Tài khoản này đã khóa nhận tin nhắn từ người lạ hoặc không thể nhận tin.');
      }

      const fullCandidates = page.locator([
        'div[aria-label="Tin nhắn" i][role="textbox"]',
        'div[aria-label="Message" i][role="textbox"]',
        'div[aria-placeholder="Aa" i]',
        'div[data-lexical-editor="true"]',
        '[role="main"] div[role="textbox"]',
        '[role="main"] div[contenteditable="true"]',
      ].join(', '));

      await fullCandidates.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      for (let i = 0; i < await fullCandidates.count(); i++) {
        const cand = fullCandidates.nth(i);
        if (await cand.isVisible().catch(() => false)) {
          editor = cand;
          break;
        }
      }
    }
  }

  if (!editor) {
    throw new Error(`Không tìm thấy ô nhập tin nhắn (người dùng có thể đã tắt nhận tin nhắn từ người lạ).${apiError ? ` [API: ${String(apiError).slice(0, 150)}]` : ''}`);
  }

  if (!await canSubmit()) {
    throw new Error('Đã hủy gửi tin nhắn trước khi thực hiện.');
  }

  // Focus the editor
  await editor.click();
  await page.waitForTimeout(300);

  // Clear any existing text
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);

  // Type message:
  // Method 1: keyboard.insertText (native beforeinput event handled by Lexical/Draft.js)
  const sample = body.slice(0, Math.min(15, body.length));
  let textFound = false;

  try {
    if (typeof page.keyboard.insertText === 'function') {
      await page.keyboard.insertText(body);
      await page.waitForTimeout(300);
      let content = await editor.innerText().catch(() => '');
      if (content.includes(sample)) textFound = true;
    }
  } catch {}

  // Method 2: keyboard.type
  if (!textFound) {
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(body, { delay: 15 });
    await page.waitForTimeout(400);
    let content = await editor.innerText().catch(() => '');
    if (content.includes(sample)) textFound = true;
  }

  // Method 3: execCommand('insertText') fallback
  if (!textFound) {
    await editor.evaluate((el, text) => {
      el.focus();
      document.execCommand('insertText', false, text);
    }, body).catch(() => {});
    await page.waitForTimeout(300);
    let content = await editor.innerText().catch(() => '');
    if (content.includes(sample)) textFound = true;
  }

  if (!textFound) {
    const tagName = await editor.evaluate(el => `${el.tagName}.${el.getAttribute('role')}.${el.getAttribute('aria-label')}`).catch(() => 'unknown');
    const editorContent = await editor.innerText().catch(() => '');
    throw new Error(`Không thể nhập tin nhắn vào Messenger (editor: ${tagName}, content: "${editorContent.slice(0, 50)}")`);
  }

  // Record pre-send state to verify submission
  const container = activeChatTab || page.locator('[role="main"]');
  const beforeSentCount = await container.locator(`div:has-text("${sample}")`).count().catch(() => 0);

  // After this point any error is ambiguous: callers must never retry automatically.
  submitted = true;
  // Press Enter to send
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // Also check if Send button (airplane/plane icon) is present and click it
  const sendBtn = (activeChatTab || page).locator([
    '[aria-label="Gửi" i]',
    '[aria-label="Send" i]',
    '[aria-label="Nhấn Enter để gửi" i]',
    '[aria-label="Press Enter to send" i]',
  ].join(', ')).first();

  // Click Send only if Enter left the text in the editor; otherwise it is a second send.
  const stillTyped = (await editor.innerText().catch(() => '')).includes(sample);
  if (stillTyped && await sendBtn.isVisible().catch(() => false)) {
    await sendBtn.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Verify that the message was sent:
  // Either a new message bubble appeared OR the editor was cleared
  let confirmed = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const currentSentCount = await container.locator(`div:has-text("${sample}")`).count().catch(() => 0);
    const currentEditorText = await editor.innerText().catch(() => '');
    if (currentSentCount > beforeSentCount || !currentEditorText.includes(sample)) {
      confirmed = true;
      break;
    }
    await page.waitForTimeout(500);
  }

  if (!confirmed) {
    // Retry pressing Enter once
    await editor.click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    const retryEditorText = await editor.innerText().catch(() => '');
    if (retryEditorText.includes(sample)) {
      throw new Error('Đã nhập tin nhắn nhưng không thể gửi (tin nhắn vẫn nằm trong ô nhập, có thể bị chặn gửi).');
    }
  }

  const { called, callNote } = options?.callAfter ? await missedCall(page, activeChatTab) : { called: false, callNote: null };

  // Close popup dialog if present to keep session clean
  const closeBtn = page.locator('[aria-label="Đóng đoạn chat" i], [aria-label="Close chat" i], [aria-label="Đóng cuộc trò chuyện" i]').first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click().catch(() => {});
  }

  return { success: true, text: body, called, callNote };
  } catch (error) {
    // API errors already carry their own flag; UI errors before Enter sent nothing.
    error.commentSubmitted ??= submitted;
    throw error;
  }
}

// Missed call (nháy máy): ring briefly then hang up so the recipient sees
// "đã bỏ lỡ cuộc gọi". Facebook opens the call in a popup window.
export async function missedCall(page, activeChatTab = null) {
  try {
    const callButtons = page.locator([
      '[aria-label="Bắt đầu cuộc gọi thoại" i]',
      '[aria-label="Start a voice call" i]',
      '[aria-label="Start an audio call" i]',
      '[aria-label="Bắt đầu gọi thoại" i]',
      '[aria-label*="cuộc gọi thoại" i]',
      '[aria-label*="audio call" i]',
      '[aria-label*="voice call" i]',
    ].join(', '));

    let callBtn = null;
    for (let i = 0; i < await callButtons.count(); i++) {
      const btn = callButtons.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        const disabled = await btn.getAttribute('aria-disabled').catch(() => null) === 'true'
          || await btn.getAttribute('disabled').catch(() => null) !== null;
        if (!disabled) {
          callBtn = btn;
          break;
        }
      }
    }

    // Check inside chat tab header dropdown if call button is not top-level
    if (!callBtn && activeChatTab && await activeChatTab.isVisible().catch(() => false)) {
      const headerBtn = activeChatTab.locator('[aria-label*="Cài đặt đoạn chat" i], [aria-label*="Chat settings" i], [role="button"]:has([aria-label*="thêm" i])').first();
      if (await headerBtn.isVisible().catch(() => false)) {
        await headerBtn.click().catch(() => {});
        await page.waitForTimeout(500);
        const menuCallBtn = page.locator([
          '[role="menuitem"]:has-text("cuộc gọi thoại")',
          '[role="menuitem"]:has-text("gọi thoại")',
          '[role="menuitem"]:has-text("voice call")',
          '[role="menuitem"]:has-text("audio call")',
        ].join(', ')).first();
        if (await menuCallBtn.isVisible().catch(() => false)) {
          callBtn = menuCallBtn;
        }
      }
    }

    if (!callBtn) return { called: false, callNote: 'Nút gọi bị ẩn hoặc chưa mở cho người lạ' };

    const popupOpened = typeof page.waitForEvent === 'function'
      ? page.waitForEvent('popup', { timeout: 5000 }).catch(() => null)
      : Promise.resolve(null);
    await callBtn.click();
    const callPage = await popupOpened || page;
    // Ring for ~4 seconds (nháy máy)
    await page.waitForTimeout(4000);

    // Exact labels only: a substring like "End" also matches "Send".
    const endButtons = callPage.locator([
      '[aria-label="Kết thúc cuộc gọi" i]',
      '[aria-label="End call" i]',
      '[aria-label="Rời khỏi cuộc gọi" i]',
      '[aria-label="Leave call" i]',
    ].join(', '));
    for (let i = 0; i < await endButtons.count(); i++) {
      const btn = endButtons.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        break;
      }
    }
    // Closing the call window hangs up even when the end button was not found.
    if (callPage !== page) await callPage.close().catch(() => {});
    return { called: true, callNote: null };
  } catch (callErr) {
    return { called: false, callNote: `Lỗi nháy máy: ${callErr.message}` };
  }
}
