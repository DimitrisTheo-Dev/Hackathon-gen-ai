import {test,expect} from '@playwright/test';
const evidence='docs/demo/evidence/creative-director';
test('chat-first home docks the same conversation and exact edits update the canvas',async({page})=>{
 await page.goto('/dev/studio/');await expect(page.getByRole('heading',{name:'What will we create today?'})).toBeVisible();await expect(page.locator('.content-card')).toHaveCount(0);
 const input=page.getByLabel('Direction for your content');await input.fill('Set title: A new shared direction');await input.focus();
 expect(await input.evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('none');
 await expect(page.locator('.director-composer')).toHaveCSS('border-color','rgb(42, 42, 39)');
 await page.screenshot({path:`${evidence}/home-desktop.png`});
 await input.press('Enter');await expect(page.locator('.content-card')).toHaveCount(3);await expect(page.locator('.director-plan')).toBeVisible();await expect(input).toBeFocused();
 await page.getByRole('button',{name:'Apply changes',exact:true}).click();await expect(page.locator('.content-card').first()).toContainText('A new shared direction');await page.reload();await expect(page.locator('.director-result')).toContainText('Saved version 2');
 await page.getByLabel('Direction for your content').fill('Play latest version');await page.getByRole('button',{name:'Prepare action plan'}).click();await expect(page.locator('.director-turn').last()).toContainText('no playable video');
 await page.getByLabel('Direction for your content').fill('Review schedule');await page.getByRole('button',{name:'Prepare action plan'}).click();await page.getByRole('button',{name:'Open review',exact:true}).click();await expect(page.getByRole('button',{name:'Approve exact schedule'})).toBeDisabled();
});
for(const width of [390,320])test(`mobile chat home ${width}: request, results and conversation resume`,async({page})=>{
 await page.setViewportSize({width,height:844});await page.goto('/dev/studio/');await expect(page.getByRole('heading',{name:'What will we create today?'})).toBeVisible();await expect(page.getByRole('button',{name:'Switch project',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`${evidence}/home-${width}.png`});
 await page.getByLabel('Direction for your content').fill('Create a 15-second video');await page.getByRole('button',{name:'Prepare action plan'}).click();await expect(page.getByRole('dialog',{name:'Content editor'})).toBeVisible();await expect(page.locator('.director-turn').last()).toContainText('not connected');
 await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.locator('.content-card')).toHaveCount(3);await expect(page.locator('.editor')).toBeHidden();
 await page.getByRole('navigation',{name:'Workspace shortcuts'}).getByRole('button',{name:'Chat',exact:true}).click();await expect(page.locator('.director-turn').last()).toContainText('Create a 15-second video');await expect(page.getByLabel('Direction for your content')).toBeVisible();
});

test('unsent directions survive item and Details switches; prior playback stays honest',async({page})=>{
 await page.goto('/dev/studio/?view=canvas');
 await page.getByLabel('Direction for your content').fill('A draft for the first storyboard');
 await page.locator('.content-select').nth(1).click();
 await expect(page.getByLabel('Direction for your content')).toHaveValue('');
 await page.getByLabel('Direction for your content').fill('A different second draft');
 await page.locator('.content-select').first().click();
 await expect(page.getByLabel('Direction for your content')).toHaveValue('A draft for the first storyboard');
 await page.getByRole('button',{name:'Details',exact:true}).click();
 await page.getByRole('button',{name:'AI Chat',exact:true}).click();
 await expect(page.getByLabel('Direction for your content')).toHaveValue('A draft for the first storyboard');
 await page.getByLabel('Direction for your content').fill('Show the previous version');
 await page.getByRole('button',{name:'Prepare action plan'}).click();
 await expect(page.locator('.director-turn').last()).toContainText('Previous video playback is not available');
 await expect(page.locator('.content-card')).toHaveCount(3);
 await expect(page.locator('.director-plan')).toHaveCount(0);
});
