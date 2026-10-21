import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { launchLoginBrowser, openHttpContext, saveHttpSession } from './facebook-http.js';
import { extractSessionFromHtml } from './facebook-graphql.js';
import { createInterface } from 'node:readline/promises';
import { profileDirectory } from './facebook.js';

export async function login(args = process.argv.slice(2)) {
  const importing = args.length === 4 && args[2] === '--cookies-file';
  if ((!importing && args.length !== 2) || args[0] !== '--user-id') throw new Error('Cách dùng: npm run login -- --user-id TELEGRAM_USER_ID [--cookies-file DUONG_DAN_JSON]');
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
  if (importing) {
    let value;
    try { value = JSON.parse(await readFile(path.resolve(args[3]), 'utf8')); }
    catch { throw new Error('File cookie JSON không hợp lệ hoặc thiếu c_user/xs.'); }
    try { await saveHttpSession(dataDir, ownerId, value); }
    catch { throw new Error('File cookie JSON không hợp lệ hoặc thiếu c_user/xs.'); }
    await checkHttpSession(dataDir, ownerId);
    return;
  }
  await mkdir(profile, { recursive: true, mode: 0o700 });
  console.log(`Đăng nhập Facebook thủ công cho Telegram ID ${ownerId}.`);
  console.log('Dừng bot trước khi đăng nhập để tránh khóa profile. Chỉ dùng tài khoản của chính bạn và nhóm bạn được phép truy cập.');
  console.log('Trình duyệt lưu phiên đăng nhập trong thư mục DATA_DIR/profiles. Không chia sẻ hoặc commit thư mục này.');
  const { chromium } = await import('playwright');
  let context;
  try {
    context = await launchLoginBrowser(chromium, profile, { args: ['--disk-cache-size=33554432', '--media-cache-size=1'] });
  } catch {
    throw new Error('Không mở được Chrome. Cài Google Chrome (hoặc chạy npx playwright install chromium); đóng bot/cửa sổ đang dùng cùng profile rồi thử lại.');
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
    const tab = context.pages()[0] ?? page;
    const userAgent = await tab.evaluate(() => navigator.userAgent).catch(() => null);
    try { await saveHttpSession(dataDir, ownerId, { cookies, userAgent }); }
    catch { throw new Error('Phiên Facebook thiếu cookie c_user/xs. Đăng nhập lại cho hoàn tất rồi nhấn Enter.'); }
  } finally {
    terminal.close();
    await context.close();
  }
  console.log('Đã lưu phiên Facebook (profile trình duyệt và cookie cho HTTP-only).');
  await checkHttpSession(dataDir, ownerId);
}

// One HTML GET with the saved cookies, no browser: proves the HTTP-only lane can read the session tokens.
async function checkHttpSession(dataDir, ownerId) {
  let context;
  try {
    context = await openHttpContext(dataDir, ownerId);
    const response = await context.request.get('https://www.facebook.com/', { timeout: 30000, failOnStatusCode: false });
    if (response.status() === 200 && extractSessionFromHtml(await response.text())) {
      console.log('Kiểm tra HTTP-only: OK. Đặt FACEBOOK_BROWSERLESS=true rồi khởi động bot.');
      return;
    }
    console.warn(`Kiểm tra HTTP-only: Facebook trả HTTP ${response.status()} không có phiên. Cookie có thể chưa hợp lệ hoặc bị checkpoint.`);
  } catch (error) {
    console.warn(`Kiểm tra HTTP-only thất bại: ${error.message}`);
  } finally {
    await context?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  login().catch(error => { console.error(error.message); process.exitCode = 1; });
}
