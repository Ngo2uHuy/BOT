import { normalizeAuthorUrl } from './facebook.js';

// Bóc tách dữ liệu bài viết và nhóm trực tiếp từ Facebook GraphQL API / Relay Modern Payloads

export function extractPostsFromGraphQLPayload(payload, targetGroupUrl = null) {
  const posts = new Map();

  function walk(node) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    // Check if this object is a Story / FeedUnit / Post node
    const creationTime = node.creation_time || node.story?.creation_time
      || node.comet_sections?.content?.story?.creation_time
      || node.comet_sections?.context_layout?.story?.comet_sections?.metadata?.find?.(m => m.story?.creation_time)?.story?.creation_time;

    const postId = node.post_id || node.legacy_fbid
      || node.story?.post_id || node.story?.legacy_fbid
      || (node.id && /^\d{8,25}$/.test(node.id) ? node.id : null);

    const validTime = creationTime && !isNaN(Number(creationTime)) && Number(creationTime) > 0;
    if (postId && validTime) {
      // Find clean text without HTML or "See more" truncation
      let text = '';
      if (typeof node.message?.text === 'string') {
        text = node.message.text;
      } else if (typeof node.story?.message?.text === 'string') {
        text = node.story.message.text;
      } else if (typeof node.comet_sections?.content?.story?.message?.text === 'string') {
        text = node.comet_sections.content.story.message.text;
      } else if (typeof node.comet_sections?.content?.story?.comet_sections?.message?.story?.message?.text === 'string') {
        text = node.comet_sections.content.story.comet_sections.message.story.message.text;
      }

      // Find author information
      let author = null;
      let authorUrl = null;
      const actors = node.actors || node.story?.actors || node.comet_sections?.content?.story?.actors;
      if (Array.isArray(actors) && actors.length > 0) {
        author = actors[0].name || null;
        // Prefer the numeric ID: DOM snapshots yield profile.php?id=..., and one
        // author stored under two URLs escapes the per-recipient dedupe.
        authorUrl = /^\d+$/.test(String(actors[0].id || '')) ? `https://www.facebook.com/profile.php?id=${actors[0].id}` : normalizeAuthorUrl(actors[0].url);
      }

      // Find target group URL
      let groupUrl = targetGroupUrl;
      const toGroup = node.to || node.story?.to;
      if (toGroup?.url) {
        try {
          const parsed = new URL(toGroup.url, 'https://www.facebook.com');
          groupUrl = `https://www.facebook.com${parsed.pathname.replace(/\/$/, '')}`;
        } catch {
          groupUrl = toGroup.url.replace(/[?#].*$/, '').replace(/\/$/, '');
        }
      } else if (groupUrl) {
        groupUrl = groupUrl.replace(/[?#].*$/, '').replace(/\/$/, '');
      }

      // Find media attachments (photos, videos, albums)
      const media = [];
      const attachments = node.attachments || node.story?.attachments || node.comet_sections?.content?.story?.attachments || [];
      const allAtts = [];
      if (Array.isArray(attachments)) {
        for (const att of attachments) {
          allAtts.push(att);
          const sub = att.subattachments?.nodes || att.all_subattachments?.nodes || att.subattachments;
          if (Array.isArray(sub)) {
            for (const s of sub) allAtts.push(s);
          }
        }
      }

      for (const att of allAtts) {
        const mediaItem = att.media || att.target?.media;
        if (mediaItem) {
          if (mediaItem.__typename === 'Video' || mediaItem.playable_url) {
            media.push({
              type: 'video',
              url: mediaItem.playable_url || mediaItem.playable_url_quality_hd || mediaItem.url,
              preview: mediaItem.preferred_thumbnail?.image?.uri || null
            });
          } else if (mediaItem.image?.uri || mediaItem.photo_image?.uri) {
            media.push({
              type: 'photo',
              url: mediaItem.image?.uri || mediaItem.photo_image?.uri
            });
          }
        }
      }

      let publishedAt = null;
      try {
        publishedAt = new Date(Number(creationTime) * 1000).toISOString();
      } catch {}

      const idStr = String(postId);
      const existing = posts.get(idStr);
      if (!existing || text.length >= existing.text.length) {
        posts.set(idStr, {
          id: idStr,
          url: groupUrl ? `${groupUrl}/posts/${idStr}` : `https://www.facebook.com/${idStr}`,
          text: text.slice(0, 30000),
          author: author?.trim() || null,
          authorUrl: authorUrl || null,
          publishedAt,
          media
        });
      } else if (!existing.publishedAt && publishedAt) {
        existing.publishedAt = publishedAt;
      }
    }

    // Recursively walk properties
    for (const key of Object.keys(node)) {
      if (key !== 'feedback') {
        walk(node[key]);
      }
    }
  }

  walk(payload);
  return Array.from(posts.values());
}

export function parseGraphQLStream(chunkText, targetGroupUrl = null) {
  const posts = [];
  const lines = String(chunkText || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const cleaned = trimmed.replace(/^for\s*\([^)]*\);?\s*/, '');
      const json = JSON.parse(cleaned);
      posts.push(...extractPostsFromGraphQLPayload(json, targetGroupUrl));
    } catch {}
  }
  return posts;
}

export function extractPostsFromPageScripts(scripts, groupUrl = null) {
  const allPosts = new Map();
  const list = Array.isArray(scripts) ? scripts : [scripts];

  for (const script of list) {
    if (!script || typeof script !== 'string') continue;
    if (!script.includes('creation_time') && !script.includes('post_id') && !script.includes('legacy_fbid')) continue;

    // Check application/json scripts or raw JSON
    try {
      const parsed = JSON.parse(script);
      for (const p of extractPostsFromGraphQLPayload(parsed, groupUrl)) {
        allPosts.set(p.id, p);
      }
      continue;
    } catch {}

    // Check for BigPipe/ScheduledServerJS embedded JSON blobs
    const jsonMatches = script.matchAll(/(\{(?:[^{}]|\{[^{}]*\})*"creation_time"\s*:\s*\d+(?:[^{}]|\{[^{}]*\})*\})/g);
    for (const m of jsonMatches) {
      try {
        const parsed = JSON.parse(m[1]);
        for (const p of extractPostsFromGraphQLPayload(parsed, groupUrl)) {
          allPosts.set(p.id, p);
        }
      } catch {}
    }
  }

  return Array.from(allPosts.values());
}

export function extractGroupsFromGraphQLPayload(payload) {
  const groups = new Map();

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    // Skip non-group entities like User, Actor, Page, Event, Story, etc.
    if (node.__typename && !['Group', 'GroupItem', 'GroupRule'].includes(node.__typename)) {
      for (const key of Object.keys(node)) walk(node[key]);
      return;
    }

    const isGroupType = node.__typename === 'Group';
    const hasGroupUrl = typeof node.url === 'string' && /\/groups\/[A-Za-z0-9._-]+\/?/.test(node.url);
    const hasUrlSlug = typeof node.url_slug === 'string' && /^[A-Za-z0-9._-]+$/.test(node.url_slug);

    if ((isGroupType || hasGroupUrl || hasUrlSlug) && node.id && node.name) {
      let groupId = null;
      if (hasGroupUrl) {
        try {
          const parsed = new URL(node.url, 'https://www.facebook.com');
          const m = parsed.pathname.match(/^\/groups\/([A-Za-z0-9._-]+)\/?$/);
          if (m && !['feed', 'discover', 'joins', 'notifications', 'create', 'user', 'member', 'your_groups'].includes(m[1].toLowerCase())) {
            groupId = m[1];
          }
        } catch {}
      }
      if (!groupId && hasUrlSlug && !['feed', 'discover', 'joins', 'notifications', 'create', 'user', 'member', 'your_groups'].includes(node.url_slug.toLowerCase())) {
        groupId = node.url_slug;
      }
      if (!groupId && isGroupType && /^[A-Za-z0-9._-]+$/.test(String(node.id))) {
        groupId = String(node.id);
      }

      if (groupId) {
        const canonicalUrl = `https://www.facebook.com/groups/${groupId}/`;
        if (typeof node.name === 'string' && node.name.trim()) {
          // Slug groups need this ID for the GraphQL feed; HTTP-only mode cannot learn it from a page visit.
          const numericId = isGroupType && /^\d{5,25}$/.test(String(node.id)) ? String(node.id) : null;
          groups.set(canonicalUrl, {
            url: canonicalUrl,
            name: node.name.trim().slice(0, 300),
            ...(numericId ? { numericId } : {})
          });
        }
      }
    }

    for (const key of Object.keys(node)) {
      walk(node[key]);
    }
  }

  walk(payload);
  return Array.from(groups.values());
}

function graphQLLines(chunkText) {
  const values = [];
  for (const line of String(chunkText || '').split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^for\s*\([^)]*\);?\s*/, '');
    if (!trimmed) continue;
    try { values.push(JSON.parse(trimmed)); } catch {}
  }
  return values;
}

// Relay streams the feed: page_info usually arrives in a separate $defer chunk,
// so fall back to the last edge cursor when it is missing.
export function extractPageInfo(chunkText) {
  let pageInfo = null, edgeCursor = null;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node.page_info && typeof node.page_info === 'object' && 'end_cursor' in node.page_info) pageInfo = node.page_info;
    if (typeof node.cursor === 'string' && node.cursor && node.node) edgeCursor = node.cursor;
    for (const key of Object.keys(node)) if (key !== 'feedback') walk(node[key]);
  }
  for (const value of graphQLLines(chunkText)) walk(value);
  const endCursor = (typeof pageInfo?.end_cursor === 'string' && pageInfo.end_cursor) || edgeCursor;
  return { endCursor: endCursor || null, hasNextPage: pageInfo && typeof pageInfo.has_next_page === 'boolean' ? pageInfo.has_next_page && Boolean(endCursor) : Boolean(endCursor) };
}

export { graphQLLines };
