import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingPage } from '../apps/web/src/landing/LandingPage';
const origin = 'https://hackathon-gen-ai-nine.vercel.app';
const data = { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Castroom', url: origin, description: 'A shared content production studio for company briefs, campaign drafts, avatar-video revisions and authorized schedule review. Live MCP, rendering and publishing are pending integration.', applicationCategory: 'MultimediaApplication', operatingSystem: 'Web browser', softwareVersion: '0.1.0', keywords: ['content production studio', 'campaign editing', 'agent-native content studio'], featureList: ['Public API and agent documentation', 'Supplied company context and campaign draft editing', 'Version-aware selected-content editor'], author: { '@type': 'Person', name: 'Dimitris Theodoropoulos', url: 'https://github.com/DimitrisTheo-Dev' } };
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const content = renderToStaticMarkup(createElement(LandingPage));
const template = await readFile('dist/index.html','utf8');
const html = template.replace('<!--PUBLIC_APP-->',content).replace('</head>',`<script type="application/ld+json">${json}</script></head>`);
await writeFile('dist/index.html',html);
console.log(`Prerendered landing: ${content.length} HTML characters; JSON-LD CSP hash sha256-${createHash('sha256').update(json).digest('base64')}`);

await mkdir('dist/studio',{recursive:true});
const privateHtml = template.replace('<!--PUBLIC_APP-->','<main class="loading-page"><p>Opening your studio…</p><noscript>JavaScript and an authenticated session are required to edit private campaigns. <a href="/docs/">Public documentation</a> is available without JavaScript.</noscript></main>').replace(/<link rel="canonical"[^>]*>/,'<meta name="robots" content="noindex, nofollow">').replace(/<title>.*?<\/title>/,'<title>Castroom studio</title>');
await writeFile('dist/studio/index.html',privateHtml);
