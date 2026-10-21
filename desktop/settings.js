import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { readConfig } from '../src/config.js';

// Sections, help text and select options drive the desktop settings form; keys mirror src/config.js.
export const SETTING_SECTIONS = [
  ['account','Tài khoản & dữ liệu','Tài khoản quản lý và nơi lưu dữ liệu trên máy.'],
  ['scan','Quét Facebook','Cách bot đọc bài: chế độ, feed “Gần đây nhất” và lịch quét theo độ sôi động.'],
  ['api','Tốc độ & an toàn API','Giới hạn request để tránh bị Facebook giới hạn; bot tự giãn khi có dấu hiệu bị chặn.'],
  ['actions','Bình luận, tin nhắn, kết bạn','Số luồng và khoảng nghỉ giữa các thao tác gửi lên Facebook.'],
  ['browser','Trình duyệt (chế độ browser)','Chỉ dùng khi SCAN_MODE=browser hoặc lúc đăng nhập.'],
  ['tiktok','TikTok Shop Affiliate','Cần quyền Creator API, Read Affiliate Share Link và publisher hợp lệ.'],
  ['shopee','Shopee Affiliate','App ID / secret của Affiliate Open API Việt Nam, gắn với một tài khoản quản lý.'],
  ['telegram','Telegram','Có token thì bot Telegram chạy cùng ứng dụng khi bắt đầu vận hành (dùng chung dữ liệu); để trống thì chỉ chạy cục bộ.'],
].map(([id,title,description])=>({id,title,description}));

const yesNo=[['true','Có'],['false','Không']];
export const SETTING_FIELDS = [
  ['ALLOWED_TELEGRAM_USER_IDS','ID tài khoản quản lý',{section:'account',help:'Nhiều ID cách nhau bằng dấu phẩy (ID Telegram).'}],
  ['DATA_DIR','Thư mục dữ liệu',{section:'account',help:'Đổi thư mục cần mở lại ứng dụng.'}],
  ['SCAN_MODE','Chế độ quét',{section:'scan',type:'select',options:[['api','API (nhanh, không mở trình duyệt)'],['browser','Trình duyệt']]}],
  ['FACEBOOK_BROWSERLESS','Chỉ dùng HTTP (không mở Chromium khi quét)',{section:'scan',type:'select',options:yesNo}],
  ['FEED_POLL_SECONDS','Đọc feed “Gần đây nhất” mỗi (giây)',{section:'scan',type:'number',help:'1 request đọc bài mới của mọi nhóm; 0 = tắt.'}],
  ['NOTIFICATION_POLL_SECONDS','Đọc thông báo để ưu tiên nhóm (giây)',{section:'scan',type:'number',help:'Mặc định 120; tối thiểu thực tế 60 giây; 0 = tắt. Không gửi bình luận từ nội dung thông báo.'}],
  ['SCAN_MIN_INTERVAL_SECONDS','Quét lại nhóm sớm nhất (giây)',{section:'scan',type:'number',help:'Nhóm vừa có bài mới được quét lại sau mức này.'}],
  ['SCAN_MAX_INTERVAL_SECONDS','Quét lại nhóm muộn nhất (giây)',{section:'scan',type:'number',help:'Nhóm im lặng vẫn được quét ít nhất mỗi khoảng này.'}],
  ['SCAN_WORKERS','Luồng quét (1–16)',{section:'scan',type:'number'}],
  ['POLL_INTERVAL_SECONDS','Khoảng cách tối thiểu giữa 2 lần quét một nguồn (giây)',{section:'scan',type:'number'}],
  ['HISTORY_INTERVAL_SECONDS','Quét lịch sử theo bộ lọc ngày (giây)',{section:'scan',type:'number'}],
  ['METRIC_WINDOW_HOURS','Cập nhật nội dung bài trong (giờ)',{section:'scan',type:'number'}],
  ['API_MIN_DELAY_MS','Giãn cách request tối thiểu (ms)',{section:'api',type:'number'}],
  ['API_MAX_DELAY_MS','Giãn cách request tối đa (ms)',{section:'api',type:'number'}],
  ['API_CONCURRENCY','Request song song mỗi tài khoản (1–4)',{section:'api',type:'number'}],
  ['API_MAX_REQUESTS_PER_HOUR','Trần request/giờ mỗi tài khoản',{section:'api',type:'number',help:'Lịch quét chia 95% trần này theo độ sôi động của nhóm.'}],
  ['API_TEMPLATE_TTL_MINUTES','Làm mới phiên GraphQL sau (phút)',{section:'api',type:'number'}],
  ['FACEBOOK_COOLDOWN_MS','Tạm nghỉ khi bị giới hạn (ms)',{section:'api',type:'number',help:'0 = không tạm nghỉ. Gợi ý 1800000 (30 phút).'}],
  ['COMMENT_WORKERS','Luồng bình luận',{section:'actions',type:'number'}],
  ['COMMENT_INTERVAL_SECONDS','Nghỉ giữa 2 bình luận (giây)',{section:'actions',type:'number'}],
  ['DIRECT_MESSAGE_WORKERS','Luồng nhắn tin riêng',{section:'actions',type:'number'}],
  ['DIRECT_MESSAGE_INTERVAL_SECONDS','Nghỉ giữa 2 tin nhắn (giây)',{section:'actions',type:'number'}],
  ['BLOCK_WORKERS','Luồng chặn người comment (1–8)',{section:'actions',type:'number'}],
  ['BLOCK_INTERVAL_SECONDS','Nghỉ giữa 2 lần chặn (giây)',{section:'actions',type:'number'}],
  ['FRIEND_WORKERS','Luồng kết bạn',{section:'actions',type:'number'}],
  ['FRIEND_INTERVAL_SECONDS','Nghỉ giữa 2 lời mời kết bạn (giây)',{section:'actions',type:'number'}],
  ['HEADLESS','Ẩn trình duyệt khi quét',{section:'browser',type:'select',options:yesNo}],
  ['SCROLL_PASSES','Số lần cuộn (1–10)',{section:'browser',type:'number'}],
  ['TIKTOK_AFFILIATE_OWNER_ID','ID tài khoản được dùng',{section:'tiktok'}],
  ['TIKTOK_AFFILIATE_APP_KEY','App key',{section:'tiktok'}],
  ['TIKTOK_AFFILIATE_APP_SECRET','App secret',{section:'tiktok',secret:true}],
  ['TIKTOK_AFFILIATE_ACCESS_TOKEN','Creator access token',{section:'tiktok',secret:true}],
  ['TIKTOK_AFFILIATE_CREATOR_ID','Creator ID',{section:'tiktok'}],
  ['TIKTOK_AFFILIATE_PUBLISHER_ID','Publisher ID',{section:'tiktok',help:'ID publisher do đối tác cấp; không dùng Creator ID.'}],
  ['TIKTOK_AFFILIATE_CAMPAIGN_ID','Campaign ID (tùy chọn)',{section:'tiktok'}],
  ['SHOPEE_AFFILIATE_OWNER_ID','ID tài khoản được dùng',{section:'shopee'}],
  ['SHOPEE_AFFILIATE_APP_ID','Affiliate App ID',{section:'shopee'}],
  ['SHOPEE_AFFILIATE_SECRET','Affiliate secret',{section:'shopee',secret:true}],
  ['TELEGRAM_BOT_TOKEN','Telegram bot token',{section:'telegram',secret:true}],
].map(([key,label,{section,secret=false,type='text',help=null,options=null}])=>({key,label,section,secret,type,help,options}));

const FIELDS = new Map(SETTING_FIELDS.map(field=>[field.key,field]));
const DEFAULTS = { ALLOWED_TELEGRAM_USER_IDS:'1',DATA_DIR:'./data',HEADLESS:'true',POLL_INTERVAL_SECONDS:'10',HISTORY_INTERVAL_SECONDS:'600',SCROLL_PASSES:'3',SCAN_WORKERS:'4',METRIC_WINDOW_HOURS:'24',
  SCAN_MODE:'api',FACEBOOK_BROWSERLESS:'false',FEED_POLL_SECONDS:'10',SCAN_MIN_INTERVAL_SECONDS:'120',SCAN_MAX_INTERVAL_SECONDS:'1800',API_MIN_DELAY_MS:'3000',API_MAX_DELAY_MS:'8000',
  API_MAX_REQUESTS_PER_HOUR:'400',API_CONCURRENCY:'1',API_TEMPLATE_TTL_MINUTES:'360',FACEBOOK_COOLDOWN_MS:'0',COMMENT_WORKERS:'4',COMMENT_INTERVAL_SECONDS:'0',
  DIRECT_MESSAGE_WORKERS:'4',DIRECT_MESSAGE_INTERVAL_SECONDS:'0',FRIEND_WORKERS:'2',FRIEND_INTERVAL_SECONDS:'0',BLOCK_WORKERS:'3',BLOCK_INTERVAL_SECONDS:'15' };

export function desktopConfig(env,baseDir) {
  const config = readConfig({...env,TELEGRAM_BOT_TOKEN:env.TELEGRAM_BOT_TOKEN?.trim() || '123456:desktop_local_only',ALLOWED_TELEGRAM_USER_IDS:env.ALLOWED_TELEGRAM_USER_IDS?.trim() || '1',DATA_DIR:path.resolve(baseDir,env.DATA_DIR || './data')});
  return config;
}

export async function readSettings(baseDir,inherited={}) {
  let content='';
  try { content=await readFile(path.join(baseDir,'.env'),'utf8'); }
  catch(error) {if(error.code!=='ENOENT') throw error;}
  return {content,env:{...inherited,...parseEnv(content)}};
}

export function publicSettings(env) {
  return {values:Object.fromEntries(SETTING_FIELDS.map(({key,secret})=>[key,secret?'':env[key] ?? DEFAULTS[key] ?? ''])),hasSecrets:Object.fromEntries(SETTING_FIELDS.filter(field=>field.secret).map(({key})=>[key,Boolean(env[key])])),fields:SETTING_FIELDS,sections:SETTING_SECTIONS};
}

export function settingsUpdate(existing,values={},clearSecrets=[]) {
  if(!values || typeof values!=='object' || Array.isArray(values) || !Array.isArray(clearSecrets)) throw new Error('Cấu hình không hợp lệ.');
  const changes={};
  for(const [key,raw] of Object.entries(values)) {
    const field=FIELDS.get(key);
    if(!field || !['string','number','boolean'].includes(typeof raw)) throw new Error('Trường cấu hình không hợp lệ.');
    const value=String(raw).trim();
    if(value.length>8192 || /[\r\n\0]/.test(value)) throw new Error(`${key} phải nằm trên một dòng.`);
    if(field.secret && !value) continue;
    changes[key]=value;
  }
  for(const key of clearSecrets) {
    if(!FIELDS.get(key)?.secret) throw new Error('Chỉ có thể xóa rõ ràng trường bí mật.');
    changes[key]='';
  }
  return {env:{...existing,...changes},changes};
}

export async function writeSettings(baseDir,content,changes) {
  // Preserve comments and unrecognized settings verbatim. Supported keys replace all
  // duplicate occurrences so an older duplicate cannot silently win on reload.
  const remaining=new Set(Object.keys(changes));
  const lines=content.split(/\r?\n/).filter(line=>{
    const key=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    return !Object.hasOwn(changes,key);
  });
  // The final newline splits into an empty line; dropping trailing blanks keeps repeated saves from growing the file.
  while(lines.length && !lines.at(-1).trim()) lines.pop();
  for(const key of remaining) {
    const value=changes[key];
    // dotenv single quotes preserve $, backslashes and #. Reject the rare value
    // containing both quote types rather than changing the secret's bytes.
    if(value.includes("'") && value.includes('"')) throw new Error(`${key} chứa tổ hợp dấu nháy không hỗ trợ.`);
    const quote=value.includes("'")?'"':"'";
    lines.push(`${key}=${quote}${value}${quote}`);
  }
  const serialized=lines.join('\n').replace(/^\n+/,'')+'\n';
  const roundtrip=parseEnv(serialized);
  for(const [key,value] of Object.entries(changes)) {
    if(roundtrip[key]!==value) throw new Error(`${key} chứa ký tự không thể lưu nguyên vẹn vào .env.`);
  }
  const filename=path.join(baseDir,'.env'),temporary=path.join(baseDir,`.env.desktop-${process.pid}.tmp`);
  await writeFile(temporary,serialized,{encoding:'utf8',mode:0o600});
  await rename(temporary,filename);
}
