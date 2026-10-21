import { graphQLLines } from './facebook-api.js';
import { schemaError } from './facebook-graphql.js';

// Notifications are hints only: never treat their excerpts/timestamps as posts.
export function notificationHints(text) {
  let foundConnection = false;
  const hints = new Map();
  const readLinks = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'url' && typeof child === 'string') {
        try {
          const url = new URL(child, 'https://www.facebook.com');
          if (url.protocol !== 'https:' || !['www.facebook.com','facebook.com','m.facebook.com','web.facebook.com'].includes(url.hostname) || url.username || url.password || url.port) continue;
          const match = url.pathname.match(/^\/groups\/([\w.-]+)\/(?:posts|permalink)\/(\d+)\/?$/) ??
            [null, url.pathname.match(/^\/groups\/([\w.-]+)\/?$/)?.[1], url.searchParams.get('multi_permalinks')?.match(/^\d+/)?.[0]];
          if (match[1] && match[2]) hints.set(`${match[1].toLowerCase()}:${match[2]}`, {groupKey:match[1].toLowerCase(),postId:match[2]});
        } catch { /* Not a post permalink. */ }
      } else if (child && typeof child === 'object') readLinks(child);
    }
  };
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key,child] of Object.entries(value)) {
      if (/^notifications(?:_page|_connection)?$/.test(key) && Array.isArray(child?.edges)) {
        foundConnection = true;
        for (const edge of child.edges) readLinks(edge.node);
      } else walk(child);
    }
  };
  for (const entry of graphQLLines(text)) walk(entry.data);
  if (!foundConnection) throw schemaError('Không nhận diện được danh sách thông báo.');
  return [...hints.values()];
}
