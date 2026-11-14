/*
 * Faceful service worker. Deliberately small:
 *   • Immutable build assets, fonts, art and icons are cached (they are content-hashed or versioned).
 *   • Page navigations always go to the network; when offline, the cached studio shell (which holds no
 *     private data) or a plain offline page is shown.
 *   • Nothing under /v1, /mcp, /api, /oauth or any cross-origin request is ever touched or cached:
 *     workspace data, tokens and signed media URLs never enter a cache.
 */
const VERSION = "faceful-v1";
const STATIC = `${VERSION}-static`;
const SHELL = `${VERSION}-shell`;
const OFFLINE_URL = "/offline.html";
const PRIVATE = /^\/(v1|mcp|api|oauth|\.well-known)(\/|$)/;
const CACHEABLE = /^\/(assets\/|fonts\/|art\/|icons\/)|^\/(design\.css|favicon\.svg|manifest\.webmanifest)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" }))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)))).then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || PRIVATE.test(url.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Keep the latest studio shell for offline launches of the installed app. It is static markup only.
          if (response.ok && /^\/studio(\/|$)/.test(url.pathname)) caches.open(SHELL).then((cache) => cache.put("/studio/", response.clone())).catch(() => undefined);
          return response;
        })
        .catch(async () => (/^\/studio(\/|$)/.test(url.pathname) && (await caches.match("/studio/"))) || (await caches.match(OFFLINE_URL)) || Response.error()),
    );
    return;
  }
  if (!CACHEABLE.test(url.pathname)) return;
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && response.type === "basic") caches.open(STATIC).then((cache) => cache.put(request, response.clone())).catch(() => undefined);
          return response;
        }),
    ),
  );
});
