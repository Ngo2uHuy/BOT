# KẾ HOẠCH TRIỂN KHAI HỆ THỐNG LÊN MẠNG 100% MIỄN PHÍ (FREE HOSTING PLAN)

> **Mục tiêu:** Đưa hệ thống Bot Facebook & Telegram lên chạy online 24/7 liên tục, không tốn bất kỳ chi phí duy trì máy chủ nào (0 VNĐ/tháng), bảo toàn dữ liệu SQLite và giữ phiên đăng nhập Facebook ổn định.

---

## 1. YÊU CẦU ĐẶC THÙ CỦA DỰ ÁN CẦN LƯU Ý KHI CHỌN NỀN TẢNG CLOUD

Trước khi chọn nơi lưu trữ, hệ thống này có 4 đặc điểm kỹ thuật quan trọng:
1. **Node.js phiên bản mới (>= 22.13.0):** Bot sử dụng `node:sqlite` tích hợp sẵn trong Node.js 22.
2. **Bộ nhớ RAM & Playwright Chromium:** Quét bài viết và đăng nhập cần chạy Chromium headless (khuyến nghị tối thiểu **1 GB RAM** trở lên, hoặc có swap RAM).
3. **Bộ nhớ lưu trữ vĩnh viễn (Persistent Storage):** Cơ sở dữ liệu SQLite (`data/monitor.sqlite`) và session đăng nhập Facebook (`data/`) bắt buộc phải được lưu trên ổ cứng vĩnh viễn. Nếu dùng các PaaS miễn phí dạng "ephemeral container" (như Render free, Heroku free cũ), mỗi lần restart server sẽ bị mất sạch database và văng phiên Facebook.
4. **Vấn đề IP của Facebook:** Facebook có cơ chế phát hiện IP lạ. Nếu đăng nhập tài khoản lần đầu trên IP Datacenter nước ngoài (US/EU), tài khoản dễ bị checkpoint. **Mẹo tối ưu:** Đăng nhập thành công trên máy tính ở nhà trước, sau đó copy toàn bộ thư mục `data/` lên máy chủ.

---

## 2. BẢNG SO SÁNH CÁC NỀN TẢNG MIỄN PHÍ TỐT NHẤT

| Nền tảng | Cấu hình miễn phí | Lưu trữ vĩnh viễn? | Độ khó | Đánh giá & Khuyến nghị |
|---|---|---|---|---|
| **1. Oracle Cloud Always Free** | **4 OCPU ARM + 24GB RAM** (hoặc 2 VM AMD 1GB RAM), 200GB SSD | **Có (Vĩnh viễn)** | Trung bình | ⭐⭐⭐⭐⭐ **KHUYÊN DÙNG SỐ 1** (Cấu hình cực mạnh, miễn phí trọn đời, chạy 24/7). |
| **2. Self-Hosted (Máy tính cũ / Mini PC / Laptop ở nhà)** | Tùy phần cứng sẵn có | **Có (Vĩnh viễn)** | Rất dễ | ⭐⭐⭐⭐⭐ **AN TOÀN CHO FB NHẤT** (IP mạng nhà sạch 100% không bao giờ bị checkpoint, 0đ chi phí). |
| **3. Google Cloud (GCP) Free Tier** | 1 vCPU (e2-micro), 1GB RAM, 30GB HDD | **Có (Vĩnh viễn)** | Trung bình | ⭐⭐⭐⭐ **TỐT** (Cần tạo thêm 2GB Swap RAM để chạy mượt Chromium). |
| **4. Docker trên VPS Miễn Phí** | Sử dụng file Dockerfile có sẵn | **Có** | Dễ | ⭐⭐⭐⭐ Dễ quản lý, chỉ 1 lệnh `docker compose up -d`. |
| **5. Render / Koyeb / Fly.io (PaaS)** | 512MB RAM, tự sleep sau 15p | Không (Bản free mất dữ liệu khi restart) | Dễ | ❌ **KHÔNG PHÙ HỢP** (Thiếu RAM cho Chromium, mất cookie Facebook khi restart). |

---

## 3. PHƯƠNG ÁN 1 (KHUYÊN DÙNG SỐ 1): ORACLE CLOUD ALWAYS FREE VPS

Oracle Cloud cung cấp gói **Always Free** hào phóng nhất thế giới hiện nay, hoàn toàn miễn phí trọn đời (cần thẻ Visa/Mastercard để xác minh danh tính lúc đăng ký, không bị trừ tiền).

### Bước 1: Đăng ký & Tạo máy ảo (Compute Instance)
1. Truy cập [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) và đăng ký tài khoản.
2. Chọn Home Region gần Việt Nam (khuyên dùng **Singapore** hoặc **Tokyo** để ping về Facebook nhanh nhất).
3. Vào menu **Compute** ➔ **Instances** ➔ Bấm **Create Instance**:
   - **Image:** Chọn **Ubuntu 24.04** hoặc **Ubuntu 22.04**.
   - **Shape:** 
     - Lựa chọn A (Khuyên dùng): **Ampere (ARM)** ➔ Chọn 2 đến 4 OCPU, 12GB đến 24GB RAM (Miễn phí 100%).
     - Lựa chọn B: **VM.Standard.E2.1.Micro (AMD)** ➔ 1 OCPU, 1GB RAM (Miễn phí 100%).
   - **Networking:** Chọn Public IP.
   - **SSH Keys:** Tải file private key (`ssh-key-*.key`) về máy tính để kết nối.

### Bước 2: Kết nối SSH và cài đặt môi trường
Từ PowerShell hoặc Terminal trên máy tính của bạn, gõ lệnh kết nối:
```bash
ssh -i /duong-dan/toi/file-key.key ubuntu@IP_ORACLE_CUA_BAN
```

Cập nhật hệ điều hành và cài đặt Node.js 22 LTS:
```bash
# 1. Cập nhật hệ thống
sudo apt update && sudo apt upgrade -y

# 2. Cài đặt Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git

# Kiểm tra phiên bản (phải >= 22.13.0)
node -v
npm -v

# 3. Cài đặt PM2 để giữ bot chạy 24/7 tự khởi động lại khi reboot
sudo npm install -g pm2
```

### Bước 3: Đưa mã nguồn và phiên đăng nhập Facebook lên VPS
1. **Clone mã nguồn lên VPS:**
   ```bash
   cd ~
   git clone https://github.com/Ngo2uHuy/BOT.git
   cd BOT
   npm install --omit=dev
   ```

2. **Cài đặt thư viện hệ thống cho trình duyệt Playwright:**
   ```bash
   npx playwright install-deps chromium
   npx playwright install chromium
   ```

3. **Tạo file cấu hình `.env`:**
   ```bash
   nano .env
   ```
   Dán nội dung `.env` của bạn vào (Token Telegram, ID cho phép, cấu hình worker,...), sau đó nhấn `Ctrl + O` ➔ `Enter` ➔ `Ctrl + X` để lưu.

4. **Copy thư mục `data/` từ máy tính lên VPS (QUAN TRỌNG ĐỂ KHÔNG BỊ CHECKPOINT FACEBOOK):**
   Trên máy tính cá nhân của bạn (mở PowerShell mới tại thư mục dự án):
   ```powershell
   # Nén thư mục data và gửi lên VPS qua scp
   scp -i /duong-dan/file-key.key -r ./data ubuntu@IP_ORACLE_CUA_BAN:~/BOT/
   ```
   *Nhờ thao tác này, bot trên server sẽ nhận ngay phiên cookie Facebook đã đăng nhập sẵn mà không cần đăng nhập lại trên IP máy chủ!*

### Bước 4: Khởi chạy bot vĩnh viễn với PM2
Trên cửa sổ SSH của VPS:
```bash
cd ~/BOT

# Khởi chạy bot bằng PM2
pm2 start src/index.js --name "fb-tele-bot" --node-args="--env-file-if-exists=.env"

# Cấu hình PM2 tự bật lại bot khi máy chủ khởi động lại
pm2 save
pm2 startup
# (Làm theo hướng dẫn sudo lệnh mà PM2 in ra nếu có)

# Xem log hoạt động thời gian thực
pm2 logs fb-tele-bot
```

---

## 4. PHƯƠNG ÁN 2: CHẠY TRÊN MÁY TÍNH CŨ / MINI PC TẠI NHÀ (SELF-HOSTED)

Nếu không có thẻ thanh toán quốc tế để đăng ký Cloud, phương án chạy tại nhà là **tốt nhất và an toàn nhất cho tài khoản Facebook**:
- **0đ chi phí máy chủ.**
- **IP mạng gia đình sạch tuyệt đối:** Facebook coi đây là thiết bị người dùng thông thường, hạn chế tối đa nguy cơ checkpoint hay khóa tính năng.

### Cách triển khai trên máy tính Windows:
1. Đảm bảo máy tính cài Node.js >= 22.13.
2. Mở PowerShell trong thư mục dự án `d:\Project\BOT`.
3. Cài đặt PM2:
   ```powershell
   npm install -g pm2
   npm install -g pm2-windows-service
   ```
4. Khởi chạy bot chạy ngầm:
   ```powershell
   pm2 start src/index.js --name "fb-bot" --node-args="--env-file-if-exists=.env"
   pm2 save
   ```
5. Đặt chế độ Sleep máy tính thành "Never" (Chỉ tắt màn hình, không cho máy ngủ đông).

---

## 5. PHƯƠNG ÁN 3: TRIỂN KHAI BẰNG DOCKER (CHO BẤT KỲ MÁY CHỦ LINUX NÀO)

Dự án đã được tích hợp sẵn file `Dockerfile` và `docker-compose.yml`.

### Các bước triển khai:
1. Cài đặt Docker & Docker Compose trên máy chủ:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   ```
2. Clone dự án và chuẩn bị file `.env` cùng thư mục `data/`:
   ```bash
   git clone https://github.com/Ngo2uHuy/BOT.git
   cd BOT
   # Copy .env và data vào đây
   ```
3. Khởi chạy bot chỉ với 1 lệnh:
   ```bash
   docker compose up -d --build
   ```
4. Quản lý container:
   ```bash
   # Xem log trực tiếp
   docker compose logs -f

   # Khởi động lại
   docker compose restart

   # Dừng bot
   docker compose down
   ```

---

## 6. LƯU Ý QUAN TRỌNG ĐỂ VẬN HÀNH ỔN ĐỊNH LÂU DÀI

1. **Bảo vệ Cookie Facebook:**
   - Định kỳ khoảng 1 - 2 tháng, cookie đăng nhập có thể hết hạn. Khi bot báo lỗi đăng nhập trên Telegram, bạn chỉ cần mở bản Desktop trên máy tính ở nhà để đăng nhập lại, rồi copy thư mục `data/` ghi đè lên server là xong.
2. **Sao lưu Database SQLite định kỳ:**
   - File `data/monitor.sqlite` chứa toàn bộ lịch sử bài viết, nhóm, cài đặt. Bạn có thể cài đặt một cron job đơn giản để nén và gửi bản backup file `monitor.sqlite` về Telegram mỗi tuần.
3. **Cấu hình Worker vừa phải với dung lượng RAM:**
   - Nếu máy chủ có 1GB RAM: Nên để `SCAN_WORKERS=2`, `COMMENT_WORKERS=2`.
   - Nếu máy chủ Oracle 12GB - 24GB RAM: Thoải mái đặt `SCAN_WORKERS=4`, `COMMENT_WORKERS=4` để đạt tốc độ tối đa.

---

## TỔNG KẾT BƯỚC ĐI TIẾP THEO (ACTION PLAN)

| Bước | Hành động | Thời gian dự kiến |
|---|---|---|
| **Bước 1** | Đăng nhập tài khoản Facebook thành công trong bản Desktop hiện tại trên máy tính để tạo sẵn session trong `data/`. | 5 phút |
| **Bước 2** | Đăng ký tài khoản Oracle Cloud Always Free (hoặc chọn 1 laptop cũ ở nhà). | 10 phút |
| **Bước 3** | Tạo máy ảo Ubuntu 24.04 (ARM/AMD), SSH vào cài Node.js 22 và Playwright dependencies. | 10 phút |
| **Bước 4** | Clone code, copy thư mục `data/` và file `.env` từ máy tính lên máy chủ. | 5 phút |
| **Bước 5** | Chạy lệnh `pm2 start src/index.js` (hoặc `docker compose up -d`) và kiểm tra tin nhắn bot trên Telegram. | 2 phút |
| **Hoàn tất** | Bot hoạt động 24/7 online vĩnh viễn với chi phí 0đ! | ✅ |
