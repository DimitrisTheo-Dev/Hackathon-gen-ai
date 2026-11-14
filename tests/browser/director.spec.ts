import {test,expect} from '@playwright/test';
const evidence='docs/demo/evidence/creative-director';
test('director plan → saved canvas revision → history → undo, with honest unavailable AI',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/dev/studio/?view=canvas');await expect(page.locator('.content-card')).toHaveCount(3);
 await expect(page.getByRole('button',{name:'AI Chat',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.getByText('Development preview',{exact:true})).toHaveCount(0);
 await page.getByLabel('Direction for your content').fill('Set title: A more inviting festival day');await page.getByRole('button',{name:'Prepare action plan'}).click();
 await expect(page.locator('.director-plan')).toContainText('Review changes');
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
test('OTP screens verify code, cooldown and failure without sending a real email',async({page})=>{
 const calls:string[]=[];
 await page.route('https://hgsgvdujzatfhsjoojll.supabase.co/auth/v1/**',async route=>{
   const url=new URL(route.request().url());calls.push(url.pathname);
   if(url.pathname.endsWith('/otp')){expect(route.request().postDataJSON().create_user).toBe(true);await route.fulfill({status:200,contentType:'application/json',body:'{}'});return;}
   if(url.pathname.endsWith('/verify')){await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error_code:'otp_expired',msg:'Token expired'})});return;}
   await route.fulfill({status:401,contentType:'application/json',body:'{"message":"Unauthenticated"}'});
 });
 await page.goto('/studio/');await page.getByLabel('Email address').fill('qa@example.com');await page.getByRole('button',{name:'Continue with email'}).click();await expect(page.getByRole('heading',{name:'Check your email'})).toBeVisible();await expect(page.getByRole('button',{name:/Resend in/})).toBeDisabled();
 await page.getByLabel('Sign-in code').fill('123 456');await expect(page.getByLabel('Sign-in code')).toHaveValue('123456');await page.getByRole('button',{name:'Verify and continue'}).click();await expect(page.getByRole('alert')).toContainText('expired');await expect(page.locator('.content-card')).toHaveCount(0);
 await page.getByRole('button',{name:'Change email'}).click();await expect(page.getByLabel('Email address')).toBeVisible();expect(calls.filter(p=>p.endsWith('/otp'))).toHaveLength(1);
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
 await page.goto('/studio/');await page.getByLabel('Email address').fill('qa@example.com');await page.getByRole('button',{name:'Continue with email'}).click();await page.getByLabel('Sign-in code').fill('123456');await page.getByRole('button',{name:'Verify and continue'}).click();
 await expect(page.getByRole('heading',{name:'You’re signed in'})).toBeVisible();await expect(page.locator('.auth-card')).toContainText('Workspace access is separate');await expect(page.locator('.content-card')).toHaveCount(0);
 await page.reload();await expect(page.getByRole('heading',{name:'You’re signed in'})).toBeVisible();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByLabel('Email address')).toBeVisible();
});
