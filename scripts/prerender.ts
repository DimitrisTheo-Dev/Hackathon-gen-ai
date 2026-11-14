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

await mkdir('dist/studio',{recursive:true});
const privateHtml = template.replace('<!--PUBLIC_APP-->','<main class="loading-page"><p>Opening your studio…</p><noscript>JavaScript and an authenticated session are required to edit private campaigns. <a href="/docs/">Public documentation</a> is available without JavaScript.</noscript></main>').replace(/<link rel="canonical"[^>]*>/,'<meta name="robots" content="noindex, nofollow">').replace(/<title>.*?<\/title>/,'<title>Faceful studio</title>');
await writeFile('dist/studio/index.html',privateHtml);
