import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from './config.js';
import { Store } from './store.js';
import { FacebookCollector } from './facebook.js';
import { createBot, registerCommands } from './bot.js';
import { Monitor, safeError } from './monitor.js';
import { ShopeeAffiliate } from './affiliate.js';
import { TikTokAffiliate } from './tiktok-affiliate.js';

// Prevent two bot processes from using the same profiles/SQLite outbox.
async function acquireLock(dataDir) {
  const filename = path.join(dataDir,'monitor.lock');
  try {
    const file = await open(filename,'wx');
    await file.writeFile(String(process.pid));
    await file.close();
    return async () => { await unlink(filename).catch(() => {}); };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(filename,'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('monitor.lock không hợp lệ. Kiểm tra tiến trình bot trước khi xóa file khóa.');
    try { process.kill(pid,0); }
    catch (probe) {
      if (probe.code === 'ESRCH') {
        await unlink(filename);
        return acquireLock(dataDir);
      }
      throw probe;
    }
    throw new Error('Bot đã chạy với DATA_DIR này. Dừng tiến trình cũ trước.');
  }
}

async function main() {
  const config = readConfig();
  await mkdir(config.dataDir,{recursive:true});
  const release = await acquireLock(config.dataDir);
  let store,collector,bot,monitor,monitorRun;
  let stopping=false;
  const stop = () => {
    if (stopping) return;
    stopping=true;
    monitor?.abort.abort();
    if (bot?.isRunning()) void bot.stop().catch(() => {});
  };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  try {
    store = new Store(path.join(config.dataDir,'monitor.sqlite'));
    collector = new FacebookCollector(config);
    const tiktokAffiliate=new TikTokAffiliate(config.tiktokAffiliate);
    bot = createBot({token:config.token,allowedUserIds:config.allowedUserIds,store,collector,affiliate:new ShopeeAffiliate(config.shopeeAffiliate),tiktokAffiliate});
    await bot.init();
    const webhook = await bot.api.getWebhookInfo();
    if (webhook.url) throw new Error('Bot đang dùng webhook. Hãy dùng token bot riêng hoặc chủ động gỡ webhook trước khi chạy polling.');
    await registerCommands(bot.api);
    if (stopping) return;
    monitor = new Monitor({store,collector,api:bot.api,config,tiktokAffiliate});
    monitorRun = monitor.start();
    // Attach rejection handling immediately; a background failure stops the bot too.
    const failure = monitorRun.catch(error => { stop(); throw error; });
    console.log(`Bot @${bot.botInfo.username} đang chạy. Nhắn /whoami hoặc /help trong chat riêng.`);
    console.log(`Chu kỳ tối thiểu: ${config.pollIntervalMs/1000}s/nhóm; độ trễ thực tế tăng khi thêm nhóm.`);
    await Promise.race([bot.start({allowed_updates:['message','callback_query']}),failure]);
  } finally {
    stop();
    await monitorRun?.catch(() => {});
    try { await collector?.close(); }
    finally {
      try { store?.close(); }
      finally {
        await release();
        process.removeListener('SIGINT',stop);
        process.removeListener('SIGTERM',stop);
      }
    }
  }
}

main().catch(error => {
  console.error(safeError(error));
  process.exitCode=1;
});
