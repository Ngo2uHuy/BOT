import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const env={...process.env,DESKTOP_NODE:process.execPath,DESKTOP_WORKSPACE:process.env.DESKTOP_WORKSPACE||root};
delete env.ELECTRON_RUN_AS_NODE;
// windowsHide must stay off: on Windows it starts the GUI hidden, so the app window never appears.
const child=spawn(require('electron'),[path.join(root,'desktop','main.cjs')],{cwd:root,env,stdio:'inherit'});
child.on('error',()=>{console.error('Không mở được Electron. Cài dependencies rồi thử lại.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
