const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const out = path.resolve('../../docs/qa/2026-09-09/navigation');
const log = [];
let app, shell;
async function record(name, detail) { log.push({name,detail}); console.log(name,JSON.stringify(detail).slice(0,900)); await fs.writeFile(path.join(out,'deeper-observations.json'),JSON.stringify(log,null,2)); }
async function capture(name) { const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')); await fs.writeFile(path.join(out,name+'.png'),Buffer.from(png,'base64')); await shell.screenshot({path:path.join(out,name+'-shell.png')}); const s=await snapshot(); const tab=s.tabs.find(t=>t.id===s.activeTabId); const page=app.windows().find(p=>p.url()===tab?.url); if(page && !(await shell.getByTestId('site-info-popover').isVisible()) && !(await shell.getByTestId('site-controls').isVisible()) && !(await shell.getByTestId('url-bar').isVisible())) await page.screenshot({path:path.join(out,name+'-content.png')}); }
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
 await nav(base,'20-fixture'); await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].focus());
 let native=app.windows().find(p=>p.url()===base+'/');
 await native.getByLabel('Draft note').fill('Remember this draft');
 await native.getByRole('link',{name:'Read second page',exact:true}).click();
 await expect(native).toHaveURL(base+'/second');
 await shell.getByRole('button',{name:'Back',exact:true}).click(); await expect(native).toHaveURL(base+'/');
 await record('draft-after-back',await native.getByLabel('Draft note').inputValue()); await capture('21-draft-after-back');
 await native.getByLabel('Draft note').click(); await native.keyboard.press('Meta+f');
 const find=app.windows().find(p=>p.url().endsWith('#find')); const field=find.getByRole('textbox',{name:'Find in page'});
 await app.evaluate(({webContents},url)=>{ const t=webContents.getAllWebContents().find(w=>w.getURL()===url);global.__qaFindEvents=[];t.on('found-in-page',(_e,result)=>global.__qaFindEvents.push(result));},base+'/');await field.fill('apple');
 await expect.poll(()=>find.evaluate(()=>window.pistachio.getFindState())).toMatchObject({query:'apple'}); await expect.poll(()=>find.evaluate(()=>window.pistachio.getFindState()),{timeout:10000}).toMatchObject({matches:3}).catch(async e=>record('find-mismatch',await find.evaluate(()=>window.pistachio.getFindState())));
 await capture('22-find-apple'); await find.screenshot({path:path.join(out,'22-find-bar.png')}); await record('find-apple',{state:await find.evaluate(()=>window.pistachio.getFindState()),events:await app.evaluate(()=>global.__qaFindEvents)});
 await field.press('Enter'); await record('find-next',await find.evaluate(()=>window.pistachio.getFindState()));
 await field.fill('zzNoSuchWord'); await expect.poll(()=>find.evaluate(()=>window.pistachio.getFindState())).toMatchObject({matches:0});await find.screenshot({path:path.join(out,'23-find-no-matches.png')});await field.press('Escape');
 await shell.keyboard.press('Meta+l');await expect(shell.getByTestId('url-bar')).toBeVisible();await shell.getByTestId('address-input').fill('127.0.0.1:59998');await shell.getByTestId('address-input').press('Enter');
 await expect(shell.getByTestId('url-bar')).toHaveCount(0);
 await expect.poll(async()=>await shell.locator('body').innerText()).toContain('ERR_CONNECTION_REFUSED');
 await capture('24-connection-refused');await record('connection-refused',{shell:await shell.locator('body').innerText(),native:await nativeRead()});
 await nav(base,'25-recovered');
 native=app.windows().find(p=>p.url()===base+'/');
 await native.getByRole('link',{name:'Open second page in new tab'}).click();
 await expect.poll(async()=>(await snapshot()).tabs.length).toBe(2);await capture('26-target-blank');await record('target-blank',await snapshot());
 await shell.keyboard.press('Meta+w');await expect.poll(async()=>(await snapshot()).tabs.length).toBe(1);
 await shell.keyboard.press('Meta+Shift+t');await expect.poll(async()=>(await snapshot()).tabs.length).toBe(2).catch(async()=>record('reopen-tab-did-not-reopen',await snapshot()));await record('reopen-tab',await snapshot());await capture('27-reopen-tab');
 await nav(base,'28-before-site-info');
 const trigger=shell.getByTestId('pane-toolbar-trigger');await trigger.dispatchEvent('pointermove');
 await expect(shell.getByTestId('site-info-button')).toBeVisible();await shell.getByTestId('site-info-button').click();
 await expect(shell.getByTestId('site-info-popover')).toBeVisible();await record('site-info',await shell.getByTestId('site-info-popover').innerText());await capture('29-site-info');
 await shell.getByRole('switch',{name:'Microphone',exact:true}).click();await record('microphone-allowed',await shell.getByTestId('site-info-popover').innerText());await capture('30-microphone-allowed');
 await shell.getByRole('switch',{name:'Microphone',exact:true}).click();await record('microphone-blocked',await shell.getByTestId('site-info-popover').innerText());
 await shell.getByTestId('site-info-reset').click();await record('permissions-reset',await shell.getByTestId('site-info-popover').innerText());
 await shell.getByTestId('site-info-site-controls').click();await expect(shell.getByTestId('site-controls')).toBeVisible();await record('site-controls',await shell.getByTestId('site-controls').innerText());await capture('31-site-controls');
 await shell.getByRole('button',{name:'Zoom in',exact:true}).click();await record('zoom-in',await shell.getByTestId('site-controls').innerText());await capture('32-zoom-in');
 await shell.keyboard.press('Escape');
 await app.evaluate(({app,webContents},dir)=>{app.setPath('downloads',dir);for(const wc of webContents.getAllWebContents())if(wc.getURL().startsWith('http://127.0.0.1:'))wc.session.once('will-download',(_e,item)=>item.setSavePath(dir+'/qa-navigation.txt'));},profile);
 native=app.windows().find(p=>p.url()===base+'/');await native.getByRole('link',{name:'Download notes',exact:true}).click();
 await expect.poll(async()=>fs.readFile(path.join(profile,'qa-navigation.txt'),'utf8').catch(()=>null)).toBe('QA download');await capture('33-download-complete');await record('download-complete-shell',await shell.locator('body').innerText());
 await shell.getByTestId('sidebar-menu-button').click();await shell.getByTestId('status-site-controls').click();await expect(shell.getByTestId('site-controls')).toBeVisible();await record('download-controls',await shell.getByTestId('site-controls').innerText());await capture('34-download-controls');
 }catch(e){await record('error',e.stack);if(app){await capture('99-failure');const f=app.windows().find(p=>p.url().endsWith('#find'));if(f)await f.screenshot({path:path.join(out,'99-find.png')});}process.exitCode=1;}finally{if(app)await app.close();server.closeAllConnections();server.close();}
})();
