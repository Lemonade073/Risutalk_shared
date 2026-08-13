/* ════════════════════════════════════════════════════════════════
   /api/chat — Vercel Edge Function

   앱과 같은 도메인에 있으므로 CORS 가 아예 없다.
   앱은 평생 OpenAI 호환 형식 하나만 말한다.
   뒤에 뭐가 붙어 있는지는 이 파일만 안다.

     POST /api/chat
       model: "gemma-3-27b-it"             → UPSTREAM (Cerebras 등)
       model: "gemti/gemini-3.6-flash"     → Antigravity (daily-cloudcode-pa)
       model: "gemti/gemini-3.5-flash-lite" → Antigravity (daily-cloudcode-pa)
       model: "vertex/gemini-2.5-flash"    → Vertex AI (서비스 계정, 선택)

   ── 환경 변수 (Vercel → Settings → Environment Variables) ──────
     UPSTREAM_URL        https://api.cerebras.ai/v1/chat/completions
     UPSTREAM_KEY        csk-...

     AGY_REFRESH_TOKEN   1//0g...           GemTi 쓸 때만
     AGY_PROJECT_ID      project-xxxx       선택. 비우면 자동 온보딩(느림)
     AGY_THINKING        low | medium | high    선택, 기본 low

     VERTEX_PROJECT_ID    my-project-123      Vertex 쓸 때만
     VERTEX_CLIENT_EMAIL  ...@....iam.gserviceaccount.com
     VERTEX_PRIVATE_KEY   -----BEGIN PRIVATE KEY-----\n...   (서비스 계정 JSON 의 private_key)
     VERTEX_LOCATION      us-central1         선택. 기본 us-central1

     PROXY_KEY           선택. 넣으면 앱의 "키" 칸에도 같은 값을 넣어야 한다.
                         배포 주소를 공개할 거면 반드시 넣어라.
   ════════════════════════════════════════════════════════════════ */

export const config = { runtime: "edge" };

const AGY_CLIENT_ID     = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const AGY_CLIENT_SECRET = "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";
const TOKEN_URL         = "https://oauth2.googleapis.com/token";
const AGY_BASE          = "https://daily-cloudcode-pa.googleapis.com";
const AGY_ENDPOINT      = AGY_BASE + "/v1internal";

/* 아는 모델은 여기에 적는다. 여기 없으면 아래 규칙으로 알아서 만든다.
   새 모델이 나와도 코드를 고칠 필요가 없게 하려는 것이다. */
const MODEL_MAP = {
  "gemini-3.7-flash":      "gemini-3.7-flash-tiered",
  "gemini-3.6-flash":      "gemini-3.6-flash-tiered",
  "gemini-3.5-flash-lite": "gemini-3.5-flash-lite",
  "gemini-3.5-flash":      "gemini-3.5-flash-low",
  "gemini-3.1-pro":        "gemini-3.1-pro-low",
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite",
  "gemini-3-flash":        "gemini-3-flash",
  "gemini-2.5-pro":        "gemini-2.5-pro",
  "claude-sonnet-4-6":     "claude-sonnet-4-6",
  "claude-opus-4-6":       "claude-opus-4-6-thinking",
  "gpt-oss-120b":          "gpt-oss-120b-medium",
};

/* gemini-3.7-flash → 3.7 처럼 판올림 번호만 뽑는다. gemini 가 아니면 null. */
function geminiVer(m) {
  const x = /^gemini-(\d+)(?:\.(\d+))?/.exec(m);
  return x ? Number(x[1]) + Number(x[2] || 0) / 10 : null;
}

/* 이미 등급이 붙어 있으면(-tiered, -low …) 손대지 않는다.
   모르는 모델을 억지로 돌려보고 싶을 때 쓰는 탈출구다. */
const HAS_TIER = /-(tiered|low|medium|high|minimal|thinking)$/;

function realModel(m) {
  if (MODEL_MAP[m]) return MODEL_MAP[m];
  if (HAS_TIER.test(m)) return m;              // 사용자가 직접 붙였다
  const v = geminiVer(m);
  if (v !== null && v >= 3.6) return m + "-tiered";   // 요즘 규칙
  return m;
}

/* 3.x 계열과 2.5-pro 는 thinking 을 받는다. */
function wantsThinking(m) {
  const v = geminiVer(m);
  return v !== null && v >= 2.5;
}

/* 2026-07-21 이후(3.6~) 모델은 sampling 파라미터와
   마지막 model 역할 prefill 을 허용하지 않는다. */
function isStrictTurn(m) {
  const v = geminiVer(m);
  return v !== null && v >= 3.6;
}

/* 함수 인스턴스가 살아있는 동안만 유지되는 캐시. 죽으면 다시 받으면 그만. */
let tokCache = { tok: null, exp: 0 };
let pidCache = null;

const rid  = () => Math.random().toString(36).slice(2, 9);
const wait = ms => new Promise(r => setTimeout(r, ms));
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const KEY = process.env.PROXY_KEY;
  if (KEY) {
    const given = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (given !== KEY) return json({ error: "bad proxy key" }, 401);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "invalid json" }, 400); }

  const model = String(body.model || "");
  try {
    if (model.startsWith("gemti/"))  return await gemti(body, model.slice(6));
    if (model.startsWith("vertex/")) return await vertex(body, model.slice(7));
    return await passthrough(body);
  } catch (err) {
    return json({ error: String((err && err.message) || err) }, 502);
  }
}

/* ── 1. 그냥 중계 — Cerebras / OpenRouter / 아무 OpenAI 호환 ── */
async function passthrough(body) {
  const url = process.env.UPSTREAM_URL;
  if (!url) throw new Error("UPSTREAM_URL 이 설정돼 있지 않습니다.");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + (process.env.UPSTREAM_KEY || ""),
      // Cloudflare WAF 가 스크립트성 요청을 403 으로 막는다.
      // realtalk/1.0 같은 이름은 딱 봇처럼 보인다. 정상 브라우저/SDK 헤더를 흉내낸다.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept": "text/event-stream",
      "Accept-Language": "en-US,en;q=0.9",
      "Origin": "https://cloud.cerebras.ai",
      "Referer": "https://cloud.cerebras.ai/",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return json({ error: `업스트림 ${res.status}\n${t.slice(0, 500)}` }, 502);
  }
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") || "application/json",
      "Cache-Control": "no-cache",
    },
  });
}

/* ── 2. GemTi — Antigravity. 플러그인 로직 그대로 옮김. ── */
function agyHeaders(tok) {
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + tok,
    "User-Agent": "antigravity/0.1.0 (browser)",
    "x-activity-request-id": rid(),
    "X-Goog-Api-Client": "gl-node/22.17.0",
    "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
  };
}

async function accessToken() {
  if (tokCache.tok && Date.now() < tokCache.exp - 60_000) return tokCache.tok;
  const rt = (process.env.AGY_REFRESH_TOKEN || "").trim();
  if (!rt) throw new Error("AGY_REFRESH_TOKEN 이 없습니다.");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: AGY_CLIENT_ID,
      client_secret: AGY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error("토큰 갱신 실패 (" + res.status + "): " + (await res.text()));
  const p = await res.json();
  tokCache = { tok: p.access_token, exp: Date.now() + (p.expires_in ?? 3600) * 1000 };
  return tokCache.tok;
}

const pickPid = d => {
  const v = d && d.cloudaicompanionProject;
  if (!v) return null;
  return typeof v === "string" ? (v || null) : (v.id || null);
};

async function projectId(tok) {
  if (process.env.AGY_PROJECT_ID) return process.env.AGY_PROJECT_ID;
  if (pidCache) return pidCache;

  const meta = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
  const load = await fetch(AGY_ENDPOINT + ":loadCodeAssist", {
    method: "POST", headers: agyHeaders(tok), body: JSON.stringify({ metadata: meta }),
  });
  if (!load.ok) throw new Error("loadCodeAssist 실패 (" + load.status + "): " + (await load.text()));
  const d = await load.json();
  let pid = pickPid(d);

  if (!pid) {
    const tiers = d.allowedTiers ?? [];
    const tier = tiers.find(t => t.id === "free-tier") ?? tiers.find(t => t.isDefault) ?? tiers[0];
    if (!tier) throw new Error("온보딩 불가: 이 계정은 사용할 수 없습니다.");
    const on = await fetch(AGY_ENDPOINT + ":onboardUser", {
      method: "POST", headers: agyHeaders(tok),
      body: JSON.stringify({ tierId: tier.id ?? "legacy-tier", metadata: meta }),
    });
    if (!on.ok) throw new Error("onboardUser 실패 (" + on.status + "): " + (await on.text()));
    let op = await on.json();
    // 첫 온보딩은 최대 50초. Edge 함수 시간 제한에 걸리면
    // AGY_PROJECT_ID 를 환경 변수에 직접 넣어라.
    for (let i = 0; i < 8 && !op.done && op.name; i++) {
      await wait(4000);
      const pr = await fetch(AGY_BASE + "/" + op.name, { headers: agyHeaders(tok) });
      if (!pr.ok) break;
      op = await pr.json();
    }
    const cp = op?.response?.cloudaicompanionProject;
    pid = cp?.id ?? (typeof cp === "string" ? cp : null);
  }
  if (!pid) throw new Error("프로젝트 ID 자동 감지 실패. AGY_PROJECT_ID 를 직접 넣으세요.");
  pidCache = pid;
  return pid;
}

function toParts(content) {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [{ text: String(content ?? "") }];
  return content.flatMap(b => {
    if (b.type === "text" && b.text) return [{ text: b.text }];
    if (b.type === "image_url" && b.image_url?.url?.startsWith("data:")) {
      const [h, d] = b.image_url.url.split(",");
      return [{ inlineData: { mimeType: h.replace("data:", "").replace(";base64", ""), data: d } }];
    }
    return [];
  });
}

/* 분산 전송: 시스템 메시지를 user/model 핑퐁으로 앞에 심는다.
   GemTi 에서 출력이 더 안정적이던 그 모드. 기본 ON. */
function convert(messages, spread = true) {
  let sys; const raw = []; const queue = [];
  for (const m of messages) {
    if (m.role === "system") {
      const t = typeof m.content === "string" ? m.content : (m.content?.[0]?.text ?? "");
      if (!t) continue;
      if (spread) queue.push(t);
      else if (!sys) sys = { parts: [{ text: t }] };
      else sys.parts[0].text += "\n\n" + t;
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const parts = toParts(m.content);
    if (!parts.length) continue;
    const last = raw[raw.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else raw.push({ role, parts });
  }
  if (spread && queue.length) {
    sys = { parts: [{ text: queue[0] }] };
    const inject = [];
    for (let i = 1; i < queue.length; i++) {
      inject.push({ role: "user",  parts: [{ text: queue[i] }] });
      inject.push({ role: "model", parts: [{ text: "알겠습니다." }] });
    }
    raw.unshift(...inject);
  }
  return { contents: raw, systemInstruction: sys };
}

async function gemti(body, model) {
  // Edge 함수는 첫 응답 바이트를 25초 안에 내보내야 한다.
  // generateContent 는 스트리밍이 아니라 다 만들고 한 번에 뱉으므로,
  // 기다렸다가 응답하면 큰 프롬프트에서 타임아웃이 난다.
  // 그래서 SSE 를 먼저 열고, 그 안에서 호출한다.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      const send = o => c.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n"));
      const frame = delta => send({
        id: "chatcmpl-" + rid(), object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, delta, finish_reason: null }],
      });

      // 연결을 즉시 살려둔다. SSE 주석은 클라이언트가 무시한다.
      c.enqueue(enc.encode(": keepalive\n\n"));
      const beat = setInterval(() => {
        try { c.enqueue(enc.encode(": keepalive\n\n")); } catch {}
      }, 8000);

      try {
        const tok = await accessToken();
        const pid = await projectId(tok);
        const { contents, systemInstruction } = convert(body.messages || []);

        const gc = {};
        if (body.temperature != null && !isStrictTurn(model)) gc.temperature = body.temperature;
        if (body.max_tokens  != null) gc.maxOutputTokens = body.max_tokens;
        if (wantsThinking(model)) gc.thinkingConfig = { thinkingLevel: process.env.AGY_THINKING || "low" };

        const real = realModel(model);
        // Claude와 최신 Gemini는 요청이 model 역할로 끝나는 prefill을 허용하지 않는다.
        if (real.startsWith("claude") || isStrictTurn(model)) {
          while (contents.length && contents[contents.length - 1].role !== "user") contents.pop();
        }

        const request = { contents };
        if (systemInstruction) request.systemInstruction = systemInstruction;
        if (Object.keys(gc).length) request.generationConfig = gc;

        const res = await fetch(AGY_ENDPOINT + ":generateContent", {
          method: "POST",
          headers: agyHeaders(tok),
          body: JSON.stringify({ project: pid, model: real, user_prompt_id: rid() + rid(), request }),
        });

        if (!res.ok) {
          const t = await res.text();
          throw new Error(res.status === 429
            ? "AGY 쿼터 소진 (429). 5시간 후 리셋.\n" + t.slice(0, 300)
            : "AGY 오류 (" + res.status + ")\n" + t.slice(0, 300));
        }

        const data  = await res.json();
        const inner = data?.response ?? data;
        const parts = inner?.candidates?.[0]?.content?.parts ?? [];
        const text  = parts.filter(p => p.text !== undefined && !p.thought).map(p => p.text).join("");
        if (!text.trim()) throw new Error("빈 응답 (안전 필터 또는 모델 오류)");

        clearInterval(beat);
        frame({ role: "assistant" });
        for (const ch of (text.match(/[\s\S]{1,24}/g) || [text])) { frame({ content: ch }); await wait(12); }
        c.enqueue(enc.encode("data: [DONE]\n\n"));
      } catch (err) {
        clearInterval(beat);
        // 오류를 대사로 실어 보내면 파서가 그걸 캐릭터의 말로 읽는다.
        // 텍스트가 아니라 신호로 보낸다.
        send({ error: String((err && err.message) || err) });
        c.enqueue(enc.encode("data: [DONE]\n\n"));
      }
      c.close();
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

/* ── 3. Vertex AI — 서비스 계정 ──
   이메일 + private key 로 JWT 를 만들어 서명하고, 그걸 access token 으로 바꿔서 부른다.
   Gemini 와 요청 형식이 같으므로 convert() 를 그대로 쓴다.
   응답은 진짜 스트리밍이라 받는 대로 흘려보낸다. */

let vtokCache = { tok: null, exp: 0 };

const b64url    = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = str => btoa(unescape(encodeURIComponent(str)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/* PEM 을 DER 로.
   붙여넣기 실수가 잦은 값이라 관대하게 받는다.
   - 줄바꿈이 \n 문자로 들어온 경우
   - JSON 의 따옴표가 같이 딸려온 경우
   - 줄바꿈을 다 지우고 한 줄로 붙인 경우 */
function pemToDer(pem) {
  let t = String(pem).replace(/\\n/g, "\n").trim();
  t = t.replace(/^["'`]+/, "").replace(/["'`]+$/, "");     // 감싼 따옴표
  t = t.replace(/-{2,}\s*BEGIN[^-]*-{2,}/i, "")            // 머리말
       .replace(/-{2,}\s*END[^-]*-{2,}/i, "");             // 꼬리말
  const body = t.replace(/[^A-Za-z0-9+/=]/g, "");          // base64 글자만 남긴다
  if (body.length < 100) throw new Error("short");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function vertexToken() {
  if (vtokCache.tok && Date.now() < vtokCache.exp - 60_000) return vtokCache.tok;

  const email = (process.env.VERTEX_CLIENT_EMAIL || "").trim();
  const pem   = process.env.VERTEX_PRIVATE_KEY || "";
  if (!email) throw new Error("VERTEX_CLIENT_EMAIL 이 없습니다.");
  if (!pem)   throw new Error("VERTEX_PRIVATE_KEY 가 없습니다.");

  const now = Math.floor(Date.now() / 1000);
  const head = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const data = b64urlStr(JSON.stringify(head)) + "." + b64urlStr(JSON.stringify(claim));

  let key;
  try {
    key = await crypto.subtle.importKey("pkcs8", pemToDer(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    const raw = String(pem);
    const hint = [
      `길이 ${raw.length}자`,
      /BEGIN/i.test(raw) ? "BEGIN 있음" : "BEGIN 없음",
      /END/i.test(raw)   ? "END 있음"   : "END 없음",
    ].join(" · ");
    throw new Error(
      "VERTEX_PRIVATE_KEY 를 읽지 못했습니다.\n" +
      "서비스 계정 JSON 의 private_key 값을 -----BEGIN 부터 -----END PRIVATE KEY----- 까지 넣으세요.\n" +
      `(지금 들어온 값: ${hint})`);
  }
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  const jwt = data + "." + b64url(sig);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Vertex 토큰 발급 실패 (${res.status})\n${t.slice(0, 300)}`);
  }
  const p = await res.json();
  vtokCache = { tok: p.access_token, exp: Date.now() + (p.expires_in ?? 3600) * 1000 };
  return vtokCache.tok;
}

async function vertex(body, model) {
  const project = (process.env.VERTEX_PROJECT_ID || "").trim();
  if (!project) throw new Error("VERTEX_PROJECT_ID 가 없습니다.");
  const loc = (process.env.VERTEX_LOCATION || "us-central1").trim();

  // gemti 와 같은 수법. Edge 는 25초 안에 첫 바이트를 내보내야 한다.
  // 토큰 발급 + 연결이 앞에 붙으므로, SSE 를 먼저 열어 두고 그 안에서 부른다.
  const enc = new TextEncoder(), dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(c) {
      const send = o => { try { c.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n")); } catch {} };
      const frame = delta => send({
        id: "chatcmpl-" + rid(), object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, delta, finish_reason: null }],
      });

      // 연결을 즉시 살려 둔다. SSE 주석은 클라이언트가 무시한다.
      c.enqueue(enc.encode(": keepalive\n\n"));
      const beat = setInterval(() => {
        try { c.enqueue(enc.encode(": keepalive\n\n")); } catch {}
      }, 8000);

      try {
        const tok = await vertexToken();
        const { contents, systemInstruction } = convert(body.messages || []);

        const gc = {};
        if (body.temperature != null) gc.temperature = body.temperature;
        if (body.max_tokens  != null) gc.maxOutputTokens = body.max_tokens;

        const request = { contents };
        if (systemInstruction) request.systemInstruction = systemInstruction;
        if (Object.keys(gc).length) request.generationConfig = gc;

        const host = loc === "global" ? "aiplatform.googleapis.com" : `${loc}-aiplatform.googleapis.com`;
        const url = `https://${host}/v1/projects/${project}/locations/${loc}`
                  + `/publishers/google/models/${model}:streamGenerateContent?alt=sse`;

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
          body: JSON.stringify(request),
        });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(`Vertex 오류 (${res.status})\n${t.slice(0, 400)}`);
        }

        clearInterval(beat);
        frame({ role: "assistant" });

        // Gemini SSE → OpenAI SSE 로 갈아입힌다. 앱은 OpenAI 형식만 안다.
        const reader = res.body.getReader();
        let buf = "", any = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n");
          buf = parts.pop();
          for (const line of parts) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let j; try { j = JSON.parse(payload); } catch { continue; }
            const text = (j?.candidates?.[0]?.content?.parts || [])
              .filter(p => p.text !== undefined && !p.thought)
              .map(p => p.text).join("");
            if (text) { any = true; frame({ content: text }); }
          }
        }
        if (!any) send({ error: "빈 응답 (안전 필터 또는 모델 오류)" });
      } catch (err) {
        clearInterval(beat);
        // 오류를 대사로 실어 보내면 파서가 그걸 캐릭터의 말로 읽는다. 신호로 보낸다.
        send({ error: String((err && err.message) || err) });
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
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
