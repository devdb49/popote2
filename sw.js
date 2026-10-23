/* Service worker : toute l'application est gardée dans l'iPad pour fonctionner sans réseau.
 * Pour publier une mise à jour, augmenter VERSION (format x.y.z) : l'iPad la prendra au lancement suivant.
 *   x.y.Z : correction   x.Y.0 : nouvelle fonction   X.0.0 : changement majeur
 * La version est affichée sur l'accueil et dans Gestion > Réglages. */
const VERSION = "3.11.0";
const CACHE = "popote-" + VERSION;
const FILES = [
  "./", "index.html", "store.js", "kiosk.js", "admin.js", "boot.js",
  "common.css", "theme.css", "manifest.webmanifest",
  "icon-180.png", "icon-192.png", "icon-512.png",
  "fonts/big-shoulders-stencil-display-latin-800-normal.woff2",
  "fonts/big-shoulders-display-latin-600-normal.woff2", "fonts/big-shoulders-display-latin-700-normal.woff2",
  "fonts/big-shoulders-display-latin-800-normal.woff2", "fonts/barlow-latin-400-normal.woff2",
  "fonts/barlow-latin-500-normal.woff2", "fonts/barlow-latin-600-normal.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Cache d'abord (hors ligne garanti), réseau en secours.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
