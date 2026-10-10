import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function acquireDesktopLock(dataDir) {
  await mkdir(dataDir,{recursive:true});
  const filename=path.join(dataDir,'monitor.lock');
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const file=await open(filename,'wx',0o600);
      try {await file.writeFile(String(process.pid));} finally {await file.close();}
      let released=false;
      return async()=>{
        if(released) return;
        released=true;
        // Do not unlink another process's lock if it was externally replaced.
        if(await readFile(filename,'utf8').catch(()=>null)===String(process.pid)) await unlink(filename).catch(()=>{});
      };
    } catch(error) {
      if(error.code!=='EEXIST') throw error;
      const pid=Number(await readFile(filename,'utf8').catch(()=>''));
      if(!Number.isSafeInteger(pid) || pid<=0) throw new Error('monitor.lock không hợp lệ. Kiểm tra tiến trình bot trước khi xử lý file khóa.');
      try {process.kill(pid,0);}
      catch(probe) {
        if(probe.code==='ESRCH') {await unlink(filename);continue;}
        throw new Error('Không kiểm tra được tiến trình đang giữ thư mục dữ liệu.');
      }
      throw new Error('Bot hoặc ứng dụng khác đang sử dụng dữ liệu này. Dừng tiến trình đó trước khi mở desktop.');
    }
  }
  throw new Error('Không lấy được khóa thư mục dữ liệu.');
}
