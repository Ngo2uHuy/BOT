const FACEBOOK_HOSTS = new Set([
  "facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com",
]);

/** Accept group home pages only. Never pass untrusted URLs to the browser. */
export function normalizeGroupUrl(input) {
  if (typeof input !== "string") throw new TypeError("Link nhóm phải là chuỗi.");
  const value = input.trim();
  if (!value || /[\s\\\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Link nhóm không hợp lệ.");
  }
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  const authority = candidate.match(/^https?:\/\/([^/?#]+)/i)?.[1];
  // Check the raw authority too: URL() normalizes away explicit default ports.
  if (!authority || authority.includes("@") || authority.includes(":")) {
    throw new Error("Chỉ nhận link nhóm Facebook không có tài khoản hoặc cổng.");
  }
  const url = new URL(candidate);
  if (!FACEBOOK_HOSTS.has(authority.toLowerCase()) || !FACEBOOK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Tên miền Facebook không hợp lệ.");
  }
  const rawPath = candidate.slice(candidate.indexOf(authority) + authority.length).split(/[?#]/, 1)[0];
  // Validate before URL() can resolve dot segments or encoded path characters.
  const match = rawPath.match(/^\/groups\/([a-z\d][a-z\d._-]{0,199})\/?$/i);
  if (!match || match[1] === "." || match[1] === "..") {
    throw new Error("Hãy gửi link trang nhóm, không gửi link bài viết.");
  }
  for (const key of url.searchParams.keys()) {
    if (/^(multi_permalinks|post_id|story_fbid|permalink|permalink_id)$/i.test(key)) {
      throw new Error("Hãy gửi link trang nhóm, không gửi link bài viết.");
    }
  }
  return `https://www.facebook.com/groups/${match[1]}/`;
}

/** Extract links from UTF-8 text or CSV; ordinary column names are ignored. */
export function parseGroupInput(text) {
  const urls = new Set();
  const invalid = new Set();
  for (const token of String(text ?? "").replace(/^\uFEFF/, "").split(/[\s,;<>"'`]+/u)) {
    const candidate = token.replace(/^[([{]+/, "").replace(/[)\]}]+$/, "");
    if (!/^(?:[a-z][a-z\d+.-]*:\/\/|https?:|(?:www\.|m\.|web\.)?facebook\.com)/i.test(candidate)) continue;
    try {
      urls.add(normalizeGroupUrl(candidate));
    } catch {
      invalid.add(candidate);
    }
  }
  return { urls: [...urls], invalid: [...invalid] };
}

export function normalizeSearchText(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d").toLocaleLowerCase("vi");
}

/** An empty filter means all posts; otherwise any keyword can match. */
export function matchesKeywords(text, keywords = []) {
  const normalized = normalizeSearchText(text);
  const terms = (keywords ?? []).map((value) => normalizeSearchText(value).trim()).filter(Boolean);
  return terms.length === 0 || terms.some((term) => normalized.includes(term));
}

export function parseKeywords(text) {
  const value = String(text ?? "").trim();
  if (!value || value.toLowerCase() === "off") return [];
  const seen = new Set();
  return value.split(/[;\n]+/).map((term) => term.trim()).filter((term) => {
    const key = normalizeSearchText(term);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
