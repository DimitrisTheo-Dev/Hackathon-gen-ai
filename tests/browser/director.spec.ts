import {test,expect} from '@playwright/test';
const evidence='docs/demo/evidence/creative-director';
test('director plan → saved canvas revision → history → undo, with honest unavailable AI',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/dev/studio/?view=canvas');await expect(page.locator('.content-card')).toHaveCount(3);
 await expect(page.getByRole('button',{name:'AI Chat',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.getByText('Development preview',{exact:true})).toHaveCount(0);
 // Empty chat: a short intro, one collapsed context chip, one quiet status by the composer. No zero-value counts.
 const chip=page.locator('.director-context-chip');await expect(chip).toHaveText('BeWell · 3 drafts · 1 source');await expect(chip).toHaveAttribute('aria-expanded','false');
 await expect(page.locator('.director-panel')).not.toContainText('Avoid medical or wellbeing guarantees.');await chip.click();await expect(page.locator('.director-context-body')).toContainText('Avoid medical or wellbeing guarantees.');
 await expect(page.locator('.director-status')).toContainText('AI isn’t connected');await expect(page.locator('.director-panel')).not.toContainText('authorized avatars');
 await page.getByLabel('Direction for your content').fill('Set title: A more inviting festival day');await page.getByRole('button',{name:'Prepare action plan'}).click();
 await expect(page.locator('.director-plan')).toContainText('Review changes');
 // The intro and chip belong to the empty state only; the proposal shows its diff as plain text, already open.
 await expect(page.locator('.director-intro')).toHaveCount(0);await expect(chip).toHaveCount(0);
 await expect(page.locator('.director-diff del')).toHaveText('Find your next moment');await expect(page.locator('.director-diff ins')).toHaveText('A more inviting festival day');
 await expect(page.locator('.content-card').first()).toContainText('Find your next moment');
 await page.getByRole('button',{name:'Apply changes',exact:true}).click();
 await expect(page.locator('.director-result')).toContainText('Saved version 2');await expect(page.locator('.content-card').first()).toContainText('A more inviting festival day');
 await page.locator('.content-select').nth(1).click();await expect(page.locator('.director-selected')).toContainText('One idea. Two platforms.');await expect(page.locator('.director-conversation')).toContainText('A more inviting festival day');
 await page.locator('.content-select').first().click();await page.reload();await expect(page.locator('.director-result')).toContainText('Saved version 2');
 await page.getByRole('button',{name:'Undo this change'}).click();await expect(page.locator('.director-result')).toContainText('Restored as a new saved revision');await expect(page.locator('.content-card').first()).toContainText('Find your next moment');
 await page.getByLabel('Direction for your content').fill('Rewrite the opening');await page.getByRole('button',{name:'Prepare action plan'}).click();await expect(page.locator('.director-turn').last()).toContainText('AI direction is not connected yet');
 await page.screenshot({path:`${evidence}/chat-desktop.png`});expect(errors).toEqual([]);
});
test('director failed edit rolls canvas back; retry preserves intent; new revisions make old plans stale',async({page})=>{
 await page.goto('/dev/studio/?view=canvas');await page.getByLabel('Direction for your content').fill('Set script: This exact opening is ready to review.');await page.getByRole('button',{name:'Prepare action plan'}).click();
 await page.evaluate(()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='castroom-development-v1')throw new DOMException('Full','QuotaExceededError');return set.call(this,k,v)};(window as any).restore=()=>Storage.prototype.setItem=set});
 await page.getByRole('button',{name:'Apply changes',exact:true}).click();await expect(page.locator('.director-result')).toContainText('could not be saved');
 await page.evaluate(()=>(window as any).restore());await page.getByRole('button',{name:'Retry action'}).click();await expect(page.locator('.director-result')).toContainText('Saved version 2');
 await page.getByLabel('Direction for your content').fill('Set title: Stale instruction');await page.getByRole('button',{name:'Prepare action plan'}).click();
 await page.getByRole('button',{name:'Details',exact:true}).click();await page.locator('#item-title').fill('The newest manual title');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('.save-state')).toContainText('version 3');
 await page.getByRole('button',{name:'AI Chat',exact:true}).click();await page.getByRole('button',{name:'Apply changes',exact:true}).click();await expect(page.locator('.director-result').last()).toContainText('changed');await expect(page.locator('.content-card').first()).toContainText('The newest manual title');
});
test('phone director exact-script plan preserves Details and safe focus styles',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/dev/studio/?view=canvas');await page.locator('.content-select').first().click();await page.getByRole('button',{name:'Edit script',exact:true}).click();
 await page.getByLabel('Your replacement script').fill('A warmer day, in your own words.');await page.getByRole('button',{name:'Review script change'}).click();await page.getByRole('button',{name:'Apply changes',exact:true}).click();await expect(page.locator('.director-result')).toContainText('Saved version 2');
 await page.screenshot({path:`${evidence}/chat-phone.png`});
 await page.getByRole('button',{name:'Details',exact:true}).click();await expect(page.locator('#script')).toHaveValue('A warmer day, in your own words.');await page.locator('#script').focus();
 const focus=await page.locator('#script').evaluate(el=>{const s=getComputedStyle(el);return {width:s.outlineWidth,offset:s.outlineOffset,shadow:s.boxShadow,font:s.fontSize}});expect(focus).toEqual({width:'1px',offset:'-2px',shadow:'none',font:'16px'});
 await page.screenshot({path:`${evidence}/details-phone-focus.png`});await page.getByRole('button',{name:'Return to campaign'}).click();await expect(page.locator('.content-card')).toHaveCount(3);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('Details stays short: guidance folds away, the render action says why it is unavailable, one hint at a time',async({page})=>{
 await page.goto('/dev/studio/?view=canvas');await page.getByRole('button',{name:'Details',exact:true}).click();
 const details=page.locator('.editor-details');const hint=page.locator('.editor-hint');
 await expect(details).not.toContainText('Use factual statements');
 const guidance=details.getByRole('button',{name:'Guidance',exact:true});await expect(guidance).toHaveAttribute('aria-expanded','false');await expect(guidance).toHaveAccessibleDescription('4 rules');
 await guidance.click();await expect(details).toContainText('Use factual statements supported by the source.');await expect(details).toContainText('BeWell Festival · Quintessential case study');await expect(details).not.toContainText('source-bewell');
 // Rendering is not connected here: the action stays in place, is marked unavailable and explains itself once.
 const render=details.getByRole('button',{name:'Render video',exact:true});await expect(render).toHaveAttribute('aria-disabled','true');await expect(render).toHaveAccessibleDescription('Rendering is unavailable in this workspace.');
 await expect(hint).toHaveText('Rendering is unavailable in this workspace.');await expect(page.locator('.save-state')).toContainText('Saved · v1');
 await page.locator('#script').fill('A shorter opening.');await expect(hint).toHaveText('Saving creates v2.');await expect(page.locator('.save-state')).toContainText('Unsaved changes');
 await render.click({force:true});await expect(hint).toHaveText('Rendering is unavailable in this workspace.');await expect(page.locator('.content-card').first()).toContainText('Draft');
 // Secondary actions live in one menu that works from the keyboard and gives focus back.
 const more=page.getByRole('button',{name:'More actions'});await more.focus();await page.keyboard.press('Enter');await expect(page.getByRole('menuitem',{name:'Undo last edit'})).toBeFocused();
 await page.keyboard.press('ArrowDown');await expect(page.getByRole('menuitem',{name:'Discard edits'})).toBeFocused();await page.keyboard.press('Escape');await expect(page.getByRole('menu')).toHaveCount(0);await expect(more).toBeFocused();
 await more.click();await page.getByRole('menuitem',{name:'Continue with your agent'}).click();await expect(page.locator('#handoff-task')).toBeFocused();await expect(details.getByRole('button',{name:'Copy handoff'})).toBeVisible();
 await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('.save-state')).toContainText('Saved · v2');
 await details.getByRole('button',{name:'Posting times',exact:true}).click();await expect(page.locator('#schedule-instagram-0')).toHaveValue('2026-11-16T09:00');
});
test('new campaign: three short steps, presets, keyboard path and Back keep the input; the saved brief is exactly what was entered',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/dev/studio/');await page.getByRole('button',{name:'Create with my own script'}).click();
 const dialog=page.getByRole('dialog',{name:'New campaign'});await expect(dialog).toBeVisible();await expect(page.locator('#company-name')).toBeFocused();
 // Continue with nothing entered: the problems are named inline, focus goes to the first, and the step does not change.
 await dialog.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.locator('#company-name')).toHaveAttribute('aria-invalid','true');await expect(dialog).toContainText('Add the brand or company name.');await expect(page.locator('#company-name')).toBeFocused();
 // Enter moves to what is still missing; Ctrl/Cmd+Enter continues.
 await page.locator('#company-name').fill('Olive Works');await page.keyboard.press('Enter');await expect(page.locator('#company-does')).toBeFocused();
 await page.locator('#company-does').fill('We make reusable lunch containers.');await page.keyboard.press('ControlOrMeta+Enter');await expect(dialog.getByRole('heading',{name:'Set the voice'})).toBeVisible();
 // Presets write into the editable field, and stay in step with it.
 await expect(page.locator('#company-tone')).toHaveValue('Clear, warm');await dialog.getByRole('button',{name:'Playful',exact:true}).click();await expect(page.locator('#company-tone')).toHaveValue('Clear, warm, playful');
 await dialog.getByRole('button',{name:'Warm',exact:true}).click();await expect(page.locator('#company-tone')).toHaveValue('Clear, playful');await expect(dialog.getByRole('button',{name:'Playful',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.locator('#company-audience').fill('Parents packing school lunches');
 await dialog.getByRole('button',{name:'Back',exact:true}).click();await expect(page.locator('#company-name')).toHaveValue('Olive Works');
 await dialog.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.locator('#company-tone')).toHaveValue('Clear, playful');await expect(page.locator('#company-audience')).toHaveValue('Parents packing school lunches');
 await dialog.getByRole('button',{name:'Continue',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Write the first scripts'})).toBeVisible();
 await page.locator('#draft-title-0').fill('Meet the lunch box');await page.keyboard.press('Enter');await expect(page.locator('#draft-script-0')).toBeFocused();
 await page.locator('#draft-script-0').fill('Make room for a reusable lunch box.');await expect(dialog).toContainText('7 words');
 await dialog.getByRole('button',{name:'Add another video'}).click();await expect(page.locator('#draft-title-1')).toBeFocused();await expect(dialog.getByRole('button',{name:'Create 2 drafts',exact:true})).toBeVisible();
 // An empty second card blocks creation and says why; removing it leaves the first intact.
 await dialog.getByRole('button',{name:'Create 2 drafts',exact:true}).click();await expect(dialog).toContainText('Give this video a title.');await expect(page.locator('.content-card')).toHaveCount(0);
 await dialog.getByRole('button',{name:'Remove video 2'}).click();await expect(page.locator('#draft-title-0')).toHaveValue('Meet the lunch box');
 await page.keyboard.press('ControlOrMeta+Enter');await expect(page.getByRole('heading',{name:'Olive Works — first drafts',exact:true})).toBeVisible();await expect(page.locator('.content-card')).toHaveCount(1);
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('castroom-development-v1')!).campaigns.find((c:{title:string})=>c.title==='Olive Works — first drafts'));
 expect(saved.companyContext).toEqual({name:'Olive Works',description:'We make reusable lunch containers.',audience:'Parents packing school lunches',tone:'Clear, playful',sourceText:'',sourceUrl:null,missingInformation:''});
 expect(saved.items.map((i:{title:string;script:string})=>[i.title,i.script])).toEqual([['Meet the lunch box','Make room for a reusable lunch box.']]);expect(errors).toEqual([]);
});
for(const width of [390,320])test(`new campaign sheet ${width}px: no sideways scroll, 44px targets, steps reachable`,async({page})=>{
 await page.setViewportSize({width,height:780});await page.goto('/dev/studio/');await page.getByRole('button',{name:'Create with my own script'}).click();
 const dialog=page.getByRole('dialog',{name:'New campaign'});await expect(dialog).toBeVisible();
 const fits=()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.create-main,.create-actions')].every(el=>el.scrollWidth<=el.clientWidth));
 expect(await fits()).toBe(true);
 await page.locator('#company-name').fill('Olive Works');await page.locator('#company-does').fill('We make reusable lunch containers.');await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 expect(await fits()).toBe(true);expect(await dialog.locator('.create-chips button').evaluateAll(els=>els.every(el=>el.getBoundingClientRect().height>=44))).toBe(true);
 await dialog.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.locator('#draft-title-0')).toBeVisible();expect(await fits()).toBe(true);
 expect(await page.locator('#draft-script-0').evaluate(el=>getComputedStyle(el).fontSize)).toBe('16px');
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
});
test('OTP screens verify code, cooldown and failure without sending a real email',async({page})=>{
 const calls:string[]=[];
 await page.route('https://hgsgvdujzatfhsjoojll.supabase.co/auth/v1/**',async route=>{
   const url=new URL(route.request().url());calls.push(url.pathname);
   if(url.pathname.endsWith('/otp')){expect(route.request().postDataJSON().create_user).toBe(true);await route.fulfill({status:200,contentType:'application/json',body:'{}'});return;}
   if(url.pathname.endsWith('/verify')){await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error_code:'otp_expired',msg:'Token expired'})});return;}
   await route.fulfill({status:401,contentType:'application/json',body:'{"message":"Unauthenticated"}'});
 });
 await page.goto('/studio/');await page.getByLabel('Email address').fill('qa@example.com');await page.getByRole('button',{name:'Continue with email'}).click();await expect(page.getByRole('heading',{name:'Check your email'})).toBeVisible();await expect(page.getByRole('button',{name:/Resend in/})).toBeDisabled();
 // A pasted code with a space is normalised, and the sixth digit submits by itself: no extra click.
 await page.getByLabel('Sign-in code').fill('123 456');await expect(page.getByRole('alert')).toContainText('expired');await expect(page.locator('.content-card')).toHaveCount(0);
 // The rejected digits are cleared and focus never left the field, so the next code can be typed at once.
 await expect(page.getByLabel('Sign-in code')).toHaveValue('');await expect(page.getByLabel('Sign-in code')).toBeFocused();expect(calls.filter(p=>p.endsWith('/verify'))).toHaveLength(1);
 await expect(page.getByText('Creating an account doesn’t grant access')).toHaveCount(0);await expect(page.getByText('Code requested')).toHaveCount(0);
 await page.getByRole('button',{name:'Use a different email'}).click();await expect(page.getByLabel('Email address')).toBeVisible();expect(calls.filter(p=>p.endsWith('/otp'))).toHaveLength(1);
});

test('hero rotates client marks without shifting the headline and can pause',async({page})=>{
 await page.emulateMedia({reducedMotion:'no-preference'});await page.goto('/');
 const title=page.getByRole('heading',{level:1});await expect(title).toHaveAttribute('aria-label','What if your agent made your next video campaign?');
 const box=await title.boundingBox();await expect(page.locator('.landing-agent-name.is-current')).toContainText('Claude Code');
 await expect(page.locator('.landing-agent-name.is-current')).toContainText('Codex',{timeout:6000});const after=await title.boundingBox();expect(Math.abs(after!.height-box!.height)).toBeLessThan(2);
 expect(await page.locator('.landing-agent-name.is-current img').evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0)).toBe(true);
 await page.getByRole('button',{name:'Pause agent rotation'}).click();await expect(page.getByRole('button',{name:'Resume agent rotation'})).toHaveAttribute('aria-pressed','true');
});

test('OTP verification opens a server-confirmed session without inventing workspace access',async({page})=>{
 const user={id:'11111111-1111-4111-8111-111111111111',aud:'authenticated',role:'authenticated',email:'qa@example.com',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()};
 const token=[{alg:'HS256',typ:'JWT'},{sub:user.id,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated'},{test:true}].map(p=>Buffer.from(JSON.stringify(p)).toString('base64url')).join('.');
 await page.route('https://hgsgvdujzatfhsjoojll.supabase.co/auth/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const body=path.endsWith('/otp')?{}:path.endsWith('/verify')?{access_token:token,refresh_token:'test-only-not-a-real-credential',expires_in:3600,token_type:'bearer',user}:user;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('/studio/');await page.getByLabel('Email address').fill('qa@example.com');await page.getByRole('button',{name:'Continue with email'}).click();await page.getByLabel('Sign-in code').fill('123456');
 // The studio now calls its own origin for the engine. This server has none, so the person is told so; no fixture is substituted.
 await expect(page.getByRole('heading',{name:'The studio service isn’t available yet.'})).toBeVisible();await expect(page.locator('.auth-card')).toContainText('no sample content was substituted');await expect(page.locator('.content-card')).toHaveCount(0);
 await page.reload();await expect(page.getByRole('heading',{name:'The studio service isn’t available yet.'})).toBeVisible();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByLabel('Email address')).toBeVisible();
});
