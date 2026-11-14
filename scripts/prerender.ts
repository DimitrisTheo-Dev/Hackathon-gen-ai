import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingPage } from '../apps/web/src/landing/LandingPage';
const origin = 'https://faceful.dtheo.dev';
const data = { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Faceful', url: origin, description: 'Describe a presenter-led video and get an editable draft. Direct it by chatting, keep every version, and let your own AI agent work in the same studio through MCP. Nothing posts without a person approving it. Presenter video rendering is rolling out; publishing to social accounts is not connected yet.', applicationCategory: 'MultimediaApplication', operatingSystem: 'Web browser', softwareVersion: '0.1.0', keywords: ['content production studio', 'campaign editing', 'agent-native content studio'], featureList: ['Prompt-to-draft video campaigns', 'Chat direction with reviewable changes and version history', 'MCP server for external AI agents', 'Human approval before any schedule', 'Shared render credits with Stripe test-mode billing'], author: { '@type': 'Person', name: 'Dimitris Theodoropoulos', url: 'https://github.com/DimitrisTheo-Dev' } };
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const content = renderToStaticMarkup(createElement(LandingPage));
const template = await readFile('dist/index.html','utf8');
const html = template.replace('<!--PUBLIC_APP-->',content).replace('</head>',`<script type="application/ld+json">${json}</script></head>`);
await writeFile('dist/index.html',html);
console.log(`Prerendered landing: ${content.length} HTML characters; JSON-LD CSP hash sha256-${createHash('sha256').update(json).digest('base64')}`);

// The private studio page. It carries the shell skeleton as static markup (the same component the app renders),
// a tiny blocking script that decides before first paint whether a studio, the sign-in card or another surface
// comes next, and early fetches for the code a studio needs, so a refresh shows one continuous loading visual.
await mkdir('dist/studio',{recursive:true});
const { readdir } = await import('node:fs/promises');
const { ShellSkeleton, bootProbe } = await import('../apps/web/src/components/ShellSkeleton');
const probe = `(${bootProbe.toString()})();`;
// The probe is emitted from its own source, so it must not lean on anything the bundler would have to supply.
if (/__name|__publicField|import_|\bexports\b/.test(probe)) throw new Error('bootProbe must be self-contained: it is emitted as a standalone script.');
new Function(probe);
const warm = (await readdir('dist/assets')).filter(name => /^(AuthApp|Studio|fixture)-[\w-]+\.(js|css)$/.test(name)).map(name => `/assets/${name}`);
const bootScript = `${probe}\n(function(urls){if(document.documentElement.getAttribute("data-boot")==="none")return;for(var i=0;i<urls.length;i++){var link=document.createElement("link"),css=/\\.css$/.test(urls[i]);link.rel=css?"preload":"modulepreload";if(css)link.as="style";link.crossOrigin="";link.href=urls[i];document.head.appendChild(link);}})(${JSON.stringify(warm)});\n`;
// Under /assets like every other built script: served as a static file locally and on the deployment, and content-hashed.
const bootFile = `/assets/studio-boot-${createHash('sha256').update(bootScript).digest('hex').slice(0,10)}.js`;
await writeFile(`dist${bootFile}`,bootScript);
// /dev/studio/ opens a studio only in builds that include the local fixture; its chunk exists exactly then.
const fixtures = warm.some(url => url.startsWith('/assets/fixture-'));
const skeleton = `${renderToStaticMarkup(createElement(ShellSkeleton))}<noscript><p class="boot-noscript">JavaScript and an authenticated session are required to edit private campaigns. <a href="/docs/">Public documentation</a> is available without JavaScript.</p></noscript>`;
const privateHtml = template.replace('<html lang="en">',fixtures?'<html lang="en" data-fixtures>':'<html lang="en">').replace('<!--PUBLIC_APP-->',skeleton).replace(/<link rel="canonical"[^>]*>/,'<meta name="robots" content="noindex, nofollow">').replace(/<title>.*?<\/title>/,'<title>Faceful studio</title>').replace('</head>',`<script src="${bootFile}"></script></head>`);
await writeFile('dist/studio/index.html',privateHtml);
console.log(`Prerendered studio shell: skeleton ${skeleton.length} HTML characters; boot script ${bootFile}; warming ${warm.length} chunks`);
