import { test, expect } from '@playwright/test';

test('landing is useful without JavaScript and exposes genuine discovery metadata', async ({ browser, request }) => {
  const context = await browser.newContext({javaScriptEnabled:false});const page=await context.newPage();
  await page.goto('/');await expect(page.getByRole('heading',{level:1})).toHaveText('Your agent runsyour content studio.');
  expect((await page.locator('main').innerText()).length).toBeGreaterThan(500);
  expect(await page.locator('script[type="application/ld+json"]').textContent()).toContain('SoftwareApplication');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href','https://hackathon-gen-ai-nine.vercel.app/');
  const md=await request.get('/',{headers:{Accept:'text/markdown'}});expect(md.headers()['content-type']).toContain('text/markdown');expect(md.headers().vary).toBe('Accept');expect(await md.text()).toContain('When to use');
  const missing=await request.get('/this-is-not-a-page',{headers:{Accept:'text/markdown'}});expect(missing.status()).toBe(404);expect(missing.headers()['content-type']).toContain('text/markdown');expect(await missing.text()).toContain('/docs/');
  await context.close();
});

test('landing samples, keyboard workflow tabs and reduced-motion companion remain honest', async ({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
  await page.getByRole('button',{name:'Preview One idea. Two platforms.'}).click();
  await expect(page.locator('.landing-preview-editor')).toContainText('React Native');
  const tab=page.getByRole('tab',{name:'Brief',exact:true});await tab.focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'Create',exact:true})).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('End');await expect(page.getByRole('tabpanel')).toContainText('Final render required');
  await expect(page.locator('.landing-companion')).toContainText('Live authentication is pending');
  expect(errors).toEqual([]);
});

test('draft edits survive item switches, save and reload; palette and filters use real objects',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/dev/studio/');await expect(page.locator('.content-card')).toHaveCount(3);
  const script=page.locator('#script');await script.fill('A warmer opening for the BeWell story.');
  await page.locator('.content-select').nth(1).click();await page.locator('.content-select').first().click();await expect(script).toHaveValue('A warmer opening for the BeWell story.');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('.save-state')).toContainText('Saved · version 2');
  await page.reload();await expect(script).toHaveValue('A warmer opening for the BeWell story.');
  await page.getByRole('button',{name:'Channels',exact:true}).click();await page.locator('#channel-copy').fill('An updated Instagram caption.');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('.save-state')).toContainText('version 3');
  await page.getByRole('button',{name:'Find projects or content'}).click();await page.getByRole('combobox',{name:'Search projects, content and actions'}).fill('familiar');await page.keyboard.press('Enter');await expect(page.locator('#item-title')).toHaveValue('A familiar feeling');
  await page.getByRole('searchbox',{name:'Filter campaign content'}).fill('no matching item');await expect(page.locator('.content-card')).toHaveCount(0);
  await page.getByRole('searchbox',{name:'Filter campaign content'}).fill('');await page.getByRole('combobox',{name:'Filter by content status'}).selectOption('ready');await expect(page.locator('.content-card')).toHaveCount(0);
  await page.getByRole('combobox',{name:'Filter by content status'}).selectOption('all');await expect(page.locator('.content-card')).toHaveCount(3);expect(errors).toEqual([]);
});

test('manual campaign saves supplied context and approval never implies publication in fixture mode',async({page})=>{
  await page.goto('/dev/studio/');await page.getByRole('button',{name:'New campaign',exact:true}).click();
  await page.locator('#company-name').fill('Olive Works');await page.locator('#campaign-name').fill('A useful first week');await page.locator('#company-does').fill('We make reusable lunch containers.');
  await page.getByRole('button',{name:'Review context & write drafts'}).click();
  await page.locator('#draft-title-0').fill('Meet the reusable lunch box');await page.locator('#draft-script-0').fill('Make room for a reusable lunch box in your everyday bag.');
  await page.getByRole('button',{name:'Create draft',exact:true}).click();await expect(page.getByRole('heading',{name:'A useful first week',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Review schedule',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('cannot be approved or published');await expect(page.getByRole('dialog').getByRole('button',{name:/Approve/})).toBeDisabled();
  await page.getByRole('button',{name:'Close dialog'}).click();await page.reload();await expect(page.getByRole('heading',{name:'A useful first week',exact:true})).toBeVisible();
});

test('offline, corrupt storage and unauthenticated paths do not claim success or fall back',async({page,context})=>{
  await page.goto('/dev/studio/');await page.locator('#script').fill('Retain this unsaved edit.');await context.setOffline(true);await expect(page.getByText('You’re offline.',{exact:false})).toBeVisible();await expect(page.locator('#script')).toHaveValue('Retain this unsaved edit.');await context.setOffline(false);
  await page.evaluate(()=>localStorage.setItem('castroom-development-v1','broken'));await page.reload();await expect(page.getByRole('heading',{name:'We couldn’t open your workspace.'})).toBeVisible();
  await page.goto('/studio/');await expect(page.locator('.auth-card')).toBeVisible();await expect(page.locator('.content-card')).toHaveCount(0);
});

for(const width of [1440,1280,1024,768,430,390,375,320]) test(`responsive ${width}px: no overflow, full-width editor, navigation and real font`,async({page})=>{
  await page.setViewportSize({width,height:900});await page.goto('/');await page.evaluate(()=>document.fonts.ready);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.evaluate(()=>document.fonts.check('500 16px InterVariable'))).toBe(true);
  await page.screenshot({path:`docs/demo/evidence/redesign/landing-${width}.png`,fullPage:width===390});
  await page.goto('/dev/studio/');await expect(page.locator('.content-card')).toHaveCount(3);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(width<=1220 && width>1000) await page.getByRole('button',{name:'Return to campaign'}).click();
  if(width<=1220){await page.getByRole('button',{name:'Toggle navigation'}).click();await expect(page.getByRole('navigation',{name:'Projects',exact:true})).toBeVisible();await page.keyboard.press('Escape');}
  await page.locator('.content-select').first().click();await expect(page.locator('#script')).toBeVisible();
  if(width<=1000){await expect(page.locator('.workspace')).toBeHidden();await expect(page.getByRole('button',{name:'Return to campaign'})).toBeVisible();}
  await page.screenshot({path:`docs/demo/evidence/redesign/editor-${width}.png`});
  await page.getByRole('button',{name:'Return to campaign'}).click();await page.screenshot({path:`docs/demo/evidence/redesign/canvas-${width}.png`});
});

test('long content, scroll ownership and keyboard shortcuts remain usable at 200% equivalent reflow',async({page})=>{
  await page.setViewportSize({width:720,height:500});await page.goto('/dev/studio/');await page.locator('.content-select').first().click();
  await page.locator('#item-title').fill('Μια εβδομάδα ευεξίας — a detailed campaign with a long descriptive title');await page.locator('#script').fill('A useful, grounded story for our audience. '.repeat(100));await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('.save-state')).toContainText('version 2');
  await page.getByRole('button',{name:'Return to campaign'}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.keyboard.press('Control+k');await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({width:390,height:900});await page.reload();await expect(page.locator('.content-card')).toHaveCount(3);
  const geometry=await page.evaluate(()=>{const canvas=document.querySelector('.canvas')!;const grid=document.querySelector('.content-grid')!;const footer=document.querySelector('.run-summary')!;return {overflow:canvas.scrollHeight-canvas.clientHeight,gridEnd:grid.getBoundingClientRect().bottom,footerStart:footer.getBoundingClientRect().top};});
  expect(geometry.overflow).toBeLessThanOrEqual(1);expect(geometry.footerStart).toBeGreaterThan(geometry.gridEnd);
  await page.locator('.workspace-main').evaluate(el=>el.scrollTop=el.scrollHeight);await expect(page.locator('.run-summary')).toBeVisible();await page.screenshot({path:'docs/demo/evidence/redesign/mobile-scroll-end.png'});
});
