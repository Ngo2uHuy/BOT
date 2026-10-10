export function mediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!['fbcdn.net', 'facebook.com', 'fbsbx.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    return url.href;
  } catch { return null; }
}

export function normalizeMedia(items = []) {
  const seen = new Set();
  return items.flatMap(item => {
    if (!['photo', 'video'].includes(item.type)) return [];
    const url = mediaUrl(item.url), preview = mediaUrl(item.preview);
    if (!url && !preview && item.type !== 'video') return [];
    const key = `${item.type}:${url || preview || 'unavailable'}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ type: item.type, url, preview }];
  }).slice(0, 10);
}
