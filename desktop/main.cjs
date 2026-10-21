const {app,BrowserWindow,ipcMain,protocol,net,shell,dialog,session}=require('electron');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const {pathToFileURL}=require('node:url');
const {mkdir,open}=require('node:fs/promises');
const path=require('node:path');

protocol.registerSchemesAsPrivileged([{scheme:'desk',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.setName('Affiliate Desk');
app.setPath('userData',process.env.DESKTOP_USER_DATA || path.join(app.getPath('appData'),'AffiliateDesk'));
const workspace=process.env.DESKTOP_WORKSPACE || (app.isPackaged?path.join(app.getPath('userData'),'workspace'):path.resolve(__dirname,'..'));
const uiRoot=path.join(__dirname,'ui');
const allowedMethods=new Set(['bootstrap','init','state','sources','posts','rejected','postCallback','retryBlocks','comments','links','command','callback','settings.get','settings.save','runtime.start','runtime.stop','login.open','login.finish','login.cancel','inboxes','friends','blocks','hot','health','joined','remove']);
let win,child,closing=false,sequence=0;
const pending=new Map();
function event(value) {if(win && !win.isDestroyed()) win.webContents.send('desktop:event',value);}
function failPending(message) {
  for(const {reject,timer} of pending.values()) {clearTimeout(timer);reject(new Error(message));}
  pending.clear();
}
function worker() {
  if(child) return;
  const backend=app.isPackaged?path.join(process.resourcesPath,'backend'):path.resolve(__dirname,'..');
  const node=app.isPackaged?path.join(process.resourcesPath,'runtime','node.exe'):process.env.DESKTOP_NODE;
  if(!node) throw new Error('Mở app bằng npm run desktop để chọn đúng Node runtime.');
  const env={...process.env,DESKTOP_WORKSPACE:workspace};
  delete env.ELECTRON_RUN_AS_NODE;
  if(app.isPackaged) env.PLAYWRIGHT_BROWSERS_PATH=path.join(process.resourcesPath,'browsers');
  child=spawn(node,['--max-old-space-size=4096','--expose-gc',path.join(backend,'desktop','service.js')],{cwd:workspace,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    let reply;try{reply=JSON.parse(line);}catch{return;}
    if(reply.event) {event(reply);return;}
    const request=pending.get(reply.id);if(!request)return;
    pending.delete(reply.id);clearTimeout(request.timer);
    if(reply.error) request.reject(new Error(typeof reply.error==='string'?reply.error:'Không xử lý được yêu cầu.'));
    else request.resolve(reply.result);
  });
  // Diagnostics stay in the worker's bounded, redacted log. Raw stderr can contain secrets.
  child.stderr.resume();
  child.on('error',()=>failPending('Không khởi động được bộ xử lý desktop. Kiểm tra Node runtime.'));
  child.on('exit',()=>{
    child=null;lines.close();failPending('Bộ xử lý đã dừng. Hãy mở lại app.');
    if(!closing) event({event:'error',data:{message:'Bộ xử lý đã dừng. Đóng và mở lại app trước khi tiếp tục.'}});
  });
}
function call(method,args={}) {
  worker();
  return new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Tác vụ mất quá lâu; hãy kiểm tra nhật ký trước khi thử lại.'));},600000);
    pending.set(id,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({id,method,args})+'\n',error=>{
      if(error) {pending.delete(id);clearTimeout(timer);reject(new Error('Mất kết nối với bộ xử lý.'));}
    });
  });
}
function trustedSender(e) {
  return win && e.sender===win.webContents && e.senderFrame===win.webContents.mainFrame && e.senderFrame.url==='desk://app/index.html';
}
function externalUrl(value) {
  if(typeof value!=='string'||value.length>4000||/[\s\\\u0000-\u001f]/.test(value))throw new Error('Link không hợp lệ.');
  const url=new URL(value);
  if(url.href==='https://chat.zalo.me/')return url.href;
  const hosts=['facebook.com','www.facebook.com','m.facebook.com','web.facebook.com','shopee.vn','www.shopee.vn','s.shopee.vn','shope.ee','tiktok.com','www.tiktok.com','shop.tiktok.com','vt.tiktok.com','vm.tiktok.com'];
  if(url.protocol!=='https:'||url.port||url.username||url.password||!hosts.includes(url.hostname))throw new Error('Chỉ mở link Facebook, Shopee hoặc TikTok hợp lệ.');
  return url.href;
}
async function createWindow() {
  win=new BrowserWindow({width:1440,height:940,minWidth:1000,minHeight:700,show:false,backgroundColor:'#f3f6fa',title:'Affiliate Desk',autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  win.webContents.on('will-attach-webview',e=>e.preventDefault());
  win.once('ready-to-show',()=>win.show());
  await win.loadURL('desk://app/index.html');
}
if(!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
  app.whenReady().then(async()=>{
    await mkdir(workspace,{recursive:true});
    session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    protocol.handle('desk',request=>{
      const url=new URL(request.url);
      if(url.host!=='app'||!['/index.html','/styles.css','/app.js'].includes(url.pathname))return new Response('Not found',{status:404});
      return net.fetch(pathToFileURL(path.join(uiRoot,url.pathname.slice(1))).href);
    });
    ipcMain.handle('desktop:call',async(e,method,args={})=>{
      if(!trustedSender(e))throw new Error('Nguồn yêu cầu không hợp lệ.');
      if(JSON.stringify(args).length>1500000)throw new Error('Dữ liệu vượt quá dung lượng cho phép.');
      if(method==='openExternal') {await shell.openExternal(externalUrl(args.url));return true;}
      if(method==='pickImport') {
        const selection=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Danh sách nhóm',extensions:['txt','csv']}]});
        if(selection.canceled)return null;
        const file=await open(selection.filePaths[0],'r');
        try {
          if((await file.stat()).size>1048576)throw new Error('File tối đa 1 MB.');
          const buffer=Buffer.alloc(1048577);let total=0;
          while(total<buffer.length) {
            const {bytesRead}=await file.read(buffer,total,buffer.length-total,null);
            if(!bytesRead)break;total+=bytesRead;
          }
          if(total>1048576)throw new Error('File tối đa 1 MB.');
          return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,total));
        } finally {await file.close();}
      }
      if(!allowedMethods.has(method))throw new Error('Chức năng không hợp lệ.');
      return call(method,args);
    });
    await createWindow();
  }).catch(()=>{dialog.showErrorBox('Affiliate Desk','Không mở được app. Kiểm tra quyền truy cập thư mục dữ liệu.');app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',e=>{
    if(closing||!child)return;
    e.preventDefault();closing=true;
    // EOF lets the worker drain and release its profile/database lock cleanly.
    child.stdin.end();
    child.once('exit',()=>app.quit());
    setTimeout(()=>{child?.kill();app.quit();},60000).unref();
  });
}
