FROM node:22-bookworm-slim

# Cài đặt dependencies hệ thống tối thiểu cho Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy file định nghĩa gói
COPY package*.json ./

# Cài đặt production dependencies (không cài electron devDependencies)
RUN npm ci --omit=dev

# Cài đặt Chromium
RUN npx playwright install chromium

# Copy mã nguồn
COPY . .

# Khởi tạo thư mục dữ liệu
RUN mkdir -p /app/data

VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

CMD ["node", "--env-file-if-exists=.env", "src/index.js"]
