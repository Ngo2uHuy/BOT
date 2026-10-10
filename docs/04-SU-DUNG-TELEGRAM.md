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
| Xem trang tiếp theo | `/joined 2` |
| Chọn một số nhóm vừa liệt kê | `/select 1,2` |
| Chọn toàn bộ danh sách vừa lấy | `/select all` |
| Thêm nhiều trang cá nhân | `/profile https://www.facebook.com/trang1 https://www.facebook.com/trang2 all` |
| Chỉ quét bài viết hoặc reel | Thay `all` cuối lệnh `/profile` bằng `posts` hoặc `reels` |
| Xem nguồn và cấu hình | `/list` |
| Mở danh sách nguồn bằng nút | `/sources` |
| Cài đặt một nguồn | `/settings 1` |
| Tạm dừng/tiếp tục | `/pause 1`, `/resume 1`; dùng `all` cho mọi nguồn của bạn |
| Xóa nguồn | `/remove 1` — xóa cả bài và hàng đợi gắn với nguồn |

Trong cài đặt nguồn có nút **Quét lại**; yêu cầu được xử lý ở lượt tiếp theo. Nhóm thêm bằng `/add` tạo mốc im lặng ở lần quét đầu nếu không đặt khoảng ngày. Trang cá nhân và nhóm chọn qua `/joined` nhận đợt bài đầu phù hợp bộ lọc.

## 2. Bộ lọc từ khóa và ngày

| Nhu cầu | Lệnh |
| --- | --- |
| Từ khóa mặc định cho tài khoản | `/keywords đồ gia dụng; nhà bếp` |
| Từ khóa riêng của nguồn | `/groupkeywords 1 mỹ phẩm; chăm sóc da` |
| Đặt riêng cho mọi nguồn hiện có | `/groupkeywords all mỹ phẩm; chăm sóc da` |
| Nhận tất cả nội dung của nguồn | `/groupkeywords 1 off` |
| Bỏ bộ lọc mặc định | `/keywords off` |
| Kế thừa lại từ khóa mặc định | `/settings 1` → **Dùng từ khóa mặc định** |
| Lọc theo ngày đăng | `/daterange 1 01/10/2026 09/10/2026` |
| Lọc từ một ngày đến hiện tại | `/daterange 1 01/10/2026` |
| Lọc cả giờ | `/daterange 1 01/10/2026 08:00:00 09/10/2026 18:00:00` |
| Bỏ lọc ngày | `/daterange 1 off` |

Từ khóa cách nhau bằng `;`, khớp ít nhất một từ, không phân biệt dấu/chữ hoa. Thời gian dùng giờ Việt Nam. Bài không xác định được ngày bị bỏ qua khi có bộ lọc ngày.

## 3. Xem bài và bình luận

| Nhu cầu | Cách làm |
| --- | --- |
| Xem bài một nguồn | `/posts 1` hoặc `/posts 1 2` để xem trang 2 |
| Xem bài mọi nguồn của bạn | `/posts all 1` |
| Bình luận bằng nút | Bấm **Bình luận** dưới tin bài, trả lời tin bot yêu cầu nhập |
| Nhập nhiều bình luận bằng nút | Bấm **Danh sách bình luận**, trả lời mỗi dòng một nội dung/link |
| Bình luận bằng reply | Trả lời trực tiếp tin bài của bot bằng nội dung bình luận |
| Bình luận một bài bằng ID | `/comment 1 123456789 \| Nội dung bình luận` |
| Cùng nội dung cho nhiều bài | `/comment 1 ID_bài1,ID_bài2 \| Nội dung bình luận` |
| Cùng nội dung cho bài phù hợp trong nguồn | `/comment 1 all \| Nội dung bình luận` |
| Cùng nội dung cho bài phù hợp mọi nguồn | `/comment all \| Nội dung bình luận` |

Trong bảng Markdown, dấu `\|` biểu diễn ký tự `|`; khi gõ lệnh chỉ dùng dấu `|`.

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

## 4. Affiliate Shopee và TikTok

Cần cấu hình quyền API trên máy trước; `/affiliate status` chỉ cho biết trạng thái cấu hình Shopee. `/tiktok check` kiểm tra Creator TikTok. Thông tin cấu hình được mô tả trong [README Desktop — Affiliate](../desktop/README.md).

| Việc cần làm | Shopee | TikTok |
| --- | --- | --- |
| Kiểm tra | `/affiliate status` | `/tiktok check` |
| Chuyển link sản phẩm | `/affiliate shopee LINK1 LINK2` | `/tiktok LINK1 LINK2` |
| Xem top 5 theo % | `/affiliatetop 5 rate` | `/tiktoktop 5 rate` |
| Xem top theo tiền hoa hồng | `/affiliatetop 5 amount` | `/tiktoktop 5 amount` |
| Tìm top theo từ khóa sản phẩm | `/affiliatetop 5 rate đồ gia dụng` | `/tiktoktop 5 rate mỹ phẩm` |
| Link đã lưu | `/affiliatelinks 1` | `/tiktoklinks 1` |
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
| Xem trạng thái quét | `/status` |
| Xem 20 bình luận gần nhất | `/comments` |
| Tạm dừng một nguồn | `/pause 1`; hàng đợi được giữ |
| Tiếp tục nguồn | `/resume 1` |
| Hủy bình luận chờ của nguồn | `/cancelcomments 1` |
| Hủy phần chờ mọi nguồn | `/cancelcomments all` |
| Tắt tạo bình luận cố định mới | `/autoreply 1 off` |
| Tắt tạo bình luận TikTok mới | `/tiktokauto 1 off` |
| Hủy phiên nhập cài đặt | `/cancel`; không phải lệnh hủy hàng đợi |
| Xem mọi hướng dẫn | `/help all` |

`pending`: chờ; `sending`: đang gửi; `sent`: đã xác nhận; `failed`: lỗi; `uncertain`: chưa xác nhận; `cancelled`: đã hủy. Với `uncertain`, kiểm tra bài Facebook trước khi thử lại để tránh gửi trùng. Hủy phần chờ không xóa bình luận đã đăng và không tự tắt mọi chế độ tự động.

## 7. Một lượt sử dụng mẫu

1. `/menu` → `/list`: kiểm tra nguồn và tài khoản.
2. Thêm nguồn, đặt từ khóa và ngày nếu cần.
3. `/posts 1`: xem bài đã lưu.
4. Chọn bài, nhập bình luận hoặc lấy top affiliate theo nhu cầu.
5. `/comments`: xem kết quả; `/status`: xem lỗi quét.
6. `/pause all` khi muốn ngừng các nguồn nhưng vẫn giữ bot trả lời tin nhắn.

Muốn đổi nick Facebook, xem [mục đổi tài khoản trong hướng dẫn chạy Telegram](02-CHAY-TELEGRAM.md#4-đăng-nhập-nick-facebook-khác-cho-cùng-telegram). Telegram chưa có nút đăng nhập nick Facebook mới trực tiếp.
