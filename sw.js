/* ════════════════════════════════════════════════════════════════
   서비스 워커

   자주 푸시하는 앱에서 캐시는 흉기다. 옛 버전이 굳어버린다.
   중요한 건 무엇을 캐시하느냐가 아니라 무엇을 캐시하지 않느냐다.

     /api/*          캐시하지 않는다. 톡·이미지·동기화는 늘 살아있어야 한다.
     index.html      네트워크 우선. 캐시는 오프라인일 때만 쓰는 예비.
     아이콘·manifest  캐시 우선. 바뀌지 않으니까.
   ════════════════════════════════════════════════════════════════ */

const CACHE = "realtalk-v3";

const STATIC = [
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(STATIC.map(u => c.add(u))))  // 하나 없어도 설치는 계속한다
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 응답을 캐시에 넣는다.
   clone() 은 반드시 응답을 돌려주기 전에, 동기적으로 해야 한다.
   비동기 안에서 부르면 이미 소비된 본문을 복제하려다 터진다. */
function stash(req, res) {
  if (!res || !res.ok) return res;
  const copy = res.clone();                       // ← 여기서 미리 뜬다
  caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 남의 도메인은 건드리지 않는다
  if (url.pathname.startsWith("/api/")) return;      // API 는 절대 캐시하지 않는다

  // 안 바뀌는 것들 — 캐시 우선
  if (STATIC.includes(url.pathname)) {
    e.respondWith(
      caches.match(req)
        .then(hit => hit || fetch(req).then(res => stash(req, res)))
        .catch(() => fetch(req))
    );
    return;
  }

  // 앱 본체 — 네트워크 우선. 푸시하면 바로 새 버전이 뜬다.
  // 실패하면(비행기 모드) 그때만 캐시를 꺼낸다.
  e.respondWith(
    fetch(req)
      .then(res => stash(req, res))
      .catch(async () => {
        // respondWith 에 undefined 를 주면 FetchEvent 가 통째로 실패한다. 반드시 무언가를 돌려준다.
        const hit = (await caches.match(req)) || (await caches.match("/"));
        return hit || new Response("오프라인입니다.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      })
  );
});
