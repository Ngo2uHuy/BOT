export function commentText(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 2000) throw new Error('Nội dung bình luận cần từ 1 đến 2000 ký tự.');
  return text;
}

// Spintax {a|b|c} is resolved per send so repeated comments are not identical; braces without | stay as typed.
export function spinText(value, random = Math.random) {
  let text = String(value ?? ''), previous;
  do {
    previous = text;
    text = text.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, options) => {
      const list = options.split('|');
      return list[Math.floor(random() * list.length)];
    });
  } while (text !== previous);
  return text.trim();
}

export function parseCommentList(value) {
  const lines = String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Danh sách bình luận trống. Nhập mỗi nội dung hoặc link trên một dòng.');
  return lines.map(commentText);
}

const EDITORS = '[role="textbox"], textarea, [contenteditable="true"]';

async function mainEditors(root) {
  const result = [];
  const boxes = root.locator(EDITORS);
  for (let i=0;i<await boxes.count();i++) {
    const box = boxes.nth(i);
    if (!await box.isVisible() || !await box.isEditable()) continue;
    if (await box.evaluate(node => {
      const names = ['aria-label','data-placeholder','placeholder'].map(key=>node.getAttribute(key) || '');
      names.push(...(node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>document.getElementById(id)?.textContent || ''));
      if (!names.some(name=>/^(?:Write (?:a |an? )?(?:public )?comment|Viết bình luận|Bình luận|Comment as)/i.test(name.trim()))) return false;
      const article = node.closest('[role="article"]');
      return !article || ![...article.querySelectorAll('a[href*="comment_id="]')].some(a=>a.closest('[role="article"]') === article);
    })) result.push(box);
  }
  return result;
}

async function permalinkScope(page) {
  // Facebook can nest main/dialog landmarks or show unrelated dialogs. Match
  // the unique comment editor first, then retain its outer scope so newly added
  // comments beside an inner main region remain visible to confirmation checks.
  const scopes = page.locator('[role="dialog"]:visible, [role="main"]:visible, main:visible');
  const candidates = [];
  for (let i=0;i<await scopes.count();i++) {
    const scope = scopes.nth(i);
    if ((await mainEditors(scope)).length === 1) candidates.push(scope);
  }
  const minimal = [];
  for (const scope of candidates) {
    let containsOther = false;
    for (const other of candidates) {
      if (scope === other) continue;
      const handle = await other.elementHandle();
      try { if (handle && await scope.evaluate((node,other)=>node !== other && other.contains(node),handle)) containsOther = true; }
      finally { await handle?.dispose(); }
    }
    if (!containsOther) minimal.push(scope);
  }
  return minimal.length === 1 ? minimal[0] : null;
}

export async function submitCommentGraphQL(page, post, text, canSubmit = () => true) {
  const session = await page.evaluate(() => {
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
    const cUser = document.cookie.match(/c_user=(\d+)/)?.[1];
    return (dtsg && cUser) ? { dtsg, cUser } : null;
  }).catch(() => null);

  if (!session) return null;

  if (!await canSubmit()) throw new Error('Đã hủy bình luận trước khi gửi.');

  const result = await page.evaluate(async ({ postId, text, dtsg, cUser }) => {
    // doc_id rotates with Facebook deploys, so a hardcoded fallback only yields
    // "document not found"; read it from the page's own Relay modules instead.
    const operation = 'useCometUFICreateCommentMutation';
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
          window.require('Bootloader').loadModules([`${operation}_facebookRelayOperation`], resolve, 'CommentBot');
        });
      } catch {}
      docId = findDocId();
    }
    if (!docId) {
      for (const s of document.scripts) {
        const txt = s.textContent || '';
        if (!txt.includes(operation)) continue;
        const m = txt.match(/"useCometUFICreateCommentMutation(?:_facebookRelayOperation)?"\s*,\s*\[\],\s*\{"id":"(\d+)"/)
          || txt.match(/"useCometUFICreateCommentMutation"[^}]+"id":"(\d+)"/);
        if (m) { docId = m[1]; break; }
      }
    }
    if (!docId) return { ok: false, error: 'Không lấy được doc_id GraphQL bình luận từ trang Facebook.' };

    let sum = 0;
    for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
    const jazoest = '2' + sum;

    const feedbackId = btoa('feedback:' + postId);
    const variables = JSON.stringify({
      displayCommentsFeedbackContext: null,
      displayCommentsContext: null,
      feedLocation: "GROUP",
      feedbackSource: 0,
      focusCommentID: null,
      includeNestedComments: false,
      input: {
        client_mutation_id: String(Date.now()),
        actor_id: cUser,
        feedback_id: feedbackId,
        message: {
          ranges: [],
          text: text
        }
      },
      inviteShortLinkKey: null,
      renderLocation: null,
      scale: 1.5,
      useDefaultActor: false,
      __relay_internal__pv__groups_comet_use_glvrelayprovider: false,
      __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: true,
      __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: "AUTO_TRANSLATE",
      __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
      __relay_internal__pv__IsWorkUserrelayprovider: false
    });

    const body = new URLSearchParams({
      av: cUser,
      __user: cUser,
      __a: '1',
      fb_dtsg: dtsg,
      jazoest: jazoest,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'useCometUFICreateCommentMutation',
      variables: variables,
      doc_id: docId
    });

    // From here on the request may have reached Facebook, so every failure is `sent`.
    try {
      const res = await fetch('/api/graphql/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const raw = await res.text();
      const entries = raw.replace(/^\s*for\s*\(;;\);?\s*/, '').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
      const data = entries.find(entry => entry.data?.comment_create) || entries[0];
      if (!res.ok) return { ok: false, sent: true, error: `HTTP ${res.status}` };
      if (!data) return { ok: false, sent: true, error: 'Phản hồi GraphQL trống.' };
      const errors = entries.flatMap(entry => entry.errors || []);
      if (errors.length) data.errors = errors;
      return { ok: true, data };
    } catch (err) {
      return { ok: false, sent: true, error: err.message };
    }
  }, { postId: post.id, text, dtsg: session.dtsg, cUser: session.cUser })
    // An evaluate aborted by navigation cannot tell whether fetch already left.
    .catch(err => ({ ok: false, sent: true, error: err?.message }));

  const unconfirmed = message => Object.assign(new Error(message), { commentSubmitted: true });
  if (!result.ok) {
    if (!result.sent) return { ok: false, error: result.error };
    throw unconfirmed(`Đã gửi bình luận qua API nhưng chưa xác nhận kết quả (${String(result.error || '').slice(0, 150)}); kiểm tra bài Facebook trước khi gửi lại.`);
  }

  const payload = result.data;
  if (payload.errors?.length) {
    const critical = payload.errors.find(e => e.severity === 'CRITICAL' || /hạn chế|bị chặn|tạm thời|đã bị gỡ|spam|blocked|restricted/i.test(e.summary || e.description || e.message || ''));
    if (critical) {
      throw new Error(`Facebook báo lỗi: ${critical.summary || critical.description || critical.message}`);
    }
  }

  const comment = payload.data?.comment_create?.comment;
  if (!comment?.id) {
    throw unconfirmed('Facebook không phản hồi kết quả bình luận hợp lệ; kiểm tra bài Facebook trước khi gửi lại.');
  }

  return comment;
}

// This adapter submits through Facebook GraphQL API when available, falling back to top-level post composer DOM.
export async function submitComment(page, post, text, canSubmit = () => true) {
  let submitted = false;
  let apiError = '';
  try {
  if (!/^[A-Za-z0-9_-]+$/.test(post.id)) throw new Error('ID bài không hợp lệ.');
  const body = commentText(text);

  // Thử gửi trực tiếp qua Facebook GraphQL API
  const apiComment = await submitCommentGraphQL(page, post, body, canSubmit).catch(err => {
    // A dispatched API comment must never be retyped in the UI: it would post twice.
    if (err.commentSubmitted) submitted = true;
    if (submitted || /Đã hủy bình luận|Facebook báo lỗi/i.test(err.message)) throw err;
    apiError = err.message;
    return null;
  });
  // {ok:false} carries the API failure reason; it is not a posted comment.
  if (apiComment?.ok === false) apiError = apiComment.error;
  else if (apiComment) return apiComment;

  const articles = page.locator('[role="article"]').filter({
    has: page.locator(`a[href*="/posts/${post.id}"], a[href*="/permalink/${post.id}"]`),
  });
  const roots = [];
  for (let i = 0; !post.kind && i < await articles.count(); i++) {
    const article = articles.nth(i);
    if (await article.isVisible() && await article.evaluate((node,id) => !node.parentElement?.closest('[role="article"]') &&
      [...node.querySelectorAll('a[href]')].some(anchor => {
        const url = new URL(anchor.href);
        return new RegExp(`/groups/[^/]+/(posts|permalink)/${id}/?$`).test(url.pathname) && !url.searchParams.has('comment_id') && !url.searchParams.has('reply_comment_id') && anchor.closest('[role="article"]') === node;
      }),post.id)) roots.push(article);
  }
  // Permalink pages can render the post inside a dialog/main without an article.
  // Use this fallback only when navigation itself identifies the exact target.
  if (roots.length !== 1) {
    const actual = new URL(page.url());
    const expected = new URL(post.url || `https://www.facebook.com/groups/unknown/posts/${post.id}`);
    const path = value => value.pathname.replace('/permalink/','/posts/').replace(/\/$/,'');
    const exact = actual.protocol === 'https:' && /^(?:www\.|m\.|web\.)?facebook\.com$/.test(actual.hostname)
      && path(actual) === path(expected) && ['id','story_fbid'].every(key => actual.searchParams.get(key) === expected.searchParams.get(key))
      && !actual.searchParams.has('comment_id') && !actual.searchParams.has('reply_comment_id');
    if (exact) {
      if (post.kind === 'reel' && !(await mainEditors(page)).length) {
        const buttons = page.locator('[role="main"], main').getByRole('button', {name:/^(?:Bình luận|Comment|Comments)(?:\s+\d.*)?$/i});
        if (await buttons.count() === 1 && await buttons.first().isVisible()) await buttons.first().click();
      }
      const until = Date.now()+10000;
      do {
        const scope = await permalinkScope(page);
        if (scope) { roots.splice(0,roots.length,scope); break; }
        await page.waitForTimeout(300);
      } while (Date.now()<until);
    }
  }
  if (roots.length !== 1) {
    const counts = await page.evaluate(() => {
      const visible = selector => [...document.querySelectorAll(selector)].filter(node=>node.getClientRects().length).length;
      return `article=${visible('[role="article"]')}, dialog=${visible('[role="dialog"]')}, main=${visible('[role="main"],main')}, editor=${visible('[contenteditable="true"],textarea,[role="textbox"]')}`;
    });
    throw new Error(`Không xác định duy nhất bài viết để bình luận (${counts}).`);
  }
  const root = roots[0];
  const editors = await mainEditors(root);
  if (editors.length !== 1) throw new Error('Không tìm thấy ô bình luận chính; bài có thể đã khóa bình luận.');
  const editor = editors[0];
  const before = await root.evaluate((node,text) => [...node.querySelectorAll('[role="article"]')]
    .filter(comment => comment.innerText.includes(text) && comment.querySelector('a[href*="comment_id="]') && !comment.querySelector('[contenteditable="true"]')).length,text);
  await editor.fill(commentText(text));
  if (!await canSubmit()) throw new Error('Đã hủy bình luận trước khi gửi.');
  // After this point any error is ambiguous: callers must never retry automatically.
  submitted = true;
  await editor.press('Enter');
  const until = Date.now()+10000;
  let retyped = false;
  do {
    const count = await root.evaluate((node,text) => [...node.querySelectorAll('[role="article"]')]
      .filter(comment => comment.innerText.includes(text) && comment.querySelector('a[href*="comment_id="]') && !comment.querySelector('[contenteditable="true"]')).length,text);
    if (count > before) return;
    if (!retyped && Date.now() > until - 7000) {
      retyped = true;
      await editor.focus().catch(() => {});
      await editor.press('Enter').catch(() => {});
    }
    await page.waitForTimeout(250);
  } while (Date.now()<until);
  throw new Error('Đã thao tác gửi nhưng chưa thấy link bình luận mới; cần kiểm tra bài Facebook.');
  } catch(error) {
    if (apiError && !submitted && !/Đã hủy bình luận|Facebook báo lỗi/i.test(error.message)) {
      error.message += ` [API: ${String(apiError).slice(0, 150)}]`;
    }
    error.commentSubmitted = submitted;
    throw error;
  }
}
