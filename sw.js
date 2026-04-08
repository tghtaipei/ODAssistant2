/**
 * Service Worker for ODAssistant2 PWA
 * Caches app shell for offline use.
 * Data (DI files, drafts) is stored in IndexedDB, not SW cache.
 */

const CACHE_NAME = 'odassistant-v6';

const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/DIParser.js',
  './js/TemplateStore.js',
  './js/DriveSync.js',
  './js/DataRepository.js',
  './js/EditorUI.js',
  './js/DraftManager.js',
  './js/ExportService.js',
  './js/validation/ValidationEngine.js',
  './js/validation/ValidatorBase.js',
  './js/validation/PlaceholderValidator.js',
  './js/validation/LegislatorValidator.js',
  './js/validation/GroupValidator.js',
  './js/validation/CaseType81Validator.js',
  './manifest.json',
];

// Install: cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for app shell, network-first for Google Drive API
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go to network for Google Drive API calls
  if (url.hostname === 'www.googleapis.com') {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: '網路連線失敗，無法同步 Google Drive' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // Cache-first strategy for app shell
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
