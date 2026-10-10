// Only collect structural counts and known UI notices, never post text or cookies.
export function inspectScanPage() {
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  const count = selector => [...document.querySelectorAll(selector)].filter(visible).length;
  const text = (document.body?.innerText || '').slice(0, 40000);
  // A post quoting a Facebook warning is not an account restriction.
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let rateText = '', node;
  while ((node = walker.nextNode()) && rateText.length < 40000) {
    const parent = node.parentElement;
    if (parent && visible(parent) && !parent.closest('[role="article"], [data-pagelet^="FeedUnit_"], [data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"], [data-testid="post_message"], script, style')) rateText += ` ${node.textContent}`;
  }
  const notices = [
    ['RATE_LIMITED', /you['’]re temporarily blocked|you have been temporarily blocked|bạn (?:đã )?(?:tạm thời bị chặn|bị chặn tạm thời)|we limit how often|chúng tôi giới hạn tần suất|rate limit exceeded/iu],
    ['MEMBERSHIP_REQUIRED', /you must (?:join|be a member)|join this group to (?:see|view)|tham gia nhóm này để xem|chỉ thành viên (?:mới )?(?:có thể )?xem/iu],
    ['CONTENT_UNAVAILABLE', /this content isn't available right now|this content is not available|nội dung này hiện không (?:hiển thị|khả dụng)/iu],
    ['EMPTY_FEED', /no posts yet|chưa có bài viết nào/iu],
  ];
  return {
    notice: notices.find(([code, pattern]) => pattern.test(code === 'RATE_LIMITED' ? rateText : text))?.[0],
    feeds: count('[role="feed"]'), articles: count('[role="article"]'),
    links: count('a[href*="/posts/"], a[href*="/permalink/"]'),
    placeholders: count('[role="feed"] a[href^="?"], [role="feed"] a[href="#"], [role="feed"] a[href*="#?fkg"]'),
    loading: count('[role="progressbar"], [aria-busy="true"]'),
  };
}

export function emptyScanError(state, { passes = 0, snapshots = 0 } = {}) {
  const reasons = {
    MEMBERSHIP_REQUIRED: ['Facebook hiển thị yêu cầu thành viên để xem nội dung.', 'Mở nhóm bằng tài khoản Facebook của bot và kiểm tra tư cách thành viên.'],
    CONTENT_UNAVAILABLE: ['Facebook báo nội dung không khả dụng; chưa xác định do quyền truy cập hay nội dung đã bị xóa.', 'Mở đúng link bằng tài khoản Facebook của bot để kiểm tra.'],
    RATE_LIMITED: ['Facebook hiển thị thông báo giới hạn truy cập.', 'Tạm dừng quét và kiểm tra thông báo trên Facebook.'],
    EMPTY_FEED: ['Facebook hiển thị thông báo chưa có bài viết.', 'Kiểm tra lại nhóm khi có bài viết.'],
    GROUP_LINK_REJECTED: ['Đã trích xuất bài nhưng không có link nào khớp nhóm mục tiêu.', 'Kiểm tra link nhóm và chuyển hướng tên nhóm sang ID.'],
    PERMALINK_UNRESOLVED: ['Có link tạm nhưng chưa trích xuất được bài với permalink hợp lệ.', 'Mở nhóm kiểm tra link thời gian đăng bài; bộ đọc có thể cần cập nhật.'],
    POST_EXTRACTION_FAILED: ['Có link bài hiển thị nhưng bộ đọc không trích xuất được bài.', 'Kiểm tra cấu trúc bài và bộ chọn DOM của bộ đọc.'],
    FEED_LOADING: ['Trang vẫn hiển thị trạng thái đang tải khi kết thúc quét.', 'Thử lại sau hoặc tăng số lượt cuộn; kiểm tra kết nối.'],
    NO_POST_EVIDENCE: ['Chưa xác định: không thấy bài mà bộ đọc nhận diện được.', 'Mở nhóm bằng tài khoản của bot để kiểm tra nội dung đang hiển thị.'],
  };
  const code = state.notice || (snapshots ? 'GROUP_LINK_REJECTED' : state.links ? 'POST_EXTRACTION_FAILED' : state.placeholders ? 'PERMALINK_UNRESOLVED' : state.loading ? 'FEED_LOADING' : 'NO_POST_EVIDENCE');
  const [reason, action] = reasons[code];
  const error = new Error(`[${code}] ${reason}\n  Bước: trích xuất bài viết\n  Quan sát: ${passes} lượt; feed=${state.feeds}, bài DOM=${state.articles}, link bài=${state.links}, link tạm=${state.placeholders}, đang tải=${state.loading}, mẫu trích xuất=${snapshots}\n  Xử lý: ${action}\n  Kết quả: chưa đánh dấu quét thành công.`);
  error.scanDiagnostic = true;
  error.code = code;
  return error;
}
