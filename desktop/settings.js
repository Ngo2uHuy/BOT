import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { readConfig } from '../src/config.js';

export const SETTING_FIELDS = [
  ['ALLOWED_TELEGRAM_USER_IDS','ID tài khoản (phân cách bằng dấu phẩy)'],
  ['TELEGRAM_BOT_TOKEN','Telegram bot token',true],
  ['DATA_DIR','Thư mục dữ liệu'],
  ['POLL_INTERVAL_SECONDS','Chu kỳ quét (giây)',false,'number'],
  ['HISTORY_INTERVAL_SECONDS','Quét lịch sử (giây)',false,'number'],
  ['HEADLESS','Ẩn trình duyệt',false,'boolean'],
  ['SCROLL_PASSES','Số lượt cuộn',false,'number'],
  ['SCAN_WORKERS','Luồng quét',false,'number'],
  ['METRIC_WINDOW_HOURS','Khoảng cập nhật tương tác (giờ)',false,'number'],
  ['METRIC_REFRESH_SECONDS','Chu kỳ cập nhật tương tác (giây)',false,'number'],
  ['SHOPEE_AFFILIATE_OWNER_ID','Shopee: ID tài khoản'],
  ['SHOPEE_AFFILIATE_APP_ID','Shopee: App ID'],
  ['SHOPEE_AFFILIATE_SECRET','Shopee: Secret',true],
  ['TIKTOK_AFFILIATE_OWNER_ID','TikTok: ID tài khoản'],
  ['TIKTOK_AFFILIATE_APP_KEY','TikTok: App key'],
  ['TIKTOK_AFFILIATE_APP_SECRET','TikTok: App secret',true],
  ['TIKTOK_AFFILIATE_ACCESS_TOKEN','TikTok: Access token',true],
  ['TIKTOK_AFFILIATE_CREATOR_ID','TikTok: Creator ID'],
  ['TIKTOK_AFFILIATE_PUBLISHER_ID','TikTok: Publisher ID'],
  ['TIKTOK_AFFILIATE_CAMPAIGN_ID','TikTok: Campaign ID (tùy chọn)'],
].map(([key,label,secret=false,type='text'])=>({key,label,secret,type}));

const FIELDS = new Map(SETTING_FIELDS.map(field=>[field.key,field]));
const DEFAULTS = { ALLOWED_TELEGRAM_USER_IDS:'1',DATA_DIR:'./data',HEADLESS:'true',POLL_INTERVAL_SECONDS:'10',HISTORY_INTERVAL_SECONDS:'600',SCROLL_PASSES:'3',SCAN_WORKERS:'4',METRIC_WINDOW_HOURS:'24',METRIC_REFRESH_SECONDS:'600' };

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
  return {values:Object.fromEntries(SETTING_FIELDS.map(({key,secret})=>[key,secret?'':env[key] ?? DEFAULTS[key] ?? ''])),hasSecrets:Object.fromEntries(SETTING_FIELDS.filter(field=>field.secret).map(({key})=>[key,Boolean(env[key])])),fields:SETTING_FIELDS};
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
