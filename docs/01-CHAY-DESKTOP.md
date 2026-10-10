# 01 — Hướng dẫn chạy ứng dụng Desktop

Tài liệu này hướng dẫn mở app, cấu hình, đăng nhập Facebook và dừng app. Cách thao tác từng chức năng nằm trong [Hướng dẫn sử dụng Desktop](03-SU-DUNG-DESKTOP.md).

## Bảng chạy nhanh

| Bạn muốn làm gì? | Thực hiện ở đâu? | Cách làm |
| --- | --- | --- |
| Mở bản Windows có sẵn | File Explorer | Mở `dist\AffiliateDesk-win32-x64\AffiliateDesk.exe` |
| Chạy từ mã nguồn | PowerShell tại `D:\Project\BOT` | `npm.cmd run desktop` |
| Đăng nhập Facebook | Trong app | Chọn tài khoản → **Đăng nhập Facebook** → hoàn tất trong trình duyệt → **Hoàn tất đăng nhập** |
| Bắt đầu quét và xử lý bình luận | **Tổng quan** | Bấm **Bắt đầu vận hành** |
| Dừng quét và gửi bình luận | **Tổng quan** | Bấm **Dừng vận hành** |
| Thay cấu hình | **Cài đặt** | Dừng vận hành, sửa các trường rồi **Lưu cấu hình** |
| Chạy lại sau khi đóng app | File Explorer | Mở lại app; kiểm tra nguồn và hàng đợi trước khi bắt đầu |
| Tạo lại bản Windows từ mã nguồn | PowerShell | `npm.cmd run desktop:pack` |

Mở app **chưa tự bắt đầu quét hoặc gửi bình luận**. Khi bấm bắt đầu, app xử lý nguồn đang bật và bình luận chờ của **mọi ID tài khoản đã cấu hình**. Bộ chọn tài khoản ở góc trên chỉ đổi dữ liệu đang xem và tài khoản dùng cho thao tác.

## A. Mở bản Windows có sẵn

1. Mở thư mục `D:\Project\BOT\dist\AffiliateDesk-win32-x64`.
2. Nhấp đúp `AffiliateDesk.exe`.
3. Vào **Cài đặt** → **ID tài khoản quản lý**. Có thể dùng ID cục bộ `1`; nếu dùng dữ liệu của bot Telegram, nhập đúng ID Telegram cũ.
4. Chọn đúng tài khoản ở góc trên, đăng nhập Facebook theo mục bên dưới.
5. Thêm nguồn ở **Nguồn thu thập**, đặt bộ lọc rồi bấm **Bắt đầu vận hành**.

Bản portable đã kèm Node và Chromium. Khi chuyển sang máy khác, sao chép **cả thư mục `AffiliateDesk-win32-x64`**, không chỉ riêng file `.exe`.

## B. Chạy từ mã nguồn

Môi trường đã dùng để kiểm thử là Node.js 24.15. Chạy các lệnh sau trong PowerShell:

```powershell
cd D:\Project\BOT
npm.cmd install
npm.cmd run install-browser
npm.cmd run desktop
```

Hai lệnh cài đặt chỉ cần cho lần đầu hoặc khi cập nhật dependencies/trình duyệt. Những lần sau chỉ cần:

```powershell
cd D:\Project\BOT
npm.cmd run desktop
```

Desktop không bắt buộc có token Telegram. Nếu cấu hình affiliate chưa dùng, để trống toàn bộ nhóm trường của nền tảng đó.

## Đăng nhập hoặc đổi nick Facebook

1. Bấm **Dừng vận hành** nếu hệ thống đang chạy.
2. Chọn đúng **ID tài khoản** ở góc trên.
3. Bấm **Đăng nhập Facebook**.
4. Trong trình duyệt vừa mở, đăng nhập và hoàn tất xác minh Facebook.
5. Nếu muốn đổi nick, đăng xuất nick cũ trong chính cửa sổ này rồi đăng nhập nick mới.
6. Quay lại app, bấm **Hoàn tất đăng nhập**.
7. Kiểm tra nguồn, tự bình luận và hàng đợi trước khi bắt đầu lại.

Mỗi ID có một thư mục phiên Facebook riêng. Đổi nick trong cùng ID **không xóa** nguồn hoặc bình luận chờ cũ. Không nhập mật khẩu Facebook vào bảng lệnh hay các ô cấu hình API.

## Dữ liệu nằm ở đâu?

| Cách chạy | Cấu hình | Dữ liệu mặc định |
| --- | --- | --- |
| Từ mã nguồn | `D:\Project\BOT\.env` | `D:\Project\BOT\data` |
| Bản `.exe` | `%APPDATA%\AffiliateDesk\workspace\.env` | `%APPDATA%\AffiliateDesk\workspace\data` |
| Đã đổi **Thư mục dữ liệu** | `.env` vẫn ở workspace tương ứng | Thư mục được đặt trong `DATA_DIR` |

Để bản `.exe` dùng dữ liệu bot cũ: đóng bot, vào **Cài đặt**, đặt **Thư mục dữ liệu** thành đường dẫn đầy đủ như `D:\Project\BOT\data`, nhập đúng ID Telegram cũ rồi lưu. Cấu hình API trong `.env` của bot không tự được nhập vào `.env` của bản `.exe`; điền các trường cần dùng trong app.

Desktop và bot Telegram **không chạy đồng thời trên cùng thư mục dữ liệu**. Desktop giữ khóa dữ liệu ngay cả khi đã bấm dừng; cần đóng cửa sổ app trước khi chuyển sang bot.

## Dừng, mở lại và sao lưu

- Dừng vận hành rồi đóng cửa sổ app; chờ tiến trình kết thúc.
- Nguồn, bài, link affiliate và hàng đợi đã lưu được giữ lại khi mở app lần sau.
- Khi mọi tiến trình đã đóng, sao lưu `.env` và toàn bộ thư mục dữ liệu, gồm `monitor.sqlite` và `profiles`.
- Desktop không nhận/gửi tin Telegram. Hàng đợi thông báo Telegram được giữ để bot xử lý khi chạy lại với cùng dữ liệu.

## Lỗi thường gặp

| Hiện tượng | Cách xử lý |
| --- | --- |
| Báo bot/app khác đang dùng dữ liệu | Đóng desktop hoặc dừng bot đang dùng cùng `DATA_DIR`; không xóa khóa khi tiến trình còn chạy |
| Đã thêm nguồn nhưng chưa có bài | Kiểm tra đăng nhập, nguồn có đang tạm dừng không, bộ lọc và nút **Bắt đầu vận hành** |
| Facebook yêu cầu xác minh | Dừng vận hành và hoàn tất thủ công trong cửa sổ đăng nhập |
| Không thấy nguồn cũ | Kiểm tra cả **ID tài khoản** và **Thư mục dữ liệu**; bản `.exe` có workspace riêng |
| Cấu hình affiliate không hợp lệ | Điền đủ nhóm trường của nền tảng đó, hoặc xóa toàn bộ nhóm nếu chưa dùng |
| Chạy từ mã nguồn nhưng thiếu Chromium | Chạy `npm.cmd run install-browser` rồi mở lại app |

Tiếp theo: [Sử dụng Desktop](03-SU-DUNG-DESKTOP.md) · [Chạy bot Telegram](02-CHAY-TELEGRAM.md).
