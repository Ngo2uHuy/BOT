# 02 — Hướng dẫn chạy bot Telegram

Bot chạy trên máy Windows; bạn điều khiển bằng chat riêng trên Telegram. Máy và tiến trình bot cần tiếp tục hoạt động để quét, gửi thông báo và xử lý bình luận.

## Bảng chạy nhanh

| Việc cần làm | Nơi thực hiện | Lệnh/thao tác |
| --- | --- | --- |
| Cài dependencies | PowerShell | `npm.cmd install` |
| Cài Chromium | PowerShell | `npm.cmd run install-browser` |
| Điền token và ID được phép dùng | File `.env` trên máy | `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_IDS` |
| Đăng nhập Facebook | PowerShell + cửa sổ Facebook | `npm.cmd run login -- --user-id 123456789` — thay số bằng ID thật |
| Khởi động bot | PowerShell | `npm.cmd start` |
| Mở menu | Chat riêng với bot trên Telegram | `/start` hoặc `/menu` |
| Lấy ID Telegram của mình | Chat riêng với bot đang chạy | `/whoami` |
| Dừng tiến trình bot | PowerShell đang chạy bot | Nhấn `Ctrl+C` |
| Tạm dừng các nguồn, vẫn giữ bot online | Telegram | `/pause all` |
| Tiếp tục các nguồn | Telegram | `/resume all` |

Các khối `powershell` được chạy **trên máy**, các khối `text` được gửi **trong chat Telegram**.

## 1. Chuẩn bị lần đầu

Đóng desktop nếu đang dùng cùng dữ liệu. Môi trường đã kiểm thử dùng Node.js 24.15.

```powershell
cd D:\Project\BOT
npm.cmd install
npm.cmd run install-browser
if (!(Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
notepad .env
```

Điền token của bot và ID Telegram được phép dùng. Nếu chưa có bot/token, tạo bot qua tài khoản chính thức `@BotFather` trên Telegram. Ví dụ cấu hình dưới đây có giá trị minh họa, cần thay bằng thông tin thật:

```dotenv
TELEGRAM_BOT_TOKEN=TOKEN_BOT_CUA_BAN
ALLOWED_TELEGRAM_USER_IDS=123456789
DATA_DIR=./data
```

Nhiều người dùng: ghi các ID cách nhau bằng dấu phẩy. Đây là **ID người dùng Telegram dạng số**, không phải username, số điện thoại hay ID Facebook.

Nếu chưa biết ID của mình: điền token thật, tạm giữ ID số mẫu trong `.env.example`, chạy bot và gửi `/whoami` trong chat riêng. Lệnh này hoạt động trước bước kiểm tra danh sách cho phép. Sau đó nhấn `Ctrl+C`, thay ID mẫu bằng ID vừa nhận rồi tiếp tục đăng nhập Facebook.

Shopee/TikTok là tùy chọn. Để trống toàn bộ trường của nền tảng chưa dùng; không gửi token, secret hoặc cookie qua Telegram.

## 2. Đăng nhập Facebook trên máy

Thay `123456789` bằng ID Telegram đã cấu hình:

```powershell
cd D:\Project\BOT
npm.cmd run login -- --user-id 123456789
```

1. Đăng nhập Facebook và hoàn tất xác minh trong trình duyệt vừa mở.
2. Kiểm tra tài khoản đã vào được Facebook.
3. Quay lại PowerShell, nhấn **Enter** khi chương trình yêu cầu.
4. Chờ thông báo đã lưu phiên.

Mỗi ID Telegram có một phiên Facebook riêng trong `DATA_DIR\profiles`. Nếu có nhiều ID, đăng nhập lần lượt cho từng ID sẽ sử dụng.

## 3. Chạy và mở menu Telegram

```powershell
cd D:\Project\BOT
npm.cmd start
```

Giữ cửa sổ PowerShell này mở. Trong chat riêng với bot, gửi:

```text
/start
/status
```

`npm.cmd start` khởi động việc xử lý các nguồn đang bật và hàng đợi đã có. `/start` trong Telegram chỉ mở menu; nó không bật máy hoặc khởi động tiến trình đã tắt.

Các thao tác sử dụng tiếp theo nằm trong [Hướng dẫn sử dụng Telegram](04-SU-DUNG-TELEGRAM.md).

## 4. Đăng nhập nick Facebook khác cho cùng Telegram

Bot hiện **không có lệnh đăng nhập/đổi nick Facebook trực tiếp trong Telegram**. Thực hiện:

1. Trong Telegram gửi `/pause all`, xem `/comments`. Nếu muốn bỏ các bình luận đang chờ, gửi `/cancelcomments all`.
2. Trên máy nhấn `Ctrl+C` để dừng bot. Đóng desktop nếu đang mở cùng dữ liệu.
3. Chạy lại lệnh login với **cùng ID Telegram**:

   ```powershell
   npm.cmd run login -- --user-id 123456789
   ```

4. Trong cửa sổ Facebook, đăng xuất nick cũ rồi đăng nhập nick mới, hoàn tất xác minh.
5. Quay lại PowerShell nhấn **Enter**, sau đó chạy `npm.cmd start`.
6. Trong Telegram xem `/list`, kiểm tra nguồn và chế độ tự động, rồi `/resume ID` cho nguồn cần chạy.

Nguồn, bài và chế độ tự bình luận cũ vẫn gắn với ID Telegram đó. Đổi nick Facebook không tự xóa chúng; nick mới phải có quyền xem các nguồn được tiếp tục.

## 5. Dừng và chạy lại

| Trạng thái mong muốn | Cách làm |
| --- | --- |
| Bot vẫn trả lời Telegram nhưng tạm ngừng nguồn | `/pause all` |
| Hủy bình luận chờ | `/cancelcomments all`; các chế độ tự động vẫn có thể tạo bình luận cho bài mới khi tiếp tục |
| Tắt hẳn bot | `Ctrl+C` ở terminal |
| Khởi động lại sau khi sửa `.env` | `Ctrl+C`, sau đó `npm.cmd start` |
| Chuyển sang desktop | Dừng bot, mở app với đúng thư mục dữ liệu và ID |

## Lỗi thường gặp

| Hiện tượng | Kiểm tra |
| --- | --- |
| Bot không trả lời | Máy/terminal có đang chạy `npm.cmd start` không; có mở đúng bot và chat riêng không |
| Chỉ `/whoami` hoạt động | ID của bạn đã nằm trong `ALLOWED_TELEGRAM_USER_IDS` chưa; đã khởi động lại sau khi sửa chưa |
| Token không hợp lệ | Sửa `TELEGRAM_BOT_TOKEN` trong `.env`; không gửi token vào chat |
| Bot báo đang dùng webhook | Tiến trình polling không tự gỡ webhook; dùng bot riêng hoặc quản trị webhook hiện có trước |
| Báo dữ liệu/phiên đang được sử dụng | Đóng app desktop và tiến trình bot trùng; không chạy hai tiến trình cùng `DATA_DIR` |
| Facebook hết phiên hoặc yêu cầu xác minh | Dừng bot và chạy lại lệnh login cho đúng ID |
| Không có bài mới | Kiểm tra `/list`, bộ lọc và quyền xem; nhóm thêm bằng `/add` thường tạo mốc im lặng ở lần quét đầu |

Tiếp theo: [Sử dụng Telegram](04-SU-DUNG-TELEGRAM.md) · [Chạy Desktop](01-CHAY-DESKTOP.md).
