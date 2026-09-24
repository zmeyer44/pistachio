// @ts-nocheck
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
export async function captureComposite(app,name){
 const dir=resolve('../../docs/qa/2026-09-09/organization/extra');await mkdir(dir,{recursive:true});
 const c=await app.evaluate(async({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];const f=await w.capturePage();const size=f.getSize();const views=await Promise.all(w.contentView.children.filter(c=>'webContents'in c&&c.getVisible()).map(async c=>{try{return await Promise.race([(async()=>({b:c.getBounds(),png:(await c.webContents.capturePage()).toPNG().toString('base64')}))(),new Promise((_,j)=>setTimeout(()=>j(new Error('timeout')),1500))]);}catch{return null;}}));return {frame:f.toPNG().toString('base64'),...size,scale:size.width/w.getContentSize()[0],views}});
 const shell=app.windows().find(p=>p.url().includes('index.html')&&!p.url().includes('#'));
 const data=await shell.evaluate(async c=>{const decode=p=>new Promise((r,j)=>{const i=new Image();i.onload=()=>r(i);i.onerror=j;i.src='data:image/png;base64,'+p});const can=document.createElement('canvas');can.width=c.width;can.height=c.height;const ctx=can.getContext('2d');ctx.drawImage(await decode(c.frame),0,0);for(const v of c.views.filter(Boolean))ctx.drawImage(await decode(v.png),Math.round(v.b.x*c.scale),Math.round(v.b.y*c.scale));return can.toDataURL('image/png').split(',')[1]},c);
 await writeFile(join(dir,name+'.png'),Buffer.from(data,'base64'));
}
