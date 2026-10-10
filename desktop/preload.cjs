const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',Object.freeze({
  call:(method,args={})=>ipcRenderer.invoke('desktop:call',method,args),
  onEvent:callback=>{
    if(typeof callback!=='function')throw new TypeError('Callback required');
    const listener=(_event,payload)=>callback(payload);
    ipcRenderer.on('desktop:event',listener);
    return ()=>ipcRenderer.removeListener('desktop:event',listener);
  },
}));
