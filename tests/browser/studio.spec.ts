import { test, expect } from '@playwright/test';
import { evidence } from './support/evidence';

test('landing is useful without JavaScript and exposes genuine discovery metadata', async ({ browser, request }) => {
  const context = await browser.newContext({javaScriptEnabled:false});const page=await context.newPage();
  await page.goto('/');await expect(page.getByRole('heading',{level:1})).toHaveAttribute('aria-label','What if your agent made your next video campaign?');
  expect((await page.locator('main').innerText()).length).toBeGreaterThan(500);
  expect(await page.locator('script[type="application/ld+json"]').textContent()).toContain('SoftwareApplication');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href','https://faceful.vercel.app/');
  const md=await request.get('/',{headers:{Accept:'text/markdown'}});expect(md.headers()['content-type']).toContain('text/markdown');expect(md.headers().vary).toBe('Accept');expect(await md.text()).toContain('When to use');
  const missing=await request.get('/this-is-not-a-page',{headers:{Accept:'text/markdown'}});expect(missing.status()).toBe(404);expect(missing.headers()['content-type']).toContain('text/markdown');expect(await missing.text()).toContain('/docs/');
  await context.close();
});

// The landing page has its own suite (landing-flow.spec.ts with landing.config.ts); this only checks the way into the studio.
test('landing renders its headline and leads into the studio', async ({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
  await expect(page.getByRole('heading',{level:1})).toHaveAttribute('aria-label','What if your agent made your next video campaign?');
  await expect(page.locator('.landing-hero').getByRole('link',{name:'Start creating'})).toHaveAttribute('href','/studio/');
  expect(errors).toEqual([]);
});

test('draft edits survive item switches, save and reload; palette and filters use real objects',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/dev/studio/?view=canvas');await expect(page.locator('.content-card')).toHaveCount(3);
  await page.getByRole('button',{name:'Details',exact:true}).click();const script=page.locator('#script');await script.fill('A warmer opening for the BeWell story.');
  await page.locator('.content-select').nth(1).click();await page.locator('.content-select').first().click();await page.getByRole('button',{name:'Details',exact:true}).click();await expect(script).toHaveValue('A warmer opening for the BeWell story.');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('.save-state')).toContainText('Saved · version 2');
  await page.reload();await page.getByRole('button',{name:'Details',exact:true}).click();await expect(script).toHaveValue('A warmer opening for the BeWell story.');
  await page.getByRole('button',{name:'Channels',exact:true}).click();await page.locator('#channel-copy').fill('An updated Instagram caption.');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('.save-state')).toContainText('version 3');
  await page.getByRole('button',{name:'Find projects or content'}).click();await page.getByRole('combobox',{name:'Search projects, content and actions'}).fill('familiar');await page.keyboard.press('Enter');await page.getByRole('button',{name:'Details',exact:true}).click();await expect(page.locator('#item-title')).toHaveValue('A familiar feeling');
  // Search, filter and sort sit behind one button, and only exist once a project has more than six drafts.
  await expect(page.getByRole('button',{name:'Filter and sort content'})).toHaveCount(0);await expect(page.getByRole('searchbox',{name:'Filter campaign content'})).toHaveCount(0);
  await page.evaluate(()=>{const key='castroom-development-v1';const state=JSON.parse(localStorage.getItem(key)!);const items=state.campaigns[0].items;for(let n=4;n<=7;n++)items.push({...structuredClone(items[0]),id:`fixture-extra-${n}`,title:`Extra draft ${n}`});localStorage.setItem(key,JSON.stringify(state));});
  await page.reload();await expect(page.locator('.content-card')).toHaveCount(7);await page.getByRole('button',{name:'Filter and sort content'}).click();
  await page.getByRole('searchbox',{name:'Filter campaign content'}).fill('no matching item');await expect(page.locator('.content-card')).toHaveCount(0);
  await page.getByRole('searchbox',{name:'Filter campaign content'}).fill('');await page.getByRole('combobox',{name:'Filter by content status'}).selectOption('ready');await expect(page.locator('.content-card')).toHaveCount(0);
  await page.getByRole('combobox',{name:'Filter by content status'}).selectOption('all');await expect(page.locator('.content-card')).toHaveCount(7);expect(errors).toEqual([]);
});

test('manual campaign saves supplied context and approval never implies publication in fixture mode',async({page})=>{
  await page.goto('/dev/studio/?view=canvas');await page.getByRole('button',{name:'Create a campaign',exact:true}).click();
  await page.locator('#company-name').fill('Olive Works');await page.locator('#campaign-name').fill('A useful first week');await page.locator('#company-does').fill('We make reusable lunch containers.');
  await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.locator('#draft-title-0').fill('Meet the reusable lunch box');await page.locator('#draft-script-0').fill('Make room for a reusable lunch box in your everyday bag.');
  await page.getByRole('button',{name:'Create draft',exact:true}).click();await expect(page.getByRole('heading',{name:'A useful first week',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Review schedule',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('cannot be approved or published');await expect(page.getByRole('dialog').getByRole('button',{name:/Approve/})).toBeDisabled();
  await page.getByRole('button',{name:'Close dialog'}).click();await page.reload();await expect(page.getByRole('heading',{name:'A useful first week',exact:true})).toBeVisible();
});

test('schedule without times offers one empty state; activity reads as a collapsed timeline',async({page})=>{
  await page.goto('/dev/studio/?view=schedule');await expect(page.locator('.day-card')).toHaveCount(3);
  await page.evaluate(()=>{const key='castroom-development-v1';const state=JSON.parse(localStorage.getItem(key)!);const c=state.campaigns[0];c.items.forEach((i:{targets:unknown[]})=>{i.targets=[];});
    const at=(m:number)=>new Date(Date.now()-m*60000).toISOString();const ev=(m:number)=>({id:crypto.randomUUID(),actor:'You · development fixture',action:'Prepared a schedule for review',objectId:c.id,revision:1,at:at(m),outcome:'0 ready · 6 blockers'});
    c.activity=[...c.activity,ev(40),ev(5)];localStorage.setItem(key,JSON.stringify(state));});
  await page.reload();
  // One empty state instead of a "No date" card and a line per draft; reviewing steps back while there is nothing to review.
  await expect(page.getByRole('heading',{name:'No posting times yet'})).toBeVisible();await expect(page.locator('.day-card')).toHaveCount(0);await expect(page.getByText('No time requested yet.')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Review schedule',exact:true})).toHaveClass(/secondary/);
  await page.getByRole('button',{name:'Suggest times'}).click();
  await expect(page.getByLabel('Direction for your content')).toHaveValue('Plan posting times for next week in Europe/Athens');await expect(page.getByLabel('Direction for your content')).toBeFocused();
  await page.getByRole('button',{name:'Schedule',exact:true}).first().click();await page.getByRole('button',{name:'Set a time',exact:true}).click();
  await expect(page.locator('#detail-schedule-trigger')).toHaveAttribute('aria-expanded','true');
  // Two identical consecutive entries collapse; the zero count is dropped from the outcome.
  await page.getByRole('button',{name:'Campaign activity'}).first().click();const dialog=page.getByRole('dialog',{name:'Campaign activity'});
  await expect(dialog.locator('.timeline-entry').first()).toContainText('Prepared a schedule for review');await expect(dialog.locator('.timeline-count').first()).toHaveText('2×');
  await expect(dialog.locator('.timeline-entry').first()).toContainText('6 blockers');await expect(dialog.locator('.timeline-entry').first()).not.toContainText('0 ready');
  await expect(dialog.getByRole('heading',{name:'Background jobs'})).toHaveCount(0);
});

test('offline, corrupt storage and unauthenticated paths do not claim success or fall back',async({page,context})=>{
  await page.goto('/dev/studio/?view=canvas');await page.getByRole('button',{name:'Details',exact:true}).click();await page.locator('#script').fill('Retain this unsaved edit.');await context.setOffline(true);await expect(page.locator('.editor-offline')).toBeVisible();await expect(page.locator('#script')).toHaveValue('Retain this unsaved edit.');await context.setOffline(false);
  await page.evaluate(()=>localStorage.setItem('castroom-development-v1','broken'));await page.reload();await expect(page.getByRole('heading',{name:'We couldn’t open your workspace.'})).toBeVisible();
  await page.goto('/studio/');await expect(page.locator('.auth-card')).toBeVisible();await expect(page.locator('.content-card')).toHaveCount(0);
});

for(const width of [1440,1280,1024,768,430,390,375,320]) test(`responsive ${width}px: no overflow, full-width editor, navigation and real font`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.goto('/');await page.evaluate(()=>document.fonts.ready);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.evaluate(()=>document.fonts.check('500 16px InterVariable'))).toBe(true);
  await page.screenshot({path:evidence(`landing-${width}.png`),fullPage:width===390});
  await page.goto('/dev/studio/?view=canvas');await expect(page.locator('.content-card')).toHaveCount(3);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(width<=1220 && width>1000) await page.getByRole('button',{name:'Return to campaign'}).click();
  if(width<=1220){await page.getByRole('button',{name:width<=760?/switch project$/:'Toggle navigation',exact:true}).click();await expect(page.getByRole('dialog',{name:'Your projects'}).getByRole('navigation',{name:'Projects',exact:true})).toBeVisible();await page.keyboard.press('Escape');}
  await page.locator('.content-select').first().click();await page.getByRole('button',{name:'Details',exact:true}).click();await expect(page.locator('#script')).toBeVisible();
  if(width<=1000){await expect(page.getByRole('dialog',{name:'Content editor',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Return to campaign'})).toBeVisible();}
  await page.screenshot({path:evidence(`editor-${width}.png`)});
  await page.getByRole('button',{name:'Return to campaign'}).click();await page.screenshot({path:evidence(`canvas-${width}.png`)});
});

test('long content, scroll ownership and keyboard shortcuts remain usable at 200% equivalent reflow',async({page})=>{
  await page.setViewportSize({width:720,height:500});await page.goto('/dev/studio/?view=canvas');await page.locator('.content-select').first().click();await page.getByRole('button',{name:'Details',exact:true}).click();
  await page.locator('#item-title').fill('Μια εβδομάδα ευεξίας — a detailed campaign with a long descriptive title');await page.locator('#script').fill('A useful, grounded story for our audience. '.repeat(100));await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('.save-state')).toContainText('version 2');
  await page.getByRole('button',{name:'Return to campaign'}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.keyboard.press('Control+k');await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({width:390,height:900});await page.reload();await expect(page.locator('.content-card')).toHaveCount(3);
  // One scroll container: the canvas never scrolls inside the page, and the last card is reachable at the end of it.
  const geometry=await page.evaluate(()=>{const canvas=document.querySelector('.canvas')!;return {overflow:canvas.scrollHeight-canvas.clientHeight};});
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  // Nothing has been rendered, scheduled or published, so the header states no counts for them.
  await expect(page.locator('.campaign-meta')).toContainText('3 drafts');await expect(page.locator('.campaign-meta')).not.toContainText(/ready|scheduled|published/);await expect(page.locator('.run-summary')).toHaveCount(0);
  await page.locator('.workspace-main').evaluate(el=>el.scrollTop=el.scrollHeight);await expect(page.locator('.content-card').last()).toBeInViewport();await page.screenshot({path:evidence('mobile-scroll-end.png')});
});
