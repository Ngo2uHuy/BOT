# Chặn người đăng từ thông báo rejected

Payload cũ trả lỗi `missing_required_variable_value`. Đã sửa theo variables
khôi phục từ `.replay/facebook/requests-facebook-19976-1792250187700.json`
của công cụ drag: dùng `input.user_id`, `blocksource`,
`should_apply_to_later_created_profiles`, các biến collection/section,
`isPrivacyCheckupContext` và biến Relay đúng như request gốc.
Actor và người bị chặn luôn lấy từ phiên/tác giả hiện tại, không dùng ID capture.
Chưa gọi thử mutation trên tài khoản thật sau sửa. Các lần cũ có trạng thái
`uncertain` được giữ nguyên, không tự gửi lại.

Bật `/rejected on` để nhận thông báo bài bị loại theo từ khóa. Thông báo mới có
nút duy nhất **Chặn người đăng**. Link bài viết vẫn có trong nội dung thông báo.
Nút kiểm tra thông báo thuộc tài khoản Telegram đang thao tác; bài ẩn danh hoặc
thiếu link tác giả sẽ báo không xác định được người đăng.

Nút gọi API bằng phiên Facebook của chủ tài khoản Telegram. Capture `facebook-block-2026-10-19T13-57-47-783Z-27216.json` (trình duyệt tự chặn, cùng variables) trả
`{"data":{"user_block":{"viewer":{}}}}` không kèm lỗi: bot coi đây là xác nhận đã chặn. Ngoài ra, khi có phản hồi
`data.user_block.blocked_user.id` đúng người đăng thì nút đổi thành **Đã chặn người đăng**.
`data.user_block: null` kèm lỗi `missing_required_variable_value` không đủ xác nhận
thành công; giữ `uncertain`, không tự gửi lại.
Lưu trạng thái theo chủ tài khoản và tác giả để tránh gửi lặp khi bấm nhiều lần.
Kết quả không rõ được giữ là `uncertain`, không tự gửi lại, kể cả sau khởi động lại.
Cần link tác giả dạng ID số; username hoặc tác giả ẩn danh chưa được hỗ trợ.
Tin rejected cũ chưa có nút không được bổ sung nút tự động vì không lưu message ID.
Nút thủ công đã gửi ở phiên bản trước sử dụng cùng callback và sẽ gọi luồng mới sau
khi khởi động lại bot; các nút phụ cũ được thay bằng một nút khi chặn thành công.

Capture `facebook-apis-2026-10-17T15-16-27-699Z-19976.json` ghi nhận
`ProfileCometActionBlockUserMutation`, document ID `27871511059188774`.
Catalog không lưu variables hoặc response body; file replay cùng phiên có
request đầy đủ và đã dùng để đối chiếu variables. Tests dùng response mô phỏng,
không chứng minh Facebook chặn thành công. HTTP 200 không kèm một trong các
xác nhận mô tả phía trên sẽ báo chưa xác nhận.
Nếu API từ chối hoặc trả cấu trúc khác, cần Request Payload và Response thực tế
đã loại bỏ cookie/token để đối chiếu; không tự thử nhiều payload hoặc retry mutation.

## Đối chiếu với autoblock

Cả hai luồng dùng `FacebookCollector.blockUser` và cùng mutation. Nút reject
chặn trực tiếp tác giả; autoblock phải đọc bình luận, loại người đăng/bot và
xử lý từng người qua hàng đợi ưu tiên thấp. ID tác giả ẩn danh nếu được cung cấp
chỉ dùng để loại trừ, không dùng để chặn hoặc suy ra danh tính thật.

Khi hết ngân sách dành cho tác vụ nền, job ghi lý do hoãn và thời điểm thử lại,
không giữ worker chờ liên tục. Lỗi đọc/chặn được lưu cùng job. Đọc chưa hết
bình luận hoặc còn kết quả chưa xác nhận không được báo hoàn tất toàn bộ.
