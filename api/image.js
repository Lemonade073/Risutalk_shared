/* ════════════════════════════════════════════════════════════════
   /api/image — Vercel Edge Function (SSE)

   gpt-image 는 60초를 넘기는 일이 잦다. Vercel Hobby 의 함수 실행
   상한은 60초라 늘릴 방법이 없다 — 그래서 붙잡고 기다리지 않는다.

   SSE 를 즉시 열어 첫 바이트를 내보내고, 연결을 살려둔 채
   뒤에서 OpenAI 를 기다린다. /api/chat 에서 검증된 수법이다.

     POST { prompt, refs: [dataURL...], size, quality }
       → data: {"t":12}          경과 초. 말풍선에 표시된다.
       → data: {"b64":"..."}     완성
       → data: {"error":"..."}   실패
       → data: [DONE]

   참조가 있으면 /v1/images/edits (multipart), 없으면 /generations (JSON).
   1인칭 사진은 참조를 보내지 않으므로 대부분 generations 로 간다.

   ── 환경 변수 ────────────────────────────────────────────────
     OPENAI_KEY    sk-...
     PROXY_KEY     (선택) /api/chat 과 같은 값
   ════════════════════════════════════════════════════════════════ */

export const config = { runtime: "edge" };

const GEN  = "https://api.openai.com/v1/images/generations";
const EDIT = "https://api.openai.com/v1/images/edits";
const CAP  = 8 * 60 * 1000;          // 8분. 이걸 넘으면 뭔가 잘못된 것이다.

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

function dataURLtoBlob(u) {
  const [head, b64] = String(u).split(",");
  const mime = (head.match(/data:([^;]+)/) || [, "image/png"])[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const KEY = process.env.PROXY_KEY;
  if (KEY) {
    const given = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (given !== KEY) return json({ error: "bad proxy key" }, 401);
  }

  const sk = process.env.OPENAI_KEY;
  if (!sk) return json({ error: "OPENAI_KEY 가 설정돼 있지 않습니다." }, 500);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "invalid json" }, 400); }

  const prompt = String(body.prompt || "").trim();
  if (!prompt) return json({ error: "prompt 가 비어 있습니다." }, 400);

  const model   = body.model   || "gpt-image-2";
  const size    = body.size    || "1024x1024";
  const quality = body.quality || "medium";
  const refs    = (body.refs || []).filter(Boolean).slice(0, 3);

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      const send = o => { try { c.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n")); } catch {} };
      const t0 = Date.now();

      // 첫 바이트를 즉시 내보내야 함수가 죽지 않는다.
      c.enqueue(enc.encode(": open\n\n"));
      const beat = setInterval(() => {
        try {
          c.enqueue(enc.encode(": ping\n\n"));
          send({ t: Math.round((Date.now() - t0) / 1000) });
        } catch {}
      }, 3000);

      const ac = new AbortController();
      const bail = setTimeout(() => ac.abort(), CAP);

      try {
        let res;
        if (refs.length) {
          // 리수 플러그인은 nativeFetch 가 FormData 를 직렬화하지 못해
          // multipart 를 손으로 조립해야 했다. 서버에서는 그냥 쓰면 된다.
          const fd = new FormData();
          fd.append("model", model);
          fd.append("prompt", prompt);
          fd.append("n", "1");
          fd.append("size", size);
          fd.append("quality", quality);
          refs.forEach((r, i) => {
            const b = dataURLtoBlob(r);
            const ext = (b.type.split("/")[1] || "png").toLowerCase();
            fd.append("image[]", b, `ref_${i + 1}.${ext}`);
          });
          res = await fetch(EDIT, {
            method: "POST",
            headers: { Authorization: "Bearer " + sk },
            body: fd,
            signal: ac.signal,
          });
        } else {
          res = await fetch(GEN, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + sk },
            body: JSON.stringify({ model, prompt, n: 1, size, quality }),
            signal: ac.signal,
          });
        }

        const text = await res.text();
        if (!res.ok) {
          // OpenAI 가 아니라 앞단 게이트웨이가 plain text 로 뱉는 경우가 있다
          let msg = text.slice(0, 400);
          try { msg = JSON.parse(text)?.error?.message || msg; } catch {}
          throw new Error(`이미지 생성 실패 (${res.status})\n${msg}`);
        }

        const data = JSON.parse(text);
        const b64 = data?.data?.[0]?.b64_json;
        if (!b64) throw new Error("이미지가 오지 않았습니다.");

        clearInterval(beat);
        send({ b64, t: Math.round((Date.now() - t0) / 1000) });
      } catch (err) {
        clearInterval(beat);
        send({ error: err?.name === "AbortError"
          ? "8분이 지나도 오지 않아 끊었습니다."
          : String((err && err.message) || err) });
      } finally {
        clearTimeout(bail);
        try { c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
