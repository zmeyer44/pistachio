import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const cwd=resolve(import.meta.dirname,'../../..');
const evidence=resolve(cwd,'../../docs/qa/2026-09-09/settings');
await mkdir(evidence,{recursive:true});
const userData=await mkdtemp(join(tmpdir(),'pistachio-qa-settings-'));
const events=[];
console.log('PROFILE '+userData);
const log=(name,data)=>{const item={name,data};events.push(item);console.log(JSON.stringify(item));};
const app=await electron.launch({args:['.'],cwd,executablePath:join(cwd,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),env:{...process.env,PISTACHIO_E2E:'1',PISTACHIO_ONBOARDING:'1',PISTACHIO_USER_DATA:userData}});
let shell;
async function capture(name){
 await shell.locator('body').evaluate(async e=>{await Promise.all(e.getAnimations({subtree:true}).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
 const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
 await writeFile(join(evidence,name+'.png'),Buffer.from(png,'base64'));
 await writeFile(join(evidence,name+'.txt'),await shell.locator('body').innerText());
}
try {
 shell=app.windows().find(p=>p.url().includes('index.html')&&!/#(drag|find|bookmark)$/.test(p.url()))??await app.waitForEvent('window',{predicate:p=>p.url().includes('index.html')&&!/#(drag|find|bookmark)$/.test(p.url())});
 shell.setDefaultTimeout(7000);shell.on('pageerror',e=>log('pageerror',e.message));
 await expect(shell.getByTestId('onboarding')).toBeVisible();await capture('01-first-run');
 const type=shell.getByTestId('onboarding-type-instead');if(await type.isVisible())await type.click();
 log('blank-name-can-continue',await shell.getByTestId('onboarding-primary').isEnabled());
 await shell.getByTestId('onboarding-name').fill('QA Reader');
 await shell.getByTestId('onboarding-bio').fill('Reads public websites and saves useful research.');
 await shell.getByTestId('onboarding-primary').click();await expect(shell.getByTestId('onboarding')).toHaveAttribute('data-step','import');
 // Avoid probing personal browser content; start fresh.
 await shell.getByTestId('import-fresh').click();await shell.getByTestId('onboarding-primary').click();
 await expect(shell.getByTestId('onboarding')).toHaveAttribute('data-step','favorites');await capture('02-favorites-required');
 log('favorites-zero-enabled',await shell.getByTestId('onboarding-primary').isEnabled());
 await shell.getByTestId('favorite-app-figma').click();log('favorites-one-enabled',await shell.getByTestId('onboarding-primary').isEnabled());
 await shell.getByTestId('favorite-app-youtube').click();await shell.getByTestId('favorite-app-gmail').click();
 await shell.getByTestId('onboarding-back').click();await shell.getByTestId('onboarding-primary').click();
 log('favorites-back-preserves',await shell.getByTestId('favorite-app-gmail').getAttribute('data-selected'));
 await shell.getByTestId('onboarding-primary').click();await expect(shell.getByTestId('onboarding')).toHaveAttribute('data-step','appearance');
 await shell.getByTestId('appearance-preset-ember').click();await capture('03-first-run-appearance');await shell.getByTestId('onboarding-primary').click();
 await expect(shell.getByTestId('onboarding')).toHaveCount(0,{timeout:15000});await capture('04-welcome');
 await shell.keyboard.press('Meta+,');const settings=shell.getByTestId('settings-page');await expect(settings).toBeVisible();await capture('05-general');
 const nav=async name=>{await settings.getByRole('button',{name,exact:true}).click();};
 await settings.getByRole('textbox',{name:'New tab page',exact:true}).fill('hello world');await shell.keyboard.press('Enter');
 log('invalid-new-tab',await settings.innerText());await capture('06-invalid-new-tab');
 await settings.getByRole('textbox',{name:'New tab page',exact:true}).fill('example.com');await shell.keyboard.press('Enter');
 await expect(settings.getByRole('textbox',{name:'New tab page',exact:true})).toHaveValue('https://example.com/');
 log('settings-search-count',await settings.getByRole('searchbox').count());
 await nav('Shortcuts');await settings.getByTestId('shortcut-newTab').click();await shell.keyboard.press('Meta+L');await capture('07-shortcut-conflict');
 log('shortcut-conflict',await settings.getByRole('alert').allTextContents());await shell.keyboard.press('Escape');
 await settings.getByTestId('shortcut-newTab').click();await shell.keyboard.press('Meta+K');await expect(settings.getByTestId('shortcut-newTab')).toContainText('K');
 await settings.getByTestId('shortcut-editAddress').click();await shell.keyboard.press('Meta+T');await expect(settings.getByTestId('shortcut-editAddress')).toContainText('T');
 await capture('08-before-reset');await settings.getByRole('button',{name:'Reset New tab',exact:true}).click();
 log('reset-into-conflict',await readFile(join(userData,'settings.json'),'utf8'));await capture('08a-reset-into-conflict');
 log('shortcut-testids',await settings.locator('[data-testid^="shortcut-"]').evaluateAll(es=>es.map(e=>({id:e.dataset.testid,text:e.innerText}))));
 await capture('08-shortcuts-rebound');
 await nav('Memory');await expect(settings.getByLabel('Preferred name')).toHaveValue('QA Reader');
 await settings.getByLabel('Preferred name').fill('Unsaved reader');await nav('General');await nav('Memory');
 log('unsaved-memory-after-navigation',await settings.getByLabel('Preferred name').inputValue());await capture('09-memory-draft-lost');
 await settings.getByLabel('Preferred name').fill('QA Saved');await settings.getByRole('button',{name:'Save',exact:true}).first().click();await expect(settings.getByLabel('Preferred name')).toHaveValue('QA Saved');
 await settings.getByLabel('Locations name').fill('Home');await settings.getByLabel('Locations detail').fill('Boston');await settings.locator('section',{hasText:'Locations'}).first().getByRole('button',{name:'Add',exact:true}).click();
 await settings.getByLabel('Fact',{exact:true}).fill('Prefers readable font sizes.');await settings.getByRole('button',{name:'Remember',exact:true}).click();
 await expect(settings.getByRole('button',{name:'Forget Prefers readable font sizes.'})).toBeVisible();await capture('10-memory-fact');
 await settings.getByRole('button',{name:'Forget Prefers readable font sizes.'}).click();await settings.getByRole('tab',{name:'Forgotten',exact:true}).click();
 await expect(settings.getByRole('button',{name:'Restore',exact:true})).toBeVisible();await capture('11-memory-forgotten');await settings.getByRole('button',{name:'Restore',exact:true}).click();
 await settings.getByRole('tab',{name:'In use',exact:true}).click().catch(e=>log('memory-tab-names',e.message));
 await settings.getByRole('button',{name:'Show',exact:true}).click();await expect(settings.getByTestId('memory-prompt-preview')).toContainText('QA Saved');await settings.getByTestId('memory-prompt-preview').scrollIntoViewIfNeeded();await capture('12-memory-prompt');
 await nav('Reminders');await capture('13-reminders-settings');await settings.getByRole('button',{name:'Open reminders',exact:true}).click();
 log('reminders-open-settings-visible',await settings.isVisible());await capture('14-reminders-page');
 log('webcontents',await app.evaluate(({webContents})=>webContents.getAllWebContents().map(w=>({id:w.id,url:w.getURL()}))));
 await shell.keyboard.press('Meta+,');await expect(settings).toBeVisible();
 for(const name of ['Account','Devices','Sync','Cloud browser','Identity egress','Approvals','Evidence','Integrations','About']){
  const b=settings.getByRole('button',{name,exact:true});if(await b.count()){await b.click();await capture('settings-'+name.toLowerCase().replaceAll(' ','-'));log('section-'+name,await settings.innerText());}
 }
 await nav('General');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(850,650));await capture('15-small-general');
 log('small-size',await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getSize()));
 await nav('About');await settings.getByTestId('replay-onboarding').click();await expect(shell.getByTestId('onboarding')).toBeVisible();await shell.keyboard.press('Escape');await expect(shell.getByTestId('onboarding')).toHaveCount(0);log('replay-escape','passed');
 log('profile',userData);log('settings-disk',JSON.parse(await readFile(join(userData,'settings.json'),'utf8')));
} catch(e){log('fatal',e.stack);if(shell)await capture('99-failure').catch(()=>{});process.exitCode=1;}
finally{await writeFile(join(evidence,'explore-log.json'),JSON.stringify(events,null,2));let timer=setTimeout(()=>app.process().kill('SIGKILL'),7000);await app.close().catch(()=>{});clearTimeout(timer);}
