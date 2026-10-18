// オフラインでも開けるように、アプリとAIモデルをスマホに保存しておく
const CACHE = "form-note-v2";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  // AIモデルとTF.js：一度読み込んだら保存したものを使う（約20MBの再ダウンロードを防ぐ）
  if (u.pathname.includes("/pose_") || u.href.includes("@tensorflow/tfjs@4.22.0")) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request); if (hit) return hit;
      const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r;
    }));
    return;
  }
  // アプリ本体：新しい版を優先し、通信できないときは保存した版を使う
  if (u.origin === location.origin) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const cl = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cl)); }
      return r;
    }).catch(() => caches.match(e.request)));
  }
});
