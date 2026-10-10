# 03 — Hướng dẫn sử dụng Desktop

Trước khi thao tác, mở app và đăng nhập Facebook theo [Hướng dẫn chạy Desktop](01-CHAY-DESKTOP.md).

## Bảng chức năng

| Màn hình | Dùng để làm gì? |
| --- | --- |
| **Tổng quan** | Xem số nguồn/bài, đăng nhập Facebook, bắt đầu hoặc dừng vận hành |
| **Nguồn thu thập** | Thêm nhóm, nhiều trang cá nhân; chỉnh từ khóa, ngày, loại bài/reel và tự bình luận |
| **Bài viết & reel** | Xem bài đã lưu, mở bài Facebook, chọn một/nhiều bài để bình luận |
| **Affiliate** | Chuyển link, tìm top Shopee/TikTok, chọn link và bình luận trên Facebook |
| **Hàng đợi bình luận** | Xem trạng thái các bình luận gần nhất, hủy phần đang chờ |
| **Nhật ký hoạt động** | Theo dõi khởi động, lỗi quét và kết quả xử lý |
| **Cài đặt** | Quản lý ID, thư mục dữ liệu, hiệu suất và thông tin API |
| **Bảng lệnh nâng cao** | Dùng các lệnh của bot ngay trong app; xem [bảng lệnh Telegram](04-SU-DUNG-TELEGRAM.md) |

## 1. Thêm nhóm Facebook

1. Chọn đúng tài khoản ở góc trên.
2. Vào **Nguồn thu thập** → **Thêm nguồn**.
3. Chọn **Nhóm Facebook**, dán một hoặc nhiều URL nhóm. Có thể nhập danh sách từ file `.txt`/`.csv` UTF-8, tối đa 1 MB.
4. Gửi biểu mẫu, đọc kết quả thêm nguồn.
5. Bấm biểu tượng cài đặt ở dòng nguồn để đặt bộ lọc.

Nút **Nhóm đã tham gia** mở kết quả trong bảng lệnh. Dùng `/select 1,2` để chọn theo **số thứ tự của danh sách vừa nhận**, hoặc `/select all`. Đây không phải ID nguồn.

Bot chỉ đọc nhóm mà phiên Facebook được quyền xem. Nhóm thêm bằng link tạo mốc ở lần quét đầu; nhóm được chọn từ danh sách đã tham gia có thể đưa vào các bài đầu tiên phù hợp bộ lọc.

## 2. Thêm nhiều trang cá nhân và reel

Trong **Thêm nguồn**, chọn **Trang cá nhân**, dán các URL và chọn:

| Chế độ | Nội dung thu thập |
| --- | --- |
| Bài viết & reel | Cả hai loại |
| Chỉ bài viết | Bài viết trên trang cá nhân |
| Chỉ reel | Reel của trang cá nhân |

Chuyển sang tab **Trang cá nhân & reel** để quản lý. Có thể chỉnh chế độ cho từng nguồn sau khi thêm. Trang cá nhân nhận đợt bài đầu phù hợp bộ lọc; số bài thực tế phụ thuộc dữ liệu Facebook tải được.

## 3. Đặt từ khóa và thời gian

Mở **Cài đặt nguồn**:

| Tùy chọn | Ý nghĩa |
| --- | --- |
| Dùng từ khóa mặc định | Kế thừa từ khóa tài khoản; chỉnh bằng nút **Từ khóa mặc định** |
| Từ khóa riêng | Bỏ chọn kế thừa, nhập ví dụ `đồ gia dụng; nhà bếp` |
| Từ khóa riêng trống | Nhận mọi nội dung của nguồn |
| Từ/đến ngày giờ | Lọc ngày đăng theo giờ Việt Nam; để trống ngày kết thúc để lấy đến hiện tại |
| Quét lại | Đưa nguồn vào lượt quét tiếp theo; vẫn cần hệ thống chạy và nguồn không tạm dừng |
| Tạm dừng | Tạm ngừng nguồn, giữ dữ liệu và bình luận chờ |
| Xóa nguồn | Xóa nguồn cùng bài và hàng đợi gắn với nguồn đó |

Từ khóa khớp ít nhất một mục, không phân biệt dấu/chữ hoa. Khi lọc ngày, bài không xác định được ngày bị bỏ qua. Bấm **Lưu cài đặt** và đọc phản hồi để biết mục nào đã được áp dụng.

## 4. Bình luận bài viết/reel

1. Vào **Bài viết & reel**, chọn nguồn hoặc xem tất cả.
2. Bấm **Bình luận** dưới một bài; hoặc đánh dấu nhiều bài rồi chọn **Bình luận bài đã chọn**.
3. Nhập mỗi dòng một nội dung hoặc một link affiliate.
4. Bấm **Xếp hàng bình luận**, đọc số lượng thực tế đã xếp.
5. Xem kết quả trong **Hàng đợi bình luận**.

Ví dụ, để tạo tối đa 5 bình luận trên mỗi bài đã chọn, dán 5 link thật khác nhau vào 5 dòng. Bình luận trùng trên cùng bài được bỏ qua. Bình luận chỉ được gửi khi hệ thống đang vận hành và nguồn được bật; khoảng cách giữa các lượt gửi ít nhất 30 giây.

## 5. Shopee và TikTok Affiliate

Trước tiên vào **Cài đặt**, điền đủ thông tin API của nền tảng cần dùng, gắn với đúng ID tài khoản. Có thể dùng các lệnh kiểm tra trong bảng lệnh: `/affiliate status` và `/tiktok check`.

| Thao tác trong Affiliate | Kết quả |
| --- | --- |
| Chuyển link sản phẩm | Tạo và lưu link affiliate; chưa bình luận |
| Lấy top, chọn số link từ 1–20 | Lấy sản phẩm phù hợp và lưu link; chưa bình luận |
| Theo tỷ lệ % (`rate`) | Xếp theo tỷ lệ hoa hồng |
| Theo tiền (`amount`) | Xếp theo tiền hoa hồng ước tính mỗi đơn |
| Chọn link đã lưu để bình luận | Chọn nguồn và ID bài đã lưu; mỗi link thành một bình luận |
| Lấy top và bình luận trên Facebook | Lấy top mới và xếp số link hợp lệ vào bài đã chọn |

Mục **Facebook** là nơi dùng link Shopee/TikTok để bình luận lên Facebook, không phải một chương trình affiliate Facebook riêng. Có thể bắt đầu từ nút **Affiliate** ngay trên thẻ bài để chọn đúng bài đích.

ID bài nằm trên thẻ bài; ID nguồn nằm trong danh sách nguồn; ID link nằm trong danh sách link đã lưu. Ba loại ID này khác nhau.

Top chỉ được xếp trong dữ liệu API đọc được; không bảo đảm cao nhất toàn sàn. Nếu yêu cầu 5 link nhưng chỉ tạo được 3 link hợp lệ, hệ thống báo số thực tế và chỉ xếp tối đa 3 bình luận. TikTok cần quyền Creator/Share Link và publisher phù hợp; hiện lọc sản phẩm VN/VND.

## 6. Tự lọc bài Facebook rồi bình luận link TikTok

Từ cài đặt nguồn, bấm **Thiết lập TikTok tự động**, hoặc mở phần tự động trong Affiliate:

1. Chọn nguồn Facebook.
2. Nhập **từ khóa bài Facebook**, ví dụ `mỹ phẩm; chăm sóc da`.
3. Chọn số link, ví dụ `5`, và tiêu chí hoa hồng.
4. Nhập **từ khóa sản phẩm TikTok**, ví dụ `mỹ phẩm`.
5. Gửi biểu mẫu, kiểm tra phản hồi và bắt đầu vận hành khi sẵn sàng.

Chế độ này áp dụng cho bài mới có ngày đăng sau thời điểm bật, phù hợp bộ lọc. Nó không tìm toàn Facebook và không tìm/bình luận trực tiếp trên video TikTok. Có thể tắt bằng nút của nguồn hoặc `/tiktokauto ID off` trong bảng lệnh.

**Tự bình luận nội dung cố định** và **TikTok tự động** là hai chế độ độc lập. Nếu bật cả hai, bài phù hợp có thể nhận cả hai loại bình luận.

## 7. Hiểu trạng thái hàng đợi

| Trạng thái dữ liệu | Ý nghĩa và cách xử lý |
| --- | --- |
| `pending` | Đang chờ; cần hệ thống chạy và nguồn được bật |
| `sending` | Đang thao tác gửi |
| `sent` | Đã xác nhận gửi |
| `failed` | Thất bại; đọc lỗi, sửa nguyên nhân trước khi yêu cầu lại |
| `uncertain` | Đã thao tác nhưng chưa xác nhận kết quả; kiểm tra bài Facebook trước khi thử lại |
| `cancelled` | Đã hủy, không còn chờ gửi |

Hủy phần chờ không xóa bình luận đã đăng và không tắt các chế độ tạo bình luận cho bài mới. Muốn dừng hẳn tự động cho một nguồn, tắt cả tự bình luận cố định và TikTok tự động nếu đang bật.

## 8. Cài đặt và thao tác hằng ngày

- Dừng vận hành trước khi lưu cấu hình hoặc đổi phiên Facebook.
- Ô bí mật để trống giữ giá trị đã lưu; dùng lựa chọn xóa rõ ràng để xóa. Nếu bỏ một tích hợp, xóa toàn bộ nhóm trường của nền tảng đó.
- Nút bắt đầu xử lý mọi nguồn đang bật của các ID đã cấu hình, không chỉ tài khoản đang xem.
- Khi kết thúc công việc, dừng vận hành và đóng app nếu cần chuyển sang bot Telegram.

Luồng dùng thường ngày: **chọn tài khoản → kiểm tra nguồn/bộ lọc → xem hàng đợi → bắt đầu → theo dõi bài và nhật ký → dừng**.
