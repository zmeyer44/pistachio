import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
const dir=resolve('../../docs/qa/2026-09-09/organization');
await mkdir(dir,{recursive:true});
const server=createServer((req,res)=>{const name=decodeURIComponent(req.url.slice(1))||'Travel planning';res.writeHead(200,{'content-type':'text/html'});res.end(`<html><head><title>${name}</title></head><body style="font:18px system-ui;max-width:720px;margin:60px auto"><h1>${name}</h1><p>Plan a weekend away. Compare destinations, save useful pages, and organize your research.</p><nav><a href="/Museums">Museums</a> · <a href="/Hotels">Hotels</a> · <a href="/Restaurants">Restaurants</a></nav><p><label>Travel notes <textarea placeholder="Write your plans here"></textarea></label></p></body></html>`)});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const profile=await mkdtemp(join(tmpdir(),'pistachio-organization-qa-'));
await writeFile(join(profile,'settings.json'),JSON.stringify({general:{homeUrl:origin+'/'},layout:{mode:'sidebar',sidebar:'pinned'}}));
let app,shell; const results=[];let seq=0;
async function launch(){app=await electron.launch({args:['.'],cwd:process.cwd(),executablePath:resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),env:{...process.env,PISTACHIO_E2E:'1',PISTACHIO_USER_DATA:profile}});await expect.poll(()=>app.windows().some(p=>p.url().includes('index.html')&&!p.url().includes('#'))).toBe(true);shell=app.windows().find(p=>p.url().includes('index.html')&&!p.url().includes('#'));await shell.waitForLoadState('domcontentloaded');shell.setDefaultTimeout(5000);}
const state=()=>shell.evaluate(()=>window.pistachio.getSnapshot());
async function shot(name){const f=`${String(++seq).padStart(2,'0')}-${name}.png`; const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));await writeFile(join(dir,f),Buffer.from(png,'base64'));return f;}
async function step(name,fn){try{const detail=await fn();results.push({name,ok:true,detail,screenshot:await shot(name)});}catch(e){results.push({name,ok:false,error:String(e),screenshot:await shot(name+'-failure'),dom:await shell.locator('body').innerText()});await shell.keyboard.press('Escape').catch(()=>{});}await writeFile(join(dir,'results.json'),JSON.stringify({profile,origin,results},null,2));console.log(JSON.stringify(results.at(-1)));}
async function menu(row,name){await row.click({button:'right'});await shell.getByRole('menuitem',{name,exact:true}).click();}
async function newTab(name){await shell.getByTestId('new-tab-button').click();await shell.getByTestId('address-input').fill(origin+'/'+name);await shell.getByTestId('address-input').press('Enter');await expect.poll(async()=>{const s=await state();return s.tabs.find(t=>t.id===s.activeTabId)?.url}).toBe(origin+'/'+name);}
try{
await launch();
await step('initial',async()=>({state:await state(),dom:await shell.locator('body').innerText()}));
await step('new-museums-tab',async()=>{await newTab('Museums');return state()});
await step('new-hotels-tab',async()=>{await newTab('Hotels');return state()});
await step('duplicate-hotels',async()=>{const n=(await state()).tabs.length;await menu(shell.getByTestId('human-tab').last(),'Duplicate tab');await expect.poll(async()=>(await state()).tabs.length).toBe(n+1);return state()});
await step('close-duplicate',async()=>{const n=(await state()).tabs.length;await menu(shell.getByTestId('human-tab').last(),'Close tab');await expect.poll(async()=>(await state()).tabs.length).toBe(n-1);return state()});
await step('reopen-closed-shortcut',async()=>{const n=(await state()).tabs.length;await shell.keyboard.press('Meta+Shift+T');await expect.poll(async()=>(await state()).tabs.length,{timeout:3000}).toBe(n+1);return state()});
await step('pin-museums',async()=>{await menu(shell.getByTestId('human-tab').filter({hasText:'Museums'}).first(),'Pin tab');await expect(shell.getByTestId('pinned-tab')).toHaveCount(1);return state()});
await step('favorite-hotels',async()=>{await menu(shell.getByTestId('human-tab').filter({hasText:'Hotels'}).first(),'Add to favorites');await expect(shell.getByTestId('favorite-tile')).toHaveCount(1);return state()});
await step('new-folder-with-pin',async()=>{await menu(shell.getByTestId('pinned-tab').first(),'New folder with this page');await expect(shell.getByTestId('folder-name-input')).toBeVisible();await shell.getByTestId('folder-name-input').fill('Weekend research');await shell.getByTestId('folder-name-input').press('Enter');await expect(shell.getByTestId('pinned-folder')).toContainText('Weekend research');return state()});
await step('folder-collapse-expand',async()=>{const f=shell.getByTestId('pinned-folder');await f.click();const before=await shell.getByTestId('pinned-tab').count();await f.click();return {collapsedPinCount:before,expandedPinCount:await shell.getByTestId('pinned-tab').count()}});
await step('split-active-tab',async()=>{const rows=shell.getByTestId('human-tab');await rows.last().click();await menu(rows.last(),'Open in split view');await expect(shell.getByTestId('secondary-pane')).toBeVisible();return state()});
await step('close-split',async()=>{await menu(shell.getByTestId('human-tab').last(),'Close split view');await expect(shell.getByTestId('secondary-pane')).toHaveCount(0);return state()});
await step('fork-space-dialog',async()=>{await shell.getByTestId('space-menu-button').click();await shell.getByTestId('fork-space-button').click();await expect(shell.getByTestId('space-fork-dialog')).toBeVisible();return {dom:await shell.getByTestId('space-fork-dialog').innerText()}});
await step('fork-weekend-space',async()=>{await shell.getByTestId('fork-space-name').fill('Weekend');await shell.getByTestId('fork-space-purpose').fill('Travel planning');await shell.getByTestId('confirm-fork-space').click();await expect(shell.getByTestId('space-fork-dialog')).toHaveCount(0);return state()});
await step('switch-original-space',async()=>{await shell.getByTestId('space-menu-button').click();await shell.getByTestId('space-chip-work').click();await expect(shell.getByTestId('space-menu-button')).toHaveAttribute('aria-label','Space: Operations');return state()});
await step('session-before-relaunch',async()=>state());
await app.close();await launch();
await step('session-after-relaunch',async()=>state());
await step('bookmark-page',async()=>{await shell.keyboard.press('Meta+Shift+B');await expect(shell.getByTestId('bookmarks-page')).toBeVisible();return {dom:await shell.getByTestId('bookmarks-page').innerText()}});
await step('bookmark-add',async()=>{await shell.getByTestId('new-bookmark').click();await shell.getByLabel('Address to bookmark').fill(origin+'/Restaurants');await shell.getByTestId('bookmark-add-submit').click();await expect(shell.getByTestId('bookmark-card')).toHaveCount(1);await expect(shell.getByTestId('bookmark-card')).toHaveAttribute('data-status','ready');return {dom:await shell.getByTestId('bookmarks-page').innerText()}});
await step('bookmark-details',async()=>{await shell.getByTestId('bookmark-card').click();await expect(shell.getByTestId('bookmark-detail')).toBeVisible();return {dom:await shell.getByTestId('bookmark-detail').innerText()}});
}finally{if(app)await app.close();server.close();}
