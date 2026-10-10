import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { profileDirectory } from './facebook.js';

export async function login(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--user-id') throw new Error('Cách dùng: npm run login -- --user-id TELEGRAM_USER_ID');
  const ownerId = args[1];
  const dataDir = process.env.DATA_DIR || './data';
  const profile = profileDirectory(dataDir, ownerId);
  let lock;
  try { lock = await readFile(path.join(dataDir, 'monitor.lock'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (lock !== undefined) {
    const pid = Number(lock);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('monitor.lock không hợp lệ. Kiểm tra tiến trình bot trước khi xử lý file khóa.');
    try {
      process.kill(pid, 0);
      throw new Error('Bot đang chạy. Dừng bot trước khi mở login để tránh xung đột profile.');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await mkdir(profile, { recursive: true, mode: 0o700 });
  console.log(`Đăng nhập Facebook thủ công cho Telegram ID ${ownerId}.`);
  console.log('Dừng bot trước khi đăng nhập để tránh khóa profile. Chỉ dùng tài khoản của chính bạn và nhóm bạn được phép truy cập.');
  console.log('Trình duyệt lưu phiên đăng nhập trong thư mục DATA_DIR/profiles. Không chia sẻ hoặc commit thư mục này.');
  const { chromium } = await import('playwright');
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false, viewport: { width: 1280, height: 900 },
      acceptDownloads: false, serviceWorkers: 'block', timeout: 30000,
    });
  } catch {
    throw new Error('Không mở được trình duyệt. Chạy npx playwright install chromium; đóng bot/cửa sổ đang dùng cùng profile rồi thử lại.');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await terminal.question('Tự đăng nhập và hoàn thành mọi xác minh trong trình duyệt. Sau khi vào được nhóm cần theo dõi, quay lại đây và nhấn Enter: ');
    const cookies = await context.cookies('https://www.facebook.com');
    if (!cookies.some(cookie => cookie.name === 'c_user' && cookie.value)) throw new Error('Chưa có phiên Facebook hợp lệ. Hãy chạy lại lệnh và đăng nhập hoàn tất.');
    const pendingCheck = context.pages().some(tab => /\/(checkpoint|challenge|two_step_verification)(\/|$)/i.test(new URL(tab.url()).pathname));
    if (pendingCheck) throw new Error('Facebook vẫn yêu cầu xác minh. Hoàn tất thủ công rồi chạy lại lệnh login.');
  } finally {
    terminal.close();
    await context.close();
  }
  console.log('Đã lưu phiên Facebook. Có thể khởi động bot.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  login().catch(error => { console.error(error.message); process.exitCode = 1; });
}
