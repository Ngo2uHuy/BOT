// Date ranges use Vietnamese calendar days, independent of the server timezone.
export function parseDay(value) {
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) throw new Error('Ngày phải có dạng DD/MM/YYYY.');
  const [, day, month, year] = match.map(Number);
  const utc = Date.UTC(year, month - 1, day);
  const date = new Date(utc);
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('Ngày không tồn tại.');
  }
  return utc - 7 * 3600000;
}

export function parseDateRange(value) {
  const parts = String(value).trim().split(/\s+/);
  if (parts.length === 1 && parts[0].toLowerCase() === 'off') return null;
  const endpoint = () => {
    const day = parseDay(parts.shift());
    if (!parts[0]?.includes(':')) return { time: day, timed: false };
    const clock = parts.shift().match(/^(\d{2}):(\d{2}):(\d{2})$/);
    if (!clock || Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3]) > 59) {
      throw new Error('Giờ phải có dạng hh:mm:ss, từ 00:00:00 đến 23:59:59 (giờ Việt Nam).');
    }
    return { time: day + (Number(clock[1])*3600 + Number(clock[2])*60 + Number(clock[3]))*1000, timed: true };
  };
  const start = endpoint().time;
  const finish = parts.length ? endpoint() : null;
  if (parts.length) throw new Error('Cú pháp: DD/MM/YYYY [hh:mm:ss] [DD/MM/YYYY [hh:mm:ss]].');
  // Exclusive bound includes the entire final second or day.
  const end = finish ? finish.time + (finish.timed ? 1000 : 86400000) : null;
  if (end !== null && end <= start) throw new Error('Ngày kết thúc phải từ ngày bắt đầu trở đi.');
  return { start, end };
}

export function matchesDateRange(post, range, now = Date.now()) {
  if (!range) return true;
  const time = post.publishedAt ? Date.parse(post.publishedAt) : NaN;
  return Number.isFinite(time) && time >= range.start && time <= now && (range.end === null || time < range.end);
}

export function formatDateRange(range) {
  if (!range) return 'không giới hạn';
  const day = time => new Date(time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  return `${day(range.start)} đến ${range.end === null ? 'mới nhất' : day(range.end - 1)}`;
}

export function formatPublishedAt(value) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) + ' (giờ Việt Nam)' : 'không rõ';
}
