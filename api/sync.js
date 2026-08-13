/* ════════════════════════════════════════════════════════════════
   /api/sync — Vercel Blob (REST API 직접 호출)

   @vercel/blob SDK 는 undici / node:stream 을 끌고 와서 Edge 에서 못 돈다.
   배포가 통째로 깨진다. Blob 은 그냥 REST 라 fetch 로 부르면 된다.
   의존성 0. package.json 도 필요 없다.

     GET  /api/sync?code=xxx               → { data, savedAt, meta } | { empty:true }
     POST /api/sync  { code, data, meta }  → { savedAt }

   code 가 곧 열쇠다. 해시해서 파일 이름으로 쓰므로 남의 것은 보이지 않는다.
   동시에 두 기기를 쓰지 않는다는 전제다. 마지막에 올린 쪽이 이긴다.

   ── 환경 변수 ────────────────────────────────────────────────
     BLOB_READ_WRITE_TOKEN   Vercel → Storage → Blob 을 만들면 자동으로 꽂힌다
   ════════════════════════════════════════════════════════════════ */

export const config = { runtime: "edge" };

const API = "https://blob.vercel-storage.com";

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/* 코드를 그대로 파일 이름에 쓰면 목록에서 남의 코드가 보인다. 해시해서 쓴다. */
async function keyOf(code) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("realtalk:" + code));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `sync/${hex.slice(0, 32)}.json`;
}

/* ── 스토어가 공개(public)인지 비공개(private)인지 코드가 모른다.
   헤더를 틀리게 보내면 400 이 난다. 한 번 해보고 틀리면 반대로 다시 건다.
   알아낸 값은 기억해 두었다가 다음부터 바로 쓴다.
   (헤더 이름은 x-vercel-blob-access 다. 옛 이름 x-access 는 서버가 무시한다.) */
let ACCESS = null;                       // 'private' | 'public' | null(아직 모름)

async function putBlob(pathname, body, auth, extra) {
  // v12 는 경로를 URL 뒤에 붙이지 않고 ?pathname= 로 받는다
  const url = `${API}/?pathname=${encodeURIComponent(pathname)}`;
  const send = (acc) =>
    fetch(url, {
      method: "PUT",
      headers: { ...auth, "x-vercel-blob-access": acc, ...extra },
      body,
    });

  const first = ACCESS || "private";
  let r = await send(first);
  if (r.ok) { ACCESS = first; return r; }

  // 400 이고 access 가 어긋났다는 말이면 반대로 한 번 더
  if (r.status === 400) {
    const t = await r.clone().text().catch(() => "");
    if (/public access on a private store|private access on a public store|access/i.test(t)) {
      const other = first === "private" ? "public" : "private";
      const r2 = await send(other);
      if (r2.ok) { ACCESS = other; return r2; }
      return r2;
    }
  }
  return r;
}

export default async function handler(req) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token)
    return json({ error: "Blob 저장소가 연결돼 있지 않습니다.\nVercel → Storage → Create → Blob" }, 500);

  const auth = { authorization: `Bearer ${token}`, "x-api-version": "12" };

  try {
    /* ── 받기 ── */
    if (req.method === "GET") {
      const u = new URL(req.url);
      const code = (u.searchParams.get("code") || "").trim();
      if (code.length < 8) return json({ error: "동기화 코드는 8자 이상이어야 합니다." }, 400);

      // ?imglist=1 → 올라온 사진 키 목록,  ?img=키 → 그 사진 한 장
      const wantList = u.searchParams.get("imglist");
      const wantImg  = (u.searchParams.get("img") || "").trim();
      if (wantList || wantImg) {
        const base = await keyOf(code);
        const dir  = base.replace(/\.json$/, "") + "/img/";
        if (wantImg) {
          const l = await fetch(`${API}?prefix=${encodeURIComponent(dir + wantImg)}&limit=1`, { headers: auth });
          const { blobs = [] } = await l.json();
          if (!blobs.length) return json({ empty: true });
          const r = await fetch(blobs[0].downloadUrl || blobs[0].url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
          return new Response(await r.text(), { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
        }
        const l = await fetch(`${API}?prefix=${encodeURIComponent(dir)}&limit=1000`, { headers: auth });
        const { blobs = [] } = await l.json();
        const keys = blobs.map(b => b.pathname.split("/img/")[1]).filter(Boolean);
        return json({ keys });
      }

      const key = await keyOf(code);

      // 파일의 진짜 주소는 스토어마다 달라서 목록으로 찾아야 한다
      const l = await fetch(`${API}?prefix=${encodeURIComponent(key)}&limit=1`, { headers: auth });
      if (!l.ok) {
        const t = await l.text();
        return json({ error: `저장소를 읽지 못했습니다 (${l.status})\n${t.slice(0, 200)}` }, 502);
      }
      const { blobs = [] } = await l.json();
      if (!blobs.length) return json({ empty: true });

      // 비공개 스토어의 파일은 주소만으로 못 읽는다. 토큰을 함께 보낸다.
      const r = await fetch(blobs[0].downloadUrl || blobs[0].url, {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!r.ok) {
        const t = await r.text();
        return json({ error: `받아오지 못했습니다 (${r.status})\n${t.slice(0, 200)}` }, 502);
      }
      return json(await r.json());
    }

    /* ── 올리기 ── */
    if (req.method === "POST") {
      const { code, data, meta } = await req.json();
      const c = String(code || "").trim();
      if (c.length < 8) return json({ error: "동기화 코드는 8자 이상이어야 합니다." }, 400);
      if (!data) return json({ error: "보낼 데이터가 없습니다." }, 400);

      const savedAt = Date.now();
      const key = await keyOf(c);

      const put = await putBlob(
        key,
        JSON.stringify({ savedAt, meta: meta || {}, data }),
        auth,
        {
          "x-content-type": "application/json",
          "x-add-random-suffix": "0",     // 같은 이름을 덮어쓴다
          "x-allow-overwrite": "1",
          "x-cache-control-max-age": "0",
        },
      );

      if (!put.ok) {
        const t = await put.text();
        return json({ error: `올리지 못했습니다 (${put.status})\n${t.slice(0, 200)}` }, 502);
      }
      return json({ savedAt });
    }

    /* ── 사진 한 장 (개별) ── PUT /api/sync?img=키&code=코드 ──
       DB 와 함께 통째로 올리면 4.5MB 함수 한계(413)에 부딪힌다.
       사진은 한 장씩 따로 올린다. */
    if (req.method === "PUT") {
      const u = new URL(req.url);
      const code = (u.searchParams.get("code") || "").trim();
      const imgKey = (u.searchParams.get("img") || "").trim();
      if (code.length < 8) return json({ error: "코드가 짧습니다." }, 400);
      if (!imgKey) return json({ error: "이미지 키가 없습니다." }, 400);

      const base = await keyOf(code);                       // sync/{해시}.json
      const dir  = base.replace(/\.json$/, "");             // sync/{해시}
      const body = await req.text();

      const put = await putBlob(
        `${dir}/img/${imgKey}`,
        body,
        auth,
        {
          "x-content-type": "text/plain",
          "x-add-random-suffix": "0",
          "x-allow-overwrite": "1",
        },
      );
      if (!put.ok) return json({ error: `사진 올리기 실패 (${put.status})` }, 502);
      return json({ ok: true });
    }

    return json({ error: "GET, POST, PUT" }, 405);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 502);
  }
}
