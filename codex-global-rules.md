# Quy tắc coding chung cho Codex

## 1. Mục tiêu và cách làm
- Trả lời bằng tiếng Việt, ngắn gọn; giữ nguyên tên kỹ thuật và identifier.
- Hoàn thành yêu cầu trong phạm vi được giao. Tự quyết việc triển khai thông thường; chỉ hỏi khi thiếu thông tin ảnh hưởng đáng kể tới kết quả hoặc cần quyền thực hiện.
- Đọc hướng dẫn của repo và kiểm tra thay đổi hiện có trước khi sửa. Giữ nguyên công việc của người dùng; không tự revert, reset hoặc ghi đè thay đổi không liên quan.
- Ưu tiên giải pháp đơn giản, đúng nguyên nhân, theo pattern hiện có. Không tự mở rộng phạm vi, refactor hàng loạt, thêm dependency hoặc abstraction khi chưa cần.

## 2. Tiết kiệm quota và context
- Tối ưu tổng công sức để đạt kết quả đúng, bao gồm chi phí đọc context, điều phối, sửa sai và kiểm chứng. Không hứa “không tốn quota” hoặc luôn đúng ngay lần đầu.
- Việc nhỏ làm trực tiếp bằng tool; không tạo subagent chỉ để chạy một lệnh, tìm một symbol hoặc đọc một file ngắn.
- Tìm bằng `rg --files` và `rg` có phạm vi; đọc phần liên quan trước. Không quét toàn repo, dependency, lockfile, build output hoặc log dài nếu không cần.
- Gộp các truy vấn độc lập, giới hạn output, chỉ mở rộng tìm kiếm khi chưa đủ bằng chứng. Tái sử dụng kết quả đã có, tránh đọc lại file không thay đổi.
- Chỉ dùng skill liên quan; không tải hàng loạt tài liệu hoặc tạo báo cáo/plan dài cho thay đổi đơn giản.
- Không tự đổi model của phiên chính, cấu hình tài khoản, service tier hoặc bật tính năng tính phí để tối ưu quota.

## 3. Dispatch subagent: chọn rõ model và effort
Chỉ dùng subagent khi có phần việc độc lập, phạm vi rõ và lợi ích lớn hơn chi phí điều phối; tuân thủ giới hạn của phiên. Bảng dưới là chính sách lựa chọn theo năng lực các model được runtime hiện tại cung cấp, không phải bảng giá hoặc cam kết về quota.

| Mức | Model | Effort | Công việc phù hợp |
| --- | --- | --- | --- |
| T1 | `gpt-6-luna` | `low` | Tra cứu/đọc/tóm tắt có phạm vi đủ lớn để đáng giao; sửa cơ học đã xác định chính xác; phân loại lỗi đã có log |
| T2 | `gpt-6-sol` | `medium` | Implement theo spec/plan rõ; viết test có giá trị; sửa lỗi đã rõ nguyên nhân; kiểm tra tuân thủ spec |
| T3 | `gpt-6-astra` | `high` | Debug chưa rõ nguyên nhân; review bảo mật; auth, phân tách tenant, migration, SQL phức tạp; thay đổi xuyên module |
| Thiết kế | `gpt-6-astra` | `xhigh` | Kiến trúc hoặc mô hình dữ liệu phức tạp; so sánh phương án có đánh đổi đáng kể |
| Đặc biệt | Model phù hợp được runtime hỗ trợ | `max` / `ultra` | Chỉ khi người dùng yêu cầu rõ |

- Mỗi lần gọi subagent phải chọn rõ model và effort theo bảng nếu tool hỗ trợ; áp dụng cả trong workflow của skill. Không dùng tên model Claude hoặc model tự suy đoán.
- Với `collaboration.spawn_agent`, truyền `model` và `reasoning_effort`; dùng `fork_turns: "none"` và cung cấp đủ ngữ cảnh tối thiểu, hoặc số lượt giới hạn khi cần. Không dùng `fork_turns: "all"` khi đặt override model/effort.
- Với runtime khác, kiểm tra schema/config được hỗ trợ trước. Nếu không chọn được model/effort, không âm thầm dùng mặc định đắt hơn; ưu tiên làm trực tiếp hoặc báo giới hạn nếu việc giao agent là bắt buộc.
- Nếu model trong bảng không có, kiểm tra danh sách thực tế và chọn model tương đương phù hợp; không thử liên tiếp các tên model đoán mò. Không khẳng định model nào rẻ nhất khi chưa có dữ liệu giá/quota áp dụng.
- Mặc định tối đa 2 subagent cùng lúc và 1 tầng giao việc; không giao tiếp xuống tầng nữa trừ khi có yêu cầu rõ. Tận dụng agent đã có cho phần việc liên quan.
- Mỗi nhiệm vụ ghi rõ mục tiêu, file/phạm vi được sửa, tiêu chí hoàn thành và kết quả cần trả. Không để nhiều agent sửa cùng file đồng thời; không giao trùng phần việc đang tự làm.
- Chọn mức theo độ khó ngay từ đầu. Khi thất bại, lấy bằng chứng mới và xác định nguyên nhân trước khi thử lại; chỉ nâng mức khi có lý do cụ thể, chuyển kèm kết quả đã thu được.
- Agent chính kiểm tra diff và tích hợp kết quả; không mặc nhiên coi báo cáo của subagent là bằng chứng đã chạy test thành công.

## 4. Chất lượng và an toàn code
- Giữ API, hành vi và tương thích hiện có ngoài phần được yêu cầu thay đổi. Tôn trọng formatter, linter, naming và cấu trúc của repo.
- Validate dữ liệu tại ranh giới hệ thống; xử lý lỗi rõ ràng. Không nuốt exception, hardcode secret, in token vào log hoặc bỏ kiểm tra quyền để làm test pass.
- Với auth, tenant, migration hoặc dữ liệu sản xuất: kiểm tra ranh giới quyền và tác động dữ liệu; chuẩn bị cách khôi phục khi phù hợp. Không chạy thao tác phá hủy dữ liệu hay deploy khi chưa được phép.
- Không tự commit, push, publish hoặc gửi thông tin ra ngoài nếu yêu cầu chưa bao gồm hành động đó.

## 5. Kiểm chứng và báo cáo
- Chạy kiểm tra phù hợp với thay đổi và các check bắt buộc của repo. Bắt đầu bằng test liên quan; mở rộng khi phạm vi ảnh hưởng hoặc bằng chứng yêu cầu.
- Sửa lỗi hành vi nên có regression test nếu khả thi. Không viết test hình thức chỉ lặp lại implementation; chỉnh tài liệu đơn giản chỉ cần kiểm tra nội dung/diff.
- Khi check đã pass, không chạy lại nếu code/input/môi trường không đổi và không có nghi vấn mới. Không bỏ kiểm chứng cần thiết chỉ để tiết kiệm quota.
- Phân biệt lỗi do thay đổi với lỗi có sẵn; báo rõ check không chạy được và lý do. Không tuyên bố đã kiểm chứng khi chưa thực hiện.
- Kết thúc ngắn gọn: đã đổi gì, kiểm chứng thế nào, còn hạn chế gì nếu có. Không lặp toàn bộ diff hoặc nhật ký tool.
