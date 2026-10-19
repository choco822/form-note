// オフラインでも開けるように、アプリ・AIモデル・Firebaseの部品をスマホに保存しておく
const CACHE = "form-note-v3";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 一度読み込んだら保存したものを使う（版の番号つきで中身が変わらないもの）
const cacheFirst = (req) => caches.open(CACHE).then(async (c) => {
  const hit = await c.match(req); if (hit) return hit;
  const r = await fetch(req); if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r;
});
// 新しい版を優先。通信できない・遅い（3秒）ときは保存した版を使う
const networkFirst = (req) => caches.open(CACHE).then((c) => new Promise((resolve) => {
  let done = false;
  const fallback = async () => { if (done) return; const hit = await c.match(req, { ignoreSearch: req.mode === "navigate" }); if (hit && !done) { done = true; resolve(hit); } };
  const timer = setTimeout(fallback, 3000);
  fetch(req).then((r) => {
    if (r.ok) c.put(req, r.clone());
    if (!done) { done = true; clearTimeout(timer); resolve(r); }
  }).catch(async () => { clearTimeout(timer); await fallback(); if (!done) { done = true; resolve(Response.error()); } });
}));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  if (u.pathname.includes("/pose_") || u.href.includes("@tensorflow/tfjs@4.22.0")) return e.respondWith(cacheFirst(e.request));
  if (u.hostname === "www.gstatic.com" && u.pathname.includes("/firebasejs/")) return e.respondWith(cacheFirst(e.request));
  if (u.hostname === "fonts.gstatic.com") return e.respondWith(cacheFirst(e.request));
  if (u.hostname === "fonts.googleapis.com") return e.respondWith(networkFirst(e.request));
  if (u.origin === location.origin) return e.respondWith(networkFirst(e.request));
});
