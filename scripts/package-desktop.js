import {cp,mkdir,mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {packager} from '@electron/packager';
import {chromium} from 'playwright';

const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Build này dành cho Windows x64.');
const buildRoot=path.join(root,'.desktop-build');
await mkdir(buildRoot,{recursive:true});
const stage=await mkdtemp(path.join(buildRoot,'package-'));
const electronVersion=require('electron/package.json').version;
const config=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
async function exists(file) {try {await access(file);return true;}catch{return false;}}
try {
  const appDir=path.join(stage,'app'),backend=path.join(stage,'backend'),runtime=path.join(stage,'runtime'),browsers=path.join(stage,'browsers');
  for(const dir of [appDir,backend,runtime,browsers])await mkdir(dir,{recursive:true});
  await cp(path.join(root,'desktop'),path.join(appDir,'desktop'),{recursive:true,filter:source=>!source.endsWith('service.js')&&!source.endsWith('settings.js')});
  await writeFile(path.join(appDir,'package.json'),JSON.stringify({name:'affiliate-desk',productName:'Affiliate Desk',version:config.version,main:'desktop/main.cjs',private:true},null,2));
  await cp(path.join(root,'src'),path.join(backend,'src'),{recursive:true});
  await cp(path.join(root,'desktop'),path.join(backend,'desktop'),{recursive:true,filter:source=>!source.includes(path.sep+'ui')});
  await writeFile(path.join(backend,'package.json'),JSON.stringify({name:config.name,version:config.version,type:'module',private:true,dependencies:config.dependencies},null,2));
  // Copy only installed production dependencies. Never copy workspace data, .env or browser sessions.
  const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
  for(const [relative,metadata] of Object.entries(lock.packages)) {
    if(!relative.startsWith('node_modules/')||metadata.dev||!await exists(path.join(root,relative)))continue;
    await cp(path.join(root,relative),path.join(backend,relative),{recursive:true,filter:source=>!source.includes(path.sep+'node_modules'+path.sep+'.cache')});
  }
  await cp(process.execPath,path.join(runtime,'node.exe'));
  const nodeLicense=path.join(path.dirname(process.execPath),'LICENSE');
  const bundledLicense=path.join(root,'desktop','licenses',`node-${process.version}-LICENSE.txt`);
  if(await exists(nodeLicense))await cp(nodeLicense,path.join(runtime,'LICENSE'));
  else if(await exists(bundledLicense))await cp(bundledLicense,path.join(runtime,'LICENSE'));
  else throw new Error(`Thiếu giấy phép Node ${process.version}. Thêm LICENSE tương ứng vào desktop/licenses trước khi đóng gói.`);
  const browserCache=path.dirname(path.dirname(path.dirname(chromium.executablePath())));
  const browserMeta=JSON.parse(await readFile(path.join(root,'node_modules','playwright-core','browsers.json'),'utf8'));
  for(const entry of browserMeta.browsers.filter(b=>['chromium','chromium-headless-shell','ffmpeg','winldd'].includes(b.name))) {
    const name=entry.name.replaceAll('-','_')+'-'+entry.revision;
    const source=path.join(browserCache,name);
    if(!await exists(source))throw new Error(`Thiếu trình duyệt ${name}. Chạy npm run install-browser rồi build lại.`);
    await cp(source,path.join(browsers,name),{recursive:true});
  }
  const output=path.resolve(root,'dist');
  if(path.dirname(output)!==root)throw new Error('Thư mục build không hợp lệ.');
  const result=await packager({dir:appDir,out:output,name:'AffiliateDesk',executableName:'AffiliateDesk',platform:'win32',arch:'x64',electronVersion,
    appVersion:config.version,overwrite:true,asar:true,prune:false,download:{cacheRoot:path.join(root,'.electron-cache')},
    extraResource:[backend,runtime,browsers],win32metadata:{CompanyName:'Affiliate Desk',FileDescription:'Affiliate Desk — Facebook & Affiliate Workspace',ProductName:'Affiliate Desk'}});
  await cp(path.join(root,'desktop','README.md'),path.join(result[0],'HUONG-DAN.md'));
  console.log(`Đã tạo: ${path.join(result[0],'AffiliateDesk.exe')}`);
  console.log('Sao chép toàn bộ thư mục để sử dụng bản portable; dữ liệu tài khoản không nằm trong gói.');
} finally {
  const resolved=path.resolve(stage);
  if(path.dirname(resolved)!==buildRoot||!path.basename(resolved).startsWith('package-'))throw new Error('Không dọn đường dẫn ngoài thư mục build.');
  await rm(resolved,{recursive:true,force:true});
}
