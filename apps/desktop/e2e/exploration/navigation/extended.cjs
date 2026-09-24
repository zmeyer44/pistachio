const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const out = path.resolve('../../docs/qa/2026-09-09/navigation');
const log = [];
let app, shell;
async function record(name, detail) { log.push({name,detail}); console.log(name,JSON.stringify(detail).slice(0,900)); await fs.writeFile(path.join(out,'extended-observations.json'),JSON.stringify(log,null,2)); }
async function capture(name) { const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')); await fs.writeFile(path.join(out,name+'.png'),Buffer.from(png,'base64')); await shell.screenshot({path:path.join(out,name+'-shell.png')}); const s=await snapshot(); const tab=s.tabs.find(t=>t.id===s.activeTabId); const page=app.windows().find(p=>p.url()===tab?.url); if(page && !(await shell.getByTestId('site-info-popover').isVisible()) && !(await shell.getByTestId('site-controls').isVisible()) && !(await shell.getByTestId('url-bar').isVisible()) && !(await shell.getByTestId('glance-overlay').isVisible())) await page.screenshot({path:path.join(out,name+'-content.png')}); }
async function snapshot() { return shell.evaluate(()=>window.pistachio.getSnapshot()); }
async function nativeRead() { const s=await snapshot(); const active=s.tabs.find(t=>t.id===s.activeTabId); return app.evaluate(async({webContents}, url)=>{const t=webContents.getAllWebContents().find(t=>t.getURL()===url); if(!t)return {missing:url,all:webContents.getAllWebContents().map(t=>t.getURL())};return {url:t.getURL(),title:t.getTitle(),loading:t.isLoading(),text:await t.executeJavaScript('document.body.innerText')};},active.url); }
async function nav(value,label) { await shell.keyboard.press('Meta+l'); const input=shell.getByTestId('address-input'); await expect(input).toBeVisible(); await input.fill(value); await capture(label+'-address'); await input.press('Enter'); await expect(input).toHaveCount(0); await expect.poll(async()=>{const s=await snapshot(); return s.tabs.find(t=>t.id===s.activeTabId)?.loading;},{timeout:30000}).not.toBe(true); await capture(label+'-page'); await record(label,{snapshot:await snapshot(),native:await nativeRead()}); }
(async()=>{
 await fs.mkdir(out,{recursive:true});
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pistachio-navigation-qa-'));
 const wav=Buffer.alloc(44+16000*2*5);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);for(let i=0;i<80000;i++)wav.writeInt16LE(Math.round(Math.sin(i/16000*Math.PI*880)*200),44+i*2);
 const server=http.createServer((req,res)=>{if(req.url==='/tone.wav'){res.writeHead(200,{'content-type':'audio/wav'});res.end(wav);return;}if(req.url==='/media'){res.writeHead(200,{'content-type':'text/html'});res.end('<title>Quiet tone QA</title><h1>Media fixture</h1><audio src="/tone.wav" loop controls></audio><button onclick="document.querySelector(\'audio\').play()">Play quiet tone</button>');return;}if(req.url==='/download'){res.writeHead(200,{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="qa-navigation.txt"'});res.end('QA download');return;}res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><title>${req.url==='/second'?'Second page':'Navigation QA'}</title><style>body{font:18px system-ui;margin:40px;line-height:1.7}a,button,input{margin:12px}p{max-width:700px}</style><h1>${req.url==='/second'?'Second page':'Navigation QA'}</h1><p>A simple browsing fixture. Apple apple apple. A normal page without audio.</p><p><a id="second" href="/second">Read second page</a><a href="/" id="home">Home</a><a href="/download" download>Download notes</a><a href="/second" target="_blank">Open second page in new tab</a></p><label>Draft note <input id="draft" placeholder="Write a draft"></label><p id="tall">${'A paragraph to explore scrolling. '.repeat(300)}</p>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 try{
 app=await electron.launch({args:['.'],cwd:process.cwd(),executablePath:path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),env:{...process.env,PISTACHIO_E2E:'1',PISTACHIO_USER_DATA:profile}});
 shell=app.windows().find(p=>p.url().endsWith('/index.html')) || await app.waitForEvent('window',{predicate:p=>p.url().endsWith('/index.html')}); await shell.waitForLoadState('domcontentloaded');
 await record('environment',{profile,base,pages:app.windows().map(p=>p.url())});
 await capture('01-initial');
 await nav('https://en.wikipedia.org/wiki/Pistachio','40-article');
 await shell.keyboard.press('Meta+Shift+a');
 await expect.poll(async()=>(await snapshot()).tabs[0].url,{timeout:30000}).toContain('pistachio://reader');
 await record('reader',await nativeRead());await capture('41-reader');
 await shell.keyboard.press('Meta+Shift+a');await expect.poll(async()=>(await snapshot()).tabs[0].url).toBe('https://en.wikipedia.org/wiki/Pistachio');await capture('42-reader-return');
 await nav(base,'43-glance-owner');
 let native=app.windows().find(p=>p.url()===base+'/');
 await native.getByRole('link',{name:'Read second page',exact:true}).click({modifiers:['Alt']});
 await expect(shell.getByTestId('glance-overlay')).toBeVisible();await record('glance-shell',await shell.locator('body').innerText());await shell.screenshot({path:path.join(out,'44-glance-shell.png')});
 await shell.keyboard.press('Escape');await expect(shell.getByTestId('glance-overlay')).toHaveCount(0);await record('glance-dismissed',await snapshot());
 await native.getByRole('link',{name:'Read second page',exact:true}).click({modifiers:['Alt']});await expect(shell.getByTestId('glance-overlay')).toBeVisible();
 await shell.getByTestId('glance-promote').click();await expect.poll(async()=>(await snapshot()).tabs.length).toBe(2);await record('glance-promoted',await snapshot());await capture('45-glance-promoted');
 await nav(base+'/media','46-media-page');
 native=app.windows().find(p=>p.url()===base+'/media');await native.getByRole('button',{name:'Play quiet tone'}).click();
 await expect.poll(()=>native.evaluate(()=>document.querySelector('audio').paused)).toBe(false);await capture('47-media-playing');
 await shell.keyboard.press('Meta+t');await expect(shell.getByTestId('address-input')).toBeVisible();await shell.getByTestId('address-input').fill(base+'/second');await shell.getByTestId('address-input').press('Enter');
 await expect.poll(async()=>shell.getByTestId('media-stack').count()).toBe(1);await record('background-media',await shell.getByTestId('media-stack').innerText());await shell.screenshot({path:path.join(out,'48-background-media-shell.png')});
 await record('media-buttons',await shell.getByTestId('media-stack').getByRole('button').evaluateAll(bs=>bs.map(b=>({text:b.textContent,label:b.getAttribute('aria-label')}))));
 await shell.getByTestId('media-stack').getByRole('button',{name:'Pause',exact:true}).click();await expect.poll(()=>native.evaluate(()=>document.querySelector('audio').paused)).toBe(true);await record('media-paused',true);await shell.screenshot({path:path.join(out,'49-media-paused-shell.png')});
 }catch(e){await record('error',e.stack);if(app){await capture('99-failure');const f=app.windows().find(p=>p.url().endsWith('#find'));if(f)await f.screenshot({path:path.join(out,'99-find.png')});}process.exitCode=1;}finally{if(app)await app.close();server.closeAllConnections();server.close();}
})();
