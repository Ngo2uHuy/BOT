# Bot Telegram theo dõi nhóm Facebook

Prototype chạy trên máy của bạn: gửi link nhóm Facebook hoặc file chứa nhiều link vào Telegram; bot kiểm tra nhóm định kỳ, lọc từ khóa và khoảng ngày đăng. Thông báo có tên nhóm, nội dung, ngày đăng, link bài và link trang cá nhân người đăng khi Facebook cung cấp; không hiển thị số cảm xúc, bình luận, chia sẻ. Bot gửi kèm ảnh/video và hỗ trợ đăng bình luận Facebook từ Telegram.

**Chưa kiểm thử tích hợp với tài khoản Facebook và nhóm thực tế.** Cần đăng nhập bằng tài khoản của bạn và chạy thử một nhóm mẫu để kiểm tra selector, quyền truy cập, nội dung, ngày đăng và link người đăng trước khi sử dụng thường xuyên.

## Menu và thao tác bằng nút

- `/start` hoặc `/menu`: mở menu gồm Thêm nguồn, Quản lý nguồn, Quét & xem bài,
  Bộ lọc & cài đặt, Bình luận & link, Trạng thái.
- `/sources`: chọn nguồn trong danh sách có phân trang; `/settings ID`: mở thẳng
  cài đặt nguồn đó. Chỉnh từ khóa, ngày và tự bình luận bằng cách trả lời tin
  hướng dẫn của bot. Phiên nhập tồn tại 30 phút và hết khi bot khởi động lại;
  cài đặt đã lưu được giữ trong cơ sở dữ liệu. `/cancel` hủy phiên nhập cài đặt.
- Mỗi nguồn có nút xem bài, yêu cầu quét lại, tạm dừng/tiếp tục và dùng lại từ
  khóa mặc định. Trang cá nhân có thêm lựa chọn bài viết, reel hoặc cả hai.
  Yêu cầu quét được xử lý ở lượt tiếp theo; nguồn đang tạm dừng cần tiếp tục trước.
- Dưới tin bài, bấm **Bình luận** để gửi một nội dung, hoặc **Danh sách bình luận**
  để nhập mỗi dòng một nội dung/link. Trả lời đúng tin bot yêu cầu; không cần gõ ID.
  Chế độ danh sách của tin yêu cầu vẫn được giữ sau khi khởi động lại bot.
- `/help` mở menu, `/help all` xem toàn bộ hướng dẫn theo nhóm. Có thể mở riêng
  `/help add`, `/help posts`, `/help filters`, `/help comments`, `/help status`.
  Các lệnh cũ vẫn hoạt động. Các lệnh trả lời tin bài không được đăng thành bình luận.

## Chuyển link Shopee Affiliate

### Tự tìm sản phẩm hoa hồng cao rồi bình luận

Không cần nhập sẵn link sản phẩm. Bot gọi `productOfferV2` bằng App ID/Secret
của tài khoản đã cấu hình, lấy `offerLink` do Shopee trả về, loại sản phẩm hết
hạn/chưa bắt đầu, hoa hồng không hợp lệ hoặc bằng 0 và sản phẩm/link trùng.

```text
/affiliatetop 5
/affiliatetop 5 amount
/affiliatetop 5 rate đồ gia dụng
/affiliatetopcomment 1 123456789 5
/affiliatetopcomment 1 123456789 3 amount đồ gia dụng
```

- `/affiliatetop`: chỉ xem và lưu link; không bình luận.
- `/affiliatetopcomment`: lấy dữ liệu mới, chọn tối đa số link yêu cầu và xếp
  mỗi link thành một bình luận vào bài/reel chỉ định. Chọn từ 1 đến 20 link.
  Số đầu là ID nguồn trong `/list`, tiếp theo là ID bài trong `/posts ID_nguồn`.
- `rate` (mặc định): xếp theo tỷ lệ hoa hồng %. `amount`: xếp theo số tiền hoa
  hồng ước tính mỗi đơn, tính bằng đồng Việt Nam theo trường `commission` API.
  Có thể thêm từ khóa sản phẩm sau tiêu chí.
- Nút **Bình luận top hoa hồng** dưới tin bài mở lựa chọn 1, 3, 5 hoặc 10 link
  theo % hoặc tiền. Bấm lựa chọn sẽ tự lấy top và xếp bình luận.

Shopee mô tả `sortType: 5` là tỷ lệ hoa hồng giảm dần. Bot đọc tối đa 5 trang,
mỗi trang 50 kết quả rồi xếp hạng trong dữ liệu đó; đặc biệt `amount` không
được coi là top tiền hoa hồng của toàn sàn. Bot báo số kết quả đã đọc, có còn
trang chưa quét hay không và số link thực tế xếp được. Không tự bổ sung sản
phẩm ngoài kết quả nếu thiếu link. Hoa hồng hiển thị là ước tính từ API, không
phải cam kết hoa hồng thực nhận. Không dùng link sản phẩm gốc thay `offerLink`.

Chống trùng nội dung bình luận hiện có vẫn áp dụng: yêu cầu 5 link có thể xếp
ít hơn nếu đã bình luận các link đó hoặc chỉ tìm được ít sản phẩm hợp lệ.
`/comments`, `/pause ID_nguồn` và `/cancelcomments ID_nguồn` vẫn dùng chung.

### Cấu hình tài khoản và chuyển link nhập tay

Tích hợp tạo link bằng Shopee Affiliate Open API Việt Nam. App ID và Secret
lấy từ tài khoản Affiliate có quyền Open API, không dùng khóa API của tài khoản
người bán. Xem [trang Open API Shopee](https://affiliate.shopee.vn/open_api/list).
Định dạng mutation `generateShortLink` và chữ ký được đối chiếu với mã tạo
request trong [API Explorer chính thức](https://open-api.affiliate.shopee.vn/explorer/v2).

Điền ba giá trị trong `.env` **trên máy chạy bot**, không gửi khóa qua Telegram:

```dotenv
SHOPEE_AFFILIATE_OWNER_ID=ID_TELEGRAM_CUA_BAN
SHOPEE_AFFILIATE_APP_ID=APP_ID_CUA_BAN
SHOPEE_AFFILIATE_SECRET=SECRET_CUA_BAN
```

ID Telegram lấy bằng `/whoami` và phải nằm trong `ALLOWED_TELEGRAM_USER_IDS`.
Mỗi máy chạy bot hiện cấu hình một tài khoản Shopee gắn với một ID Telegram;
người dùng khác không được sử dụng tài khoản đó. Bỏ trống cả ba biến để tắt
tích hợp mà vẫn dùng các chức năng Facebook bình thường. `.env` được bỏ qua
bởi `.gitignore`. Khởi động lại bot sau khi cấu hình.

1. `/affiliate status`: kiểm tra đã cấu hình cho đúng ID Telegram hay chưa.
   Trạng thái này chưa xác nhận khóa hợp lệ; chuyển thử một link để kiểm tra.
2. Chuyển các link sản phẩm, tối đa 20 link mỗi lệnh:

   ```text
   /affiliate shopee https://shopee.vn/product/SHOP_ID/ITEM_ID
   https://s.shopee.vn/LINK_SAN_PHAM
   ```

   Thay phần ví dụ bằng link thật. Tách link bằng khoảng trắng/xuống dòng.
   Bot kiểm tra toàn bộ đầu vào trước khi gọi API, bỏ link trùng, tạo từng link
   và báo riêng kết quả thành công/thất bại. Giữ nguyên tham số link đầu vào.
   Chỉ nhận HTTPS trên Shopee Việt Nam, `s.shopee.vn` và `shope.ee`.
3. `/affiliatelinks [trang]`: xem link đã tạo cùng ID link; mỗi trang 10 link.
   Kết quả được lưu trong SQLite và tách theo người dùng/tài khoản App ID.
4. Đưa các link chỉ định vào bình luận, theo thứ tự bạn chọn:

   ```text
   /affiliatecomment 1 123456789 | 1,2,3,4,5
   ```

   `1` trước ID bài là ID nguồn trong `/list`; `123456789` là ID bài/reel đã
   lưu trong `/posts 1`; danh sách sau `|` là ID link từ `/affiliatelinks`.
   Tất cả ID phải hợp lệ trước khi xếp hàng. Mỗi link thành một bình luận,
   cách nhau ít nhất 30 giây, bỏ qua nội dung trùng. Dùng `/comments` để theo dõi
   và `/cancelcomments ID_nguồn` để hủy phần chờ.

Chuyển link không tự xếp bình luận. Không dùng link gốc thay thế nếu Shopee
trả lỗi. Tích hợp đã kiểm thử bằng phản hồi API giả lập; cần thử với khóa và
sản phẩm thật sau khi cấu hình. TikTok được cấu hình riêng theo phần bên dưới.

## Phạm vi hoạt động

- Dùng Playwright đọc giao diện Facebook trong phiên đăng nhập riêng của từng Telegram user. Đây không phải tích hợp Facebook Groups API.
- Nhóm riêng tư chỉ đọc được khi tài khoản Facebook tương ứng đã có quyền xem nhóm. Đưa link vào bot không cấp thêm quyền truy cập.
- Kiểm tra định kỳ, không có bảo đảm thông báo ngay lập tức. Thời gian quét, số nhóm, kết nối mạng và giới hạn từ Facebook đều ảnh hưởng độ trễ.
- Không đặt giới hạn cứng về số nhóm trong sản phẩm; máy chạy và tốc độ tải trang vẫn có giới hạn hữu hạn. Tăng số nhóm có thể kéo dài chu kỳ quét.
- Khi không đặt khoảng ngày, lần quét thành công đầu tiên tạo mốc ban đầu và không gửi hàng loạt bài cũ. Khi đặt khoảng ngày, bot gửi cả bài cũ phù hợp, kể cả bài thuộc mốc ban đầu.
- Không bảo đảm tìm được mọi bài hoặc toàn bộ nội dung. Nội dung có thể bị thu gọn, phân trang hoặc chưa tải. Ngày đăng/link người đăng không đọc được sẽ hiển thị `không rõ`; bài thiếu ngày bị bỏ qua khi lọc theo ngày.
- Thông báo đã gửi có thể được chỉnh sửa khi nội dung, ngày đăng hoặc link người đăng đọc được thay đổi. Bot mở lại các bài đã gửi trong cửa sổ thời gian cấu hình để kiểm tra nội dung.
- Dữ liệu chống trùng và hàng đợi gửi được lưu trong SQLite. Bot thử lại khi gửi thất bại; nếu Telegram đã nhận tin nhưng phản hồi mạng bị mất, lần thử lại vẫn có thể tạo tin trùng. Không có bảo đảm gửi đúng một lần trong mọi tình huống.
- Facebook có thể đổi giao diện, hết phiên đăng nhập hoặc yêu cầu xác minh thủ công. Khi đó cần đăng nhập lại hoặc điều chỉnh adapter.

## Cài đặt trên Windows

Cần Node.js 24 và terminal PowerShell tại thư mục dự án. Dùng `npm.cmd` để tránh việc PowerShell chặn script `npm.ps1` trên một số máy.

```powershell
cd D:\Project\BOT
npm.cmd install
npm.cmd run install-browser
Copy-Item .env.example .env
```

Mở `.env` bằng trình soạn thảo, điền token bot do BotFather cấp và danh sách Telegram user ID được phép sử dụng. Giữ token tại máy chạy; không gửi token, mật khẩu Facebook hoặc cookie vào cuộc trò chuyện với bot.

```dotenv
TELEGRAM_BOT_TOKEN=replace_with_your_bot_token
ALLOWED_TELEGRAM_USER_IDS=123456789
DATA_DIR=./data
POLL_INTERVAL_SECONDS=10
HISTORY_INTERVAL_SECONDS=600
HEADLESS=true
SCROLL_PASSES=3
METRIC_WINDOW_HOURS=24
METRIC_REFRESH_SECONDS=600
```

| Biến | Ý nghĩa |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token của bot Telegram. |
| `ALLOWED_TELEGRAM_USER_IDS` | Telegram user ID dạng số, ngăn cách bằng dấu phẩy. |
| `DATA_DIR` | Thư mục lưu SQLite và profile trình duyệt. |
| `POLL_INTERVAL_SECONDS` | Khoảng nghỉ tối thiểu giữa các lượt quét bài mới của một nhóm; mặc định 10 giây, không phải cam kết độ trễ đầu cuối. |
| `HISTORY_INTERVAL_SECONDS` | Khoảng nghỉ giữa các lượt quét lịch sử của một nhóm; mặc định 600 giây, tối thiểu 60 giây. Chạy riêng với quét bài mới. |
| `HEADLESS` | `true`: chạy browser ẩn; `false`: mở cửa sổ khi bot quét. |
| `SCROLL_PASSES` | Số lượt đọc/cuộn tạo mốc ban đầu và quét nền khi không đặt khoảng ngày, từ 1 đến 10. Quét bài mới sau đó chỉ đọc phần đầu feed. |
| `METRIC_WINDOW_HOURS` | Cửa sổ mở lại bài đã phát hiện để cập nhật nội dung; giữ tên biến cũ để tương thích cấu hình. |
| `METRIC_REFRESH_SECONDS` | Khoảng thời gian tối thiểu trước khi mở lại bài để cập nhật nội dung; mặc định 600 giây. |

## Đăng nhập Facebook và chạy bot

Mỗi Telegram user cần đăng nhập Facebook một lần tại máy chạy bot. Gửi `/whoami` trong cuộc trò chuyện riêng với bot đang chạy để xem Telegram user ID; lệnh này không yêu cầu ID đã có trong allowlist. Nếu chưa biết ID khi cấu hình lần đầu, có thể giữ ID mẫu để khởi động, lấy ID thật qua `/whoami`, rồi dừng bot và cập nhật `.env`.

Ví dụ user ID `123456789`:

```powershell
npm.cmd run login -- --user-id 123456789
```

Đăng nhập trực tiếp trong cửa sổ Chromium mở ra và xử lý xác minh nếu Facebook yêu cầu. Làm theo hướng dẫn trong terminal để kết thúc. Profile được lưu tại `data/profiles/123456789` nếu giữ `DATA_DIR=./data`.

**Dừng bot trước khi chạy lệnh đăng nhập**, kể cả khi đăng nhập lại cho một user đã có profile. Hai tiến trình không được sử dụng đồng thời cùng profile trình duyệt.

Sau đó chạy:

```powershell
npm.cmd start
```

Giữ tiến trình chạy và máy có kết nối mạng để tiếp tục theo dõi. Dùng `Ctrl+C` để dừng.

Thêm người dùng mới bằng cách thêm ID vào allowlist, đăng nhập profile Facebook riêng theo ID đó và khởi động lại bot. Đây là quy trình cài đặt qua terminal trên máy vận hành; bản hiện tại chưa phải dịch vụ SaaS để khách tự đăng nhập Facebook từ xa hoàn toàn qua Telegram.

## Sử dụng trong Telegram

Nhắn tin riêng cho bot. Bot không xử lý lệnh trong nhóm Telegram. Gửi `/help` để xem các lệnh.

Gõ `/` hoặc mở **Menu** trong Telegram để xem gợi ý lệnh. Danh sách lệnh được đăng ký khi bot khởi động, vì vậy cần khởi động lại sau khi cập nhật mã nguồn.

| Lệnh | Tác dụng |
| --- | --- |
| `/whoami` | Xem Telegram user ID để cấu hình allowlist. |
| `/add LINK` | Thêm một hoặc nhiều link nhóm; cũng có thể gửi link trực tiếp. |
| `/list` | Xem ID nhóm nội bộ, bộ lọc và lần quét gần nhất. |
| `/remove ID` | Xóa nhóm khỏi danh sách theo dõi. |
| `/pause [ID]` | Tạm dừng một nhóm; bỏ ID để dừng tất cả nhóm của bạn. |
| `/resume [ID]` | Tiếp tục một nhóm hoặc tất cả nhóm của bạn. |
| `/keywords laptop; tuyển dụng` | Đặt bộ lọc mặc định; không truyền từ khóa để xem bộ lọc hiện tại. |
| `/keywords off` | Đặt bộ lọc mặc định nhận tất cả bài. |
| `/groupkeywords ID laptop; tuyển dụng` | Đặt bộ lọc riêng cho nhóm. |
| `/groupkeywords ID off` | Nhận tất cả bài của nhóm đó, kể cả khi bộ lọc mặc định đang có từ khóa. |
| `/status` | Xem số nhóm, số bài đã lưu, thông báo đang chờ và lỗi quét. |
| `/daterange ID DD/MM/YYYY [DD/MM/YYYY]` | Lấy bài trong khoảng ngày; bỏ ngày cuối để lấy đến mới nhất. |
| `/daterange ID off` | Tắt lọc ngày, tiếp tục theo dõi thông thường. |
| `/posts ID [trang]` | Xem ID và link bài đã lưu, 20 bài mỗi trang. |
| `/comment ID all \| nội dung` | Bình luận toàn bộ bài đã lưu trong nhóm, phù hợp bộ lọc hiện tại. |
| `/comment ID ID_bài_1,ID_bài_2 \| nội dung` | Bình luận các bài chỉ định đã được bot lưu trong nhóm. |
| `/autoreply ID nội dung` | Bật tự bình luận các bài mới phù hợp bộ lọc. |
| `/autoreply ID off` | Tắt tự bình luận và hủy phần tự động đang chờ. |
| `/comments` | Xem trạng thái 20 bình luận gần nhất. |
| `/cancelcomments [ID]` | Hủy bình luận đang chờ của một nhóm hoặc toàn bộ nhóm của bạn. |

`ID` trong các lệnh quản lý là số sau dấu `#` do `/list` hiển thị, không phải ID nhóm Facebook hay ID Telegram.

Ví dụ `523792591346040` trong `facebook.com/groups/523792591346040/` là **ID nhóm Facebook**, không phải ID người đăng. Tiêu đề thông báo và `/list` hiển thị `Tên nhóm (523792591346040)`. Nếu chưa đọc được tên thì hiển thị `Chưa đọc được tên nhóm (523792591346040)`; URL bằng tên chưa xác định được ID số sẽ ghi `chưa rõ ID nhóm`. Thông báo cũng ghi `Nhóm #1 · ID bài: ...` để phân biệt ID quản lý nhóm và ID bài viết.

Ví dụ nhóm có ID nội bộ `1`:

```text
/daterange 1 10/10/2025
/daterange 1 9/9/2025 9/9/2026
```

Lệnh đầu lấy từ 10/10/2025 đến mới nhất; lệnh sau lấy từ 9/9/2025 đến hết 9/9/2026. Tính cả hai ngày theo giờ Việt Nam (UTC+7). Khoảng ngày được lưu qua lần khởi động lại và kết hợp với bộ lọc từ khóa. Bài đã gửi không được gửi trùng. Dùng `/list` để xem khoảng ngày hiện tại. Nhóm đang tạm dừng cần `/resume ID` để quét.

Chế độ khoảng ngày cuộn tối đa 300 lượt mỗi lần quét lịch sử, dừng sớm sau 5 lượt không tìm thêm bài. Lịch sử chạy trong luồng nền riêng, theo `HISTORY_INTERVAL_SECONDS`; quét bài mới vẫn tiếp tục ở phần đầu feed. Đây là giới hạn thu thập giao diện, không phải cam kết lấy đủ lịch sử; nhóm nhiều bài hoặc feed tải chậm có thể thiếu bài. Các nhóm chia sẻ một luồng lịch sử nên lượt quét sâu có thể làm lịch sử nhóm khác chậm hơn. Bot chỉ dùng ngày tuyệt đối đọc được, không đoán ngày từ nhãn như “2 giờ”.

File đầu vào hỗ trợ `.txt` hoặc `.csv`, mã hóa UTF-8, tối đa **1 MiB (1.048.576 byte)**. Cách đơn giản nhất là một link mỗi dòng:

```text
https://www.facebook.com/groups/123456789/
https://www.facebook.com/groups/987654321/
```

Link trùng được bỏ qua trong danh sách của cùng người dùng. Chỉ nhập link trang nhóm; không nhập link bài viết hoặc link chia sẻ rút gọn. Nhóm có URL bằng tên cũng được chấp nhận. Nếu URL bằng tên không đọc được bài do Facebook dùng ID số trong permalink và không cung cấp thông tin quy đổi, hãy thử URL nhóm bằng ID số. Hai URL dùng tên và ID của cùng nhóm có thể vẫn được lưu thành hai mục riêng; nên giữ một dạng URL để tránh theo dõi trùng.

Các từ/cụm từ cách nhau bằng dấu chấm phẩy hoặc xuống dòng. Chỉ cần nội dung chứa **ít nhất một** từ khóa, không phân biệt chữ hoa và dấu tiếng Việt. Đây là phép tìm chuỗi con: `sale` cũng khớp `sales`. Bộ lọc riêng của nhóm được ưu tiên; chỉnh bộ lọc mặc định không thay thế bộ lọc riêng đã đặt. Dùng `/daterange` để lấy cả bài cũ phù hợp được tìm thấy trong các lượt quét.

Thông báo hiển thị ngày đăng theo giờ Việt Nam và link trang cá nhân người đăng nếu đọc được. Bài ẩn danh hoặc thiếu thông tin sẽ hiển thị `không rõ`. Nội dung dài được rút gọn để vừa một tin Telegram; mở link bài để đọc tiếp. Các tin cũ chỉ được cập nhật khi bot xử lý lại bài đó.

## Ảnh, video và bình luận từ Telegram

Áp dụng cho toàn bộ nhóm của bạn bằng một lệnh:

```text
/comment all | Ai cần inb mình nhé, xong mới tt, không cọc. 0349206916
/autoreply all Ai cần inb mình nhé, xong mới tt, không cọc. 0349206916
/autoreply all off
```

Lệnh đầu xếp bình luận cho bài đã lưu phù hợp bộ lọc của từng nhóm. Lệnh thứ hai bật tự bình luận bài mới cho tất cả nhóm hiện có; nhóm thêm sau cần bật riêng. Lệnh cuối tắt tự bình luận và hủy phần tự động đang chờ trên mọi nhóm. Nhóm tạm dừng vẫn chờ `/resume`. Các lệnh chỉ tác động nhóm của người gửi, không ảnh hưởng người dùng khác.

Dưới tin bài viết và ảnh/video có các nút:

- **💬 Bình luận**: mở ô reply để nhập bình luận đăng lên đúng bài Facebook. Chỉ bấm nút chưa gửi bình luận; cần nhập và gửi nội dung.
- **↗️ Chia sẻ**: mở lựa chọn chia sẻ link bài qua Telegram.
- **🔗 Đi tới bài viết**: mở bài gốc trên Facebook.
- **👤 Trang cá nhân**: mở trang người đăng; bài ẩn danh/thiếu link sẽ hiện thông báo không có thông tin.

Khởi động lại bot để nhận thao tác nút. Các nút xuất hiện trên tin mới và tin được bot cập nhật lại; không tự thêm vào toàn bộ tin lịch sử.

Ảnh/video được gửi dưới dạng tin đính kèm, reply vào tin nội dung của bài (tối đa 10 mục đọc được mỗi bài). Video có đường dẫn phát trực tiếp được gửi bằng video; nếu chỉ có ảnh xem trước thì gửi ảnh kèm link bài. Nếu Telegram từ chối tải media, bot gửi link để xem trên Facebook. Đường dẫn yêu cầu đăng nhập, hết hạn hoặc video dạng `blob:` có thể không phát trực tiếp trong Telegram. Bot không tải toàn bộ album và không mở trình phát để truy tìm video chưa được Facebook tải sẵn. Lỗi mạng không rõ kết quả gửi media sẽ không được tự gửi lại.

**Reply trực tiếp tin bài viết, ảnh hoặc video do bot gửi rồi nhập văn bản**: nội dung đó được xếp hàng để đăng thành bình luận trên bài Facebook tương ứng, bằng tài khoản Facebook đã đăng nhập của bạn. Reply vào một bình luận Telegram không tạo luồng trả lời bình luận trên Facebook; chỉ các tin bài/media có ánh xạ được hỗ trợ. Bình luận hiện chỉ hỗ trợ văn bản từ 1 đến 2000 ký tự. Khi reply, toàn bộ văn bản được hiểu là bình luận, kể cả văn bản bắt đầu bằng `/`; muốn chạy lệnh hãy gửi tin riêng không reply.

Ví dụ (nhóm nội bộ `1`, thay các ID bài bằng ID lấy từ `/posts 1`):

```text
/comment 1 all | Tôi muốn tìm hiểu thêm, vui lòng cho biết thông tin.
/comment 1 12345,67890 | Tôi muốn tìm hiểu thêm.
/autoreply 1 Tôi đã nhận được bài viết, cảm ơn bạn.
/autoreply 1 off
/comments
/cancelcomments 1
```

`all` áp dụng **bài đã lưu tại thời điểm chạy lệnh**, phù hợp bộ lọc từ khóa/ngày hiện tại, không tự quét hết lịch sử Facebook. Danh sách ID cụ thể và thao tác reply chọn chính xác bài, không phụ thuộc bộ lọc. `/posts` hiển thị mọi bài đã lưu, kể cả bài không khớp bộ lọc.

Tự bình luận mặc định tắt. Sau khi bật, bot chỉ xếp bình luận cho bài lần đầu được phát hiện sau mốc khởi tạo, có ngày đăng từ thời điểm bật trở đi và phù hợp bộ lọc. Bài lịch sử, bài thiếu ngày hoặc bài đã được lưu không tự bình luận. Mỗi bài/nội dung giống nhau chỉ được xếp một lần. Đổi nội dung tự bình luận hủy phần tự động cũ đang chờ.

Hàng đợi lưu trong SQLite, gửi tuần tự với khoảng nghỉ ít nhất 30 giây. `/pause ID` tạm dừng cả quét, thông báo và bình luận chưa bắt đầu của nhóm. `/cancelcomments` chỉ hủy phần đang chờ, không xóa bình luận đã đăng hoặc dừng phần đang gửi. Để ngừng phát sinh tự động, dùng `/autoreply ID off`.

Worker bình luận có hàng đợi và tab riêng, chạy đồng thời với quét nhóm và gửi Telegram. Ngay khi đọc được bài mới với ngày đăng xác định và đủ điều kiện, bot lưu bài và đánh thức worker để bình luận, không chờ hết lượt quét hoặc gửi Telegram. Tab bình luận dùng chung phiên đăng nhập đang mở của tài khoản, không mở thêm Chromium trên cùng thư mục profile. Khoảng nghỉ 30 giây giữa các bình luận vẫn áp dụng. Bật bằng `/autoreply all Nội dung bình luận` hoặc `/autoreply ID Nội dung bình luận`. Quét bài mới mặc định nghỉ 10 giây giữa các lượt; quét lịch sử chạy riêng. Đây là theo dõi bằng quét định kỳ, không phải thông báo tức thời từ Facebook. Bài nằm ngoài phần đầu feed có thể phải chờ lượt quét nền.

Bot chỉ ghi **đã đăng** khi nhìn thấy bình luận mới có link bình luận trên giao diện. Nếu không tìm được ô nhập, bị khóa bình luận, lỗi mạng hoặc bot dừng trong khi gửi, trạng thái là **chưa xác nhận**; không tự gửi lại. Kiểm tra bài Facebook và `/comments` trước khi thao tác tiếp. Chức năng được kiểm thử bằng trang mẫu cục bộ, chưa được xác minh trên nhóm thật.

Menu lệnh và gửi ảnh/video dùng các phương thức trong [Telegram Bot API](https://core.telegram.org/bots/api#setmycommands).

## Kiểm tra và dữ liệu

```powershell
npm.cmd test
```

Các bài kiểm thử tự động không thay thế kiểm thử trên nhóm Facebook thật. Với lần chạy thử đầu tiên: thêm một nhóm tài khoản xem được, kiểm tra link/nội dung/ngày đăng/người đăng, thử keyword và khoảng ngày, rồi khởi động lại để quan sát chống trùng.

Thư mục `data` chứa phiên Facebook và dữ liệu bài viết đã đọc. Chỉ cấp quyền truy cập thư mục này cho người vận hành tin cậy; không commit `.env` hoặc `data` lên Git. Khi sao lưu hoặc chuyển máy, dừng bot trước và giữ dữ liệu cùng profile tương ứng với từng Telegram user.

## Tham khảo nền tảng

[Changelog Graph API v19.0 của Meta](https://developers.facebook.com/docs/graph-api/changelog/version19.0/) là nguồn chính thức để kiểm tra thay đổi liên quan Groups API. Trong phiên xây dựng prototype, trang này trả HTTP 429 nên nội dung không được xác minh trực tiếp. Mã nguồn hiện tại hoạt động bằng giao diện trình duyệt và không dựa vào quyền truy cập Groups API.
# Chọn nhóm Facebook đã tham gia

Bot mặc định chạy **4 worker quét bài mới**. Có thể đặt `SCAN_WORKERS=1` đến `4` trong `.env`, rồi khởi động lại bot. Mỗi worker nhận một nhóm khác nhau, ưu tiên nhóm lâu chưa quét, và dùng tab riêng. Ngoài các worker này có một luồng bình luận và một luồng nền dành cho lịch sử/cập nhật bài đã lưu, tối đa `SCAN_WORKERS + 2` tác vụ trình duyệt đồng thời. Các tab của cùng tài khoản dùng chung một profile Facebook đang mở, không mở nhiều Chromium trên cùng thư mục profile. Bình luận không phải đợi slot quét, kể cả khi `SCAN_WORKERS=1`. Tốc độ thực tế phụ thuộc mạng, tài nguyên máy và thời gian Facebook tải từng nhóm.

`/daterange ID|all DD/MM/YYYY [hh:mm:ss] [DD/MM/YYYY [hh:mm:ss]]` hỗ trợ giờ Việt Nam (UTC+7). Bỏ mốc cuối để lấy đến mới nhất. Không nhập giờ thì lấy trọn ngày; khi nhập giờ kết thúc, lấy cả giây kết thúc.

Sau khi đăng nhập Facebook theo tài khoản Telegram và khởi động bot:

- `/joined`: đọc danh sách nhóm đã tham gia, hiển thị 15 nhóm mỗi trang.
- `/joined 2`: xem trang tiếp; `/joined refresh`: tải lại danh sách.
- `/select 1,2,5`: thêm các nhóm theo số thứ tự trong danh sách `/joined`.
- `/select all`: thêm toàn bộ nhóm trong danh sách đã đọc, bỏ qua nhóm trùng.

Nhóm mới được chọn sẽ gửi đợt bài mới nhất đọc được ngay lần quét đầu, theo bộ lọc hiện tại, rồi tiếp tục theo dõi. Nhóm đã có giữ nguyên cấu hình. Danh sách chọn riêng cho từng người dùng và cần tải lại sau khi khởi động lại bot. Facebook có thể tải chưa đủ danh sách; bot báo khi chạm giới hạn quét.

`all` trong các lệnh sau chỉ áp dụng các nhóm hiện có của người gửi:

```text
/pause all
/resume all
/groupkeywords all việc làm; tuyển dụng
/groupkeywords all off
/daterange all 01/10/2026
/daterange all 08/10/2026 14:30:00
/daterange all 08/10/2026 14:30:00 08/10/2026 18:00:00
/daterange all off
/posts all 1
/cancelcomments all
/autoreply all off
/comment all | Nội dung bình luận
/remove all
```

`/remove all` xóa toàn bộ nhóm theo dõi và dữ liệu liên quan của bạn trong bot, không rời nhóm Facebook. `/list` hiển thị ID quản lý nhóm; ID này khác số thứ tự chọn trong `/joined`. `/keywords` đặt bộ lọc mặc định; `/groupkeywords all` thay bộ lọc riêng của mọi nhóm hiện có.

# Quét trang cá nhân và reel

## Bình luận theo danh sách trên một bài/reel

Lấy ID nguồn bằng `/list`, ID bài bằng `/posts ID_nguồn`. Nhập mỗi link hoặc
nội dung trên một dòng sau dấu `|`. Ví dụ xếp 5 bình luận, mỗi bình luận một link:

```text
/commentlist 1 123456789 |
https://s.shopee.vn/LINK_AFFILIATE_1
https://s.shopee.vn/LINK_AFFILIATE_2
https://s.shopee.vn/LINK_AFFILIATE_3
https://s.shopee.vn/LINK_AFFILIATE_4
https://s.shopee.vn/LINK_AFFILIATE_5
```

Thay các link ví dụ bằng link affiliate của bạn. Bot giữ nguyên link và tham số,
không tự tạo link affiliate. Mỗi dòng là một bình luận riêng trên đúng bài đã
chọn, áp dụng cả bài nhóm, trang cá nhân và reel. Hàng đợi gửi theo thứ tự,
cách nhau ít nhất 30 giây. Dòng trống bị bỏ qua; nội dung trùng trên cùng bài
không được xếp lại. Bình luận lỗi trước khi gửi có thể xếp lại thủ công;
bình luận đã thao tác gửi nhưng chưa xác nhận không tự gửi lại.
Xem `/comments`, tạm dừng bằng `/pause ID_nguồn`, hoặc hủy phần đang chờ
của nguồn bằng `/cancelcomments ID_nguồn`.

## Thêm nguồn trang cá nhân

Thêm nguồn bằng `/profile https://www.facebook.com/ten.nguoi.dung all`.
Quét nhiều trang bằng một lệnh (chế độ ở cuối áp dụng cho toàn bộ danh sách):

```text
/profile https://www.facebook.com/nguoi.thu.nhat
https://www.facebook.com/nguoi.thu.hai
https://www.facebook.com/profile.php?id=123456 reels
```

Tách link bằng xuống dòng, khoảng trắng, dấu phẩy hoặc dấu chấm phẩy.
Bot loại link trùng và trả ID riêng cho từng trang. Nếu có link không hợp lệ,
bot yêu cầu sửa trước khi lưu cả danh sách. Bỏ chế độ cuối lệnh để quét `all`.

Hỗ trợ cả link `https://www.facebook.com/profile.php?id=123456`.
Thay `all` bằng `posts` để chỉ quét bài viết hoặc `reels` để chỉ quét reel.
Gửi lại lệnh với cùng link để đổi loại nội dung. Bot nhận đợt bài đầu đọc được;
các bộ lọc từ khóa/ngày vẫn áp dụng. Nguồn nhóm cũ giữ nguyên hành vi.

Dùng `/list` lấy ID nguồn, `/posts ID` xem bài/reel đã lưu, rồi reply tin bot
hoặc gửi `/comment ID ID_bài | Nội dung` để bình luận đúng bài/reel.
Các lệnh `/pause`, `/resume`, `/remove`, `/daterange`, `/groupkeywords` và
`/autoreply` dùng chung ID này. Lệnh có `all` áp dụng cả nhóm và trang cá nhân.

Bot chỉ đọc nội dung tài khoản đã đăng nhập có quyền xem. Reel phải xác minh
được tác giả thuộc trang cá nhân mục tiêu; nội dung không xác minh được bị bỏ qua.
Không bảo đảm quét đủ lịch sử. Khi không đọc được ngày, bộ lọc ngày và tự bình
luận không chọn bài đó; vẫn có thể xem bài đã lưu và bình luận thủ công.
Giao diện Facebook có thể thay đổi; ô bình luận phải xác định duy nhất trước khi gửi.



## Ứng dụng desktop Windows

Mở `dist/AffiliateDesk-win32-x64/AffiliateDesk.exe` để dùng bản portable đã đóng gói.
Giữ nguyên cả thư mục ứng dụng, gồm Node và Chromium đi kèm. App có giao diện tiếng
Việt: tổng quan, nguồn nhóm/trang cá nhân, bài viết/reel, affiliate, hàng đợi bình
luận, nhật ký và cài đặt. Các thao tác nâng cao vẫn có bảng lệnh đầy đủ.

Từ mã nguồn: `npm.cmd run desktop`. Tạo lại gói: `npm.cmd run desktop:pack`.
Kiểm tra giao diện với dữ liệu thử riêng: `npm.cmd run desktop:verify`.
App không tự chạy quét khi mở; đăng nhập Facebook, thêm nguồn rồi bấm bắt đầu.
Desktop xử lý cục bộ; đóng app trước khi chạy bot Telegram trên cùng dữ liệu.
Xem [hướng dẫn desktop](desktop/README.md) về cấu hình, vị trí dữ liệu và tài khoản.

## Hiệu năng và đo tốc độ

Chạy `npm.cmd run benchmark` để đo xử lý SQLite bằng 20.000 bài giả lập trong bộ nhớ.
Lệnh này không mở dữ liệu thật, không gọi Facebook/Telegram/affiliate API. Mỗi phép đo
lấy trung vị 3 lượt sau khi làm nóng; kết quả thay đổi theo máy và tải nền.

Kết quả trước/sau tối ưu trên cùng máy phát triển (tổng thời gian, ms):

| Tác vụ | Số lượt | Trước | Sau |
| --- | ---: | ---: | ---: |
| Kiểm tra hàng đợi bình luận và thông báo trống | 100 | 1.081,66 | 1,28 |
| Chọn một bài để xếp bình luận | 50 | 4.980,67 | 2,16 |
| Đọc trang 20 bài của nguồn | 100 | 1.065,33 | 10,27 |
| Tra cứu một bài theo ID | 1.000 | 45,64 | 6,39 |

Thay đổi: tra bài trực tiếp theo khóa; chỉ mục hàng đợi chưa xử lý, phân trang và
link affiliate; bộ nhớ đệm tối đa 256 câu lệnh SQL (không lưu kết quả dữ liệu);
lọc nguồn đến hạn ngay tại SQLite; bỏ ghi nội dung thông báo/tên nguồn không đổi.
Trình duyệt dùng ngày có sẵn trên permalink thay vì chờ tooltip và bỏ đọc toàn bộ
nội dung trang khi đã có link bài hợp lệ. Vẫn kiểm tra đăng nhập và quyền truy cập.

Đây là tốc độ xử lý nội bộ, không phải mức tăng tốc quét Facebook đầu cuối.
Bot có tối đa 4 worker quét; `SCAN_WORKERS=1..4` điều chỉnh số tab theo tài nguyên máy.
Quét lịch sử chạy riêng theo `HISTORY_INTERVAL_SECONDS`; bình luận vẫn cách nhau ít
nhất 30 giây. Khởi động lại bot để áp dụng mã mới; chỉ mục được tạo tự động, lần
khởi động đầu có thể lâu hơn nếu cơ sở dữ liệu lớn. Chưa đo trên dữ liệu thật.

## TikTok Affiliate và bình luận trên Facebook

Menu chính `/menu` gồm: **1. Nhóm Facebook**, **2. Affiliate TikTok · Facebook · Shopee**,
**3. Bài viết & reel trang cá nhân**. Facebook trong mục Affiliate là nơi đăng link
Shopee/TikTok, không phải chương trình affiliate riêng.

### Cấu hình tài khoản TikTok

Điền các biến `TIKTOK_AFFILIATE_*` trong `.env.example` vào `.env` trên máy chạy bot:
`OWNER_ID` (ID Telegram), `APP_KEY`, `APP_SECRET`, `ACCESS_TOKEN`, `CREATOR_ID`,
`PUBLISHER_ID`; `CAMPAIGN_ID` tùy chương trình. Khởi động lại bot sau khi đổi cấu hình.
Access token phải được Creator của bạn cấp quyền qua ứng dụng TikTok Shop Partner;
token hết hạn cần được làm mới và cập nhật trên máy. Không gửi bí mật qua Telegram.

Ứng dụng cần quyền Creator search/profile và **Read Affiliate Share Link**
(`creator.affiliate.share_link.read`). API publisher yêu cầu publisher hợp lệ trong
hệ thống partner và sản phẩm đủ điều kiện campaign. Publisher ID không mặc nhiên
là Creator ID. Tài khoản affiliate thông thường chưa được cấp API này có thể không
tạo được link; bot không tự đăng ký campaign hoặc thay link lỗi bằng link sản phẩm.
Tích hợp hiện kiểm tra đúng Creator, vùng VN và hoa hồng VND.

- `/tiktok check`: kiểm tra Creator và quyền affiliate.
- `/tiktok LINK1 LINK2`: chuyển tối đa 20 link/ID sản phẩm; hỗ trợ link chia sẻ TikTok.
- `/tiktoktop 5 rate đồ gia dụng`: lấy top theo tỷ lệ hoa hồng; `amount` theo tiền/đơn.
- `/tiktoklinks`: xem link đã lưu riêng cho tài khoản TikTok.
- `/tiktoktopcomment 1 ID_BÀI 5 rate`: lấy top mới, xếp tối đa 5 bình luận riêng trên bài Facebook đã lưu.
- `/tiktokcomment 1 ID_BÀI | 1,2,3`: dùng ID link đã lưu; có thể bấm nút top TikTok dưới tin bài.

Top được xếp trong tối đa 200 sản phẩm API trả về, còn hàng, thuộc VN/VND;
không bảo đảm cao nhất toàn sàn hoặc hoa hồng thực nhận. Nếu chỉ tạo được 3/5 link,
bot báo rõ và chỉ xếp 3 bình luận. Lệnh xem top/chuyển link không tự bình luận.

### Tự động lọc bài Facebook và bình luận link TikTok

Thêm nhóm hoặc nhiều trang cá nhân bằng `/add` hoặc `/profile`, xem ID ở `/sources`.
Ví dụ với nguồn số 1:

```text
/groupkeywords 1 đồ gia dụng; nhà bếp
/tiktokauto 1 5 rate đồ gia dụng
```

Từ khóa ở lệnh đầu lọc **bài Facebook**; từ khóa ở lệnh sau tìm **sản phẩm TikTok**.
Bot theo dõi những nguồn đã thêm mà tài khoản được xem, không tìm kiếm toàn Facebook.
Chỉ bài mới có ngày đăng sau lúc bật, qua bộ lọc từ khóa/ngày, mới tạo tác vụ.
Lần quét làm mốc ban đầu không tự bình luận. Mỗi bài lấy top mới bằng tài khoản đã
cấu hình, mỗi link một bình luận, số link từ 1–20, cách nhau ít nhất 30 giây.
Nội dung trùng trên cùng bài được bỏ qua. Chế độ `/autoreply` cố định hoạt động độc lập;
tắt chế độ đó nếu chỉ muốn bình luận affiliate.

`/tiktokauto 1 off` tắt và hủy tác vụ/bình luận tự động đang chờ.
`/pause 1` tạm dừng, `/resume 1` tiếp tục; `/cancelcomments 1` hủy phần đang chờ
nhưng không tắt chế độ cho bài mới tiếp theo. Bình luận đã gửi không bị xóa.
Bot kiểm tra lại bộ lọc trước khi xếp/gửi; lỗi lấy link được báo để thử lại thủ công.
`/comments` xem kết quả. TikTok không bị bình luận trực tiếp.

API tham chiếu chính thức:
[tìm sản phẩm](https://partner.tiktokshop.com/docv2/page/creator-search-open-collaboration-product-202405),
[kiểm tra Creator](https://partner.tiktokshop.com/docv2/page/get-creator-profile-202405),
[tạo publisher link](https://partner.tiktokshop.com/docv2/page/creator-generate-publisher-link-202504),
[ký request](https://partner.tiktokshop.com/docv2/page/sign-your-api-request).
Kiểm thử dùng API giả lập và trang Facebook cục bộ; cần cấu hình quyền API và phiên
Facebook thực tế trước khi chạy, chưa kiểm chứng hoa hồng bằng đơn hàng thật.
