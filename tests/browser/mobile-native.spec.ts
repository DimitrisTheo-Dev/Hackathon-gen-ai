import { test, expect, chromium, webkit, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:4173';
const evidence = 'docs/demo/evidence/mobile-refinement';
async function cleanConsole(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  return errors;
}

for (const engine of [chromium, webkit]) test(`${engine.name()} phone: native navigation, draft preservation, rollback, history and review`, async () => {
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: {width:390,height:844}, isMobile:true, hasTouch:true, reducedMotion:'reduce' });
  const page = await context.newPage(); const errors = await cleanConsole(page);
  try {
    await page.goto(origin);
    await page.getByRole('button',{name:'Open navigation',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'Explore Castroom'})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name:'Open navigation',exact:true})).toBeFocused();
    await page.getByRole('button',{name:'Inspect this draft',exact:true}).click();
    await expect(page.locator('.landing-preview-script')).toBeVisible();
    expect(await page.locator('.landing-preview-script').evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).toContain('viewport-fit=cover'); expect(viewport).not.toMatch(/maximum-scale|user-scalable/);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.goto(`${origin}/dev/studio/`);
    await expect(page.locator('.content-card')).toHaveCount(3);
    await page.screenshot({path:`${evidence}/${engine.name()}-phone-initial.png`});
    await page.getByRole('button',{name:'Filter and sort content'}).click();
    await page.getByRole('combobox',{name:'Filter by content status'}).selectOption('ready');
    await expect(page.getByRole('heading',{name:'No matching content'})).toBeVisible();
    await page.getByRole('button',{name:'Clear search'}).click();
    await page.getByRole('button',{name:'Filter and sort content'}).click();
    await page.getByRole('button',{name:'Switch project',exact:true}).click();
    const projects = page.getByRole('dialog',{name:'Your projects'});
    await expect(projects).toBeVisible();
    await page.screenshot({path:`${evidence}/${engine.name()}-projects.png`});
    await page.goBack(); await expect(projects).toHaveCount(0);
    await page.locator('.content-select').first().click();
    const editor = page.getByRole('dialog',{name:'Content editor'});
    await expect(editor).toBeVisible();
    await expect(page.getByRole('button',{name:'Return to campaign'})).toBeFocused();
    await page.locator('#script').fill('A draft retained when I leave this editor.');
    expect(await page.locator('#script').evaluate(el=>getComputedStyle(el).fontSize)).toBe('16px');
    await page.goBack(); await expect(editor).toHaveCount(0);
    await page.locator('.content-select').first().click();
    await expect(page.locator('#script')).toHaveValue('A draft retained when I leave this editor.');

    // Deterministic storage failure: the UI must restore its saved card and keep the edit.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key,value) {
        if (key==='castroom-development-v1') throw new DOMException('Quota exceeded','QuotaExceededError');
        return original.call(this,key,value);
      };
      (window as unknown as {restoreStorage:()=>void}).restoreStorage = () => {Storage.prototype.setItem=original;};
    });
    await page.locator('#item-title').fill('Title that must roll back on failure');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(editor.getByRole('alert')).toContainText('could not be saved');
    await expect(page.locator('.save-state')).toContainText('Unsaved changes');
    await expect(page.locator('.content-card').first().locator('h2')).toHaveText('Find your next moment');
    await page.screenshot({path:`${evidence}/${engine.name()}-save-error.png`});
    await page.evaluate(()=>(window as unknown as {restoreStorage:()=>void}).restoreStorage());
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await expect(page.locator('.save-state')).toContainText('version 2');
    await expect(page.locator('.content-card').first().locator('h2')).toHaveText('Title that must roll back on failure');
    await context.setOffline(true);
    await expect(editor.getByText('You’re offline.',{exact:false})).toBeVisible();
    await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
    await context.setOffline(false);
    await page.getByRole('button',{name:'Return to campaign'}).click();
    await page.getByRole('button',{name:'Review schedule',exact:true}).click();
    await expect(page.getByRole('button',{name:'Approve exact schedule'})).toBeDisabled();
    const modal = page.getByRole('dialog');
    expect(await modal.evaluate(el=>el.getBoundingClientRect().bottom <= visualViewport!.height+1)).toBe(true);
    await page.keyboard.press('Escape');
    await page.reload(); await page.locator('.content-select').first().click();
    await expect(page.locator('#script')).toHaveValue('A draft retained when I leave this editor.');
    await page.setViewportSize({width:844,height:390});
    await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await context.close(); await browser.close(); }
});

test('Chromium synthesized touch: sheet tracks, reverses, dismisses, restores focus; content scroll stays native', async ({browser}) => {
  const context = await browser.newContext({viewport:{width:390,height:844}, isMobile:true, hasTouch:true, reducedMotion:'no-preference'});
  const page = await context.newPage(); const errors = await cleanConsole(page);
  const session = await context.newCDPSession(page);
  const touch = (type:'touchStart'|'touchMove'|'touchEnd',x:number,y:number) => session.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1}]});
  try {
    await page.goto(`${origin}/dev/studio/`);await page.locator('.content-select').first().click();
    const editor = page.getByRole('dialog',{name:'Content editor'});
    await expect(editor).toBeVisible();
    await expect.poll(()=>editor.evaluate(el=>Math.round(el.getBoundingClientRect().top))).toBe(0);
    // Downward drag then reversal: no transition completion lock or jump to target.
    await touch('touchStart',195,22);await touch('touchMove',195,90);
    expect(await editor.evaluate(el=>el.getBoundingClientRect().top)).toBeGreaterThan(50);
    await touch('touchMove',195,36);await touch('touchEnd',195,36);
    await expect.poll(()=>editor.evaluate(el=>Math.round(el.getBoundingClientRect().top))).toBe(0);
    // A scroll on content belongs to the browser, not the dismissal gesture.
    await touch('touchStart',180,400);
    for(let y=380;y>=180;y-=20){await touch('touchMove',180,y);await page.evaluate(()=>new Promise(requestAnimationFrame));}
    await touch('touchEnd',180,180);
    await expect.poll(()=>page.locator('.editor-scroll').evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
    await expect(editor).toBeVisible();
    await touch('touchStart',195,22);await touch('touchMove',195,120);await touch('touchMove',195,260);await touch('touchEnd',195,260);
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.content-select').first()).toBeFocused();
    // A bottom sheet follows the same handle gesture and restores the native page lock.
    await page.getByRole('button',{name:'Switch project',exact:true}).click();
    const sheet=page.getByRole('dialog',{name:'Your projects'});
    await expect.poll(()=>sheet.evaluate(el=>getComputedStyle(el).transform)).toBe('matrix(1, 0, 0, 1, 0, 0)');
    const grip=await sheet.locator('.sheet-grip').boundingBox();
    await touch('touchStart',195,grip!.y+22);await touch('touchMove',195,grip!.y+115);await touch('touchMove',195,grip!.y+240);await touch('touchEnd',195,grip!.y+240);
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.style.overflow)).toBe('');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('phone loading, empty, failed workspace and expired media are explicit and usable',async({page})=>{
  await page.setViewportSize({width:375,height:812});
  let release!:()=>void;
  const paused=new Promise<void>(resolve=>release=resolve);
  await page.route('**/assets/AuthApp-*.js',async route=>{await paused;await route.continue();});
  await page.goto('/dev/studio/',{waitUntil:'domcontentloaded'});
  await expect(page.getByText('Opening your studio…')).toBeVisible();
  await page.screenshot({path:`${evidence}/loading-375.png`});
  release();await expect(page.locator('.content-card')).toHaveCount(3);
  await page.evaluate(()=>{const key='castroom-development-v1';const state=JSON.parse(localStorage.getItem(key)!);state.campaigns[0].items[0].media={id:'expired-media',url:'https://example.com/expired.mp4',expiresAt:'2020-01-01T00:00:00.000Z',sha256:'example',revision:1,durationSeconds:20,hasAudio:true};localStorage.setItem(key,JSON.stringify(state));});
  await page.reload();await page.locator('.content-select').first().click();
  await expect(page.getByRole('dialog',{name:'Content editor'})).toContainText('Preview expired');
  await page.screenshot({path:`${evidence}/expired-preview-375.png`});
  await page.getByRole('button',{name:'Return to campaign'}).click();
  await page.evaluate(()=>localStorage.setItem('castroom-development-v1',JSON.stringify({version:1,campaigns:[],operations:{}})));
  await page.reload();await page.getByRole('navigation',{name:'Workspace shortcuts'}).getByRole('button',{name:'Canvas',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Your first campaign belongs here.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Create a campaign',exact:true})).toBeVisible();
  await page.screenshot({path:`${evidence}/empty-375.png`});
  await page.evaluate(()=>localStorage.setItem('castroom-development-v1','invalid'));await page.reload();
  await expect(page.getByRole('heading',{name:'We couldn’t open your workspace.'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Try again'})).toBeVisible();
  await page.screenshot({path:`${evidence}/workspace-error-375.png`});
});

test('mobile project selection rolls back when the refreshed project is unavailable',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/dev/studio/');
  await expect(page.locator('.content-card')).toHaveCount(3);
  await page.evaluate(()=>{
    const key='castroom-development-v1';const state=JSON.parse(localStorage.getItem(key)!);
    const other=structuredClone(state.campaigns[0]);other.id='fixture-second';other.title='A second project';
    other.items=other.items.map((item:{id:string;campaignId:string})=>({...item,id:item.id+'-second',campaignId:other.id}));
    state.campaigns.push(other);localStorage.setItem(key,JSON.stringify(state));
  });
  await page.reload();await expect(page.locator('.content-card')).toHaveCount(3);
  await page.evaluate(()=>{const key='castroom-development-v1';const state=JSON.parse(localStorage.getItem(key)!);state.campaigns=state.campaigns.filter((c:{id:string})=>c.id!=='fixture-second');localStorage.setItem(key,JSON.stringify(state));});
  await page.getByRole('button',{name:'Switch project',exact:true}).click();
  await page.getByRole('dialog',{name:'Your projects'}).getByRole('button',{name:/A second project/}).click();
  await expect(page.getByRole('heading',{name:'A week of BeWell',exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('was not found');
  await expect(page.locator('.content-card')).toHaveCount(3);
});
