/* CuraBot 极简 Service Worker：占位升级与离线壳，回访提醒主逻辑在页面内定时检查 */
self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});
