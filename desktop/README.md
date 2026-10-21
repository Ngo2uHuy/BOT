# Affiliate Desk cho Windows

Ứng dụng desktop dùng chung bộ quét Facebook, dữ liệu SQLite, hàng đợi bình luận
và tích hợp Shopee/TikTok của bot. Các thao tác thường dùng có biểu mẫu; bảng lệnh
nâng cao giữ lại cú pháp của bot cho những thao tác hàng loạt.

## Mở ứng dụng

Từ mã nguồn, dùng Node.js 22.13 trở lên và chạy tại thư mục dự án:

```powershell
npm.cmd install
npm.cmd run install-browser
npm.cmd run desktop
```

Đóng tiến trình bot Telegram trước khi dùng ứng dụng với cùng thư mục dữ liệu.
Ứng dụng dùng khóa `data/monitor.lock` để tránh hai tiến trình cùng quét, đăng
bình luận hoặc mở một phiên Facebook. Không xóa file khóa khi tiến trình còn chạy.

Để tạo bản Windows mang sang máy khác:

```powershell
npm.cmd run desktop:pack
```

Kết quả nằm trong `dist/AffiliateDesk-win32-x64/`. Mở `AffiliateDesk.exe`; sao chép
cả thư mục khi chuyển máy, bao gồm runtime Node và trình duyệt đi kèm.

## Dữ liệu và tài khoản

- Chạy từ mã nguồn: dùng `.env` và `data/` của thư mục dự án, hoặc `DATA_DIR` đã cấu hình.
- Chạy bản đóng gói: workspace mặc định nằm ở
  `%APPDATA%/AffiliateDesk/workspace`; cấu hình và dữ liệu nằm trong workspace này.
- Chọn ID tài khoản trong phần cài đặt. Nếu đang có dữ liệu bot, dùng đúng ID
  Telegram cũ để thấy nguồn, bài và phiên Facebook tương ứng. ID mặc định `1`
  dành cho tài khoản cục bộ mới, không tự chuyển dữ liệu của ID khác.
- Shopee/TikTok phải gắn với cùng ID chủ sở hữu đang chọn. Đổi ID không chuyển
  quyền sở hữu link affiliate hoặc nguồn đã lưu.
- Không có token Telegram: ứng dụng chạy cục bộ, không polling hay gửi tin;
  hàng đợi thông báo được giữ để bot CLI xử lý sau. Có `TELEGRAM_BOT_TOKEN`:
  khi bắt đầu vận hành, bot Telegram chạy cùng ứng dụng, dùng chung dữ liệu và
  thông báo bài mới gửi về Telegram. Lỗi Telegram (token sai, 409) chỉ chuyển
  sang chế độ cục bộ và báo ở Tổng quan.

Chọn tài khoản chỉ đổi dữ liệu đang xem và tài khoản dùng cho thao tác trong
giao diện. Nút bắt đầu hệ thống xử lý các nguồn không tạm dừng của **tất cả ID
đã cấu hình**, gồm cả hàng đợi bình luận của những ID đó.

Đăng nhập Facebook bằng cửa sổ trình duyệt của ứng dụng và hoàn tất xác minh
thủ công. Phiên được lưu riêng theo ID trong `data/profiles/`. Không nhập mật
khẩu Facebook vào bảng lệnh hoặc cấu hình affiliate. Đóng cửa sổ đăng nhập theo
hướng dẫn trước khi bắt đầu quét.

## Ba nhóm chức năng chính

### 1. Thu thập bài viết trong nhóm

Thêm một hoặc nhiều link nhóm; có thể dùng danh sách nhóm đã tham gia để chọn
nguồn. Đặt từ khóa, khoảng ngày và bật hoặc tạm dừng từng nguồn. Nút quét lại đưa
nguồn vào lượt kế tiếp; nguồn đang tạm dừng cần tiếp tục để được xử lý.

Nhóm thêm bằng link tạo mốc ở lần quét đầu. Nhóm chọn từ danh sách đã tham gia
nhận đợt bài đầu phù hợp bộ lọc. Quét theo khoảng ngày chỉ lấy lịch sử Facebook
đọc được, không bảo đảm toàn bộ lịch sử.

### 2. Affiliate TikTok · Facebook · Shopee

- Chuyển link sản phẩm thành link affiliate của tài khoản đã cấu hình.
- Lấy top theo tỷ lệ hoa hồng (`rate`) hoặc tiền hoa hồng mỗi đơn (`amount`).
- Chọn từ 1 đến 20 link, lưu kết quả rồi bình luận lên bài Facebook đã lưu.
- Chọn những link đã tạo bằng ID link trong danh sách.
- “Facebook affiliate” quản lý việc bình luận link Shopee/TikTok lên Facebook.

Lấy top hoặc chuyển link chỉ tạo dữ liệu xem trước. Thao tác bình luận mới đưa
link vào hàng đợi đăng. Mỗi link là một bình luận; nội dung trùng trên cùng bài
được bỏ qua nên số bình luận thực tế có thể ít hơn số yêu cầu.

Shopee cần Affiliate Open API Việt Nam. TikTok cần Creator API, quyền Share Link
và Publisher ID phù hợp; Creator ID không tự thay thế Publisher ID. TikTok hiện
lọc sản phẩm Việt Nam/VND. Top được xếp trong kết quả API đọc được, không phải
cam kết cao nhất toàn sàn.

Trong cài đặt, điền các trường tương ứng với tài khoản được cấp quyền:

| Tích hợp | Trường cần điền |
| --- | --- |
| Shopee | `SHOPEE_AFFILIATE_OWNER_ID`, `SHOPEE_AFFILIATE_APP_ID`, `SHOPEE_AFFILIATE_SECRET` |
| TikTok | `TIKTOK_AFFILIATE_OWNER_ID`, `TIKTOK_AFFILIATE_APP_KEY`, `TIKTOK_AFFILIATE_APP_SECRET`, `TIKTOK_AFFILIATE_ACCESS_TOKEN`, `TIKTOK_AFFILIATE_CREATOR_ID`, `TIKTOK_AFFILIATE_PUBLISHER_ID` |
| Chiến dịch TikTok, khi được yêu cầu | `TIKTOK_AFFILIATE_CAMPAIGN_ID` |

Nếu chưa dùng một tích hợp, để trống toàn bộ nhóm trường của tích hợp đó.
Tài khoản TikTok cần quyền tạo link publisher cho sản phẩm/chiến dịch tương ứng;
ứng dụng không tự đăng ký chiến dịch. Khi access token hết hạn, cập nhật token
trong cài đặt. Dùng `/tiktok check` để kiểm tra Creator sau khi lưu.

Trường bí mật đã lưu không được trả về giao diện. Để trống ô bí mật giữ nguyên
giá trị cũ; muốn xóa cần chọn thao tác xóa rõ ràng trong cài đặt.

### 3. Thu thập bài viết và reel từ trang cá nhân

Thêm nhiều link trang cá nhân và chọn **Bài viết**, **Reel** hoặc **Cả hai**.
Mỗi trang có bộ lọc từ khóa/ngày và trạng thái riêng. Kết quả dùng chung màn hình
bài đã lưu và các thao tác bình luận/affiliate.

## Bộ lọc, tự động và hàng đợi

Từ khóa cách nhau bằng `;`, khớp ít nhất một từ khóa, không phân biệt dấu hoặc
chữ hoa. Nguồn có thể dùng từ khóa mặc định, có bộ lọc riêng hoặc nhận tất cả.
Khoảng ngày dùng giờ Việt Nam; bài không xác định được ngày sẽ không qua bộ lọc ngày.

Ví dụ tự lọc bài Facebook về mỹ phẩm rồi bình luận tối đa 5 link TikTok:

```text
/groupkeywords 1 mỹ phẩm; chăm sóc da
/tiktokauto 1 5 rate mỹ phẩm
```

`1` là ID nguồn. Từ khóa ở dòng đầu lọc nội dung Facebook; từ khóa ở dòng sau
tìm sản phẩm TikTok. Chỉ áp dụng cho bài mới có ngày đăng sau thời điểm bật và
qua bộ lọc. Tắt bằng `/tiktokauto 1 off`. Đây là quét các nguồn Facebook đã thêm,
không tìm toàn Facebook hoặc tìm/bình luận video TikTok.

Tự bình luận nội dung cố định và TikTok tự động là hai chế độ độc lập; nếu bật
cả hai, một bài có thể nhận cả hai loại bình luận. Bình luận được gửi tuần tự,
cách nhau ít nhất 30 giây. Tạm dừng nguồn giữ hàng đợi; hủy chỉ tác động phần chưa
gửi. Trạng thái **chưa xác nhận** cần kiểm tra bài Facebook trước khi thử lại.

## Bảng lệnh nâng cao

Gửi `/menu` hoặc `/start` trong chat riêng với bot để mở menu cố định dưới ô
nhập tin nhắn, gồm 4 hàng × 2 cột: Nguồn theo dõi / Bài viết đã lưu,
Shopee Affiliate / TikTok Affiliate, Bình luận / Bộ lọc & Cài đặt,
Trạng thái / Hướng dẫn. Bấm trực tiếp nút để mở chức năng. Nếu đã ẩn bàn phím,
gửi `/keyboard` hoặc `/menu` để mở lại. Nút “🏠 Menu” cũng mở lại bàn phím này.

Dùng ID nguồn từ danh sách nguồn, ID bài từ bài đã lưu và ID link từ danh sách
affiliate. Các thao tác có tác động trực tiếp như `comment`, `remove` và
`tiktokauto` thực thi khi gửi lệnh.

| Nhóm | Lệnh |
| --- | --- |
| Điều hướng và hướng dẫn | `/menu`, `/sources`, `/settings ID`, `/help all`, `/cancel` |
| Nguồn nhóm | `/add LINK1 LINK2`, `/joined refresh`, `/joined 2`, `/select 1,2`, `/select all` |
| Trang cá nhân | `/profile LINK1 LINK2 all`, thay `all` bằng `posts` hoặc `reels` |
| Cấu hình và trạng thái | `/config [ID]`, `/list`, `/status`, `/whoami`, `/pause ID`, `/resume ID`, `/remove ID` |
| Từ khóa nhận / chặn | `/keywords từ 1; từ 2` (nhận), `/reject từ 1; từ 2` (chặn), `/groupkeywords ID từ 1; từ 2`, `/groupreject ID từ 1; từ 2` |
| Khoảng ngày | `/daterange ID DD/MM/YYYY DD/MM/YYYY`, `/daterange ID now`, `/daterange ID off` (mặc định khởi động từ hiện tại → tương lai) |
| Bài đã lưu | `/posts ID 1`, `/posts all 1` |
| Một nội dung | `/comment ID ID_bài \| nội dung`, `/comment ID all \| nội dung`, `/comment all \| nội dung` |
| Danh sách bình luận | `/commentlist ID ID_bài \|` rồi mỗi dòng một nội dung/link |
| Tự bình luận cố định | `/autoreply ID nội dung`, `/autoreply ID off` |
| Hàng đợi | `/comments`, `/cancelcomments ID`, `/cancelcomments all` |
| Shopee | `/affiliate status`, `/affiliate shopee LINK1 LINK2`, `/affiliatetop 5 rate từ khóa` |
| Link Shopee | `/affiliatelinks 1`, `/affiliatecomment ID ID_bài \| ID_link1,ID_link2`, `/affiliatetopcomment ID ID_bài 5 amount từ khóa` |
| TikTok | `/tiktok status`, `/tiktok check`, `/tiktok LINK1 LINK2`, `/tiktoktop 5 rate từ khóa` |
| Link TikTok | `/tiktoklinks 1`, `/tiktokcomment ID ID_bài \| ID_link1,ID_link2`, `/tiktoktopcomment ID ID_bài 5 amount từ khóa` |
| TikTok tự động | `/tiktokauto ID 5 rate từ khóa`, `/tiktokauto ID off` |

Các chỉ số của `/select` là số thứ tự trong lần lấy `/joined` gần nhất, không
phải ID nguồn. Với danh sách nhóm `.txt`/`.csv`, dùng tính năng nhập file của ứng
dụng hoặc dán nội dung vào ô thêm nguồn; file cần mã hóa UTF-8.

## Đóng ứng dụng và sao lưu

Khi Facebook trả HTTP 429 hoặc hiển thị thông báo giới hạn truy cập, bot không tạm
nghỉ 6 giờ mà tự động gọi lại liên tục đến khi thành công. Quét thường, quét lịch sử,
cập nhật bài, lấy danh sách nhóm và gửi bình luận/tin nhắn riêng sẽ tự động thử lại theo chu kỳ.
Bình luận và tin nhắn riêng chưa gửi được vẫn được giữ trong hàng đợi ở trạng thái chờ để tiếp tục gửi.

Dừng quét trước khi thay tài khoản hoặc cấu hình runtime. Chờ thao tác đang xử lý
kết thúc rồi đóng ứng dụng. Nếu cần chạy bot CLI riêng, đóng desktop và chạy
lại bot với cùng thư mục dữ liệu và ID.

Khi mọi tiến trình đã đóng, sao lưu `.env` và toàn bộ `data/` cùng nhau. Đây là
dữ liệu cục bộ chứa khóa API và phiên đăng nhập; giữ bản sao ở nơi riêng tư.

Kiểm thử tự động sử dụng dữ liệu giả lập, không thay thế kiểm tra với tài khoản
Facebook hoặc quyền API affiliate thực tế. Đăng nhập và chạy thử một nguồn để
kiểm tra phiên, quyền xem và khả năng đọc nội dung trước khi bật nhiều nguồn.
