/* ════════════════════════════════════════════════════════════════
   /api/nai — NovelAI 이미지 생성 프록시 (Edge, SSE)

   NAI 는 danbooru 태그로 그린다. 자연어 → 태그 변환은 앱(보조 모델)이
   미리 해서 positive/negative 를 완성해 보낸다. 여기서는 그대로 넘긴다.

   NAI 응답은 zip(그 안에 png 한 장)이라, 풀어서 base64 로 돌려준다.
   /api/image 와 같은 SSE 수법 — 붙잡지 않고 경과 초만 흘린다.

     POST { positive, negative, model, steps, scale, sampler, width, height, seed }
       → data: {"t":8}          경과 초
       → data: {"b64":"..."}    완성 (png base64)
       → data: {"error":"..."}  실패
       → data: [DONE]

   ── 환경 변수 ────────────────────────────────────────────────
     NAI_TOKEN    NovelAI 영구 토큰 (pst-... 또는 Bearer 용)
     PROXY_KEY    (선택) /api/chat 과 같은 값
   ════════════════════════════════════════════════════════════════ */

export const config = { runtime: "edge" };

const API = "https://image.novelai.net/ai/generate-image";
const CAP = 3 * 60 * 1000;

const enc = new TextEncoder();
const sse = (c, o) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));

export default async function handler(req) {
  if (req.method !== "POST")
    return new Response(JSON.stringify({ error: "POST" }), { status: 405 });

  // PROXY_KEY 를 넣어 뒀으면 앱이 같은 값을 보내야 통과한다.
  // 넣지 않았으면 검사하지 않는다. (chat.js / image.js 와 같은 규칙)
  const KEY = process.env.PROXY_KEY;
  if (KEY) {
    const given = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (given !== KEY)
      return new Response(JSON.stringify({ error: "bad proxy key" }),
        { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const token = process.env.NAI_TOKEN;
  if (!token)
    return new Response(JSON.stringify({ error: "NAI_TOKEN 이 설정돼 있지 않습니다." }),
      { status: 500, headers: { "Content-Type": "application/json" } });

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const {
    positive = "", negative = "",
    model = "nai-diffusion-4-5-full",
    steps = 28, scale = 5, sampler = "k_euler_ancestral",
    width = 832, height = 1216, seed,
  } = body;

  const isV4 = /^nai-diffusion-4/.test(model);
  const finalSeed = seed ?? Math.floor(Math.random() * 4294967295);

  const params = {
    params_version: 3,
    width, height, scale,
    cfg_rescale: 0,
    sampler,
    noise_schedule: "karras",
    steps, n_samples: 1,
    seed: finalSeed,
    ucPreset: 0,
    qualityToggle: true,
    negative_prompt: negative,
  };

  if (isV4) {
    // v4/v4.5 는 이 구조가 없으면 500 을 뱉는다.
    params.v4_prompt = {
      caption: { base_caption: positive, char_captions: [] },
      use_coords: false,
      use_order: true,
    };
    params.v4_negative_prompt = {
      caption: { base_caption: negative, char_captions: [] },
      legacy_uc: false,
    };
  } else {
    params.sm = false;
    params.sm_dyn = false;
  }

  const payload = { input: positive, model, action: "generate", parameters: params };

  const stream = new ReadableStream({
    async start(c) {
      const t0 = Date.now();
      const beat = setInterval(() => sse(c, { t: Math.round((Date.now() - t0) / 1000) }), 1000);
      const done = (o) => { clearInterval(beat); if (o) sse(c, o); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); };

      const timer = setTimeout(() => done({ error: "시간이 너무 오래 걸립니다." }), CAP);

      try {
        const r = await fetch(API, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          },
          body: JSON.stringify(payload),
        });

        if (!r.ok) {
          const t = await r.text().catch(() => "");
          clearTimeout(timer);
          return done({ error: `NAI ${r.status}\n${t.slice(0, 200)}` });
        }

        // 응답은 zip. 그 안의 첫 파일(png)을 꺼낸다.
        const buf = new Uint8Array(await r.arrayBuffer());
        const png = await extractFirstFromZip(buf);
        clearTimeout(timer);
        if (!png || png.length < 100)
          return done({ error: `이미지를 풀지 못했습니다. (zip ${buf.length}B → png ${png?png.length:0}B, 시그니처 ${buf[0]?.toString(16)} ${buf[1]?.toString(16)})` });

        // 큰 바이너리를 String.fromCharCode 로 한 번에 넘기면 스택이 터진다. 청크로.
        let bin = "";
        const CH = 0x8000;
        for (let i = 0; i < png.length; i += CH)
          bin += String.fromCharCode.apply(null, png.subarray(i, i + CH));
        const b64 = "data:image/png;base64," + btoa(bin);
        done({ b64 });
      } catch (err) {
        clearTimeout(timer);
        done({ error: String((err && err.message) || err) });
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}

/* NAI 의 zip 에서 png 를 꺼낸다.
   NAI 는 streaming zip 이라 로컬 헤더의 압축 크기가 0 이다.
   진짜 크기는 끝의 중앙 디렉토리(Central Directory)에 있다. 거기서 읽는다. */
async function extractFirstFromZip(buf) {
  // 애초에 png 를 그대로 준 경우
  if (buf[0] === 0x89 && buf[1] === 0x50) return buf;
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return null;

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // EOCD(End Of Central Directory) 시그니처 0x06054b50 를 뒤에서 찾는다
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const cdOffset = dv.getUint32(eocd + 16, true);   // 중앙 디렉토리 시작 위치
  const cdCount  = dv.getUint16(eocd + 10, true);   // 엔트리 수

  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break; // 중앙 디렉토리 헤더 시그니처
    const method   = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen  = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commLen  = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));

    if (/\.png$/i.test(name) || cdCount === 1) {
      // 로컬 헤더에서 실제 데이터 시작점을 계산 (로컬 헤더의 name/extra 길이 사용)
      const lNameLen  = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const chunk = buf.slice(dataStart, dataStart + compSize);
      if (method === 0) return chunk;                 // 비압축
      if (method === 8) {                             // deflate
        try {
          const ds = new DecompressionStream("deflate-raw");
          const stream = new Response(chunk).body.pipeThrough(ds);
          return new Uint8Array(await new Response(stream).arrayBuffer());
        } catch { return null; }
      }
      return null;
    }
    p += 46 + nameLen + extraLen + commLen;
  }
  return null;
}
