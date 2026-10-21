// Affiliate Desk renderer. Plain JS, no build step. Strict CSP: no inline handlers or styles,
// so all interaction goes through data-action / data-form / data-change attributes (see "Events").

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
// Every dynamic value that ends up inside HTML must pass through here.
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  flame: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 .3l3-3a5 5 0 0 0-7-7l-2 2m3 6a5 5 0 0 0-7-.3l-3 3a5 5 0 0 0 7 7l2-2"/>',
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings: '<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  code: '<path d="m7 7-5 5 5 5m10-10 5 5-5 5M14 4l-4 16"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  external: '<path d="M15 3h6v6m0-6L10 14M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/>',
  filter: '<path d="M4 4h16l-6 8v7l-4 2v-9z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  shield: '<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z"/><path d="m8 12 3 3 5-6"/>',
};

const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.grid}</svg>`;

// {a:1,b:'x'} -> ' data-a="1" data-b="x"'
const dataAttrs = data => Object.entries(data || {}).map(([key, value]) => ` data-${key}="${escape(value)}"`).join('');

const formatDateTime = value => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('vi-VN', {hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'});
};
const formatClock = value => new Date(value).toLocaleTimeString('vi-VN', {hour12: false});
const formatNumber = value => new Intl.NumberFormat('vi-VN').format(Number(value || 0));

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} giây`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} phút ${seconds % 60} giây` : `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} giờ ${minutes % 60} phút` : `${hours} giờ`;
}

/* ========================================================================== */
/* State store                                                                 */
/* ========================================================================== */

const state = {
  page: 'dashboard',
  data: null,            // last bootstrap response
  ownerId: null,
  renderToken: 0,        // guards async page fills against stale navigation
  health: null,
  hot: null,
  logs: [],
  logFilter: {level: 'all', search: '', category: 'all', paused: false},
  sourceTab: 'group',
  postTab: 'accepted',
  lists: {},             // per list: page, pageSize, q, filters, sort, dir (kept across tabs and refreshes)
  selectedPosts: new Set(),
  queueTab: 'comments',
  provider: 'tiktok',
  selectedLinks: new Set(),
  console: [],
  replyTo: null,
};

const LOG_LIMIT = 1000;
const CONSOLE_LIMIT = 80;

const rpc = (method, args = {}) => {
  if (!window.desktop?.call) {
    return Promise.reject(new Error('Hãy chạy giao diện bằng ứng dụng Affiliate Desk để kết nối dữ liệu trên máy.'));
  }
  // Electron wraps worker errors as "Error invoking remote method '…': Error: <message>".
  return window.desktop.call(method, args).catch(error => {
    throw new Error(String(error?.message || error).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ''));
  });
};

const settingValue = key => state.data?.settings?.values?.[key];
const sources = () => state.data?.sources || [];
const findSource = id => sources().find(source => source.id === Number(id));

function resetOwnerScope() {
  state.selectedPosts.clear();
  state.selectedLinks.clear();
  state.console = [];
  state.replyTo = null;
  state.lists = {};
  state.postTab = 'accepted';
  state.health = null;
  state.hot = null;
}

/* ========================================================================== */
/* UI building blocks                                                          */
/* ========================================================================== */

function button({label = '', action = '', iconName = '', kind = '', size = '', data = {}, type = 'button', title = '', disabled = false} = {}) {
  const classes = ['btn', kind && `btn-${kind}`, size && `btn-${size}`].filter(Boolean).join(' ');
  const actionAttr = action ? ` data-action="${escape(action)}"` : '';
  const titleAttr = title ? ` title="${escape(title)}" aria-label="${escape(title)}"` : '';
  return `<button type="${type}" class="${classes}"${disabled ? ' disabled' : ''}${actionAttr}${dataAttrs(data)}${titleAttr}>${iconName ? icon(iconName) : ''}${label ? `<span>${escape(label)}</span>` : ''}</button>`;
}

const badge = (label, tone = 'neutral') => `<span class="badge badge-${tone}">${escape(label)}</span>`;

const loadingBlock = (text = 'Đang tải dữ liệu…') => `<div class="loading"><div class="spinner"></div><p>${escape(text)}</p></div>`;

function emptyState(title, description, actionHtml = '') {
  return `<div class="empty"><h3>${escape(title)}</h3><p>${escape(description)}</p>${actionHtml}</div>`;
}

const infoStrip = (text, tone = 'info') => `<div class="strip strip-${tone}">${icon('info')}<div>${escape(text)}</div></div>`;

function pageHeader(title, description, actionsHtml = '') {
  return `<div class="page-head"><div><h2>${escape(title)}</h2><p>${escape(description)}</p></div><div class="page-actions">${actionsHtml}</div></div>`;
}

// `title` is trusted markup from callers (they escape), `aside` is trusted markup too.
function card(title, bodyHtml, {aside = '', description = '', id = ''} = {}) {
  return `<section class="card"${id ? ` id="${escape(id)}"` : ''}><div class="card-head"><div><h3>${title}</h3>${description ? `<p>${escape(description)}</p>` : ''}</div>${aside}</div>${bodyHtml}</section>`;
}

function field({label, name, value = '', placeholder = '', type = 'text', help = '', attrs = ''}) {
  return `<label class="field"><span>${escape(label)}</span><input name="${escape(name)}" type="${escape(type)}" value="${escape(value)}" placeholder="${escape(placeholder)}" autocomplete="off" ${attrs}>${help ? `<small>${escape(help)}</small>` : ''}</label>`;
}

function textarea({label, name, value = '', placeholder = '', help = '', required = false, rows = 5}) {
  return `<label class="field"><span>${escape(label)}</span><textarea name="${escape(name)}" rows="${rows}" placeholder="${escape(placeholder)}" ${required ? 'required' : ''}>${escape(value)}</textarea>${help ? `<small>${escape(help)}</small>` : ''}</label>`;
}

function selectField({label, name, options, value = '', help = ''}) {
  const items = options.map(([optionValue, optionLabel]) => `<option value="${escape(optionValue)}" ${String(optionValue) === String(value) ? 'selected' : ''}>${escape(optionLabel)}</option>`).join('');
  return `<label class="field"><span>${escape(label)}</span><select name="${escape(name)}">${items}</select>${help ? `<small>${escape(help)}</small>` : ''}</label>`;
}

function checkbox({label, name, checked = false, attrs = ''}) {
  return `<label class="check"><input type="checkbox" name="${escape(name)}" ${checked ? 'checked' : ''} ${attrs}><span>${escape(label)}</span></label>`;
}

function sourceOptions({withAll = false, selected = null} = {}) {
  const all = withAll ? `<option value="all">Tất cả nguồn</option>` : '';
  const items = sources().map(source => `<option value="${source.id}" ${String(selected) === String(source.id) ? 'selected' : ''}>#${source.id} · ${escape(source.label || source.url)}</option>`).join('');
  return all + items;
}

function tabs(items, active, action, key) {
  return `<div class="tabs" role="tablist">${items.map(([id, label, count]) =>
    `<button type="button" role="tab" class="tab ${id === active ? 'active' : ''}" data-action="${action}" data-${key}="${escape(id)}">${escape(label)}${count !== undefined ? `<span class="tab-count">${formatNumber(count)}</span>` : ''}</button>`).join('')}</div>`;
}

/* ----- Paged lists: search, filters, sort, page size and pager ----------- */

const QUEUE_FILTER = [['pending', 'Đang chờ'], ['sending', 'Đang gửi'], ['sent', 'Đã gửi'], ['failed', 'Thất bại'], ['uncertain', 'Cần kiểm tra'], ['cancelled', 'Đã hủy']];
const BLOCK_FILTER = [['pending', 'Đang chờ'], ['running', 'Đang chạy'], ['interrupted', 'Gián đoạn'], ['done', 'Hoàn tất'], ['failed', 'Thất bại'], ['stopped', 'Đã dừng']];
const MODE_FILTER = [['manual', 'Thủ công'], ['auto', 'Tự động']];
const SOURCE_TYPES = [['group', 'Nhóm'], ['profile', 'Trang cá nhân']];
const queueList = (search, modes = MODE_FILTER, sorts = []) => ({sort: 'id', dir: 'desc', size: 20, search,
  filters: [['state', 'Trạng thái', QUEUE_FILTER], ['source', 'Nguồn', 'sources'], ['mode', 'Cách tạo', modes]],
  sorts: [['id', 'Mới tạo'], ['time', 'Thời gian'], ['state', 'Trạng thái'], ['source', 'Nguồn'], ...sorts]});
const POST_LIST = {sort: 'seen', dir: 'desc', size: 20, search: 'Tìm nội dung, tác giả, link, ID bài, nguồn…',
  filters: [['source', 'Nguồn', 'sources'], ['kind', 'Loại bài', [['post', 'Bài viết'], ['reel', 'Reel']]], ['type', 'Loại nguồn', SOURCE_TYPES], ['hidden', 'Bài ẩn', [['yes', 'Chỉ bài đã ẩn']], 'Bài đang hiện']],
  sorts: [['seen', 'Thời gian lưu'], ['published', 'Ngày đăng'], ['author', 'Tác giả'], ['source', 'Nguồn']]};
// Mirrors LISTS in src/listing.js; the service rejects any other filter, sort key or direction.
const LISTS = {
  comments: queueList('Tìm nội dung, ID bài, nguồn, lỗi…', [...MODE_FILTER, ['tiktok', 'TikTok tự động']]),
  inboxes: queueList('Tìm nội dung, người nhận, ID bài, lỗi…', MODE_FILTER, [['name', 'Người nhận']]),
  friends: queueList('Tìm người nhận, link, ID bài, lỗi…', MODE_FILTER, [['name', 'Người nhận']]),
  blocks: {sort: 'id', dir: 'desc', size: 20, search: 'Tìm link/ID bài, nguồn, lỗi…',
    filters: [['state', 'Trạng thái', BLOCK_FILTER], ['source', 'Nguồn', 'sources'], ['mode', 'Cách tạo', MODE_FILTER]],
    sorts: [['id', 'Mới tạo'], ['time', 'Hẹn lúc'], ['state', 'Trạng thái'], ['source', 'Nguồn']]},
  posts: POST_LIST,
  rejected: {...POST_LIST, search: 'Tìm nội dung, tác giả, lý do loại…'},
  links: {sort: 'updated', dir: 'desc', size: 10, search: 'Tìm link gốc, link affiliate, ID…', filters: [],
    sorts: [['updated', 'Cập nhật'], ['id', 'ID link'], ['origin', 'Link gốc']]},
  sources: {sort: 'id', dir: 'asc', size: 20, search: 'Tìm tên, URL hoặc ID nguồn…',
    filters: [['status', 'Trạng thái', [['active', 'Đang theo dõi'], ['paused', 'Tạm dừng'], ['error', 'Cần kiểm tra']]], ['auto', 'Tự động', [['on', 'Có tự động'], ['off', 'Không tự động']]]],
    sorts: [['id', 'ID'], ['name', 'Tên'], ['scan', 'Quét gần nhất'], ['interval', 'Chu kỳ quét']]},
  hot: {sort: 'rank', dir: 'asc', size: 20, search: 'Lọc tên, link, ID nguồn…',
    filters: [['type', 'Loại nguồn', SOURCE_TYPES], ['status', 'Lỗi quét', [['ok', 'Không lỗi'], ['error', 'Đang lỗi']]]],
    sorts: [['rank', 'Hạng'], ['total', 'Tổng bài'], ['missed', 'Feed bỏ sót'], ['interval', 'Chu kỳ quét'], ['scan', 'Quét gần nhất'], ['name', 'Tên']]},
  // Paged in the renderer: the log buffer (page 1 = newest) and the source list of the configuration dialog.
  logs: {sort: 'time', dir: 'desc', size: 100, search: '', filters: [], sorts: []},
  config: {sort: 'id', dir: 'asc', size: 20, search: 'Tìm tên, URL hoặc ID nguồn…', filters: [], sorts: []},
  joined: {sort: 'order', dir: 'asc', size: 15, search: 'Tìm tên, link, ID nhóm…', filters: [['status', 'Trạng thái', [['new', 'Chưa thêm'], ['added', 'Đã thêm']]]],
    sorts: [['order', 'Thứ tự Facebook'], ['name', 'Tên']]},
};
const listState = kind => state.lists[kind] ||= {page: 1, pageSize: LISTS[kind].size, q: '', filters: {}, sort: LISTS[kind].sort, dir: LISTS[kind].dir};
const listFiltered = kind => Boolean(listState(kind).q.trim() || Object.keys(listState(kind).filters).length);
function listArgs(kind, filters = {}) {
  const {page, pageSize, q, sort, dir} = listState(kind);
  return {ownerId: state.ownerId, page, pageSize, q, filters: {...listState(kind).filters, ...filters}, sort, dir};
}
// Same idea as the backend search: case and Vietnamese accents are ignored.
const foldText = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
// Pages an in-memory array the way the backend does (a page past the end shows the last page).
function pageArray(kind, items) {
  const current = listState(kind), pages = Math.max(1, Math.ceil(items.length / current.pageSize));
  current.page = Math.min(current.page, pages);
  const start = (current.page - 1) * current.pageSize;
  return {items: items.slice(start, start + current.pageSize), total: items.length, page: current.page, pages};
}
const noMatch = () => emptyState('Không có mục phù hợp', 'Thử đổi bộ lọc hoặc từ khóa tìm kiếm.');

function listToolbar(kind) {
  const spec = LISTS[kind], current = listState(kind);
  const select = (field, label, options, value) => `<select class="select" data-change="list-field" data-list="${kind}" data-field="${field}" aria-label="${escape(label)}">${options.map(([optionValue, optionLabel]) =>
    `<option value="${escape(optionValue)}" ${String(optionValue) === String(value ?? '') ? 'selected' : ''}>${escape(optionLabel)}</option>`).join('')}</select>`;
  // A filter's optional 4th item names its unfiltered choice (hidden posts: the visible ones).
  const filters = spec.filters.map(([name, label, options, all]) => select(`filter:${name}`, label,
    [['', all || `${label}: tất cả`], ...(options === 'sources' ? sources().map(source => [source.id, `#${source.id} · ${source.label || source.url}`]) : options)], current.filters[name]));
  const sizes = [...new Set([spec.size, 10, 20, 50, 100])].sort((a, b) => a - b);
  return `<div class="toolbar list-toolbar">
    <label class="search">${icon('search')}<input data-input="list-search" data-list="${kind}" value="${escape(current.q)}" placeholder="${escape(spec.search)}" aria-label="Tìm kiếm" maxlength="200"></label>
    <div class="row">${filters.join('')}${spec.sorts.length ? select('sort', 'Sắp xếp', spec.sorts.map(([value, label]) => [value, `Sắp xếp: ${label}`]), current.sort) + select('dir', 'Chiều sắp xếp', [['desc', 'Giảm dần'], ['asc', 'Tăng dần']], current.dir) : ''}${select('pageSize', 'Số dòng mỗi trang', sizes.map(size => [size, `${size} / trang`]), current.pageSize)}</div>
  </div>`;
}

function listPager(kind, result) {
  const page = result.page || 1, pages = result.pages || 1;
  const go = (label, target, disabled, active = false) => button({label, action: 'list-page', size: 'sm', kind: active ? 'primary' : '', disabled, data: {list: kind, page: target}});
  const numbers = [];
  for (let number = Math.max(1, page - 2); number <= Math.min(pages, page + 2); number++) numbers.push(go(String(number), number, false, number === page));
  return `<div class="pagination"><span>Trang ${formatNumber(page)}/${formatNumber(pages)} · tổng ${formatNumber(result.total)}</span><div class="row">${go('Đầu', 1, page <= 1)}${go('Trước', page - 1, page <= 1)}${numbers.join('')}${go('Sau', page + 1, page >= pages)}${go('Cuối', pages, page >= pages)}</div></div>`;
}

// The newest request for a container wins, so a slow older response cannot overwrite a newer filter.
const listLoads = {};
async function loadList(selector, token, task, errorTitle) {
  const mine = listLoads[selector] = (listLoads[selector] || 0) + 1;
  let html;
  try { html = await task(); } catch (error) { html = emptyState(errorTitle, error.message); }
  return mine === listLoads[selector] && fillIfCurrent(token, selector, html);
}

/* ----- Removing one row ------------------------------------------------------ */

// Mirrors REMOVABLE/REMOVE_NOTES in src/listing.js; the service (store.removeListItem) applies the rules.
const SENT_NOTE = 'Đang chờ: hủy và xóa khỏi hàng đợi. Đã gửi/chưa xác nhận: chỉ ẩn khỏi danh sách (giữ lại để chống gửi lặp), không gỡ được trên Facebook. Đang gửi: chưa xóa được.';
const HIDE_NOTE = 'Chỉ ẩn khỏi danh sách: ứng dụng vẫn nhớ bài nên không thông báo, bình luận hay nhắn tin tự động lại. Xem lại bằng bộ lọc "Chỉ bài đã ẩn".';
const REMOVE = {
  comments: ['bình luận', SENT_NOTE], inboxes: ['tin nhắn riêng', SENT_NOTE], friends: ['lời mời kết bạn', SENT_NOTE],
  blocks: ['lượt chặn người comment', 'Xóa lượt chặn; người đã chặn không bị bỏ chặn. Lượt đang chạy sẽ dừng trước người kế tiếp. Nguồn đang bật tự chặn có thể tạo lại lượt chặn cho bài còn mới khi quét lại.'],
  posts: ['bài viết', HIDE_NOTE], rejected: ['bài bị loại', HIDE_NOTE],
  links: ['link affiliate', 'Xóa link khỏi thư viện. Bình luận đã xếp hàng/đã đăng giữ nguyên nội dung link.'],
};
// Posts are keyed "source:post"; with the hidden filter on, a post gets "Bỏ ẩn" instead.
function removeButton(list, id, label = `#${id}`) {
  const hide = list === 'posts' || list === 'rejected';
  if (hide && listState(list).filters.hidden) return button({label: 'Bỏ ẩn', action: 'row-restore', iconName: 'refresh', size: 'sm', data: {list, id}});
  return button({label: hide ? 'Ẩn' : '', action: 'row-remove', iconName: 'trash', size: 'sm', kind: hide ? '' : 'ghost', title: hide ? '' : 'Xóa', data: {list, id, label}});
}

/* ----- Toasts and modal ----------------------------------------------------- */

function toast(message, isError = false) {
  const node = document.createElement('div');
  node.className = `toast ${isError ? 'toast-error' : 'toast-ok'}`;
  node.innerHTML = `${icon(isError ? 'info' : 'check')}<span>${escape(message)}</span>`;
  $('#toasts').append(node);
  setTimeout(() => node.remove(), isError ? 10000 : 5000);
}

function openModal({title, description = '', body = '', footer = '', wide = false}) {
  $('#modal-content').innerHTML = `
    <div class="modal-head">
      <div><h3>${escape(title)}</h3>${description ? `<p>${escape(description)}</p>` : ''}</div>
      ${button({action: 'close-modal', iconName: 'close', kind: 'ghost', title: 'Đóng'})}
    </div>
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ''}`;
  $('#modal').classList.toggle('modal-wide', wide);
  if (!$('#modal').open) $('#modal').showModal();
}

const closeModal = () => { if ($('#modal').open) $('#modal').close(); };

function openConfirm({title, description = '', text, confirmLabel, confirmAction, data = {}}) {
  openModal({
    title,
    description,
    body: `<p class="muted-text">${escape(text)}</p>`,
    footer: button({label: 'Giữ lại', action: 'close-modal'}) + button({label: confirmLabel, action: confirmAction, kind: 'danger', data}),
  });
}

/* ========================================================================== */
/* Bot command bridge (local Telegram bot replies)                             */
/* ========================================================================== */

function renderBotMessage(message) {
  const rows = message.buttons?.inline_keyboard || message.buttons || [];
  const keyboard = Array.isArray(rows) ? rows.flat() : [];
  const buttons = keyboard.map(item => {
    if (item.copy_text) return button({label: item.text, action: 'copy-phone', iconName: 'copy', size: 'sm', data: {phone: item.copy_text.text}});
    if (item.callback_data) {
      return button({label: item.text, action: 'message-callback', size: 'sm', data: {callback: item.callback_data, message: message.messageId}});
    }
    if (item.url) return button({label: item.text, action: 'open-external', iconName: 'external', size: 'sm', data: {url: item.url}});
    return '';
  }).join('');
  const reply = message.forceReply
    ? button({label: 'Trả lời yêu cầu này', action: 'reply-message', iconName: 'message', size: 'sm', kind: 'primary', data: {message: message.messageId}})
    : '';
  return `<div class="bot-message"><div class="bot-text">${escape(message.text || '')}</div>${buttons || reply ? `<div class="bot-buttons">${buttons}${reply}</div>` : ''}</div>`;
}

function showResult(messages, title = 'Kết quả thao tác') {
  const body = messages.length
    ? messages.map(renderBotMessage).join('')
    : '<p class="muted-text">Đã xử lý yêu cầu.</p>';
  openModal({title, description: 'Phản hồi từ hệ thống', body, footer: button({label: 'Đóng', action: 'close-modal', kind: 'primary'}), wide: true});
}

function pushConsole(entry) {
  state.console.push(entry);
  if (state.console.length > CONSOLE_LIMIT) state.console.splice(0, state.console.length - CONSOLE_LIMIT);
  if (state.page === 'console') updateConsoleOutput();
}

async function execute(text, {show = true, refresh = true, replyToMessageId} = {}) {
  pushConsole({command: text});
  const response = await rpc('command', {ownerId: state.ownerId, text, ...(replyToMessageId ? {replyToMessageId} : {})});
  const messages = response.messages || [];
  pushConsole({messages});
  if (refresh) await reloadData();
  if (show) showResult(messages);
  return response;
}

async function pressCallback(data, messageId, {show = true, refresh = true} = {}) {
  const response = await rpc('callback', {ownerId: state.ownerId, data, messageId: Number(messageId) || 1});
  const messages = response.messages || [];
  pushConsole({messages});
  if (refresh) await reloadData();
  if (show) showResult(messages);
  return response;
}

// Runs several commands in sequence and shows one combined result.
async function executeAll(commands) {
  const messages = [];
  for (const command of commands) {
    const result = await execute(command, {show: false, refresh: false});
    messages.push(...(result.messages || []));
  }
  await reloadData();
  return messages;
}

/* ========================================================================== */
/* Data loading and shell                                                      */
/* ========================================================================== */

async function loadBootstrap() {
  const response = await rpc('bootstrap', {...(state.ownerId ? {ownerId: state.ownerId} : {}), logs: !state.logs.length});
  state.data = response;
  state.ownerId = response.ownerId ?? response.owners?.[0] ?? null;
  if (!state.logs.length) state.logs = (response.logs || []).map(normalizeLog).slice(-LOG_LIMIT);
  renderChrome();
  $('#status-refresh').textContent = `Cập nhật ${new Date().toLocaleTimeString('vi-VN')}`;
}

async function reloadData() {
  await loadBootstrap();
  if (['dashboard', 'sources'].includes(state.page)) renderPage();
}

function renderChrome() {
  const runtime = state.data?.runtime || {};
  $('#nav').innerHTML = PAGES.map(page => {
    const count = page.id === 'sources' && sources().length ? `<span class="nav-count">${sources().length}</span>` : '';
    return `<button type="button" class="nav-item ${page.id === state.page ? 'active' : ''}" data-action="navigate" data-page="${page.id}">${icon(page.icon)}<span>${escape(page.title)}</span>${count}</button>`;
  }).join('');
  $('#page-title').textContent = PAGES.find(page => page.id === state.page)?.title || '';

  const pill = $('#runtime-pill');
  const [label, tone] = runtime.error ? ['Cần cấu hình', 'warning'] : runtime.running ? ['Đang chạy', 'running'] : ['Đã dừng', 'stopped'];
  pill.textContent = label;
  pill.className = `pill pill-${tone}`;
  $('#status-runtime').textContent = runtime.error
    ? `Cần sửa cấu hình: ${runtime.error}`
    : runtime.loginOpen ? 'Cửa sổ đăng nhập Facebook đang mở' : runtime.running ? 'Đang quét và xử lý hàng đợi' : 'Hệ thống đang dừng';

  const owners = state.data?.owners || [];
  $('#owner-select').innerHTML = owners.length
    ? owners.map(id => `<option value="${escape(id)}" ${String(id) === String(state.ownerId) ? 'selected' : ''}>Tài khoản #${escape(id)}</option>`).join('')
    : '<option value="">Chưa có tài khoản</option>';
  $('#refresh-button').innerHTML = icon('refresh');
}

/* ========================================================================== */
/* Router                                                                      */
/* ========================================================================== */

const PAGES = [
  {id: 'dashboard', title: 'Tổng quan', icon: 'grid'},
  {id: 'sources', title: 'Nguồn', icon: 'users'},
  {id: 'hot', title: 'Nguồn sôi động', icon: 'flame'},
  {id: 'posts', title: 'Bài viết', icon: 'file'},
  {id: 'queue', title: 'Hàng đợi', icon: 'queue'},
  {id: 'affiliate', title: 'Affiliate', icon: 'link'},
  {id: 'logs', title: 'Nhật ký', icon: 'activity'},
  {id: 'settings', title: 'Cài đặt', icon: 'settings'},
  {id: 'console', title: 'Bảng lệnh', icon: 'code'},
];

const main = $('#main');

async function navigate(pageId) {
  state.page = PAGES.some(page => page.id === pageId) ? pageId : 'dashboard';
  state.renderToken++;
  renderChrome();
  await renderPage();
  main.scrollTop = 0;
}

async function renderPage() {
  if (!state.data) return;
  const token = ++state.renderToken;
  try {
    await PAGE_RENDERERS[state.page](token);
    if (token === state.renderToken && state.data.runtime?.error && state.page !== 'settings') {
      main.insertAdjacentHTML('afterbegin', infoStrip(`Cần sửa cấu hình: ${state.data.runtime.error}`, 'warning'));
    }
  } catch (error) {
    toast(error.message, true);
  }
}

// Fills a container only if the user has not navigated away since `token` was issued.
function fillIfCurrent(token, selector, html) {
  if (token !== state.renderToken) return false;
  const node = $(selector);
  if (!node) return false;
  node.innerHTML = html;
  return true;
}

/* ========================================================================== */
/* Page: Tổng quan                                                             */
/* ========================================================================== */

function statCard(label, value, note) {
  return `<article class="stat"><span class="stat-label">${escape(label)}</span><strong class="stat-value">${formatNumber(value)}</strong><span class="stat-note">${escape(note)}</span></article>`;
}

function renderDashboardStats() {
  const stats = state.data.stats || {};
  return statCard('Nguồn', stats.groups, 'Nhóm và trang cá nhân')
    + statCard('Đang theo dõi', stats.active, 'Nguồn đang bật quét')
    + statCard('Bài viết đã lưu', stats.posts, 'Bài viết và reel')
    + statCard('Thông báo chờ', stats.pending, 'Chờ gửi thông báo');
}

function telegramStatus(runtime) {
  if (runtime.telegramRunning) return 'đang chạy cùng ứng dụng, dùng chung dữ liệu.';
  if (runtime.telegramError) return `lỗi, đang chạy cục bộ không Telegram (${runtime.telegramError}).`;
  return runtime.telegramConfigured ? 'sẽ chạy khi bắt đầu vận hành.' : 'tắt vì chưa có token (nhập ở Cài đặt).';
}

function renderRuntimeCard() {
  const runtime = state.data.runtime || {};
  const toggle = runtime.running
    ? button({label: 'Dừng vận hành', action: 'runtime-stop', iconName: 'stop', kind: 'danger'})
    : button({label: 'Bắt đầu vận hành', action: 'runtime-start', iconName: 'play', kind: 'primary'});

  const login = runtime.loginOpen
    ? `<p class="muted-text">Đăng nhập Facebook trong cửa sổ Chrome vừa mở (tài khoản #${escape(runtime.loginOwnerId ?? state.ownerId)}). Khi thấy trang Facebook đã đăng nhập, bấm "Hoàn tất đăng nhập" để lưu cookie cho chế độ HTTP-only.</p>
       <div class="row">${button({label: 'Hoàn tất đăng nhập', action: 'login-finish', iconName: 'check', kind: 'primary'})}${button({label: 'Hủy', action: 'login-cancel'})}</div>`
    : `<p class="muted-text">Mở cửa sổ Chrome, đăng nhập Facebook thủ công; cookie được lưu trên máy để quét bằng HTTP mà không cần mở trình duyệt.</p>
       <div class="row">${button({label: 'Đăng nhập Facebook', action: 'login-open', iconName: 'person', })}</div>`;

  return `<div class="grid-2">
    <div><h4>Vận hành</h4>
      <p class="muted-text">${runtime.running ? 'Hệ thống đang quét nguồn và gửi bình luận, tin nhắn, kết bạn trong hàng đợi.' : 'Hệ thống đang dừng. Bắt đầu vận hành để quét nguồn và xử lý hàng đợi của mọi tài khoản đã cấu hình.'}</p>
      <div class="row">${toggle}${button({label: 'Mở khóa cooldown', action: 'unblock', iconName: 'shield'})}</div>
      <p class="muted-text">Mở khóa cooldown xóa trạng thái tạm nghỉ và lỗi chờ của mọi nguồn để quét lại ngay.</p>
      <p class="muted-text">Telegram: ${escape(telegramStatus(runtime))}</p></div>
    <div><h4>Phiên Facebook</h4>${login}</div>
  </div>`;
}

function definitionList(rows) {
  return `<dl class="defs">${rows.map(([term, value]) => `<div><dt>${escape(term)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

function renderHealthCard() {
  const health = state.health;
  if (!health) return loadingBlock('Đang đọc trạng thái động cơ quét…');
  if (health.error) return `<p class="muted-text">${escape(health.error)}</p>`;
  const plan = health.plan;
  const rows = [
    ['Chế độ quét', escape(health.scanMode === 'browser' ? 'Trình duyệt' : 'API') + (health.browserless ? ' · chỉ HTTP' : '')],
    ['Chu kỳ đọc feed', health.feedPollMs ? escape(formatDuration(health.feedPollMs)) : 'Tắt'],
    ['Giãn cách request', health.slowdown > 1 ? badge(`Đang chậm ×${Number(health.slowdown).toFixed(1)}`, 'warning') : badge('Bình thường ×1', 'success')],
    ['Tạm nghỉ (cooldown)', health.cooldown ? badge('Đang tạm nghỉ', 'warning') : badge('Không', 'success')],
    ['Hoãn đến', health.deferredUntil ? escape(formatDateTime(health.deferredUntil)) : '—'],
    ['Trần request/giờ', health.maxPerHour ? formatNumber(health.maxPerHour) : '—'],
    ['Request 1 giờ qua', health.usedLastHour == null ? '—' : formatNumber(health.usedLastHour)],
  ];
  const planHtml = plan
    ? definitionList([
      ['Số nhóm trong lịch', formatNumber(plan.groups)],
      ['Quét lại nhanh nhất', escape(formatDuration(plan.fastestMs))],
      ['Quét lại trung vị', escape(formatDuration(plan.medianMs))],
      ['Quét lại chậm nhất', escape(formatDuration(plan.slowestMs))],
    ])
    : '<p class="muted-text">Chưa có lịch quét. Lịch được lập sau khi bắt đầu vận hành.</p>';
  return `<div class="grid-2"><div>${definitionList(rows)}</div><div><h4>Lịch quét gần nhất</h4>${planHtml}</div></div>`;
}

function hotName(item) {
  return escape(item.name || item.url || `#${item.id}`);
}

function renderHotMini() {
  if (!state.hot) return loadingBlock();
  if (state.hot.error) return `<p class="muted-text pad">${escape(state.hot.error)}</p>`;
  const items = state.hot.items.slice(0, 10);
  if (!items.length) return emptyState('Chưa có dữ liệu', 'Cần nguồn đang bật và bài đã quét trong 48 giờ gần đây.');
  return `<div class="table-wrap"><table><thead><tr><th>#</th><th>Nguồn</th><th class="num">Bài hữu ích</th><th class="num">Tổng bài</th></tr></thead><tbody>${items.map(item =>
    `<tr><td>${item.rank}</td><td class="cell-wrap">${hotName(item)}</td><td class="num">${formatNumber(item.useful)}</td><td class="num">${formatNumber(item.total)}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderRecentLogs() {
  const recent = state.logs.slice(-6).reverse();
  if (!recent.length) return emptyState('Chưa có hoạt động', 'Các lần khởi động, quét và thông báo hệ thống sẽ hiển thị ở đây.');
  return `<div class="log-mini">${recent.map(entry => `<div class="log-row level-${entry.level}"><time>${escape(formatClock(entry.at))}</time><span class="log-msg">${escape(entry.message)}</span></div>`).join('')}</div>`;
}

function renderKeywordSummary() {
  const accept = state.data.keywords || [];
  const reject = state.data.rejectKeywords || [];
  return `<div class="pad">
    <p><strong>Accept:</strong> <span class="muted-text">${accept.length ? escape(accept.join('; ')) : 'Tất cả bài viết (không lọc)'}</span></p>
    <p><strong>Reject:</strong> <span class="muted-text">${reject.length ? escape(reject.join('; ')) : 'Không chặn bài nào'}</span></p>
    <div class="row">${button({label: 'Sửa từ khóa mặc định', action: 'default-keywords', iconName: 'filter', size: 'sm'})}</div>
  </div>`;
}

async function renderDashboard(token) {
  main.innerHTML = pageHeader('Tổng quan', 'Vận hành, trạng thái động cơ quét và hoạt động gần đây.', button({label: 'Thêm nguồn', action: 'add-source', iconName: 'plus', kind: 'primary'}))
    + `<div class="stats" id="dash-stats">${renderDashboardStats()}</div>`
    + card('Vận hành', `<div class="pad" id="dash-runtime">${renderRuntimeCard()}</div>`)
    + card('Động cơ quét', `<div class="pad" id="dash-health">${renderHealthCard()}</div>`, {description: 'Tự cập nhật mỗi 5 giây khi mở trang này.'})
    + `<div class="grid-2">
        ${card('Top 10 nguồn sôi động', `<div id="dash-hot">${renderHotMini()}</div>`, {aside: button({label: 'Xem tất cả', action: 'navigate', size: 'sm', data: {page: 'hot'}})})}
        ${card('Từ khóa mặc định', `<div id="dash-keywords">${renderKeywordSummary()}</div>`)}
      </div>`
    + card('Hoạt động gần đây', `<div id="dash-logs">${renderRecentLogs()}</div>`, {aside: button({label: 'Mở nhật ký', action: 'navigate', size: 'sm', data: {page: 'logs'}})});
  await loadLiveCards(token);
}

async function loadLiveCards(token = state.renderToken) {
  const args = {ownerId: state.ownerId};
  const [health, hot] = await Promise.all([
    rpc('health', args).catch(error => ({error: error.message})),
    rpc('hot', {...args, pageSize: 10}).catch(error => ({error: error.message, items: []})),
  ]);
  state.health = health;
  state.hot = hot;
  if (token !== state.renderToken || state.page !== 'dashboard') return;
  const healthNode = $('#dash-health');
  const hotNode = $('#dash-hot');
  if (healthNode) healthNode.innerHTML = renderHealthCard();
  if (hotNode) hotNode.innerHTML = renderHotMini();
}

async function refreshDashboard({bootstrap = true} = {}) {
  if (bootstrap && state.data?.runtime?.running) await loadBootstrap();
  const stats = $('#dash-stats');
  const runtimeNode = $('#dash-runtime');
  if (stats) stats.innerHTML = renderDashboardStats();
  if (runtimeNode) runtimeNode.innerHTML = renderRuntimeCard();
  await loadLiveCards();
}

/* ========================================================================== */
/* Page: Nguồn                                                                 */
/* ========================================================================== */

function sourceStatusBadge(source) {
  if (source.paused) return badge('Tạm dừng', 'warning');
  if (source.lastError) return badge('Cần kiểm tra', 'danger');
  return badge(state.data.runtime?.running ? 'Đang theo dõi' : 'Đã bật', 'success');
}

function sourceKindLabel(source) {
  if (source.sourceType !== 'profile') return 'Nhóm Facebook';
  const content = source.contentType === 'reels' ? 'reel' : source.contentType === 'posts' ? 'bài viết' : 'bài viết & reel';
  return `Trang cá nhân · ${content}`;
}

function sourceFilterPills(source) {
  const defaultAccept = state.data.keywords || [];
  const defaultReject = state.data.rejectKeywords || [];
  const pills = [];
  pills.push(source.keywords === null ? `Accept: mặc định${defaultAccept.length ? ` (${defaultAccept.length})` : ''}`
    : source.keywords?.length ? `Accept: ${source.keywords.length} từ` : 'Accept: tất cả');
  const rejectCount = source.rejectKeywords === null ? defaultReject.length : source.rejectKeywords?.length || 0;
  if (rejectCount) pills.push(`Reject: ${rejectCount} từ${source.rejectKeywords === null ? ' (mặc định)' : ''}`);
  if (source.dateRange) pills.push(`Ngày: ${formatDateTime(source.dateRange.start)} → ${source.dateRange.end ? formatDateTime(source.dateRange.end) : 'mới nhất'}`);
  return pills.map(text => `<span class="chip">${escape(text)}</span>`).join('');
}

function sourceAutoBadges(source) {
  const items = [];
  if (source.autoReply) items.push(badge('Tự bình luận', 'info'));
  if (source.autoInbox) items.push(badge('Tự nhắn tin', 'info'));
  if (source.autoFriend) items.push(badge('Tự kết bạn', 'info'));
  if (source.autoBlock) items.push(badge('Tự chặn người comment', 'info'));
  if (source.tiktokAuto) items.push(badge('TikTok tự động', 'info'));
  return items.join(' ');
}

function sourceRow(source) {
  const interval = source.scanIntervalMs ? formatDuration(source.scanIntervalMs) : '—';
  return `<tr>
    <td class="cell-wrap"><strong>${escape(source.label || source.url)}</strong><small class="block muted-text">#${source.id} · ${escape(sourceKindLabel(source))}</small>
      ${source.lastError ? `<small class="block text-danger">${escape(source.lastError)}</small>` : ''}</td>
    <td>${sourceStatusBadge(source)}</td>
    <td class="cell-wrap">${sourceFilterPills(source)}<div class="gap-top">${sourceAutoBadges(source)}</div></td>
    <td>${escape(interval)}</td>
    <td>${source.lastScanAt ? escape(formatDateTime(source.lastScanAt)) : 'Chưa quét'}</td>
    <td class="actions-cell">
      ${button({iconName: 'settings', action: 'source-edit', kind: 'ghost', title: 'Cài đặt nguồn', data: {id: source.id}})}
      ${button({iconName: source.paused ? 'play' : 'pause', action: 'source-toggle', kind: 'ghost', title: source.paused ? 'Tiếp tục' : 'Tạm dừng', data: {id: source.id}})}
      ${button({iconName: 'trash', action: 'source-delete', kind: 'ghost', title: 'Xóa nguồn', data: {id: source.id}})}
    </td></tr>`;
}

function sourcesTable(items) {
  if (!items.length) {
    return listFiltered('sources') ? noMatch() : emptyState('Chưa có nguồn nào', 'Dán danh sách link nhóm hoặc trang cá nhân để bắt đầu.',
      button({label: 'Thêm nguồn đầu tiên', action: 'add-source', iconName: 'plus', kind: 'primary'}));
  }
  return `<div class="table-wrap"><table><thead><tr><th>Nguồn</th><th>Trạng thái</th><th>Bộ lọc & tự động</th><th>Chu kỳ quét</th><th>Quét gần nhất</th><th></th></tr></thead><tbody>${items.map(sourceRow).join('')}</tbody></table></div>`;
}

function loadSources(token = state.renderToken) {
  return loadList('#sources-list', token, async () => {
    const result = await rpc('sources', listArgs('sources', {type: state.sourceTab}));
    listState('sources').page = result.page;
    return sourcesTable(result.items || []) + (result.total ? listPager('sources', result) : '');
  }, 'Không tải được nguồn');
}

function sourceTabs() {
  const count = type => sources().filter(source => source.sourceType === type).length;
  return tabs([['group', 'Nhóm Facebook', count('group')], ['profile', 'Trang cá nhân', count('profile')]], state.sourceTab, 'source-tab', 'type');
}

// Background refresh: tab counts and the table only, so the toolbar and scroll position stay.
function refreshSources() {
  const node = $('.tabs');
  if (node) node.outerHTML = sourceTabs();
  return loadSources();
}

function renderSources(token) {
  main.innerHTML = pageHeader('Nguồn', 'Quản lý nhóm, trang cá nhân và bộ lọc nội dung.',
    button({label: 'Nhóm đã tham gia', action: 'joined', iconName: 'users'}) + button({label: 'Thêm nguồn', action: 'add-source', iconName: 'plus', kind: 'primary'}))
    + sourceTabs()
    + `<div class="toolbar">
        <div class="row">${button({label: 'Cấu hình hiện tại', action: 'show-config', iconName: 'info', size: 'sm'})}${button({label: 'Từ khóa mặc định', action: 'default-keywords', iconName: 'filter', size: 'sm'})}${button({label: 'Thử bộ lọc', action: 'test-filter', iconName: 'filter', size: 'sm'})}${button({label: 'Áp dụng cho tất cả', action: 'all-sources', iconName: 'settings', size: 'sm'})}${button({label: 'Tiếp tục tất cả', action: 'resume-all', iconName: 'play', size: 'sm'})}${button({label: 'Tạm dừng tất cả', action: 'pause-all', iconName: 'pause', size: 'sm'})}</div>
      </div>`
    + listToolbar('sources')
    + `<section class="card" id="sources-list">${loadingBlock()}</section>`;
  return loadSources(token);
}

/* ----- Source dialogs ---------------------------------------------------------- */

function showAddSource() {
  openModal({
    title: 'Thêm nguồn',
    description: 'Thêm một hoặc nhiều nguồn trong một lần.',
    body: `<form id="add-source-form" data-form="add-source">
      <div class="form-row">
        ${selectField({label: 'Loại nguồn', name: 'type', value: state.sourceTab, options: [['group', 'Nhóm Facebook'], ['profile', 'Trang cá nhân']]})}
        ${selectField({label: 'Nội dung trang cá nhân', name: 'mode', options: [['all', 'Bài viết & reel'], ['posts', 'Chỉ bài viết'], ['reels', 'Chỉ reel']]})}
      </div>
      ${textarea({label: 'Danh sách đường dẫn', name: 'urls', placeholder: 'https://www.facebook.com/groups/…\nhttps://www.facebook.com/…', help: 'Mỗi dòng một link.', required: true})}
      <div class="row">${button({label: 'Nhập file TXT / CSV', action: 'source-import', iconName: 'upload', size: 'sm'})}</div>
      <p class="muted-text">Nhóm thêm trực tiếp tạo mốc nội dung cũ ở lần quét đầu; trang cá nhân nhận bài phù hợp bộ lọc ngay lần đầu.</p>
      <div class="modal-actions">${button({label: 'Hủy', action: 'close-modal'})}${button({label: 'Thêm nguồn', iconName: 'plus', kind: 'primary', type: 'submit'})}</div>
    </form>`,
  });
}

// Source dates are stored as epoch ms and edited in Vietnam time (UTC+7).
function toDayInput(value) {
  if (!value) return '';
  return new Date(value + 7 * 3600000).toISOString().slice(0, 19);
}
const normalizeDay = value => (value && value.length === 16 ? `${value}:00` : value || '');
function toDayCommand(value) {
  if (!value) return '';
  const [day, time] = value.split('T');
  return `${day.split('-').reverse().join('/')} ${time.length === 5 ? `${time}:00` : time}`;
}

function showSourceEdit(id) {
  const source = findSource(id);
  if (!source) return;
  const isProfile = source.sourceType === 'profile';
  const tiktok = source.tiktokAuto
    ? `${source.tiktokAuto.count} link/bài · ${source.tiktokAuto.rank === 'amount' ? 'theo tiền hoa hồng' : 'theo % hoa hồng'} · ${source.tiktokAuto.keyword || 'mọi sản phẩm'}`
    : 'Chưa bật cho nguồn này.';
  const endValue = source.dateRange?.end ? toDayInput(source.dateRange.end - 1000) : '';

  openModal({
    title: `Nguồn #${source.id}`,
    description: source.label || source.url,
    wide: true,
    body: `<form id="source-edit-form" data-form="source-edit" data-id="${source.id}">
      <div class="row">
        ${sourceStatusBadge(source)}
        ${button({label: 'Mở Facebook', action: 'open-external', iconName: 'external', size: 'sm', data: {url: source.url}})}
        ${button({label: 'Quét lại', action: 'source-scan', iconName: 'refresh', size: 'sm', data: {id: source.id}})}
        ${button({label: source.paused ? 'Tiếp tục' : 'Tạm dừng', action: 'source-toggle', iconName: source.paused ? 'play' : 'pause', size: 'sm', data: {id: source.id}})}
        ${button({label: 'Xem bài viết', action: 'source-posts', iconName: 'file', size: 'sm', data: {id: source.id}})}
      </div>
      <p class="muted-text">Chu kỳ quét: ${escape(source.scanIntervalMs ? formatDuration(source.scanIntervalMs) : 'chưa có')} · Quét gần nhất: ${escape(source.lastScanAt ? formatDateTime(source.lastScanAt) : 'chưa quét')}</p>
      ${source.lastError ? `<p class="text-danger">Lỗi gần nhất: ${escape(source.lastError)}</p>` : ''}
      <hr>
      ${isProfile ? selectField({label: 'Loại nội dung thu thập', name: 'mode', value: source.contentType, options: [['all', 'Bài viết & reel'], ['posts', 'Chỉ bài viết'], ['reels', 'Chỉ reel']]}) : ''}
      ${checkbox({label: 'Dùng từ khóa nhận (Accept) mặc định', name: 'defaultKeywords', checked: source.keywords === null})}
      ${field({label: 'Từ khóa nhận (Accept) riêng', name: 'keywords', value: source.keywords?.join('; ') || '', placeholder: 'đồ gia dụng; nhà bếp', help: 'Khớp ít nhất một từ khóa, không phân biệt hoa/thường và dấu. Để trống để nhận tất cả.'})}
      ${checkbox({label: 'Dùng từ khóa chặn (Reject) mặc định', name: 'defaultRejectKeywords', checked: source.rejectKeywords === null})}
      ${field({label: 'Từ khóa chặn (Reject) riêng', name: 'rejectKeywords', value: source.rejectKeywords?.join('; ') || '', placeholder: 'vay tiền; lừa đảo', help: 'Bỏ qua bài chứa bất kỳ từ khóa nào. Để trống để không chặn.'})}
      <div class="form-row">
        ${field({label: 'Từ ngày / giờ', name: 'dateStart', type: 'datetime-local', value: toDayInput(source.dateRange?.start), attrs: 'step="1"'})}
        ${field({label: 'Đến ngày / giờ', name: 'dateEnd', type: 'datetime-local', value: endValue, attrs: 'step="1"'})}
      </div>
      <p class="muted-text">Giờ Việt Nam. Xóa cả hai ô để bỏ bộ lọc thời gian.</p>
      <hr>
      ${textarea({label: 'Tự bình luận nội dung cố định', name: 'autoReply', value: source.autoReply || '', rows: 3, placeholder: 'Nhập nội dung muốn bình luận…', help: 'Để trống để tắt. Áp dụng cho bài mới phù hợp sau thời điểm lưu.'})}
      ${textarea({label: 'Tự nhắn tin riêng cho người đăng', name: 'autoInbox', value: source.autoInbox || '', rows: 3, placeholder: 'Chào {name}, mình thấy bài {link}…', help: 'Dùng {name} cho tên người đăng, {link} cho link bài. Để trống để tắt.'})}
      ${checkbox({label: 'Tự kết bạn với người đăng bài mới', name: 'autoFriend', checked: Boolean(source.autoFriend)})}
      ${checkbox({label: 'Tự chặn người comment (bài đạt, trừ người đăng)', name: 'autoBlock', checked: Boolean(source.autoBlock)})}
      <hr>
      <div class="inset">
        <strong>TikTok Affiliate tự động</strong>
        <p class="muted-text">${escape(tiktok)}</p>
        ${button({label: 'Thiết lập TikTok tự động', action: 'source-auto', iconName: 'spark', size: 'sm', data: {id: source.id}})}
      </div>
      <div class="modal-actions">
        <div class="grow">${button({label: 'Xóa nguồn', action: 'source-delete', iconName: 'trash', kind: 'danger', size: 'sm', data: {id: source.id}})}</div>
        ${button({label: 'Hủy', action: 'close-modal'})}
        ${button({label: 'Lưu cài đặt', iconName: 'check', kind: 'primary', type: 'submit'})}
      </div>
    </form>`,
  });
}

// Compares the form with the stored source and returns only the bot commands that are needed.
function sourceEditCommands(source, values) {
  const id = source.id;
  const commands = [];
  if (source.sourceType === 'profile' && values.mode !== source.contentType) commands.push(`/profile ${source.url} ${values.mode}`);

  const keywords = (values.keywords || '').trim();
  if (values.defaultKeywords) {
    if (source.keywords !== null) commands.push(`/groupkeywords ${id} default`);
  } else if (keywords !== (source.keywords?.join('; ') || '') || source.keywords === null) {
    commands.push(`/groupkeywords ${id} ${keywords || 'off'}`);
  }

  const reject = (values.rejectKeywords || '').trim();
  if (values.defaultRejectKeywords) {
    if (source.rejectKeywords !== null) commands.push(`/groupreject ${id} default`);
  } else if (reject !== (source.rejectKeywords?.join('; ') || '') || source.rejectKeywords === null) {
    commands.push(`/groupreject ${id} ${reject || 'off'}`);
  }

  if (values.dateEnd && !values.dateStart) throw new Error('Hãy chọn ngày bắt đầu trước ngày kết thúc.');
  const oldStart = toDayInput(source.dateRange?.start);
  const oldEnd = source.dateRange?.end ? toDayInput(source.dateRange.end - 1000) : '';
  if (normalizeDay(values.dateStart) !== normalizeDay(oldStart) || normalizeDay(values.dateEnd) !== normalizeDay(oldEnd)) {
    commands.push(`/daterange ${id} ${values.dateStart ? `${toDayCommand(values.dateStart)} ${toDayCommand(values.dateEnd)}`.trim() : 'off'}`);
  }

  const reply = (values.autoReply || '').trim();
  if (reply !== (source.autoReply || '')) commands.push(`/autoreply ${id} ${reply || 'off'}`);
  const inbox = (values.autoInbox || '').trim();
  if (inbox !== (source.autoInbox || '')) commands.push(`/autoinbox ${id} ${inbox || 'off'}`);
  if (Boolean(values.autoFriend) !== Boolean(source.autoFriend)) commands.push(`/autofriend ${id} ${values.autoFriend ? 'on' : 'off'}`);
  if (Boolean(values.autoBlock) !== Boolean(source.autoBlock)) commands.push(`/autoblock ${id} ${values.autoBlock ? 'on' : 'off'}`);
  return commands;
}

function showDefaultKeywords() {
  openModal({
    title: 'Từ khóa mặc định',
    description: 'Áp dụng cho các nguồn chưa đặt từ khóa riêng.',
    body: `<form data-form="default-keywords">
      ${field({label: 'Từ khóa nhận (Accept) mặc định', name: 'keywords', value: (state.data.keywords || []).join('; '), placeholder: 'đồ gia dụng; nhà bếp', help: 'Để trống để nhận mọi nội dung.'})}
      ${field({label: 'Từ khóa chặn (Reject) mặc định', name: 'rejectKeywords', value: (state.data.rejectKeywords || []).join('; '), placeholder: 'vay tiền; lừa đảo', help: 'Để trống nếu không chặn bài nào.'})}
      <div class="modal-actions">${button({label: 'Hủy', action: 'close-modal'})}${button({label: 'Lưu từ khóa', kind: 'primary', type: 'submit'})}</div>
    </form>`,
  });
}

const ALL_SOURCE_ACTIONS = [
  ['autoreply', 'Tự bình luận: đặt nội dung'], ['autoreply-off', 'Tự bình luận: tắt'],
  ['autoinbox', 'Tự nhắn tin: đặt nội dung'], ['autoinbox-off', 'Tự nhắn tin: tắt'],
  ['autofriend-on', 'Tự kết bạn: bật'], ['autofriend-off', 'Tự kết bạn: tắt'],
  ['autoblock-on', 'Tự chặn người comment: bật'], ['autoblock-off', 'Tự chặn người comment: tắt'],
  ['daterange', 'Khoảng ngày: đặt từ - đến'], ['daterange-now', 'Khoảng ngày: từ hiện tại'], ['daterange-off', 'Khoảng ngày: bỏ lọc'],
  ['comment', 'Bình luận tất cả bài mới đã lưu'],
];

function showAllSources() {
  openModal({
    title: 'Áp dụng cho tất cả nguồn',
    description: `${sources().length} nguồn của tài khoản đang chọn`,
    body: `<form data-form="all-sources">
      ${selectField({label: 'Thao tác', name: 'action', options: ALL_SOURCE_ACTIONS})}
      ${textarea({label: 'Nội dung', name: 'text', rows: 3, placeholder: 'Dùng cho tự bình luận, tự nhắn tin và bình luận', help: 'Tự nhắn tin: {name} là tên người đăng, {link} là link bài.'})}
      <div class="form-row">
        ${field({label: 'Từ ngày / giờ', name: 'dateStart', type: 'datetime-local', attrs: 'step="1"'})}
        ${field({label: 'Đến ngày / giờ', name: 'dateEnd', type: 'datetime-local', attrs: 'step="1"'})}
      </div>
      <div class="modal-actions">
        <div class="grow">${button({label: 'Xóa tất cả nguồn', action: 'source-delete-all', iconName: 'trash', kind: 'danger', size: 'sm'})}</div>
        ${button({label: 'Hủy', action: 'close-modal'})}${button({label: 'Áp dụng', iconName: 'check', kind: 'primary', type: 'submit'})}
      </div>
    </form>`,
  });
}

function allSourcesCommand(values) {
  const text = (values.text || '').trim(), [name, mode] = values.action.split('-');
  if (['autoreply', 'autoinbox', 'comment'].includes(values.action) && !text) throw new Error('Hãy nhập nội dung.');
  if (values.action === 'comment') return `/comment all | ${text}`;
  if (name === 'daterange') {
    if (mode) return `/daterange all ${mode}`;
    if (!values.dateStart) throw new Error('Hãy chọn ngày bắt đầu.');
    return `/daterange all ${toDayCommand(values.dateStart)} ${toDayCommand(values.dateEnd)}`.trim();
  }
  return `/${name} all ${mode || text}`;
}

function showTestFilter() {
  openModal({
    title: 'Thử bộ lọc từ khóa',
    description: 'Kiểm tra một nội dung bài có được nhận hay bị loại. Không lưu bài và không gửi gì.',
    body: `<form data-form="test-filter">
      <label class="field"><span>Bộ lọc</span><select name="scope"><option value="default">Mặc định tài khoản</option>${sourceOptions()}</select></label>
      ${textarea({label: 'Nội dung bài', name: 'text', required: true, placeholder: 'Dán nội dung bài viết cần thử…'})}
      <div class="modal-actions">${button({label: 'Hủy', action: 'close-modal'})}${button({label: 'Thử bộ lọc', iconName: 'filter', kind: 'primary', type: 'submit'})}</div>
    </form>`,
  });
}

// /joined keeps each owner's snapshot inside the bot, so /select and the page links reuse it.
// The numbers are the positions used by /select, so they stay the same under any filter or sort.
function loadJoined(refresh = false) {
  return loadList('#joined-results', state.renderToken, async () => {
    const result = await rpc('joined', {...listArgs('joined'), refresh});
    if (result.unavailable) return emptyState('Chưa đọc được danh sách nhóm', 'Kiểm tra đăng nhập Facebook và trang Nhật ký, rồi bấm "Làm mới danh sách".');
    listState('joined').page = result.page;
    const rows = result.items.map(item => `<tr><td>${item.index}</td><td class="cell-wrap"><strong>${escape(item.name || item.url)}</strong><small class="block muted-text">${escape(item.url)}</small></td>
      <td>${item.added ? badge('Đã thêm', 'success') : badge('Chưa thêm')}</td><td class="actions-cell">${button({label: 'Chọn', action: 'joined-pick', size: 'sm', data: {index: item.index}})}</td></tr>`).join('');
    return (result.limited ? infoStrip('Đã chạm giới hạn quét nên danh sách có thể chưa đầy đủ.', 'warning') : '')
      + (rows ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Nhóm</th><th>Trạng thái</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : listFiltered('joined') ? noMatch() : emptyState('Không có nhóm', 'Bấm "Làm mới danh sách" để đọc lại từ Facebook.'))
      + listPager('joined', result);
  }, 'Không đọc được danh sách nhóm');
}

function showJoined() {
  openModal({
    title: 'Nhóm đã tham gia',
    description: 'Nhập hoặc bấm "Chọn" số thứ tự nhóm muốn thêm làm nguồn.',
    wide: true,
    body: `${listToolbar('joined')}<div id="joined-results">${loadingBlock('Đang đọc danh sách nhóm…')}</div>
      <form data-form="joined-select" class="gap-top">
        ${field({label: 'Số thứ tự nhóm', name: 'indexes', placeholder: '1,2 hoặc all', help: 'Số thứ tự ở cột # (không phải ID nguồn); all chọn mọi nhóm đã đọc, kể cả nhóm đang bị lọc ẩn.', attrs: 'required'})}
        <div class="modal-actions">
          <div class="grow row">${button({label: 'Làm mới danh sách', action: 'joined-refresh', iconName: 'refresh', size: 'sm'})}</div>
          ${button({label: 'Đóng', action: 'close-modal'})}${button({label: 'Thêm nhóm đã chọn', iconName: 'plus', kind: 'primary', type: 'submit'})}
        </div>
      </form>`,
  });
  return loadJoined();
}

function renderConfigList() {
  const node = $('#config-list');
  if (!node) return;
  const accept = state.data.keywords || [];
  const reject = state.data.rejectKeywords || [];
  const needle = foldText(listState('config').q.trim());
  const page = pageArray('config', sources().filter(source => foldText(`${source.label || ''} ${source.url} ${source.id}`).includes(needle)));
  const list = page.items.map(source => {
    const sourceAccept = source.keywords === null ? `mặc định (${accept.join('; ') || 'tất cả'})` : source.keywords.join('; ') || 'tất cả bài';
    const sourceReject = source.rejectKeywords === null ? `mặc định (${reject.join('; ') || 'không có'})` : source.rejectKeywords.join('; ') || 'không có';
    const extras = [
      source.dateRange ? `Ngày: ${formatDateTime(source.dateRange.start)} → ${source.dateRange.end ? formatDateTime(source.dateRange.end) : 'mới nhất'}` : '',
      source.autoReply ? `Tự bình luận: ${source.autoReply}` : '',
      source.autoInbox ? `Tự nhắn tin: ${source.autoInbox}` : '',
      source.autoFriend ? 'Tự kết bạn: bật' : '',
      source.autoBlock ? 'Tự chặn người comment: bật' : '',
      source.tiktokAuto ? `TikTok tự động: ${source.tiktokAuto.count} link/bài (${source.tiktokAuto.rank})` : '',
    ].filter(Boolean);
    return `<div class="config-item"><strong>#${source.id} ${escape(source.label || source.url)}</strong> ${source.paused ? badge('Tạm dừng', 'warning') : badge('Đang theo dõi', 'success')}
      <ul><li>Accept: ${escape(sourceAccept)}</li><li>Reject: ${escape(sourceReject)}</li>${extras.map(text => `<li>${escape(text)}</li>`).join('')}</ul></div>`;
  }).join('');
  node.innerHTML = (list || (needle ? noMatch() : '<p class="muted-text">Chưa có nguồn nào.</p>')) + (page.total ? listPager('config', page) : '');
}

function showConfigModal() {
  const accept = state.data.keywords || [];
  const reject = state.data.rejectKeywords || [];
  openModal({
    title: 'Cấu hình hiện tại',
    description: 'Bộ lọc của tài khoản và từng nguồn',
    wide: true,
    body: `<div class="inset"><p><strong>Accept mặc định:</strong> ${escape(accept.join('; ') || 'Tất cả bài viết')}</p><p><strong>Reject mặc định:</strong> ${escape(reject.join('; ') || 'Không có')}</p></div>
      <h4>Danh sách nguồn (${sources().length})</h4>${listToolbar('config')}<div id="config-list"></div>`,
    footer: button({label: 'Đóng', action: 'close-modal'}),
  });
  renderConfigList();
}

/* ========================================================================== */
/* Page: Nguồn sôi động                                                        */
/* ========================================================================== */

function hotRow(item) {
  return `<tr>
    <td>${item.rank}</td>
    <td class="cell-wrap"><strong>${hotName(item)}</strong><small class="block muted-text">#${item.id}</small></td>
    <td class="num"><strong>${formatNumber(item.useful)}</strong></td>
    <td class="num">${formatNumber(item.total)}</td>
    <td class="num">${formatNumber(item.missedByFeed)}</td>
    <td>${escape(item.scanIntervalMs ? formatDuration(item.scanIntervalMs) : '—')}</td>
    <td>${item.lastScanAt ? escape(formatDateTime(item.lastScanAt)) : 'Chưa quét'}</td>
    <td class="cell-wrap ${item.lastError ? 'text-danger' : ''}">${escape(item.lastError || '')}</td>
    <td class="actions-cell">${button({iconName: 'external', action: 'open-external', kind: 'ghost', title: 'Mở Facebook', data: {url: item.url}})}</td></tr>`;
}

async function renderHot(token) {
  main.innerHTML = pageHeader('Nguồn sôi động', 'Xếp hạng nguồn theo số bài hữu ích trong 48 giờ gần đây.', button({label: 'Làm mới', action: 'reload-hot', iconName: 'refresh'}))
    + infoStrip('Chỉ bài khớp Accept/Reject mới được tính, tối đa 2 bài mỗi tác giả, nên tài khoản spam không làm nguồn trông sôi động giả.')
    + `<form class="card pad" data-form="search-rank"><label class="search">${icon('search')}<input name="query" placeholder="Tên, link hoặc ID nhóm cần xem thứ hạng…" aria-label="Tìm nhóm và xem thứ hạng" required maxlength="300"></label>${button({label: 'Tìm và xem thứ hạng', iconName: 'search', type: 'submit'})}</form>`
    + listToolbar('hot')
    + `<section class="card" id="hot-results">${loadingBlock()}</section>`;
  await loadHot(token);
}

function loadHot(token = state.renderToken) {
  return loadList('#hot-results', token, async () => {
    const result = await rpc('hot', listArgs('hot'));
    listState('hot').page = result.page;
    return result.items.length
      ? `<div class="table-wrap"><table><thead><tr><th>Hạng</th><th>Nguồn</th><th class="num">Bài hữu ích</th><th class="num">Tổng bài</th><th class="num">Feed bỏ sót</th><th>Chu kỳ quét</th><th>Quét gần nhất</th><th>Lỗi</th><th></th></tr></thead><tbody>${result.items.map(hotRow).join('')}</tbody></table></div>${listPager('hot', result)}`
      : listFiltered('hot') ? noMatch() : emptyState('Chưa có dữ liệu', 'Cần nguồn đang bật và bài đã quét trong 48 giờ gần đây.');
  }, 'Không đọc được xếp hạng');
}

/* ========================================================================== */
/* Page: Bài viết                                                              */
/* ========================================================================== */

const AUTHOR_BLOCK = {blocked: ['Đã chặn người đăng', true], sending: ['Đang chặn người đăng', true], uncertain: ['Chặn chưa xác nhận: kiểm tra Facebook', true], failed: ['Chặn lại người đăng', false]};

function rejectedCard(post) {
  const source = findSource(post.groupId);
  const author = post.author || 'Bài viết Facebook';
  const [blockLabel, blockDisabled] = AUTHOR_BLOCK[post.authorState] || ['Chặn người đăng', false];
  return `<article class="post">
    <div class="post-head">
      <span class="avatar">${escape(author.slice(0, 1).toUpperCase())}</span>
      <div class="post-meta"><strong>${escape(author)}</strong><small>${escape(post.sourceName || source?.label || `Nguồn #${post.groupId}`)} · ${escape(post.publishedAt ? formatDateTime(post.publishedAt) : 'Không rõ ngày đăng')}</small></div>
      ${badge('Bị loại', 'warning')}
    </div>
    <div class="post-text">${escape(post.text || '[Không đọc được nội dung bài viết]')}</div>
    <details class="post-text"><summary>Lý do bị loại</summary><p class="muted-text">${escape(post.reason || '')}</p></details>
    <div class="post-foot">
      <span class="muted-text">#${escape(post.id)}</span>
      <div class="row">
        ${button({label: 'Mở bài', action: 'open-external', iconName: 'external', size: 'sm', disabled: !post.url, data: {url: post.url || ''}})}
        ${button({label: 'Trang cá nhân', action: 'open-external', iconName: 'person', size: 'sm', disabled: !post.profileUrl, title: post.profileUrl ? '' : 'Bài ẩn danh hoặc chưa đọc được link trang cá nhân', data: {url: post.profileUrl || ''}})}
        ${button({label: blockLabel, action: 'post-block-author', iconName: 'shield', size: 'sm', kind: 'danger', disabled: !post.profileUrl || blockDisabled, data: {source: post.groupId, post: post.id}})}
        ${removeButton('rejected', `${post.groupId}:${post.id}`, `bài ${post.id}`)}
      </div>
    </div>
  </article>`;
}

const timeOf = time => new Date(time).toLocaleTimeString('vi-VN', {hour: '2-digit', minute: '2-digit', hour12: false});
const blockActive = job => job?.state === 'pending' || job?.state === 'running';

const blockTally = counts => [`Đã chặn ${counts.blocked || 0}`, `bỏ qua ${(counts.skipped || 0) + (counts.unknown || 0)}`, `lỗi ${counts.failed || 0}`, `chưa xác nhận ${counts.uncertain || 0}`,
  ...(counts.unresolved ? [`không lấy được ID ${counts.unresolved}`] : []), ...(counts.pending ? [`chưa xử lý ${counts.pending}`] : [])].join(' · ');
const WAIT_WARN = ['paused', 'retry', 'hold', 'cooldown', 'budget', 'stopped'];

// Live progress comes from the monitor's memory (running), the saved job (pending/finished) or a stopped runtime.
function blockStatus(post) {
  const job = post.commenterBlock;
  if (!job?.state) return '';
  const progress = job.progress, counts = progress?.counts || job.result || {};
  const tally = blockTally(counts);
  const lines = [], error = job.error || job.result?.lastError;
  let bar = '', tone = 'info';
  if (blockActive(job)) {
    if (job.waitingRuntime) {
      return `<div class="block-status strip strip-warning">${icon('info')}<div>Hệ thống đang dừng, việc chặn chưa chạy. Bấm "Bắt đầu vận hành" để chạy. ${button({label: 'Mở Tổng quan', action: 'navigate', size: 'sm', data: {page: 'dashboard'}})}</div></div>`;
    }
    if (progress?.phase === 'reading') lines.push(`Đang đọc bình luận… ${progress.pages ? `${progress.pages} trang · ${progress.comments} comment` : ''}`);
    else if (progress?.phase) {
      const {index = 0, total = 0} = progress;
      lines.push(!total ? 'Không có người cần chặn.' : progress.phase === 'waiting' ? `Đang chờ giãn cách an toàn${progress.waitUntil ? ` đến ${timeOf(progress.waitUntil)}` : ''} · đã xử lý ${index}/${total}` : `Đang chặn người thứ ${Math.min(index + 1, total)}/${total}`);
      if (total) bar = `<progress class="block-bar" max="${total}" value="${index}"></progress>`;
      lines.push(tally);
    } else if (job.state === 'pending' && job.runAt > Date.now()) { lines.push(`Thử lại lúc ${timeOf(job.runAt)}`); tone = 'warning'; if (job.result?.blocked != null) lines.push(tally); }
    else { lines.push(job.wait?.text || 'Đang chờ đến lượt xử lý…'); if (WAIT_WARN.includes(job.wait?.reason)) tone = 'warning'; }
  } else {
    tone = job.state === 'done' ? 'success' : 'warning';
    lines.push(job.state === 'done' ? `Hoàn tất. ${tally}` : job.result?.noComments ? 'Chưa có comment để chặn.' : `Chưa xong. ${tally}`);
  }
  if (error) lines.push(`Lỗi gần nhất: ${error}`);
  return `<div class="block-status strip strip-${tone}"><div>${lines.map(escape).join('<br>')}${bar}</div></div>`;
}

function postCard(post) {
  const key = `${post.groupId}:${post.id}`;
  const source = findSource(post.groupId);
  const author = post.author || 'Bài viết Facebook';
  const noProfile = 'Bài ẩn danh hoặc chưa đọc được link trang cá nhân người đăng';
  return `<article class="post" data-key="${escape(key)}"${blockActive(post.commenterBlock) ? ' data-block-active' : ''}>
    <div class="post-head">
      <input type="checkbox" data-change="select-post" data-key="${escape(key)}" ${state.selectedPosts.has(key) ? 'checked' : ''} aria-label="Chọn bài ${escape(post.id)}">
      <span class="avatar">${escape(author.slice(0, 1).toUpperCase())}</span>
      <div class="post-meta"><strong>${escape(author)}</strong><small>${escape(post.sourceName || source?.label || `Nguồn #${post.groupId}`)} · ${escape(post.publishedAt ? formatDateTime(post.publishedAt) : 'Không rõ ngày đăng')}</small></div>
      ${badge(post.kind === 'reel' ? 'Reel' : 'Bài viết', post.kind === 'reel' ? 'info' : 'neutral')}
    </div>
    <div class="post-text">${escape(post.text || '[Không đọc được nội dung bài viết]')}</div>
    ${post.zaloPhones?.length ? `<div class="post-text"><strong>Liên hệ Zalo</strong><p class="muted-text">Sao chép SĐT rồi dán vào tìm kiếm Zalo. Kiểm tra đúng người trước khi nhắn tin hoặc kết bạn; số này chưa được xác minh có Zalo.</p>${post.zaloPhones.map(phone => `<div class="row"><span>${escape(phone)}</span>${button({label: 'Sao chép SĐT', action: 'copy-phone', iconName: 'copy', size: 'sm', data: {phone}})}</div>`).join('')}${button({label: 'Mở Zalo', action: 'open-external', iconName: 'external', size: 'sm', data: {url: 'https://chat.zalo.me/'}})}</div>` : ''}
    <div class="post-foot">
      <span class="muted-text">#${escape(post.id)}${post.media?.length ? ` · ${post.media.length} đính kèm` : ''}</span>
      <div class="row">
        ${button({label: 'Lấy SĐT/email', action: 'post-contacts', iconName: 'users', size: 'sm', data: {url: post.url}})}
        ${button({label: 'Mở bài', action: 'open-external', iconName: 'external', size: 'sm', data: {url: post.url}})}
        ${button({label: 'Affiliate', action: 'post-affiliate', iconName: 'link', size: 'sm', data: {source: post.groupId, post: post.id}})}
        ${button({label: 'Trang cá nhân', action: 'open-external', iconName: 'person', size: 'sm', disabled: !post.profileUrl, title: post.profileUrl ? '' : noProfile, data: {url: post.profileUrl || ''}})}
        ${button({label: 'Nhắn tin riêng', action: 'post-inbox', iconName: 'message', size: 'sm', disabled: !post.profileUrl, title: post.profileUrl ? '' : noProfile, data: {source: post.groupId, post: post.id}})}
        ${button({label: 'Kết bạn', action: 'post-friend', iconName: 'person', size: 'sm', disabled: !post.profileUrl, title: post.profileUrl ? '' : noProfile, data: {source: post.groupId, post: post.id}})}
        ${button({label: post.commenterBlock?.label || 'Chặn người comment', action: 'post-block-commenters', iconName: 'shield', size: 'sm', disabled: !post.url, data: {source: post.groupId, post: post.id}})}
        ${button({label: 'Danh sách bình luận', action: 'post-commentlist', iconName: 'message', size: 'sm', data: {source: post.groupId, post: post.id}})}
        ${button({label: 'Bình luận', action: 'post-comment', iconName: 'message', size: 'sm', kind: 'primary', data: {source: post.groupId, post: post.id}})}
        ${removeButton('posts', key, `bài ${post.id}`)}
      </div>
    </div>
    ${blockStatus(post)}
  </article>`;
}

function renderPostSelection() {
  const node = $('#post-selection');
  if (!node) return;
  node.innerHTML = state.selectedPosts.size
    ? `<div class="sticky-bar"><span>Đã chọn <strong>${state.selectedPosts.size}</strong> bài viết</span><div class="row">${button({label: 'Bỏ chọn', action: 'clear-posts', size: 'sm'})}${button({label: 'Bình luận bài đã chọn', action: 'selected-comment', iconName: 'message', size: 'sm', kind: 'primary'})}</div></div>`
    : '';
}

async function renderPosts(token) {
  const rejected = state.postTab === 'rejected';
  const notify = state.data.rejectedSince != null;
  main.innerHTML = pageHeader('Bài viết', 'Nội dung đã thu thập từ các nguồn Facebook.',
    (rejected ? button({label: notify ? 'Tắt ghi nhận bài bị loại' : 'Bật ghi nhận bài bị loại', action: 'rejected-toggle', iconName: notify ? 'stop' : 'play'}) : '') + button({label: 'Làm mới', action: 'reload-posts', iconName: 'refresh'}))
    + tabs([['accepted', 'Bài đạt'], ['rejected', 'Bài bị loại']], state.postTab, 'post-tab', 'tab')
    + (rejected ? infoStrip(notify ? 'Đang ghi nhận bài bị loại theo từ khóa (chỉ bài trong khoảng ngày, thấy từ lúc bật).' : 'Chưa bật ghi nhận bài bị loại. Bật để lưu các bài bị loại theo từ khóa từ bây giờ.') : '')
    + listToolbar(rejected ? 'rejected' : 'posts')
    + `<div id="post-results">${loadingBlock()}</div><div id="post-selection"></div>`;
  await loadPosts(token);
}

// Replaces only the result cards: ticked posts (state.selectedPosts) and the toolbar survive refreshes.
async function loadPosts(token = state.renderToken) {
  const rejected = state.postTab === 'rejected', kind = rejected ? 'rejected' : 'posts';
  const filled = await loadList('#post-results', token, async () => {
    const result = await rpc(kind, listArgs(kind));
    listState(kind).page = result.page;
    const items = result.items || [];
    return items.length
      ? items.map(rejected ? rejectedCard : postCard).join('') + listPager(kind, result)
      : listFiltered(kind) ? noMatch()
        : rejected ? emptyState('Chưa có bài bị loại', 'Bật ghi nhận bài bị loại; bài bị từ khóa loại sẽ xuất hiện ở đây.')
          : emptyState('Chưa có bài viết', 'Thêm nguồn, đăng nhập Facebook và bắt đầu vận hành. Bài đã quét sẽ xuất hiện ở đây.', button({label: 'Quản lý nguồn', action: 'navigate', data: {page: 'sources'}}));
  }, 'Không tải được bài viết');
  if (filled) renderPostSelection();
}

function showCommentForm(targets, list = true) {
  openModal({
    title: list ? 'Danh sách bình luận' : 'Bình luận',
    description: list ? `${targets.length} bài viết đã chọn · mỗi dòng là một bình luận riêng.` : `${targets.length} bài viết · một nội dung bình luận.`,
    body: `<form data-form="comment" data-list="${list ? 1 : ''}" data-targets="${escape(JSON.stringify(targets))}">
      ${list ? textarea({label: 'Nội dung / link bình luận', name: 'comments', placeholder: 'https://…\nhttps://…', help: 'Nhập 5 dòng khác nhau để tạo 5 bình luận trên mỗi bài. Nội dung trùng được bỏ qua.', required: true})
        : textarea({label: 'Nội dung bình luận', name: 'comments', placeholder: 'Nhập nội dung đăng lên Facebook…', help: 'Nội dung trùng được bỏ qua.', required: true})}
      ${infoStrip('Bình luận được xếp vào hàng đợi và gửi khi hệ thống đang vận hành. Nguồn tạm dừng sẽ chờ.')}
      <div class="modal-actions">${button({label: 'Hủy', action: 'close-modal'})}${button({label: 'Xếp hàng bình luận', iconName: 'message', kind: 'primary', type: 'submit'})}</div>
    </form>`,
  });
}

function showInboxForm(sourceId, postId) {
  openModal({
    title: 'Nhắn tin riêng cho người đăng',
    description: `Nguồn #${sourceId} · Bài ${postId}`,
    body: `<form data-form="inbox" data-source="${escape(sourceId)}" data-post="${escape(postId)}">
      ${textarea({label: 'Nội dung tin nhắn', name: 'text', placeholder: 'Nội dung gửi qua Messenger…', help: 'Giãn cách an toàn 5-10 phút/tin, tối đa 15 tin/ngày để bảo vệ tài khoản Facebook.', required: true})}
      <div class="modal-actions">${button({label: 'Hủy', action: 'close-modal'})}${button({label: 'Xếp hàng tin nhắn', iconName: 'message', kind: 'primary', type: 'submit'})}</div>
    </form>`,
  });
}

// Reuses the bot's owner-checked callbacks (they resolve the post through a message mapping made by the service).
async function postCallback(data, sourceId, postId, mode = 'single') {
  const response = await rpc('postCallback', {ownerId: state.ownerId, data, groupId: Number(sourceId), postId, mode});
  const hint = data === 'post:block-commenters' ? [{text: state.data.runtime?.running ? 'Tiến trình chặn hiện ngay trên thẻ bài và tự cập nhật.' : 'Hệ thống đang dừng: bấm "Bắt đầu vận hành" ở Tổng quan để việc chặn chạy.'}] : [];
  showResult([...(response.messages || []), ...hint]);
  await renderPage();
}

// Updates only the cards with a running block job, so scroll position and ticked posts are untouched.
const blockRefresh = () => state.page === 'posts' && state.postTab === 'accepted' && document.querySelector('article.post[data-block-active]') ? refreshBlockCards : null;
async function refreshBlockCards() {
  const result = await rpc('posts', listArgs('posts'));
  for (const item of result.items || []) {
    const card = $(`article.post[data-key="${CSS.escape(`${item.groupId}:${item.id}`)}"][data-block-active]`);
    if (card) card.outerHTML = postCard(item);
  }
}

/* ========================================================================== */
/* Page: Hàng đợi                                                              */
/* ========================================================================== */

const QUEUE_STATES = {
  pending: ['Đang chờ', 'warning'],
  sending: ['Đang gửi', 'info'],
  sent: ['Đã gửi', 'success'],
  failed: ['Thất bại', 'danger'],
  uncertain: ['Cần kiểm tra', 'warning'],
  cancelled: ['Đã hủy', 'neutral'],
  running: ['Đang chạy', 'info'],
  interrupted: ['Gián đoạn', 'warning'],
  done: ['Hoàn tất', 'success'],
  stopped: ['Đã dừng', 'neutral'],
};
const stateBadge = value => badge(...(QUEUE_STATES[value] || [value || '—', 'neutral']));

function blockQueueDetail(item) {
  const progress = item.progress, counts = progress?.counts || item.result || {};
  const line = item.wait?.text || (progress?.phase === 'reading' ? `Đang đọc bình luận… ${progress.pages ? `${progress.pages} trang · ${progress.comments} comment` : ''}`
    : progress?.phase ? `Đang chặn ${Math.min((progress.index || 0) + 1, progress.total || 0)}/${progress.total || 0}` : item.state === 'running' ? 'Đang chạy…' : '');
  return `${line ? `<small class="block ${item.wait && WAIT_WARN.includes(item.wait.reason) ? 'text-warning' : 'muted-text'}">${escape(line)}</small>` : ''}${counts.blocked != null || progress ? `<small class="block muted-text">${escape(blockTally(counts))}</small>` : ''}`;
}

const QUEUES = {
  comments: {
    label: 'Bình luận', rpc: 'comments', cancel: 'cancelcomments', intervalKey: 'COMMENT_INTERVAL_SECONDS',
    empty: 'Chọn bài viết và thêm nội dung hoặc link affiliate để tạo bình luận.',
    head: ['Nội dung', 'Bài viết', 'Trạng thái', 'Thời gian'],
    row: item => [`${escape(item.body)}`, `#${item.group_id}<small class="block muted-text">${escape(item.post_id)}</small>`],
  },
  inboxes: {
    label: 'Tin nhắn riêng', rpc: 'inboxes', cancel: 'cancelinbox', intervalKey: 'DIRECT_MESSAGE_INTERVAL_SECONDS',
    empty: 'Bật tự nhắn tin ở cài đặt nguồn hoặc dùng lệnh /inbox để tạo tin nhắn.',
    head: ['Nội dung', 'Người nhận', 'Trạng thái', 'Thời gian'],
    row: item => [escape(item.body), `${escape(item.recipient_name || item.recipient_url)}<small class="block muted-text">Nguồn #${item.group_id} · ${escape(item.source)}</small>`],
  },
  blocks: {
    label: 'Chặn người comment', rpc: 'blocks', cancelNote: 'Lượt đang chạy dừng ở lần chặn kế tiếp; người đã chặn không bị bỏ chặn. Hủy không tắt tự chặn (/autoblock ID off).', cancel: 'cancelblocks', intervalKey: 'BLOCK_INTERVAL_SECONDS',
    empty: 'Bấm "Chặn người comment" ở bài viết hoặc bật /autoblock cho nguồn để tạo lượt chặn.',
    head: ['Bài viết', 'Nguồn · hàng đợi', 'Trạng thái', 'Hẹn lúc'],
    time: item => item.runAt,
    row: item => [`${escape(item.postId)}<small class="block muted-text">${item.auto ? 'Tự động' : 'Thủ công'}</small>`,
      `#${item.groupId} · ${escape(item.sourceName)}${blockQueueDetail(item)}`],
  },
  friends: {
    label: 'Kết bạn', rpc: 'friends', cancel: 'cancelfriend', intervalKey: 'FRIEND_INTERVAL_SECONDS',
    empty: 'Bật tự kết bạn ở cài đặt nguồn hoặc dùng lệnh /friend để tạo lời mời.',
    head: ['Người nhận', 'Bài viết', 'Trạng thái', 'Thời gian'],
    row: item => [`${escape(item.recipient_name || item.recipient_url)}<small class="block muted-text">${escape(item.recipient_url)}</small>`, `#${item.group_id}<small class="block muted-text">${escape(item.post_id)} · ${escape(item.source)}</small>`],
  },
};

function queueIntervalNote(queue) {
  const seconds = Number(settingValue(queue.intervalKey));
  if (!Number.isFinite(seconds)) return '';
  return seconds > 0
    ? `Khoảng nghỉ giữa 2 lần gửi: ${seconds} giây (${queue.intervalKey}). Đổi ở trang Cài đặt.`
    : `Không nghỉ thêm giữa 2 lần gửi (${queue.intervalKey} = 0). Đổi ở trang Cài đặt.`;
}

function queueTable(queue, items) {
  if (!items.length) return listFiltered(state.queueTab) ? noMatch() : emptyState('Hàng đợi đang trống', queue.empty);
  return `<div class="table-wrap"><table><thead><tr>${queue.head.map(text => `<th>${escape(text)}</th>`).join('')}<th></th></tr></thead><tbody>${items.map(item => {
    const [first, second] = queue.row(item);
    const retry = state.queueTab === 'blocks' ? button({label: 'Thử lại', action: 'queue-retry-blocks', iconName: 'refresh', size: 'sm', data: {id: item.id}, disabled: !(['failed', 'stopped'].includes(item.state) || item.state === 'pending' && item.runAt > Date.now())}) : '';
    return `<tr><td class="cell-wrap">${first}${item.error ? `<small class="block text-danger">${escape(item.error)}</small>` : ''}</td><td class="cell-wrap">${second}</td><td>${stateBadge(item.state)}</td><td>${escape(formatDateTime(queue.time ? queue.time(item) : item.sent_at || item.created_at))}</td><td class="actions-cell">${retry}${removeButton(state.queueTab, item.id)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function loadQueue(token) {
  const kind = state.queueTab, queue = QUEUES[kind];
  return loadList('#queue-results', token, async () => {
    const result = await rpc(queue.rpc, listArgs(kind));
    listState(kind).page = result.page;
    return queueTable(queue, result.items || []) + (result.total ? listPager(kind, result) : '');
  }, 'Không tải được hàng đợi');
}

function renderQueue(token) {
  const queue = QUEUES[state.queueTab];
  main.innerHTML = pageHeader('Hàng đợi', 'Theo dõi trạng thái và hủy các thao tác đang chờ gửi.', (state.queueTab === 'blocks' ? button({label: 'Thử lại tất cả', action: 'queue-retry-blocks', iconName: 'refresh'}) : '') + button({label: 'Làm mới', action: 'reload-queue', iconName: 'refresh'}))
    + tabs(Object.entries(QUEUES).map(([id, item]) => [id, item.label]), state.queueTab, 'queue-tab', 'tab')
    + infoStrip(`${queueIntervalNote(queue)} "Cần kiểm tra" nghĩa là chưa xác định được kết quả; hãy xem trên Facebook trước khi thử lại.`.trim())
    + `<div class="toolbar"><div class="row"><label class="inline-label">Hủy phần đang chờ của
        <select id="queue-cancel-scope" class="select">${sourceOptions({withAll: true})}</select></label>
        ${button({label: 'Hủy đang chờ', action: 'queue-cancel', iconName: 'stop', kind: 'danger', size: 'sm'})}</div></div>`
    + listToolbar(state.queueTab)
    + `<section class="card" id="queue-results">${loadingBlock()}</section>`;
  return loadQueue(token);
}

/* ========================================================================== */
/* Page: Affiliate                                                             */
/* ========================================================================== */

const PROVIDERS = [['tiktok', 'TikTok Shop'], ['shopee', 'Shopee'], ['facebook', 'Đăng lên Facebook']];

function rankFields(defaults = {}) {
  return `<div class="form-row three">
    <label class="field"><span>Số link</span><input type="number" name="count" min="1" max="20" step="1" value="${escape(defaults.count || 5)}" required></label>
    ${selectField({label: 'Xếp hạng theo', name: 'rank', value: defaults.rank === 'amount' ? 'amount' : 'rate', options: [['rate', '% hoa hồng'], ['amount', 'Tiền hoa hồng']]})}
    ${field({label: 'Từ khóa sản phẩm', name: 'keyword', value: defaults.keyword || '', placeholder: 'Ví dụ: mỹ phẩm'})}
  </div>`;
}

function renderFacebookProvider() {
  return `<div class="grid-2">
    ${card('Lấy top link và bình luận', `<form class="pad" data-form="affiliate-post">
      ${selectField({label: 'Nguồn affiliate', name: 'provider', options: [['tiktok', 'TikTok Shop'], ['shopee', 'Shopee']]})}
      <label class="field"><span>Nguồn bài Facebook</span><select name="sourceId" required>${sourceOptions()}</select></label>
      ${field({label: 'ID bài viết đã lưu', name: 'postId', placeholder: 'Lấy ở trang Bài viết'})}
      ${rankFields()}
      ${button({label: 'Lấy link và xếp hàng bình luận', iconName: 'message', kind: 'primary', type: 'submit'})}
    </form>`)}
    ${card('Tự động theo từ khóa', `<div class="pad">
      <p class="muted-text">Khi có bài Facebook mới phù hợp bộ lọc, lấy top sản phẩm TikTok và tự xếp bình luận.</p>
      <p class="muted-text">Từ khóa Facebook lọc nội dung bài viết; từ khóa sản phẩm dùng để chọn link affiliate.</p>
      ${button({label: 'Thiết lập tự động', action: 'source-auto', iconName: 'spark', kind: 'primary'})}
    </div>`)}
  </div>`;
}

function renderConvertProvider(provider) {
  const isTikTok = provider === 'tiktok';
  const check = isTikTok ? button({label: 'Kiểm tra kết nối', action: 'affiliate-check', iconName: 'shield', size: 'sm'}) : '';
  return `<div class="grid-2">
    ${card('Chuyển link sản phẩm', `<form class="pad" data-form="affiliate-convert">
      ${textarea({label: 'Link sản phẩm đầu vào', name: 'urls', placeholder: isTikTok ? 'Link sản phẩm TikTok Shop hoặc ID…' : 'Link sản phẩm Shopee…', help: 'Mỗi dòng một link.', required: true})}
      ${button({label: 'Tạo link affiliate', iconName: 'link', kind: 'primary', type: 'submit'})}
    </form>`, {aside: check})}
    ${card('Top sản phẩm hoa hồng', `<form class="pad" data-form="affiliate-top">
      ${rankFields()}
      <p class="muted-text">Kết quả phụ thuộc quyền tài khoản và dữ liệu API.</p>
      ${button({label: 'Tìm top hoa hồng', iconName: 'spark', kind: 'primary', type: 'submit'})}
    </form>`)}
  </div>
  ${card('Thư viện link affiliate', `<div class="pad">${listToolbar('links')}<div id="affiliate-links">${loadingBlock()}</div></div>`, {description: `Link đã tạo bởi tài khoản ${isTikTok ? 'TikTok' : 'Shopee'} hiện tại`, aside: button({label: 'Làm mới', action: 'reload-links', iconName: 'refresh', size: 'sm'})})}`;
}

async function renderAffiliate(token) {
  const provider = state.provider;
  main.innerHTML = pageHeader('Affiliate', 'Chuyển link, tìm sản phẩm theo hoa hồng và bình luận link vào bài viết.',
    button({label: 'Trạng thái TikTok', action: 'affiliate-status', iconName: 'info', data: {provider: 'tiktok'}}) + button({label: 'Trạng thái Shopee', action: 'affiliate-status', iconName: 'info', data: {provider: 'shopee'}}) + button({label: 'Cấu hình', action: 'navigate', iconName: 'settings', data: {page: 'settings'}}))
    + tabs(PROVIDERS, provider, 'affiliate-tab', 'provider')
    + (provider === 'facebook' ? renderFacebookProvider() : renderConvertProvider(provider));
  if (provider !== 'facebook') await loadLinks(token);
}

function linkRow(row) {
  return `<div class="link-row">
    <input type="checkbox" data-change="select-link" data-id="${row.id}" ${state.selectedLinks.has(row.id) ? 'checked' : ''} aria-label="Chọn link ${row.id}">
    <div class="link-info"><strong>Link #${row.id}</strong>
      <button type="button" class="link-url" data-action="open-external" data-url="${escape(row.affiliate_url)}">${escape(row.affiliate_url)}</button>
      <small class="block muted-text">${escape(row.origin_url)}</small>
      <small class="block muted-text">Cập nhật ${escape(formatDateTime(row.updated_at))}</small></div>
    ${button({iconName: 'copy', action: 'copy-link', kind: 'ghost', title: 'Sao chép', data: {url: row.affiliate_url}})}
    ${removeButton('links', row.id, `link #${row.id}`)}
  </div>`;
}

function renderLinkSelection() {
  const node = $('#link-selection');
  if (!node) return;
  node.innerHTML = state.selectedLinks.size
    ? `<div class="sticky-bar"><span>Đã chọn ${state.selectedLinks.size} link</span>${button({label: 'Bình luận các link này', action: 'selected-links', iconName: 'message', size: 'sm', kind: 'primary'})}</div>`
    : '';
}

async function loadLinks(token = state.renderToken) {
  const filled = await loadList('#affiliate-links', token, async () => {
    const result = await rpc('links', {...listArgs('links'), provider: state.provider});
    listState('links').page = result.page;
    const items = result.items || [];
    return items.length
      ? `<div class="link-list">${items.map(linkRow).join('')}</div>${listPager('links', result)}<div id="link-selection"></div>`
      : listFiltered('links') ? noMatch() : emptyState('Thư viện link đang trống', 'Chuyển link sản phẩm hoặc tìm top hoa hồng để thêm link vào thư viện.');
  }, 'Không tải được thư viện link');
  if (filled) renderLinkSelection();
}

function showSelectedLinks() {
  openModal({
    title: 'Bình luận link đã chọn',
    description: `${state.selectedLinks.size} link · ${state.provider === 'tiktok' ? 'TikTok' : 'Shopee'}`,
    body: `<form data-form="selected-links">
      <label class="field"><span>Nguồn bài Facebook</span><select name="sourceId" required>${sourceOptions()}</select></label>
      ${field({label: 'ID bài viết đã lưu', name: 'postId', placeholder: 'ID bài trong trang Bài viết'})}
      ${infoStrip('Mỗi link được chọn tạo một bình luận riêng. Bài viết phải có trong dữ liệu đã thu thập.')}
      <div class="modal-actions">${button({label: 'Hủy', action: 'close-modal'})}${button({label: 'Xếp hàng bình luận', iconName: 'message', kind: 'primary', type: 'submit'})}</div>
    </form>`,
  });
}

function showPostAffiliate(sourceId, postId) {
  openModal({
    title: 'Bình luận top affiliate',
    description: `Nguồn #${sourceId} · Bài ${postId}`,
    body: `<form data-form="affiliate-post">
      <input type="hidden" name="sourceId" value="${escape(sourceId)}"><input type="hidden" name="postId" value="${escape(postId)}">
      ${selectField({label: 'Nền tảng affiliate', name: 'provider', options: [['tiktok', 'TikTok Shop'], ['shopee', 'Shopee']]})}
      ${rankFields()}
      ${infoStrip('Sản phẩm được lấy mới từ API. Chỉ link affiliate hợp lệ mới được đưa vào hàng đợi.')}
      <div class="modal-actions">${button({label: 'Hủy', action: 'close-modal'})}${button({label: 'Lấy link và xếp hàng', iconName: 'message', kind: 'primary', type: 'submit'})}</div>
    </form>`,
  });
}

function showTikTokAuto(id) {
  const source = id ? findSource(id) : null;
  const options = source?.tiktokAuto || {};
  openModal({
    title: 'TikTok Affiliate tự động',
    description: 'Thu thập bài Facebook theo từ khóa rồi bình luận link sản phẩm.',
    body: `<form data-form="tiktok-auto">
      <label class="field"><span>Nguồn Facebook</span><select name="sourceId" required>${sourceOptions({selected: id})}</select></label>
      ${field({label: 'Từ khóa bài Facebook', name: 'keywords', value: source?.keywords?.join('; ') || '', placeholder: 'đồ gia dụng; nhà bếp', help: 'Để trống để nhận mọi bài. Đây là bộ lọc riêng của nguồn, thay từ khóa mặc định.'})}
      <hr>
      ${rankFields(options)}
      ${infoStrip('Chỉ bài mới có ngày đăng sau thời điểm bật mới được xử lý. Cần TikTok Creator API và publisher link hợp lệ.')}
      <div class="modal-actions">
        ${source?.tiktokAuto ? `<div class="grow">${button({label: 'Tắt tự động', action: 'auto-off', kind: 'danger', data: {id: source.id}})}</div>` : ''}
        ${button({label: 'Hủy', action: 'close-modal'})}${button({label: 'Bật / cập nhật', iconName: 'spark', kind: 'primary', type: 'submit'})}
      </div>
    </form>`,
  });
}

/* ========================================================================== */
/* Page: Nhật ký                                                               */
/* ========================================================================== */

function logLevel(level) {
  if (level === 'error') return 'error';
  return ['warn', 'warning'].includes(level) ? 'warning' : 'info';
}

// "[QUÉT NHÓM #3 | acc 1] ..." -> "QUÉT NHÓM"; messages without a leading tag -> "KHÁC".
function logCategory(message) {
  const match = /^\s*\[([^\]]+)\]/.exec(message);
  if (!match) return 'KHÁC';
  const tag = match[1].split('|')[0].replace(/#\d+/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  return tag || 'KHÁC';
}

function normalizeLog(entry) {
  const message = String(entry.message ?? '');
  return {at: entry.at, level: logLevel(entry.level), message, category: logCategory(message), lower: message.toLowerCase()};
}

function logMatches(entry) {
  const filter = state.logFilter;
  if (filter.level !== 'all' && entry.level !== filter.level) return false;
  if (filter.category !== 'all' && entry.category !== filter.category) return false;
  return !filter.search || entry.lower.includes(filter.search.toLowerCase());
}

const LEVEL_LABELS = {info: 'Thông tin', warning: 'Lưu ý', error: 'Lỗi'};

function logRow(entry) {
  return `<div class="log-row level-${entry.level}"><time>${escape(formatClock(entry.at))}</time><span class="log-level">${escape(LEVEL_LABELS[entry.level])}</span><span class="log-msg">${escape(entry.message)}</span></div>`;
}

function renderLogChips() {
  const counts = new Map();
  for (const entry of state.logs) counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
  const chips = [['all', 'Tất cả', state.logs.length], ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => [name, name, count])];
  return chips.map(([id, label, count]) =>
    `<button type="button" class="chip chip-button ${state.logFilter.category === id ? 'active' : ''}" data-action="log-category" data-category="${escape(id)}">${escape(label)} <span>${count}</span></button>`).join('');
}

// Page 1 holds the newest lines (oldest first inside a page, so the live tail stays at the bottom).
function logPage() {
  const rows = state.logs.filter(logMatches), current = listState('logs'), pages = Math.max(1, Math.ceil(rows.length / current.pageSize));
  current.page = Math.min(current.page, pages);
  const end = rows.length - (current.page - 1) * current.pageSize;
  return {items: rows.slice(Math.max(0, end - current.pageSize), end), total: rows.length, page: current.page, pages};
}

function renderLogList() {
  const list = $('#log-list');
  if (!list) return;
  const page = logPage();
  list.innerHTML = page.items.length ? page.items.map(logRow).join('') : emptyState('Không có nhật ký phù hợp', 'Thử đổi mức độ, danh mục hoặc từ khóa tìm kiếm.');
  $('#log-pager').innerHTML = listPager('logs', page);
  if (!state.logFilter.paused && page.page === 1) list.scrollTop = list.scrollHeight;
}

function renderLogs() {
  const filter = state.logFilter;
  main.innerHTML = pageHeader('Nhật ký', 'Dòng nhật ký trực tiếp (giữ tối đa 1000 dòng). Trang 1 là mới nhất, dòng mới nhất ở cuối trang.',
    button({label: filter.paused ? 'Tiếp tục cuộn' : 'Tạm dừng cuộn', action: 'log-pause', iconName: filter.paused ? 'play' : 'pause'}) + button({label: 'Xóa màn hình', action: 'log-clear', iconName: 'trash'}))
    + `<div class="toolbar">
        <select class="select" data-change="log-level" aria-label="Mức độ">${[['all', 'Mọi mức độ'], ['info', 'Thông tin'], ['warning', 'Lưu ý'], ['error', 'Lỗi']].map(([value, label]) => `<option value="${value}" ${filter.level === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <label class="search">${icon('search')}<input data-input="log-search" placeholder="Tìm trong nhật ký…" value="${escape(filter.search)}" aria-label="Tìm trong nhật ký"></label>
        <select class="select" data-change="list-field" data-list="logs" data-field="pageSize" aria-label="Số dòng mỗi trang">${[50, 100, 200, 500].map(size => `<option value="${size}" ${listState('logs').pageSize === size ? 'selected' : ''}>${size} / trang</option>`).join('')}</select>
      </div>
      <div class="chips" id="log-chips">${renderLogChips()}</div>
      <section class="card log-card"><div id="log-list" class="log-list"></div></section><div id="log-pager"></div>`;
  renderLogList();
}

function appendLog(raw) {
  const entry = normalizeLog(raw);
  state.logs.push(entry);
  if (state.logs.length > LOG_LIMIT) state.logs.shift();
  if (state.page === 'logs') {
    const list = $('#log-list');
    // Only the newest page shows new lines; older pages stay still while the pager counts them.
    if (list && logMatches(entry) && listState('logs').page === 1) {
      list.querySelector('.empty')?.remove();
      list.insertAdjacentHTML('beforeend', logRow(entry));
      while (list.children.length > listState('logs').pageSize) list.firstElementChild.remove();
      if (!state.logFilter.paused) list.scrollTop = list.scrollHeight;
    }
    const pager = $('#log-pager');
    if (pager) pager.innerHTML = listPager('logs', logPage());
    $('#log-chips').innerHTML = renderLogChips();
  } else if (state.page === 'dashboard') {
    const node = $('#dash-logs');
    if (node) node.innerHTML = renderRecentLogs();
  }
}

/* ========================================================================== */
/* Page: Cài đặt (rendered entirely from backend metadata)                     */
/* ========================================================================== */

function settingControl(item, settings) {
  const value = settings.values?.[item.key] ?? '';
  const saved = Boolean(settings.hasSecrets?.[item.key]);
  const help = item.help ? `<small>${escape(item.help)}</small>` : '';
  if (item.type === 'select') {
    const options = (item.options || []).map(([optionValue, label]) => `<option value="${escape(optionValue)}" ${String(value) === String(optionValue) ? 'selected' : ''}>${escape(label)}</option>`).join('');
    return `<label class="field"><span>${escape(item.label)}</span><select name="${escape(item.key)}">${options}</select>${help}</label>`;
  }
  if (item.secret) {
    return `<label class="field"><span>${escape(item.label)}</span>
      <input name="${escape(item.key)}" type="password" value="" autocomplete="off" placeholder="${saved ? 'Đã lưu · nhập để thay đổi' : 'Chưa cấu hình'}">
      ${saved ? `<span class="check"><input type="checkbox" name="clear:${escape(item.key)}"><span>Xóa giá trị đã lưu</span></span>` : ''}${help}</label>`;
  }
  const type = item.type === 'number' ? 'number' : 'text';
  return `<label class="field"><span>${escape(item.label)}</span><input name="${escape(item.key)}" type="${type}" ${type === 'number' ? 'min="0" step="any"' : ''} value="${escape(value)}" autocomplete="off">${help}</label>`;
}

function renderSettings() {
  const settings = state.data.settings || {};
  const {fields, sections} = settings;
  if (!Array.isArray(fields) || !Array.isArray(sections)) {
    main.innerHTML = pageHeader('Cài đặt', 'Thiết lập tài khoản, tốc độ quét và tích hợp.') + emptyState('Không có dữ liệu cài đặt', 'Backend chưa trả về danh sách trường cấu hình.');
    return;
  }
  const running = Boolean(state.data.runtime?.running);
  const groups = sections.map(section => {
    const items = fields.filter(item => item.section === section.id);
    if (!items.length) return '';
    return card(escape(section.title), `<div class="pad"><div class="settings-grid">${items.map(item => settingControl(item, settings)).join('')}</div></div>`, {description: section.description});
  }).join('');

  main.innerHTML = pageHeader('Cài đặt', 'Mọi thay đổi áp dụng cho lần vận hành tiếp theo.')
    + (running ? infoStrip('Hệ thống đang chạy nên không thể lưu cấu hình. Hãy dừng vận hành trước.', 'warning') : '')
    + infoStrip('Để trống ô bí mật sẽ giữ giá trị đã lưu. Chỉ chọn "Xóa giá trị đã lưu" khi muốn gỡ cấu hình đó.')
    + `<form id="settings-form" data-form="settings"><div id="settings-error"></div>${groups}
        <div class="sticky-bar"><span>${running ? 'Đang chạy: tạm khóa việc lưu.' : 'Chưa lưu thay đổi sẽ mất khi rời trang.'}</span>${button({label: 'Lưu cấu hình', iconName: 'check', kind: 'primary', type: 'submit', disabled: running})}</div>
      </form>`;
}

function collectSettings(form) {
  const values = {};
  const clearSecrets = [];
  for (const item of state.data.settings.fields) {
    const input = form.elements.namedItem(item.key);
    if (!input) continue;
    if (item.secret) {
      if (input.value !== '') values[item.key] = input.value;
      if (form.elements.namedItem(`clear:${item.key}`)?.checked) clearSecrets.push(item.key);
    } else {
      values[item.key] = input.value;
    }
  }
  return {values, clearSecrets};
}

/* ========================================================================== */
/* Page: Bảng lệnh                                                             */
/* ========================================================================== */

const HELP_TOPICS = [['help', 'Tổng quan'], ['groups', 'Nhóm'], ['profiles', 'Trang cá nhân'], ['add', 'Thêm nguồn'], ['posts', 'Quét & xem bài'], ['filters', 'Bộ lọc'], ['testfilter', 'Thử bộ lọc'], ['comments', 'Bình luận, inbox, kết bạn'], ['tiktok', 'TikTok'], ['affiliate', 'Shopee'], ['facebook', 'Affiliate trên Facebook'], ['status', 'Trạng thái'], ['lists', 'Lọc & tìm danh sách'], ['all', 'Tất cả']];

const CONSOLE_PLACEHOLDER = 'Sẵn sàng. Chọn lệnh ở danh sách bên phải hoặc nhập /help.\nKết quả hiển thị tại đây và không gửi tin Telegram.';

function renderConsoleLines() {
  if (!state.console.length) return `<div class="console-hint">${escape(CONSOLE_PLACEHOLDER)}</div>`;
  return state.console.map(entry => entry.command
    ? `<div class="console-command">› ${escape(entry.command)}</div>`
    : (entry.messages || []).map(renderBotMessage).join('')).join('');
}

function updateConsoleOutput() {
  const output = $('#console-output');
  if (!output) return;
  output.innerHTML = renderConsoleLines();
  output.scrollTop = output.scrollHeight;
}

function renderConsole() {
  const commands = state.data.commands || [];
  main.innerHTML = pageHeader('Bảng lệnh', 'Dùng mọi lệnh của bot ngay trên desktop.', button({label: 'Hướng dẫn /help', action: 'console-help', iconName: 'info'}))
    + `<div class="console-layout">
        <div>
          <div id="console-output" class="console-output" aria-live="polite">${renderConsoleLines()}</div>
          <form data-form="console" class="gap-top">
            <label class="field"><span id="console-label">${state.replyTo ? `Đang trả lời yêu cầu nhập #${escape(state.replyTo)}` : 'Nhập lệnh'}</span>
              <textarea name="text" id="console-input" rows="3" placeholder="/help" required></textarea>
              <small>Ctrl+Enter để thực hiện. Phím / ở bất kỳ trang nào để mở bảng lệnh.</small></label>
            <div class="row">${state.replyTo ? button({label: 'Hủy trả lời', action: 'cancel-reply'}) : ''}${button({label: 'Thực hiện lệnh', iconName: 'play', kind: 'primary', type: 'submit'})}</div>
          </form>
        </div>
        <div>
          ${card('Hướng dẫn theo chủ đề', `<div class="pad row">${HELP_TOPICS.map(([topic, label]) => button({label, action: 'help-topic', size: 'sm', data: {topic}})).join('')}</div>`)}
          ${card('Danh sách lệnh', `<div class="pad"><label class="search">${icon('search')}<input data-input="command-filter" placeholder="Lọc lệnh hoặc mô tả…" aria-label="Lọc danh sách lệnh"></label></div><div class="command-list">${commands.map(item =>
            `<button type="button" class="command-item" data-action="fill-command" data-command="${escape(item.command)}"><code>/${escape(item.command)}</code><span>${escape(item.description)}</span></button>`).join('')}</div>`)}
        </div>
      </div>`;
  const output = $('#console-output');
  output.scrollTop = output.scrollHeight;
}

/* ========================================================================== */
/* Actions (data-action) and forms (data-form)                                 */
/* ========================================================================== */

const PAGE_RENDERERS = {
  dashboard: renderDashboard,
  sources: renderSources,
  hot: renderHot,
  posts: renderPosts,
  queue: renderQueue,
  affiliate: renderAffiliate,
  logs: renderLogs,
  settings: renderSettings,
  console: renderConsole,
};

// Reloads only a list's results, keeping its toolbar (and the search box being typed in) untouched.
const LIST_RELOAD = {
  comments: () => loadQueue(state.renderToken), inboxes: () => loadQueue(state.renderToken),
  friends: () => loadQueue(state.renderToken), blocks: () => loadQueue(state.renderToken),
  posts: () => loadPosts(), rejected: () => loadPosts(), sources: () => loadSources(),
  hot: () => loadHot(), links: () => loadLinks(), joined: () => loadJoined(),
  logs: () => renderLogList(), config: () => renderConfigList(),
};

// Pages that refresh themselves every 5 s while visible.
const PAGE_REFRESH = {
  dashboard: refreshDashboard,
  queue: () => loadQueue(state.renderToken),
};

const confirmedCommand = text => () => execute(text);

const ACTIONS = {
  navigate: ({page}) => navigate(page),
  refresh: async () => { await loadBootstrap(); await renderPage(); },
  'close-modal': () => closeModal(),
  'open-external': ({url}) => rpc('openExternal', {url}),
  'copy-link': async ({url}) => { await navigator.clipboard.writeText(url); toast('Đã sao chép link.'); },
  'copy-phone': async ({phone}) => { await navigator.clipboard.writeText(phone); toast('Đã sao chép SĐT. Dán vào tìm kiếm Zalo để nhắn tin hoặc kết bạn.'); },

  // runtime and login
  'runtime-start': async () => { await rpc('runtime.start'); await reloadData(); toast('Đã bắt đầu vận hành.'); },
  'runtime-stop': async () => { await rpc('runtime.stop'); await reloadData(); toast('Đã dừng vận hành.'); },
  'login-open': async () => { await rpc('login.open', {ownerId: state.ownerId}); await reloadData(); toast('Đã mở cửa sổ Chrome. Đăng nhập Facebook rồi quay lại bấm "Hoàn tất đăng nhập".'); },
  'login-finish': async () => { await rpc('login.finish'); await reloadData(); toast('Đã lưu phiên đăng nhập Facebook.'); },
  'login-cancel': async () => { await rpc('login.cancel'); await reloadData(); },

  // sources
  'add-source': () => showAddSource(),
  'source-import': async () => {
    const text = await rpc('pickImport');
    if (text == null) return;
    const area = $('#modal textarea[name="urls"]');
    if (area) area.value = text;
  },
  'source-tab': ({type}) => { state.sourceTab = type; listState('sources').page = 1; return renderPage(); },
  'source-edit': ({id}) => showSourceEdit(id),
  'source-toggle': ({id}) => execute(`/${findSource(id)?.paused ? 'resume' : 'pause'} ${id}`),
  'source-scan': ({id}) => pressCallback(`source:scan:${id}`, 1),
  'source-posts': ({id}) => { closeModal(); state.postTab = 'accepted'; Object.assign(listState('posts'), {page: 1, filters: {source: Number(id)}}); return navigate('posts'); },
  'source-delete': ({id}) => openConfirm({title: 'Xóa nguồn?', description: `Nguồn #${id}`, text: 'Xóa nguồn, bài đã lưu và hàng đợi liên quan trong ứng dụng. Bình luận đã đăng trên Facebook vẫn còn.', confirmLabel: 'Xóa nguồn', confirmAction: 'source-delete-confirm', data: {id}}),
  'source-delete-confirm': ({id}) => execute(`/remove ${id}`),
  'source-auto': ({id}) => showTikTokAuto(id),
  'auto-off': ({id}) => execute(`/tiktokauto ${id} off`),
  'pause-all': () => execute('/pause all'),
  'resume-all': () => execute('/resume all'),
  'all-sources': () => showAllSources(),
  'source-delete-all': () => openConfirm({title: 'Xóa tất cả nguồn?', description: `${sources().length} nguồn`, text: 'Xóa mọi nguồn, bài đã lưu và hàng đợi liên quan của tài khoản đang chọn. Bình luận đã đăng trên Facebook vẫn còn.', confirmLabel: 'Xóa tất cả nguồn', confirmAction: 'source-delete-all-confirm'}),
  'source-delete-all-confirm': () => execute('/remove all'),
  'test-filter': () => showTestFilter(),
  'show-config': () => showConfigModal(),
  'default-keywords': () => showDefaultKeywords(),
  joined: () => showJoined(),
  'joined-refresh': () => loadJoined(true),
  'joined-pick': ({index}) => {
    const input = $('#modal input[name="indexes"]');
    const picked = new Set(input.value.split(/[ ,]+/).filter(value => /^d+$/.test(value)));
    picked.add(index);
    input.value = [...picked].join(',');
  },

  // paged lists
  'list-page': ({list, page}) => { listState(list).page = Number(page); return LIST_RELOAD[list](); },
  'row-remove': ({list, id, label}) => openConfirm({title: `${REMOVE[list][1] === HIDE_NOTE ? 'Ẩn' : 'Xóa'} ${REMOVE[list][0]}?`, description: label, text: REMOVE[list][1],
    confirmLabel: REMOVE[list][1] === HIDE_NOTE ? 'Ẩn' : 'Xóa', confirmAction: 'row-remove-confirm', data: {list, id}}),
  // Only the results reload, keeping page and filters; a page left empty shows the last page (the store clamps it).
  'row-remove-confirm': async ({list, id}) => {
    const result = await rpc('remove', {ownerId: state.ownerId, list, id});
    closeModal(); toast(result.message);
    await LIST_RELOAD[list]();
  },
  'row-restore': async ({list, id}) => {
    const result = await rpc('remove', {ownerId: state.ownerId, list, id, restore: true});
    toast(result.message);
    await LIST_RELOAD[list]();
  },

  // hot / posts
  'reload-hot': () => renderPage(),
  'reload-posts': () => renderPage(),
  'clear-posts': () => { state.selectedPosts.clear(); return renderPage(); },
  'post-contacts': ({url}) => execute(`/contacts ${url}`),
  'post-tab': ({tab}) => { state.postTab = tab; state.selectedPosts.clear(); return renderPage(); },
  'rejected-toggle': async () => { await execute(`/rejected ${state.data.rejectedSince != null ? 'off' : 'on'}`); return renderPage(); },
  'post-comment': ({source, post}) => showCommentForm([{sourceId: Number(source), postId: post}], false),
  'post-commentlist': ({source, post}) => showCommentForm([{sourceId: Number(source), postId: post}]),
  'post-inbox': ({source, post}) => showInboxForm(source, post),
  'post-friend': ({source, post}) => execute(`/friend ${source} ${post}`),
  'post-block-commenters': ({source, post}) => postCallback('post:block-commenters', source, post),
  'post-block-author': ({source, post}) => postCallback('rejected:block', source, post, 'rejected'),
  'post-affiliate': ({source, post}) => showPostAffiliate(Number(source), post),
  'selected-comment': () => showCommentForm([...state.selectedPosts].map(key => {
    const colon = key.indexOf(':');
    return {sourceId: Number(key.slice(0, colon)), postId: key.slice(colon + 1)};
  })),

  // queue
  'queue-tab': ({tab}) => { state.queueTab = tab; return renderPage(); },
  'queue-retry-blocks': async ({id}) => {
    const result = await rpc('retryBlocks', {ownerId: state.ownerId, ...(id ? {id: Number(id)} : {})});
    toast(result.message);
    return renderPage();
  },
  'reload-queue': () => renderPage(),
  'queue-cancel': () => {
    const scope = $('#queue-cancel-scope')?.value || 'all';
    const queue = QUEUES[state.queueTab];
    openConfirm({title: `Hủy ${queue.label.toLowerCase()} đang chờ?`, description: scope === 'all' ? 'Mọi nguồn của tài khoản đang chọn' : `Nguồn #${scope}`, text: queue.cancelNote || 'Mục đang gửi hoặc đã gửi không bị ảnh hưởng. Các chế độ tự động vẫn tiếp tục tạo mục mới cho đến khi bạn tắt.', confirmLabel: 'Hủy phần đang chờ', confirmAction: 'queue-cancel-confirm', data: {scope}});
  },
  'queue-cancel-confirm': ({scope}) => execute(`/${QUEUES[state.queueTab].cancel} ${scope}`),

  // affiliate
  'affiliate-tab': ({provider}) => { state.provider = provider; listState('links').page = 1; state.selectedLinks.clear(); return renderPage(); },
  'affiliate-check': () => execute('/tiktok check'),
  'affiliate-status': ({provider}) => execute(provider === 'tiktok' ? '/tiktok status' : '/affiliate status', {refresh: false}),
  unblock: () => execute('/unblock'),
  'help-topic': ({topic}) => execute(`/help ${topic}`, {show: state.page !== 'console', refresh: false}),
  'reload-links': () => loadLinks(),
  'selected-links': () => showSelectedLinks(),

  // logs
  'log-category': ({category}) => { state.logFilter.category = category; listState('logs').page = 1; $('#log-chips').innerHTML = renderLogChips(); renderLogList(); },
  'log-pause': () => { state.logFilter.paused = !state.logFilter.paused; renderLogs(); },
  'log-clear': () => { state.logs = []; renderLogs(); },

  // console
  'console-help': () => execute('/help', {show: false}),
  'fill-command': ({command}) => { const input = $('#console-input'); input.value = `/${command} `; input.focus(); },
  'message-callback': ({callback, message}) => pressCallback(callback, message, {show: state.page !== 'console'}),
  'reply-message': ({message}) => { state.replyTo = Number(message); closeModal(); return navigate('console'); },
  'cancel-reply': () => { state.replyTo = null; renderConsole(); },
};

const FORMS = {
  'search-rank': values => execute(`/search ${values.query.trim()}`, {refresh: false}),
  'add-source': values => {
    const urls = values.urls.trim();
    return execute(values.type === 'profile' ? `/profile ${urls} ${values.mode}` : `/add ${urls}`);
  },

  'source-edit': async (values, form) => {
    const source = findSource(form.dataset.id);
    const commands = sourceEditCommands(source, values);
    if (!commands.length) { closeModal(); toast('Cài đặt không thay đổi.'); return; }
    showResult(await executeAll(commands));
  },

  'default-keywords': async values => {
    const commands = [];
    const accept = values.keywords.trim();
    const reject = (values.rejectKeywords || '').trim();
    if (accept !== (state.data.keywords || []).join('; ')) commands.push(`/keywords ${accept || 'off'}`);
    if (reject !== (state.data.rejectKeywords || []).join('; ')) commands.push(`/reject ${reject || 'off'}`);
    if (!commands.length) { closeModal(); toast('Từ khóa không thay đổi.'); return; }
    showResult(await executeAll(commands));
  },

  comment: async (values, form) => {
    const targets = JSON.parse(form.dataset.targets);
    const commands = targets.map(target => form.dataset.list
      ? `/commentlist ${target.sourceId} ${target.postId} |\n${values.comments.trim()}`
      : `/comment ${target.sourceId} ${target.postId} | ${values.comments.trim()}`);
    const messages = await executeAll(commands);
    state.selectedPosts.clear();
    showResult(messages);
  },

  inbox: async (values, form) => showResult(await executeAll([`/inbox ${form.dataset.source} ${form.dataset.post} | ${values.text.trim()}`])),

  'all-sources': async values => showResult(await executeAll([allSourcesCommand(values)])),

  'test-filter': values => execute(`/testfilter ${values.scope} | ${values.text.trim()}`, {refresh: false}),

  'joined-select': values => execute(`/select ${values.indexes.trim()}`),

  'affiliate-convert': values => execute(`${state.provider === 'tiktok' ? '/tiktok' : '/affiliate shopee'} ${values.urls.trim()}`),
  'affiliate-top': values => execute(`/${state.provider === 'tiktok' ? 'tiktoktop' : 'affiliatetop'} ${values.count} ${values.rank} ${values.keyword.trim()}`),

  'affiliate-post': values => {
    if (!values.sourceId || !values.postId.trim()) throw new Error('Chọn nguồn và nhập ID bài viết đã lưu.');
    const command = values.provider === 'tiktok' ? 'tiktoktopcomment' : 'affiliatetopcomment';
    return execute(`/${command} ${values.sourceId} ${values.postId.trim()} ${values.count} ${values.rank} ${values.keyword.trim()}`);
  },

  'selected-links': async values => {
    if (!values.sourceId || !values.postId.trim()) throw new Error('Chọn nguồn và nhập ID bài viết đã lưu.');
    const command = state.provider === 'tiktok' ? 'tiktokcomment' : 'affiliatecomment';
    await execute(`/${command} ${values.sourceId} ${values.postId.trim()} | ${[...state.selectedLinks].join(',')}`);
    state.selectedLinks.clear();
  },

  'tiktok-auto': async values => {
    if (!values.sourceId) throw new Error('Hãy thêm nguồn Facebook trước.');
    showResult(await executeAll([
      `/groupkeywords ${values.sourceId} ${values.keywords.trim() || 'off'}`,
      `/tiktokauto ${values.sourceId} ${values.count} ${values.rank} ${values.keyword.trim()}`,
    ]));
  },

  settings: async (_values, form) => {
    const errorBox = $('#settings-error');
    errorBox.innerHTML = '';
    try {
      const saved = await rpc('settings.save', collectSettings(form));
      state.data = saved;
      state.ownerId = saved.ownerId;
      resetOwnerScope();
      await loadBootstrap();
      renderSettings();
      toast('Đã lưu cấu hình. Hệ thống vẫn đang dừng; bắt đầu vận hành khi sẵn sàng.');
    } catch (error) {
      errorBox.innerHTML = infoStrip(error.message, 'danger');
      throw error;
    }
  },

  console: async (values) => {
    const replyToMessageId = state.replyTo;
    state.replyTo = null;
    $('#console-label').textContent = 'Nhập lệnh';
    await execute(values.text.trim(), {show: false, replyToMessageId});
    $('#console-input').value = '';
  },
};

const CHANGES = {
  owner: async element => {
    state.ownerId = Number(element.value);
    resetOwnerScope();
    await loadBootstrap();
    await renderPage();
  },
  'list-field': element => {
    const current = listState(element.dataset.list), field = element.dataset.field;
    if (field.startsWith('filter:')) {
      if (element.value) current.filters[field.slice(7)] = element.value;
      else delete current.filters[field.slice(7)];
    } else current[field] = field === 'pageSize' ? Number(element.value) : element.value;
    current.page = 1;
    return LIST_RELOAD[element.dataset.list]();
  },
  'select-post': element => { element.checked ? state.selectedPosts.add(element.dataset.key) : state.selectedPosts.delete(element.dataset.key); renderPostSelection(); },
  'select-link': element => { const id = Number(element.dataset.id); element.checked ? state.selectedLinks.add(id) : state.selectedLinks.delete(id); renderLinkSelection(); },
  'log-level': element => { state.logFilter.level = element.value; listState('logs').page = 1; renderLogList(); },
};

const searchTimers = {};
const INPUTS = {
  'list-search': element => {
    const kind = element.dataset.list;
    clearTimeout(searchTimers[kind]);
    searchTimers[kind] = setTimeout(() => {
      Object.assign(listState(kind), {q: element.value, page: 1});
      guarded(() => LIST_RELOAD[kind]());
    }, 300);
  },
  'log-search': element => { state.logFilter.search = element.value; listState('logs').page = 1; renderLogList(); },
  'command-filter': element => {
    const needle = foldText(element.value.trim());
    for (const item of $('.command-item')) item.hidden = Boolean(needle) && !foldText(item.textContent).includes(needle);
  },
};

/* ========================================================================== */
/* Events                                                                      */
/* ========================================================================== */

async function guarded(task, element) {
  if (element) element.disabled = true;
  try {
    await task();
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (element?.isConnected) element.disabled = false;
  }
}

document.addEventListener('click', event => {
  if (event.target === $('#modal')) { closeModal(); return; }
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  const handler = ACTIONS[element.dataset.action];
  if (!handler) return;
  event.preventDefault();
  guarded(() => handler(element.dataset, element), element);
});

document.addEventListener('submit', event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
  event.preventDefault();
  const handler = FORMS[form.dataset.form];
  const submit = $('button[type="submit"]', form);
  if (!handler || submit?.disabled) return;
  const values = Object.fromEntries(new FormData(form));
  guarded(() => handler(values, form), submit);
});

document.addEventListener('change', event => {
  const handler = CHANGES[event.target.dataset?.change];
  if (handler) guarded(() => handler(event.target));
});

document.addEventListener('input', event => {
  const handler = INPUTS[event.target.dataset?.input];
  if (handler) handler(event.target);
});

document.addEventListener('keydown', event => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
  if (event.key === '/' && !typing && !$('#modal').open) {
    event.preventDefault();
    navigate('console').then(() => $('#console-input')?.focus());
  } else if (event.key === 'Enter' && event.ctrlKey && event.target.id === 'console-input') {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});

/* ----- Backend events and polling ------------------------------------------ */

function handleBackendEvent(payload) {
  if (!payload) return;
  if (payload.event === 'log' && payload.data) {
    appendLog(payload.data);
  } else if (payload.event === 'state' && state.data) {
    const wasRunning = state.data.runtime?.running;
    state.data.runtime = payload.data;
    renderChrome();
    const runningChanged = wasRunning !== payload.data?.running;
    if (state.page === 'dashboard' || (state.page === 'settings' && runningChanged)) renderPage();
  } else if (payload.event === 'changed') {
    scheduleSync();
  } else if (payload.event === 'error') {
    toast(payload.data?.message || 'Mất kết nối với bộ xử lý.', true);
  }
}

// Telegram/scan writes reload the open page; skipped while a modal or input is in use so nothing is lost.
let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncData, 500);
}
async function syncData() {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (!state.data || polling || document.hidden || $('#modal').open || typing) return;
  polling = true;
  try {
    await loadBootstrap();
    if (state.page === 'dashboard') await refreshDashboard({bootstrap: false});
    else if (PAGE_REFRESH[state.page]) await PAGE_REFRESH[state.page]();
    else if (blockRefresh()) await refreshBlockCards();
    else if (state.page === 'posts' || state.page === 'hot') await LIST_RELOAD[state.page]();
    else if (state.page === 'sources') await refreshSources();
  } catch (error) {
    toast(error.message, true);
  } finally {
    polling = false;
  }
}

let polling = false;
async function pollPage() {
  const refresh = PAGE_REFRESH[state.page] || blockRefresh();
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (!refresh || polling || document.hidden || $('#modal').open || typing) return;
  polling = true;
  try {
    await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    polling = false;
  }
}

async function start() {
  if (window.desktop?.onEvent) window.desktop.onEvent(handleBackendEvent);
  // Hidden windows skip polling and sync; catch up once when shown again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.data) scheduleSync(); });
  setInterval(pollPage, 5000);
  try {
    await loadBootstrap();
    await renderPage();
  } catch (error) {
    renderChrome();
    main.innerHTML = pageHeader('Chào mừng', 'Quản lý Facebook và affiliate trên thiết bị này.')
      + emptyState('Chưa kết nối được dữ liệu cục bộ', error.message, button({label: 'Thử lại', action: 'refresh', iconName: 'refresh', kind: 'primary'}));
  }
}

start();
