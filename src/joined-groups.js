import { extractGroupsFromGraphQLPayload, extractPageInfo, graphQLLines } from './facebook-api.js';
import { schemaError } from './facebook-graphql.js';

// Runs on the groups page, extracting groups managed and joined.
export function extractJoinedGroups() {
  const groups = new Map();
  // Search across the document to include main feed, center cards, and left sidebar ("Nhóm do bạn quản lý")
  for (const anchor of document.querySelectorAll('a[href*="/groups/"]')) {
    let url;
    try { url = new URL(anchor.href); } catch { continue; }
    const match = url.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)\/?$/);
    if (url.protocol !== 'https:' || !/^(?:www\.|m\.|web\.)?facebook\.com$/.test(url.hostname) || !match) continue;
    const slug = match[1].toLowerCase();
    if (['joins', 'feed', 'discover', 'create', 'notifications', 'your_groups', 'user', 'member', 'search'].includes(slug)) continue;

    let name = (
      anchor.querySelector('h2, h3, strong, span[dir="auto"]')?.innerText ||
      anchor.innerText ||
      anchor.getAttribute('aria-label') ||
      anchor.querySelector('img')?.alt ||
      ''
    ).split('\n')[0].trim();
    name = name.replace(/^(?:Chưa đọc|Đã đọc|Xem nhóm|View group|Visit group)\s*/i, '').trim();
    const label = /^(?:Ảnh.*|Photo.*)$/i.test(name) ? '' : name;
    const canonical = `https://www.facebook.com/groups/${match[1]}/`;
    if (!groups.has(canonical) || (label && !groups.get(canonical).name)) {
      groups.set(canonical, { url: canonical, name: label.slice(0, 300) });
    }
  }
  return [...groups.values()];
}

export async function readJoinedGroups(page) {
  if (new URL(page.url()).pathname.replace(/\/$/,'') !== '/groups/joins') throw new Error('Facebook không mở được danh sách nhóm đã tham gia.');
  await page.locator('[role="main"] a[href*="/groups/"], main a[href*="/groups/"], a[href*="/groups/"]').first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  const groups = new Map();

  let inFlight = 0;
  const onRequest = req => {
    if (req.url().includes('/api/graphql/')) inFlight++;
  };
  const onRequestEnd = req => {
    if (req.url().includes('/api/graphql/')) inFlight = Math.max(0, inFlight - 1);
  };
  page.on('request', onRequest);
  page.on('requestfinished', onRequestEnd);
  page.on('requestfailed', onRequestEnd);

  // 1. Intercept GraphQL responses during scroll
  const onResponse = async res => {
    if (res.url().includes('/api/graphql/')) {
      try {
        const text = await res.text();
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim().replace(/^for\s*\([^)]*\);?\s*/, '');
          if (!trimmed) continue;
          try {
            const json = JSON.parse(trimmed);
            for (const g of extractGroupsFromGraphQLPayload(json)) {
              if (!groups.has(g.url) || (g.name && !groups.get(g.url).name)) {
                groups.set(g.url, g);
              }
            }
          } catch {}
        }
      } catch {}
    }
  };
  page.on('response', onResponse);

  try {
    // 2. Extract directly from initial page scripts / Relay JSON payloads
    const scriptGroups = await page.evaluate(() => {
      const list = [];
      for (const script of document.querySelectorAll('script')) {
        const text = script.textContent || '';
        if (!text || text.length > 500000) continue;
        if (!text.includes('"all_joined_groups"') && !text.includes('"admined_groups"') && !text.includes('"Group"') && !text.includes('groups/')) continue;
        try {
          const parsed = JSON.parse(text);
          if (parsed) list.push(parsed);
        } catch {
          const matches = text.matchAll(/(\{"(?:[^{}]|\{[^{}]*\})*"__typename"\s*:\s*"Group"(?:[^{}]|\{[^{}]*\})*\})/g);
          for (const m of matches) {
            try {
              const parsed = JSON.parse(m[1]);
              if (parsed) list.push(parsed);
            } catch {}
          }
        }
      }
      return list;
    }).catch(() => []);
    for (const payload of scriptGroups) {
      for (const g of extractGroupsFromGraphQLPayload(payload)) {
        groups.set(g.url, g);
      }
    }

    // Read target count from page header (e.g., "Tất cả các nhóm bạn đã tham gia (106)")
    const targetCount = await page.evaluate(() => {
      for (const el of document.querySelectorAll('h2, span, div, h1')) {
        const t = el.innerText || '';
        const m = t.match(/(?:Tất cả các nhóm|All groups|Nhóm bạn đã tham gia|Groups you've joined)[^(]*\((\d+)\)/i);
        if (m && Number(m[1]) > 0) return Number(m[1]);
      }
      return null;
    }).catch(() => null);

    // 3. Fast scroll & extraction (loads all groups reliably)
    let stagnant = 0, limited = false;
    const maxPasses = 100;
    for (let pass = 0; pass < maxPasses; pass++) {
      const before = groups.size;
      for (const group of await page.evaluate(extractJoinedGroups)) {
        const old = groups.get(group.url);
        groups.set(group.url, { ...group, name: group.name || old?.name || '' });
      }

      // If we matched the exact target count displayed by Facebook, we have 100% of all groups
      if (targetCount && groups.size >= targetCount) {
        limited = false;
        break;
      }

      if (groups.size === before && inFlight === 0) {
        stagnant++;
      } else {
        stagnant = 0;
      }

      // Only finish when no new groups arrive and no network traffic is in flight for 8 passes (~3.2s)
      if (stagnant >= 8) {
        limited = false;
        break;
      }

      if (pass === maxPasses - 1) {
        limited = true;
      }

      await page.evaluate(() => {
        window.scrollBy(0, 2500);
        window.scrollTo(0, document.body.scrollHeight);
        window.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(400);
    }
    return { groups: [...groups.values()], limited };
  } finally {
    page.off('request', onRequest);
    page.off('requestfinished', onRequestEnd);
    page.off('requestfailed', onRequestEnd);
    page.off('response', onResponse);
  }
}

// Pages through a captured joined-groups query. `baseline` is the browser count at capture time:
// a query that returns far fewer (e.g. a sidebar section) must not replace the full list.
export async function readJoinedGroupsApi(fetchText, { maxPages = 100, baseline = 0 } = {}) {
  const groups = new Map();
  let cursor = null, limited = false;
  for (let pass = 0; ; pass++) {
    if (pass >= maxPages) { limited = true; break; }
    let text;
    try { text = await fetchText(cursor); }
    catch (error) {
      if (error.code === 'SCAN_DEFERRED' && pass) { limited = true; break; }
      throw error;
    }
    const known = groups.size;
    for (const value of graphQLLines(text)) {
      for (const group of extractGroupsFromGraphQLPayload(value)) {
        if (!groups.has(group.url) || (group.name && !groups.get(group.url).name)) groups.set(group.url, group);
      }
    }
    if (!groups.size) throw schemaError('Trang GraphQL nhóm đã tham gia đầu tiên không có nhóm nào.');
    const page = extractPageInfo(text);
    if (!page.hasNextPage || !page.endCursor || page.endCursor === cursor || groups.size === known) break;
    cursor = page.endCursor;
  }
  if (!limited && groups.size < baseline / 2) throw schemaError(`GraphQL chỉ trả ${groups.size}/${baseline} nhóm đã tham gia.`);
  return { groups: [...groups.values()], limited };
}
