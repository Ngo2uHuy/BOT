# 04 — Hướng dẫn sử dụng bot Telegram

Trước tiên chạy bot và đăng nhập Facebook trên máy theo [Hướng dẫn chạy Telegram](02-CHAY-TELEGRAM.md). Các lệnh trong tài liệu này được gửi trong **chat riêng với bot**.

## Menu và các loại ID

Gửi `/start` hoặc `/menu`. Ba mục chính là:

1. Thu thập bài viết trong các nhóm.
2. Affiliate TikTok · Facebook · Shopee.
3. Thu thập bài viết và reel từ các trang cá nhân.

| Loại ID | Lấy ở đâu? | Dùng để làm gì? |
| --- | --- | --- |
| ID Telegram | `/whoami` | Gắn tài khoản, phiên Facebook và quyền dùng bot |
| ID nguồn | `/list` hoặc `/sources` | Chọn nhóm/trang cá nhân cần thao tác |
| ID bài | `/posts ID_nguồn` hoặc tin thông báo bài | Chọn bài/reel để bình luận |
| ID link | `/affiliatelinks` hoặc `/tiktoklinks` | Chọn link affiliate đã lưu |
| Số thứ tự nhóm đã tham gia | Danh sách `/joined` gần nhất | Dùng với `/select`, không phải ID nguồn |

Trong ví dụ, `1` là ID nguồn và `123456789` là ID bài minh họa. Thay bằng ID thực tế; thay URL minh họa bằng link thật trước khi gửi.

## 1. Thêm và quản lý nguồn

| Nhu cầu | Lệnh |
| --- | --- |
| Thêm nhiều nhóm | `/add https://www.facebook.com/groups/nhom1 https://www.facebook.com/groups/nhom2` |
| Nhập danh sách nhóm | Gửi file `.txt`/`.csv` UTF-8 chứa URL nhóm; tối đa 1 MB |
| Xem nhóm đã tham gia | `/joined` |
| Cập nhật danh sách nhóm | `/joined refresh` |
| Xem trang tiếp theo | `/joined 2` hoặc nút ▶️ |
| Lọc/tìm nhóm đã tham gia | `/joined status:new bếp`, `/joined sort:name` |
| Chọn một số nhóm vừa liệt kê | `/select 1,2` |
| Chọn toàn bộ danh sách vừa lấy | `/select all` |
| Thêm nhiều trang cá nhân | `/profile https://www.facebook.com/trang1 https://www.facebook.com/trang2 all` |
| Chỉ quét bài viết hoặc reel | Thay `all` cuối lệnh `/profile` bằng `posts` hoặc `reels` |
| Xem nguồn và cấu hình | `/list`, `/list 2 status:error`, `/list type:profile auto:on` |
| Mở danh sách nguồn bằng nút | `/sources` |
| Cài đặt một nguồn | `/settings 1` |
| Tạm dừng/tiếp tục | `/pause 1`, `/resume 1`; dùng `all` cho mọi nguồn của bạn |
| Xóa nguồn | `/remove 1` — xóa cả bài và hàng đợi gắn với nguồn |
| Xóa một mục bất kỳ | `/delete comment 12`, `/delete post 3 1234567890` hoặc nút 🗑 dưới danh sách — xem mục "Xóa từng mục" |

Trong cài đặt nguồn có nút **Quét lại**; yêu cầu được xử lý ở lượt tiếp theo. Nhóm thêm bằng `/add` tạo mốc im lặng ở lần quét đầu nếu không đặt khoảng ngày. Trang cá nhân và nhóm chọn qua `/joined` nhận đợt bài đầu phù hợp bộ lọc.

## 2. Bộ lọc từ khóa và ngày

| Nhu cầu | Lệnh |
| --- | --- |
| **Xem toàn bộ cấu hình hiện tại** | `/config` (hoặc `/filters`) |
| **Xem cấu hình chi tiết một nguồn** | `/config 1` |
| Xem từ khóa accept và reject mặc định | `/keywords` hoặc `/reject` (gõ lệnh không kèm nội dung) |
| Từ khóa nhận (Accept) mặc định | `/keywords đồ gia dụng; nhà bếp` hoặc `/accept đồ gia dụng; nhà bếp` |
| Từ khóa nhận (Accept) riêng của nguồn | `/groupkeywords 1 mỹ phẩm; chăm sóc da` hoặc `/groupaccept 1 mỹ phẩm; chăm sóc da` |
| Đặt từ khóa nhận cho mọi nguồn | `/groupkeywords all mỹ phẩm; chăm sóc da` |
| Từ khóa loại trừ (Reject/chặn bài) mặc định | `/reject vay tiền; lừa đảo; cờ bạc` |
| Từ khóa loại trừ (Reject) riêng của nguồn | `/groupreject 1 môi giới; trung gian` |
| Đặt từ khóa loại trừ cho mọi nguồn | `/groupreject all vay tiền; lừa đảo` |
| Nhận tất cả nội dung của nguồn | `/groupkeywords 1 off` |
| Xóa chặn loại trừ của nguồn | `/groupreject 1 off` |
| Bỏ bộ lọc mặc định | `/keywords off` hoặc `/reject off` |
| Kế thừa lại từ khóa mặc định cho nguồn | `/groupkeywords 1 default` hoặc `/groupreject 1 default` (hoặc `/settings 1` → **Dùng từ khóa mặc định**) |
| Lọc theo ngày đăng | `/daterange 1 01/10/2026 09/10/2026` |
| Lọc từ một ngày đến hiện tại | `/daterange 1 01/10/2026` |
| Lọc cả giờ | `/daterange 1 01/10/2026 08:00:00 09/10/2026 18:00:00` |
| Lọc từ thời điểm hiện tại đến tương lai | `/daterange 1 now` hoặc `/daterange all now` |
| Bỏ lọc ngày | `/daterange 1 off` |

Nguyên tắc lọc ngày & từ khóa:
- **Bộ lọc ngày khởi động:** Khi khởi động hệ thống (bot hoặc desktop), bộ lọc ngày `daterange` tự động được thiết lập bắt đầu từ thời điểm hiện tại đến tương lai (`mới nhất`), giúp hệ thống chỉ thu thập bài viết mới phát sinh từ lúc chạy trở đi.
- **Từ khóa nhận (Accept):** Khớp ít nhất một từ khóa nhận (hoặc nhận tất cả bài nếu danh sách rỗng).
- **Từ khóa loại trừ (Reject):** Nếu bài viết chứa bất kỳ từ khóa loại trừ nào thì sẽ **bị bỏ qua ngay lập tức**, kể cả khi bài viết có chứa từ khóa nhận.
- Các từ khóa cách nhau bằng `;`, không phân biệt dấu/chữ hoa chữ thường. Thời gian dùng giờ Việt Nam. Bài không xác định được ngày bị bỏ qua khi có bộ lọc ngày.

## 3. Xem bài và bình luận

| Nhu cầu | Cách làm |
| --- | --- |
| Xem bài một nguồn | `/posts 1` hoặc `/posts 1 2` để xem trang 2; `/posts 1 kind:reel sort:published- máy lọc` |
| Xem bài mọi nguồn của bạn | `/posts all 1`, `/posts all type:profile`, `/posts all source:3 tủ lạnh` |
| Bình luận bằng nút | Bấm **Bình luận** dưới tin bài, trả lời tin bot yêu cầu nhập |
| Nhập nhiều bình luận bằng nút | Bấm **Danh sách bình luận**, trả lời mỗi dòng một nội dung/link |
| Bình luận bằng reply | Trả lời trực tiếp tin bài của bot bằng nội dung bình luận |
| Bình luận một bài bằng ID | `/comment 1 123456789 \| Nội dung bình luận` |
| Cùng nội dung cho nhiều bài | `/comment 1 ID_bài1,ID_bài2 \| Nội dung bình luận` |
| Cùng nội dung cho bài phù hợp trong nguồn | `/comment 1 all \| Nội dung bình luận` |
| Cùng nội dung cho bài phù hợp mọi nguồn | `/comment all \| Nội dung bình luận` |

Trong bảng Markdown, dấu `\|` biểu diễn ký tự `|`; khi gõ lệnh chỉ dùng dấu `|`.

Random nội dung (spintax): viết `{phương án 1|phương án 2|...}`, mỗi lần đăng bot chọn ngẫu nhiên một
phương án, áp dụng cho `/comment`, `/commentlist`, reply và `/autoreply`. Ví dụ
`/autoreply 1 {Chào|Hi} bạn, {inbox|ib} mình {nhé|nha}` có thể đăng "Hi bạn, inbox mình nha".
Ngoặc nhọn không có `|` (như `{name}`) được giữ nguyên.

Ví dụ danh sách 5 bình luận trên **một bài**:

```text
/commentlist 1 123456789 |
LINK_AFFILIATE_1
LINK_AFFILIATE_2
LINK_AFFILIATE_3
LINK_AFFILIATE_4
LINK_AFFILIATE_5
```

Thay mỗi dòng bằng link thật khác nhau. `/commentlist` chỉ nhận một ID bài trong mỗi lệnh. Hệ thống gửi từng bình luận, cách nhau ít nhất 30 giây và bỏ qua nội dung trùng trên cùng bài. Đọc số lượng đã xếp trong phản hồi.

Reply nội dung vào tin bài là thao tác bình luận, không phải ghi chú riêng. Bài đích phải đã được bot lưu.

## 4. Nhắn tin riêng cho người đăng (Direct Message / Messenger)

Ngoài bình luận, bot hỗ trợ gửi tin nhắn riêng trực tiếp đến trang cá nhân của người đăng bài:

| Nhu cầu | Cách làm |
| --- | --- |
| Nhắn tin bằng nút | Bấm **📩 Nhắn tin riêng** dưới tin bài trong Telegram, reply tin bot với nội dung muốn gửi |
| Nhắn tin thủ công bằng lệnh | `/inbox ID_nguồn ID_bài \| Nội dung tin nhắn` |
| Tự động nhắn khi có bài mới | `/autoinbox ID_nguồn Nội dung tin nhắn` (dùng `{name}` để chèn tên, `{link}` chèn link bài) |
| Tự động cho tất cả nguồn | `/autoinbox all Nội dung tin nhắn` |
| Tắt tự động nhắn tin | `/autoinbox ID_nguồn off` hoặc `/autoinbox all off` |
| Xem tin nhắn riêng | `/inboxes`, `/inboxes 2 state:failed`, `/inboxes mode:auto sort:name` |
| Hủy tin nhắn đang chờ | `/cancelinbox ID_nguồn` hoặc `/cancelinbox all` |

> [!NOTE]
> **Tin nhắn riêng gửi ngay lập tức**: Bot sẽ gửi tin nhắn riêng + nháy máy ngay khi phát hiện bài viết mới, không giãn cách.
> - Nếu bài viết là bài ẩn danh hoặc tác giả tắt nhận tin nhắn từ người lạ, bot sẽ ghi nhận lỗi và thông báo trạng thái về Telegram.

## 5. Affiliate Shopee và TikTok

Cần cấu hình quyền API trên máy trước; `/affiliate status` chỉ cho biết trạng thái cấu hình Shopee. `/tiktok check` kiểm tra Creator TikTok. Thông tin cấu hình được mô tả trong [README Desktop — Affiliate](../desktop/README.md).

| Việc cần làm | Shopee | TikTok |
| --- | --- | --- |
| Kiểm tra | `/affiliate status` | `/tiktok check` |
| Chuyển link sản phẩm | `/affiliate shopee LINK1 LINK2` | `/tiktok LINK1 LINK2` |
| Xem top 5 theo % | `/affiliatetop 5 rate` | `/tiktoktop 5 rate` |
| Xem top theo tiền hoa hồng | `/affiliatetop 5 amount` | `/tiktoktop 5 amount` |
| Tìm top theo từ khóa sản phẩm | `/affiliatetop 5 rate đồ gia dụng` | `/tiktoktop 5 rate mỹ phẩm` |
| Link đã lưu | `/affiliatelinks 1`, `/affiliatelinks sort:id- nồi` | `/tiktoklinks 1`, `/tiktoklinks sort:origin` |
| Bình luận link đã chọn | `/affiliatecomment 1 123456789 \| 1,2,3` | `/tiktokcomment 1 123456789 \| 1,2,3` |
| Lấy top mới rồi bình luận | `/affiliatetopcomment 1 123456789 5 rate` | `/tiktoktopcomment 1 123456789 5 rate` |

Lệnh chuyển link và xem top **chưa bình luận**. Các lệnh có `comment`, hoặc nút **Bình luận top Shopee/TikTok** rồi chọn số link, sẽ xếp bình luận lên bài Facebook.

Chọn từ 1–20 link. Top được xếp trong kết quả API đọc được: tối đa 250 sản phẩm Shopee hoặc 200 sản phẩm TikTok. Không bảo đảm cao nhất toàn sàn hoặc hoa hồng thực nhận. Số link thực tế có thể ít hơn yêu cầu nếu thiếu sản phẩm hợp lệ hoặc bị trùng.

## 5. Tự động theo bài mới

### Nội dung cố định

```text
/autoreply 1 Nội dung muốn bình luận
```

Tắt bằng `/autoreply 1 off`. Có thể dùng `all` thay ID để áp dụng cho mọi nguồn của bạn.

Tự chặn người comment: `/autoblock 1 on` (hoặc `all`) tạo lượt rà soát cho các bài accept đã lưu và mới phát hiện, không chờ gửi Telegram. Bot gọi API chặn người comment, bỏ qua người đăng và tài khoản bot; chỉ quét một lần cho mỗi bài. Nguồn tạm dừng sẽ chờ. Không xác định được người đăng thì dừng để tránh chặn nhầm. Nếu API chỉ trả trang đầu, bot báo chưa quét hết. Tắt bằng `/autoblock 1 off` sẽ dừng thao tác tiếp theo (không hủy được request đã gửi).

Xem hàng đợi chặn: `/blocks` liệt kê các lượt theo trang (`/blocks 2 state:failed mode:auto`) kèm vị trí trong hàng đợi, lý do đang chờ (hệ thống dừng, nguồn tạm dừng, hẹn giờ thử lại, tài khoản bị hoãn/nghỉ, hết ngân sách request nền, các luồng đang bận) và giờ dự kiến khi biết. `/cancelblocks 1` hoặc `/cancelblocks all` hủy lượt đang chờ/đang chạy (lượt đang chạy dừng ở lần chặn kế tiếp); không tắt tự chặn, dùng `/autoblock 1 off`. Desktop có cùng danh sách ở Hàng đợi, tab "Chặn người comment".

### Lọc bài Facebook rồi dùng link TikTok Affiliate

```text
/groupkeywords 1 mỹ phẩm; chăm sóc da
/tiktokauto 1 5 rate mỹ phẩm
```

Dòng đầu lọc nội dung **bài Facebook**, dòng sau tìm **sản phẩm TikTok** và chọn tối đa 5 link/bài. Chỉ bài mới có ngày đăng sau khi bật, qua bộ lọc, mới được tạo tác vụ. Không tìm toàn Facebook và không bình luận trực tiếp video TikTok.

Tắt bằng:

```text
/tiktokauto 1 off
```

Hai chế độ tự bình luận cố định và TikTok tự động hoạt động độc lập. Nếu chỉ muốn link affiliate, tắt nội dung cố định của nguồn đó.

## 6. Theo dõi, tạm dừng và hủy

| Mục đích | Lệnh / ý nghĩa |
| --- | --- |
| Xem toàn bộ thông tin cấu hình hiện tại | `/config` |
| Xem trạng thái quét & lỗi | `/status` |
| Xem cấu hình mọi nguồn | `/list` (10 nguồn mỗi trang) |
| Xem bình luận | `/comments`, `/comments 2 state:failed`, `/comments source:1 sort:time- hết hàng` |
| Xem lời mời kết bạn | `/friends`, `/friends state:sent` |
| Xem nguồn sôi động | `/hot` (top 10), `/hot 20`, `/hot type:group status:error sort:missed-` |
| Tạm dừng một nguồn | `/pause 1`; hàng đợi được giữ |
| Tiếp tục nguồn | `/resume 1` |
| Hủy bình luận chờ của nguồn | `/cancelcomments 1` |
| Hủy phần chờ mọi nguồn | `/cancelcomments all` |
| Tắt tạo bình luận cố định mới | `/autoreply 1 off` |
| Tắt tạo bình luận TikTok mới | `/tiktokauto 1 off` |
| Hủy phiên nhập cài đặt | `/cancel`; không phải lệnh hủy hàng đợi |
| Xem mọi hướng dẫn | `/help all` |

`pending`: chờ; `sending`: đang gửi; `sent`: đã xác nhận; `failed`: lỗi; `uncertain`: chưa xác nhận; `cancelled`: đã hủy. Với `uncertain`, kiểm tra bài Facebook trước khi thử lại để tránh gửi trùng. Hủy phần chờ không xóa bình luận đã đăng và không tự tắt mọi chế độ tự động.

### Phân trang, lọc, sắp xếp và tìm kiếm danh sách

Mọi lệnh danh sách (`/comments`, `/inboxes`, `/friends`, `/blocks`, `/posts`, `/list`, `/sources`, `/hot`, `/affiliatelinks`, `/tiktoklinks`, `/joined`) hiển thị đầy đủ theo trang, không còn giới hạn "N mục gần nhất", và dùng chung cú pháp:

```
/lệnh [trang] [khóa:giá_trị …] [sort:khóa[-]] [từ khóa tìm kiếm]
/comments 2 state:failed sort:time- hết hàng
```

- Số đứng đầu là số trang (`page:N` cũng được). Riêng `/posts` vẫn bắt đầu bằng `ID|all`; `/hot N` giữ nghĩa cũ là số nguồn mỗi trang.
- `sort:khóa` tăng dần, `sort:khóa-` giảm dần. Không ghi sort: mới nhất trước (riêng `/list` theo ID, `/hot` theo hạng, `/joined` theo thứ tự Facebook).
- Phần còn lại là từ khóa tìm, không phân biệt hoa/thường và dấu; ký tự `%`, `_` được tìm đúng nguyên văn.
- Phản hồi ghi "Trang x/y · tổng z"; nút ⏮ ◀️ ▶️ ⏭ chuyển trang và giữ nguyên bộ lọc. Bot khởi động lại thì gửi lại lệnh.
- `/sources` giữ dạng nút chọn nguồn, nhận cùng bộ lọc với `/list` (8 nguồn mỗi trang). `/config` (10 nguồn mỗi trang) và `/search` có nút chuyển trang; `/config 5` vẫn là xem nguồn #5, trang khác dùng `/config page:2 status:error`.
- Gõ sai khóa hoặc giá trị, bot báo lỗi kèm cú pháp hợp lệ của lệnh đó. Số thứ tự trong `/joined` luôn là số dùng cho `/select`, kể cả khi đang lọc.

| Lệnh | Bộ lọc | sort |
| --- | --- | --- |
| `/comments` | `state:` pending, sending, sent, failed, uncertain, cancelled · `source:ID` · `mode:` manual, auto, tiktok | id, time, state, source |
| `/inboxes`, `/friends` | `state:` như trên · `source:ID` · `mode:` manual, auto | id, time, state, name, source |
| `/blocks` | `state:` pending, running, interrupted, done, failed, stopped · `source:ID` · `mode:` manual, auto | id, time, state, source |
| `/posts` | `source:ID` · `kind:` post, reel · `type:` group, profile · `hidden:yes` (bài đã ẩn) | seen, published, author, source |
| `/list` | `type:` group, profile · `status:` active, paused, error · `auto:` on, off | id, name, scan, interval |
| `/hot` | `type:` group, profile · `status:` ok, error | rank, total, missed, interval, scan, name |
| `/affiliatelinks`, `/tiktoklinks` | — | updated, id, origin |
| `/joined` | `status:` new, added | order, name |

Desktop có cùng bộ lọc, sắp xếp, tìm kiếm và phân trang trên thanh công cụ của từng danh sách.

### Xóa từng mục

Dưới mỗi trang danh sách có nút `🗑 #ID` cho từng dòng; bấm sẽ hỏi lại (nút Xóa/Hủy), xóa xong bot vẽ lại đúng trang đang xem. Gõ lệnh cũng được (không hỏi lại):

| Danh sách | Lệnh | Kết quả |
| --- | --- | --- |
| `/comments`, `/inboxes`, `/friends` | `/delete comment\|inbox\|friend ID` | Đang chờ: hủy và xóa. Đã gửi/chưa xác nhận: chỉ ẩn khỏi danh sách, vẫn giữ để không gửi lặp; không gỡ được trên Facebook. Đang gửi: báo thử lại sau |
| `/blocks` | `/delete block ID` | Xóa lượt chặn, không bỏ chặn ai. Lượt đang chạy: dừng bằng `/cancelblocks` trước. Nguồn đang bật `/autoblock` có thể tạo lại lượt chặn cho bài còn mới |
| `/posts` | `/delete post ID_nguồn ID_bài` | Chỉ ẩn bài; bot vẫn nhớ bài nên không thông báo/tự động lại. Xem bài ẩn: `/posts all hidden:yes` (nút ♻️ để bỏ ẩn) hoặc `/unhide post ID_nguồn ID_bài` |
| Bài bị loại | `/delete rejected ID_nguồn ID_bài`, `/unhide rejected …` | Ẩn/bỏ ẩn khỏi danh sách bài bị loại trên desktop |
| `/affiliatelinks`, `/tiktoklinks` | `/delete link ID` | Xóa link khỏi thư viện; bình luận đã xếp/đã đăng giữ nguyên |
| `/list` | `/delete source ID` (như `/remove ID`) | Xóa nguồn cùng bài và hàng đợi của nguồn |

`/joined`, `/hot`, `/sources` và nhật ký không có nút xóa: đó là dữ liệu đọc lại từ Facebook hoặc tính từ nguồn, không phải bản ghi lưu riêng. Desktop có nút 🗑/Ẩn ở cùng các danh sách, dùng chung quy tắc trên.

## 7. Một lượt sử dụng mẫu

1. `/menu` → `/list`: kiểm tra nguồn và tài khoản.
2. Thêm nguồn, đặt từ khóa và ngày nếu cần.
3. `/posts 1`: xem bài đã lưu.
4. Chọn bài, nhập bình luận hoặc lấy top affiliate theo nhu cầu.
5. `/comments`: xem kết quả; `/status`: xem lỗi quét.
6. `/pause all` khi muốn ngừng các nguồn nhưng vẫn giữ bot trả lời tin nhắn.

Muốn đổi nick Facebook, xem [mục đổi tài khoản trong hướng dẫn chạy Telegram](02-CHAY-TELEGRAM.md#4-đăng-nhập-nick-facebook-khác-cho-cùng-telegram). Telegram chưa có nút đăng nhập nick Facebook mới trực tiếp.


## Thu thập thông tin liên hệ từ comment

Dùng `/contacts LINK_BÀI_HOẶC_VIDEO` để đọc comment và lấy SĐT Việt Nam, email xuất hiện trong nội dung. Ví dụ:

```text
/contacts https://www.facebook.com/groups/123/posts/456
/contacts https://www.facebook.com/tenpage/posts/456
/contacts https://www.facebook.com/tenpage/videos/789
```

Quảng cáo dùng permalink của bài viết gốc, không dùng link Ads Manager hoặc thư viện quảng cáo. Livestream dùng link video dạng `/TEN/videos/ID`. Cần đăng nhập Facebook và tài khoản có quyền xem comment. Desktop có nút **Lấy SĐT/email** trên từng bài; cũng có thể nhập lệnh trong **Bảng lệnh nâng cao**.

Kết quả gồm tên hiển thị, nội dung comment, SĐT/email và permalink comment; thông tin liên hệ có thể thuộc người khác được nhắc trong comment. SĐT được chuẩn hóa về đầu 0 và loại trùng trong cùng comment. Đây là lượt quét theo yêu cầu, tối đa 10 lượt tải comment; chỉ đọc comment/reply có permalink đang hiển thị, không đảm bảo lấy hết comment, không theo dõi livestream liên tục. Nếu Facebook thay đổi giao diện hoặc không hiển thị comment, lệnh báo không đọc được. Kết quả trả về cuộc trò chuyện/cửa sổ desktop, chưa lưu thành danh bạ hay xuất file.
