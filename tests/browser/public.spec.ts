import {test,expect} from '@playwright/test';
test('public docs use the shared font, readable mobile layout and functional navigation',async({page})=>{
  await page.setViewportSize({width:320,height:900});await page.goto('/docs/api/');await expect(page.getByRole('heading',{level:1})).toContainText('API');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await page.evaluate(()=>getComputedStyle(document.documentElement).fontFamily)).toContain('InterVariable');
  await page.screenshot({path:'docs/demo/evidence/mobile-refinement/docs-api-320.png',fullPage:true});
  await page.getByRole('link',{name:'Privacy',exact:true}).click();await expect(page.getByRole('heading',{level:1})).toContainText('Privacy');
});
test('sample review groups repeated blockers and never offers a completed schedule',async({page})=>{
  await page.goto('/dev/studio/');await page.getByRole('button',{name:'Review schedule',exact:true}).click();await expect(page.locator('.review-blockers li')).toHaveCount(2);await expect(page.getByRole('button',{name:'Approve exact schedule'})).toBeDisabled();await page.screenshot({path:'docs/demo/evidence/mobile-refinement/review-blocked.png'});
});
