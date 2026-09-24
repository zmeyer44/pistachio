const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const out = path.resolve('../../docs/qa/2026-09-09/navigation');
const log = [];
let app, shell;
async function record(name, detail) { log.push({name,detail}); console.log(name,JSON.stringify(detail)); await fs.writeFile(path.join(out,'observations.json'),JSON.stringify(log,null,2)); }
async function capture(name) { const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')); await fs.writeFile(path.join(out,name+'.png'),Buffer.from(png,'base64')); }
async function snapshot() { return shell.evaluate(()=>window.pistachio.getSnapshot()); }
async function nativeRead() { const s=await snapshot(); const active=s.tabs.find(t=>t.id===s.activeTabId); return app.evaluate(async({webContents}, url)=>{const t=webContents.getAllWebContents().find(t=>t.getURL()===url); if(!t)return {missing:url,all:webContents.getAllWebContents().map(t=>t.getURL())};return {url:t.getURL(),title:t.getTitle(),loading:t.isLoading(),text:await t.executeJavaScript('document.body.innerText')};},active.url); }
async function nav(value,label) { await shell.keyboard.press('Meta+l'); const input=shell.getByTestId('address-input'); await expect(input).toBeVisible(); await input.fill(value); await capture(label+'-address'); await input.press('Enter'); await expect(input).toHaveCount(0); await expect.poll(async()=>{const s=await snapshot(); return s.tabs.find(t=>t.id===s.activeTabId)?.loading;},{timeout:30000}).not.toBe(true); await capture(label+'-page'); await record(label,{snapshot:await snapshot(),native:await nativeRead()}); }
(async()=>{
 await fs.mkdir(out,{recursive:true});
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'pistachio-navigation-qa-'));
 const server=http.createServer((req,res)=>{if(req.url==='/download'){res.writeHead(200,{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="qa-navigation.txt"'});res.end('QA download');return;}res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><title>${req.url==='/second'?'Second page':'Navigation QA'}</title><style>body{font:18px system-ui;margin:40px;line-height:1.7}a,button,input{margin:12px}p{max-width:700px}</style><h1>${req.url==='/second'?'Second page':'Navigation QA'}</h1><p>A simple browsing fixture. Apple apple apple. A normal page without audio.</p><p><a id="second" href="/second">Read second page</a><a href="/" id="home">Home</a><a href="/download" download>Download notes</a><a href="/second" target="_blank">Open second page in new tab</a></p><label>Draft note <input id="draft" placeholder="Write a draft"></label><p id="tall">${'A paragraph to explore scrolling. '.repeat(300)}</p>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 try{
 app=await electron.launch({args:['.'],cwd:process.cwd(),executablePath:path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),env:{...process.env,PISTACHIO_E2E:'1',PISTACHIO_USER_DATA:profile}});
 shell=app.windows().find(p=>p.url().endsWith('/index.html')) || await app.waitForEvent('window',{predicate:p=>p.url().endsWith('/index.html')}); await shell.waitForLoadState('domcontentloaded');
 await record('environment',{profile,base,pages:app.windows().map(p=>p.url())});
 await capture('01-initial');
 await nav('https://example.com','02-example');
 await nav('https://en.wikipedia.org/wiki/Pistachio','03-wikipedia');
 await shell.keyboard.press('Meta+f');
 const find=app.windows().find(p=>p.url().endsWith('#find')); await record('find-page',{pages:app.windows().map(p=>p.url()),found:!!find});
 if(find){const field=find.getByRole('textbox',{name:'Find in page'});await field.fill('pistachio');await expect.poll(()=>find.evaluate(()=>window.pistachio.getFindState())).toMatchObject({query:'pistachio'});await capture('04-find-wikipedia');await record('find-wikipedia',await find.evaluate(()=>window.pistachio.getFindState()));await field.press('Escape');}
 await nav('pistachio recipes','05-search');
 await nav(base,'06-fixture');
 await record('native-context-pages',app.context().pages().map(p=>p.url()));
 await nav(base+'/second','07-second');
 await shell.keyboard.press('Meta+['); await capture('08-back');await record('back',await nativeRead());
 await shell.keyboard.press('Meta+]');await capture('09-forward');await record('forward',await nativeRead());
 await shell.keyboard.press('Meta+r');await capture('10-reload');await record('reload',await nativeRead());
 await nav('http://127.0.0.1:1','11-error');
 await nav(base,'12-recovered');
 await shell.keyboard.press('Meta+l'); await record('recent-overlay',await shell.locator('body').innerText()); await capture('13-recent-overlay');await shell.keyboard.press('Escape');
 await record('shell-buttons',await shell.getByRole('button').evaluateAll(bs=>bs.map(b=>({text:b.textContent,label:b.getAttribute('aria-label'),title:b.title,testid:b.getAttribute('data-testid')}))));
 }catch(e){await record('error',e.stack);if(app)await capture('99-failure');process.exitCode=1;}finally{if(app)await app.close();server.closeAllConnections();server.close();}
})();
