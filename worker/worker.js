/**
 * Cloudflare Worker: Virtual Photo Evaluation with Dropbox Knowledge Base
 *
 * Bindings expected in wrangler.toml:
 *   AI                  -> Workers AI binding (name: AI)
 *   PHOTOS_BUCKET       -> Optional R2 bucket for original uploads
 *   MODEL (var)         -> Optional default model override
 *   HEADER_URL (var)    -> Public Dropbox share URL for UI header banner
 *   JSON_TOKEN (var)    -> Optional secret required for ?format=json
 *   DROPBOX_TOKEN (var) -> Dropbox API token for storing uploads & reading KB
 *   DROPBOX_UPLOAD_PATH (var) -> Dropbox folder for uploaded photos (default: /Apps/AI-Inspector)
 *   KNOWLEDGE_SOURCES (var) -> JSON array of Dropbox paths or share URLs with reference docs
 */

const META_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const FALLBACK_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const DEFAULT_MODEL = META_MODEL;

/* ---------- Security / CORS ---------- */
const ALLOWED_ORIGINS = ["https://homehealthinspections.com", "http://localhost:8787"];
function withSecurityHeaders(res, origin = "*") {
  const h = new Headers(res.headers);
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "no-referrer");
  h.set("x-robots-tag", "noindex, nofollow");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  h.set(
    "content-security-policy",
    "default-src 'none'; img-src 'self' blob: data: https:; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; font-src data: https:"
  );
  h.set("cross-origin-opener-policy", "same-origin");
  h.set("access-control-allow-origin", origin);
  h.set("access-control-allow-methods", "GET,POST,OPTIONS");
  h.set("access-control-allow-headers", "content-type, accept");
  return new Response(res.body, { status: res.status, headers: h });
}
function corsOrigin(url, req) {
  const reqOrigin = req.headers.get("origin") || "";
  return ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : "https://homehealthinspections.com";
}
function corsPreflight(req) {
  if (req.method === "OPTIONS") {
    return withSecurityHeaders(new Response(null, { status: 204 }), corsOrigin(new URL(req.url), req));
  }
  return null;
}

/* ---------- Header URL normalizer (Dropbox share -> direct image) ---------- */
function normalizeHeaderUrl(u) {
  try {
    const url = new URL(u);
    if (url.hostname.includes("dropbox.com")) {
      url.searchParams.set("dl", "1");
      url.searchParams.delete("raw");
      url.searchParams.delete("st");
      return url.toString();
    }
    return u;
  } catch {
    return u || "";
  }
}

/* ---------- UI (renders human summary) ---------- */
function renderPage(env) {
  const headerUrl = normalizeHeaderUrl(
    env.HEADER_URL ||
      "https://www.dropbox.com/scl/fi/aewpmmuyzbdnholcuppx4/aiinspectorimage.gif?rlkey=iuoi1l4dm34qn2gml2ij8fcnq&dl=1"
  );
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Virtual Photo Evaluation</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:20px;line-height:1.35}
header{margin-bottom:14px}
.header-banner{display:block;height:auto;max-width:180px;width:100%;margin:0 auto 10px auto;border-radius:10px;border:1px solid #ddd}
.card{border:1px solid #ddd;border-radius:10px;padding:16px;max-width:980px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.row-3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
label{font-weight:600;font-size:14px}
input[type="text"],input[type="number"],textarea{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:14px}
input[type="file"]{font-size:14px}
textarea{min-height:90px}
.actions{margin-top:14px;display:flex;gap:10px}
button{padding:10px 14px;border-radius:8px;border:1px solid #222;background:#222;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#222}
#result{white-space:pre-wrap;background:#f9fafb;padding:12px;border-radius:8px;border:1px solid #e5e7eb;overflow:auto;max-height:560px}
.preview-wrap{position:relative;display:inline-block}
.preview{margin-top:10px;max-width:420px;border-radius:8px;border:1px solid #ddd;display:block}
.badge{position:absolute;top:8px;left:8px;background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;border-radius:999px;padding:4px 10px;font-weight:700;font-size:13px;display:none}
.hint{color:#666;font-size:13px}
.small{color:#666;font-size:12px}
.analyzing{font-weight:700;font-size:18px;color:#1d4ed8}
</style></head><body>
<header>
  ${headerUrl ? `<img class="header-banner" src="${headerUrl}" alt="Header">` : ""}
  <h2>Virtual Photo Evaluation</h2>
  <div class="hint">Upload one photo and optional context. The result below is a user-friendly summary.</div>
</header>

<div class="card">
  <div class="row">
    <div>
      <label for="image">Photo</label><br>
      <input id="image" type="file" accept="image/*" />
      <div class="preview-wrap">
        <img id="preview" class="preview" hidden />
        <span id="anBadge" class="badge">Analyzing...</span>
      </div>
      <div class="small" id="imgMsg"></div>
    </div>
    <div>
      <div class="row-3">
        <div><label for="area">Area</label><input id="area" type="text" placeholder="bathroom, kitchen, exterior"></div>
        <div><label for="bedrooms">Bedrooms</label><input id="bedrooms" type="number" min="0" step="1" placeholder="e.g., 3"></div>
        <div style="display:flex;align-items:end;gap:8px;"><input id="mh" type="checkbox"><label for="mh" style="font-weight:500;">Manufactured home</label></div>
      </div>
      <div style="margin-top:10px;"><label for="notes">Notes</label><textarea id="notes" placeholder="context or concerns to consider"></textarea></div>
    </div>
  </div>

  <div class="actions">
    <button id="run">Evaluate</button>
    <button id="clear" class="secondary">Clear</button>
  </div>

  <div style="margin-top:14px;">
    <label>Result</label>
    <div id="result">—</div>
  </div>
</div>

<script>
const imgInput=document.getElementById('image');
const preview=document.getElementById('preview');
const anBadge=document.getElementById('anBadge');
const resultEl=document.getElementById('result');
const imgMsg=document.getElementById('imgMsg');

imgInput.addEventListener('change',()=>{
  const f=imgInput.files && imgInput.files[0];
  if(!f){preview.hidden=true;preview.src="";anBadge.style.display="none";imgMsg.textContent="";return;}
  const url=URL.createObjectURL(f);
  preview.src=url;preview.hidden=false;imgMsg.textContent=f.name;
  if (/\\bimage\\/hei(c|f)\\b/i.test(f.type)) {
    imgMsg.textContent += " — preview may not display in this browser, but the file will still be analyzed.";
  }
});

document.getElementById('clear').addEventListener('click',()=>{
  document.getElementById('area').value="";
  document.getElementById('bedrooms').value="";
  document.getElementById('mh').checked=false;
  document.getElementById('notes').value="";
  resultEl.textContent="—";
  if (imgInput) imgInput.value="";
  preview.hidden=true;preview.src="";imgMsg.textContent="";
  anBadge.style.display="none";
});

document.getElementById('run').addEventListener('click',async()=>{
  const file=imgInput.files && imgInput.files[0];
  if(!file){resultEl.textContent="Select a photo first.";return;}

  const meta={
    area:document.getElementById('area').value||undefined,
    bedrooms:document.getElementById('bedrooms').value?Number(document.getElementById('bedrooms').value):undefined,
    manufacturedHome:document.getElementById('mh').checked||undefined,
    notes:document.getElementById('notes').value||undefined
  };
  const fd=new FormData();fd.append('image',file,file.name);fd.append('meta',JSON.stringify(meta));

  anBadge.style.display="inline-block";
  resultEl.innerHTML="<span class='analyzing'>Analyzing...</span>";

  try{
    const res=await fetch('/evaluate?format=human',{method:'POST',body:fd,headers:{'accept':'text/plain'}});
    const txt=await res.text();
    resultEl.textContent=txt;
  }catch(e){
    resultEl.textContent=String(e);
  }finally{
    anBadge.style.display="none";
  }
});
</script>
</body></html>`;
}

/* ---------- System rules ---------- */
const TEXT_SYSTEM = `
You perform a Washington State–context VIRTUAL PHOTO EVALUATION (not an inspection).
Be direct and concise. Do not cite codes unless asked.

Always apply:
- Bathroom photos: include exhaust-fan paper test reminder.
- IAQ thresholds when legible:
  PM2.5 >12 caution, >35 unhealthy; CO2 >1000 elevated, >1500 poor;
  HCHO >0.10 mg/m3 caution, >0.30 high; TVOC >0.30 mg/m3 caution, >1.0 high;
  Humidity outside 40–60% note; >65% mold risk.
- Water-heater sizing (WA heuristic): occupants ~ bedrooms + 1.
  Storage: 1–2BR <40gal; 3BR <50; 4BR <60; 5+BR <80.
  Tankless: 1–2BR <4 GPM @ ~70F rise; 3BR <6; 4+BR <8. Note all-electric slow recovery; caution for soaking tubs/frequent simultaneous showers.
- Manufactured homes when indicated: remind about skirting/treatment stamp and HUD pre-1976 vs post-1976 awareness.

Output valid JSON with:
- id, area, model
- findings[] where each finding includes: label, severity (info|note|caution|alert), detail,
  confidenceBase (0–100 integer self-rating), evidence[] (2–3 short cues), riskCues[] (1–3 short cues),
  flags: { codeSensitive?: boolean, needsAlternateAngle?: boolean, lowImageQuality?: boolean }
- quickChecks[] and cautions[].

Keep phrasing plain-language; short bullets.
`;

/* ---------- JSON schema ---------- */
const JSON_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    area: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          severity: { type: "string", enum: ["info", "note", "caution", "alert"] },
          detail: { type: "string" },
          confidenceBase: { type: "integer", minimum: 0, maximum: 100 },
          evidence: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 5 },
          riskCues: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 5 },
          flags: {
            type: "object",
            properties: {
              codeSensitive: { type: "boolean" },
              needsAlternateAngle: { type: "boolean" },
              lowImageQuality: { type: "boolean" }
            },
            additionalProperties: false
          }
        },
        required: ["label", "severity", "detail", "confidenceBase"],
        additionalProperties: false
      }
    },
    quickChecks: { type: "array", items: { type: "string" } },
    cautions: { type: "array", items: { type: "string" } },
    model: { type: "string" }
  },
  required: ["id", "findings", "model"],
  additionalProperties: false
};

/* ---------- Prompt template ---------- */
function PROMPT_TEMPLATE(meta, knowledgeText, knowledgeSources) {
  const kbIntro = knowledgeText
    ? `\n\nReference knowledge (summaries from Dropbox):\n${knowledgeText}`
    : "";
  const kbList = knowledgeSources.length
    ? `\n\nKnowledge sources consulted:\n${knowledgeSources
        .map((s) => `- ${s}`)
        .join("\n")}`
    : "";
  return `
Context:
- Area: ${meta.area ?? "unspecified"}
- Bedrooms (only if relevant to water heater sizing): ${meta.bedrooms ?? "n/a"}
- Manufactured home: ${meta.manufacturedHome ? "yes" : "no"}
- Notes: ${meta.notes ?? "n/a"}${kbIntro}${kbList}

Task:
1) Identify visible systems/components and obvious conditions from the photo while leveraging the knowledge provided.
2) List concise findings with severity (info|note|caution|alert).
3) Provide short "quickChecks" next steps.
4) Add applicable "cautions" (IAQ thresholds, moisture risk, electrical safety, etc.).
Return ONLY valid JSON per the schema.
`;
}

/* ---------- Knowledge handling (Dropbox + caching) ---------- */
const knowledgeCache = new Map();

function parseKnowledgeSources(env) {
  const raw = env.KNOWLEDGE_SOURCES || env.KNOWLEDGE_DOCS || env.KNOWLEDGE_PATHS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v)).filter(Boolean);
    if (typeof parsed === "string") return [parsed];
  } catch {
    if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  }
  return [];
}

function normalizeDropboxShareUrl(u) {
  try {
    const url = new URL(u);
    if (!url.hostname.includes("dropbox.com")) return u;
    url.searchParams.set("dl", "1");
    url.searchParams.delete("raw");
    return url.toString();
  } catch {
    return u;
  }
}

function describeSourceLabel(source) {
  if (!source) return "Dropbox source";
  if (source.startsWith("/")) return source;
  try {
    const url = new URL(source);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || url.hostname;
    return decodeURIComponent(last || "Dropbox file");
  } catch {
    return source;
  }
}

function isProbablyBinary(u8) {
  if (!u8 || !u8.length) return false;
  const len = Math.min(u8.length, 4096);
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const byte = u8[i];
    if (byte === 0) {
      suspicious++;
      continue;
    }
    if (byte < 7 || byte > 127) {
      if (!(byte >= 9 && byte <= 13)) suspicious++;
    }
  }
  return suspicious / len > 0.2;
}

async function fetchDropboxPath(env, path) {
  if (!env.DROPBOX_TOKEN) return null;
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DROPBOX_TOKEN}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (!res.ok) return null;
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (isProbablyBinary(buffer)) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

async function fetchKnowledgeSource(env, source) {
  if (source.startsWith("/")) {
    return fetchDropboxPath(env, source);
  }
  const url = normalizeDropboxShareUrl(source);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (isProbablyBinary(buffer)) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  } catch {
    return null;
  }
}

async function loadKnowledge(env) {
  const sources = parseKnowledgeSources(env);
  if (!sources.length) {
    return { knowledgeText: "", knowledgeSources: [] };
  }

  const docs = [];
  for (const source of sources) {
    if (knowledgeCache.has(source)) {
      const cached = knowledgeCache.get(source);
      if (cached) {
        docs.push({ label: describeSourceLabel(source), text: cached });
        continue;
      }
    }
    try {
      const text = await fetchKnowledgeSource(env, source);
      if (text && text.trim()) {
        knowledgeCache.set(source, text);
        docs.push({ label: describeSourceLabel(source), text });
      } else {
        knowledgeCache.set(source, null);
      }
    } catch {
      knowledgeCache.set(source, null);
    }
  }

  if (!docs.length) {
    return { knowledgeText: "", knowledgeSources: [] };
  }

  const maxChars = 12000;
  let used = 0;
  const knowledgeParts = [];
  for (const doc of docs) {
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const snippet = doc.text.length > remaining ? doc.text.slice(0, remaining) : doc.text;
    used += snippet.length;
    knowledgeParts.push(`From ${doc.label}:\n${snippet}`);
  }
  return {
    knowledgeText: knowledgeParts.join("\n\n"),
    knowledgeSources: docs.map((doc) => doc.label),
  };
}

/* ---------- Helpers ---------- */
function toBase64(u8) {
  let b = "";
  const c = 0x8000;
  for (let i = 0; i < u8.length; i += c) {
    b += String.fromCharCode.apply(null, u8.subarray(i, i + c));
  }
  return btoa(b);
}
function htmlResponse(body, status = 200, req) {
  return withSecurityHeaders(
    new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } }),
    corsOrigin(new URL(req.url), req)
  );
}
function jsonResponse(body, status = 200, req) {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    corsOrigin(new URL(req.url), req)
  );
}
function textResponse(body, status = 200, req) {
  return withSecurityHeaders(
    new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } }),
    corsOrigin(new URL(req.url), req)
  );
}
function extractFirstJson(text) {
  const s = String(text);
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
async function safeReadFile(file) {
  if (!(file instanceof File)) throw new Error("no file");
  const type = file.type || "";
  if (!ALLOWED_MIME.has(type)) throw new Error("unsupported image type");
  const ab = await file.arrayBuffer();
  if (ab.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large");
  return new Uint8Array(ab);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function computeAdjustedConfidence(f) {
  let base = Number.isFinite(f.confidenceBase) ? f.confidenceBase : 60;
  let penalty = 0;
  if (f.flags && f.flags.lowImageQuality) penalty += 20;
  const rc = (f.riskCues || []).join(" ").toLowerCase();
  if ((f.flags && f.flags.needsAlternateAngle) || rc.includes("angle") || rc.includes("lighting") || rc.includes("obstruction")) penalty += 15;
  if (rc.includes("label") || rc.includes("nameplate") || rc.includes("plate") || rc.includes("date code")) penalty += 10;
  const txt = String((f.label || "") + " " + (f.detail || "")).toLowerCase();
  if ((f.flags && f.flags.codeSensitive) || /(bond|clearance|gfc|afc|disconnect|separation|lug|neutral|ground|trap|slope)/.test(txt)) penalty += 10;
  let adjusted = clamp(base - penalty, 5, 95);
  if (adjusted > 95) adjusted = 95;
  if (adjusted < 5) adjusted = 5;
  return adjusted;
}
function confidenceAction(score) {
  return score < 70 ? "manual_review" : "auto_ok";
}

function summarizeHuman(r) {
  const lines = [];
  const area = r.area || "Area";
  lines.push(String(area.charAt(0).toUpperCase() + area.slice(1)) + " — Virtual Photo Evaluation (WA)");

  if (Array.isArray(r.findings) && r.findings.length) {
    lines.push("\nFIR:");
    for (const f of r.findings) {
      const sev = String(f.severity || "note").toUpperCase();
      lines.push("- [" + sev + "] " + (f.label || "Finding") + ": " + (f.detail || ""));
      lines.push("  Remedy: Recommend evaluation and repair by a qualified, licensed professional.");

      const score = computeAdjustedConfidence(f);
      const ev = f.evidence && f.evidence.length ? f.evidence.join(", ") : "—";
      const rc = f.riskCues && f.riskCues.length ? f.riskCues.join(", ") : "—";
      const act = confidenceAction(score) === "manual_review" ? "route for human review" : "proceed, no manual review required";
      lines.push("  Confidence: " + score + "%  |  Evidence: " + ev);
      lines.push("  Risk cues: " + rc);
      lines.push("  Action: " + act);
    }
  } else {
    lines.push("\nFIR:\n- No notable issues identified from this single photo.\n  Remedy: None at this time.");
  }

  if (Array.isArray(r.quickChecks) && r.quickChecks.length) {
    lines.push("\nQuick Checks:");
    for (const q of r.quickChecks) lines.push("- " + q);
  }

  if (Array.isArray(r.cautions) && r.cautions.length) {
    lines.push("\nCautions:");
    for (const c of r.cautions) lines.push("- " + c);
  }

  if (String(r.area || "").toLowerCase().includes("bathroom")) {
    lines.push("\nReminder: Verify exhaust fan suction with a paper test at the grille.");
  }

  lines.push("\nRef: " + (r.id || "ref"));
  return lines.join("\n");
}

async function ensureMetaAgreement(env, model) {
  if (model !== META_MODEL) return;
  try {
    await env.AI.run(model, { prompt: "agree" });
  } catch {}
}

async function runVision(env, model, { dataUrl, prompt }) {
  const messages = [
    { role: "system", content: TEXT_SYSTEM },
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  const requestMeta = {
    messages,
    response_format: model === META_MODEL ? { type: "json_schema", json_schema: JSON_SCHEMA } : undefined,
    max_tokens: 800,
    temperature: 0.2,
  };
  try {
    await ensureMetaAgreement(env, model);
    return await env.AI.run(model, requestMeta);
  } catch (e1) {
    if (model !== FALLBACK_MODEL) {
      return await env.AI.run(FALLBACK_MODEL, { messages, max_tokens: 800, temperature: 0.2 });
    }
    throw e1;
  }
}

function sanitizeFilename(name) {
  const base = name || "photo";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned.slice(0, 140) || "photo";
}

function buildDropboxPath(env, filename) {
  const base = (env.DROPBOX_UPLOAD_PATH || "/Apps/AI-Inspector").replace(/\/$/, "");
  return `${base}/${filename}`;
}

async function uploadToDropbox(env, filename, data, mimeType) {
  if (!env.DROPBOX_TOKEN) return;
  const path = buildDropboxPath(env, filename);
  await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DROPBOX_TOKEN}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path, mode: "add", autorename: true, mute: false }),
    },
    body: data,
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    const pre = corsPreflight(req);
    if (pre) return pre;

    if (req.method === "GET" && url.pathname === "/") {
      return htmlResponse(renderPage(env), 200, req);
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true }, 200, req);
    }

    if (req.method === "POST" && url.pathname === "/evaluate") {
      const ctype = req.headers.get("content-type") || "";
      if (!ctype.toLowerCase().includes("multipart/form-data")) return jsonResponse({ error: "multipart/form-data required" }, 400, req);

      const form = await req.formData();
      const image = form.get("image");
      if (!(image instanceof File)) return jsonResponse({ error: "image file required" }, 400, req);

      let meta = {};
      const metaRaw = form.get("meta");
      if (typeof metaRaw === "string" && metaRaw.trim().length) {
        try {
          meta = JSON.parse(metaRaw);
        } catch {}
      }

      if (!env.AI) return jsonResponse({ error: "AI binding not configured" }, 500, req);

      let u8;
      try {
        u8 = await safeReadFile(image);
      } catch (e) {
        return jsonResponse({ error: String(e.message || e) }, 400, req);
      }

      const now = new Date().toISOString().replace(/[:.]/g, "-");
      const sanitized = sanitizeFilename(image.name);
      const key = `uploads/${now}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}-${sanitized}`;
      const uploadTasks = [];
      if (env.PHOTOS_BUCKET) {
        uploadTasks.push(
          env.PHOTOS_BUCKET.put(key, u8, {
            httpMetadata: { contentType: image.type || "application/octet-stream" },
          })
        );
      }
      if (env.DROPBOX_TOKEN) {
        uploadTasks.push(uploadToDropbox(env, `${now}-${sanitized}`, u8, image.type).catch(() => {}));
      }

      const dataUrl = `data:${image.type || "image/jpeg"};base64,${toBase64(u8)}`;

      const model = url.searchParams.get("model") || env.MODEL || DEFAULT_MODEL;

      const { knowledgeText, knowledgeSources } = await loadKnowledge(env);
      const prompt = PROMPT_TEMPLATE(meta, knowledgeText, knowledgeSources);
      const ai = await runVision(env, model, { dataUrl, prompt });
      const raw = ai && ai.response !== undefined ? ai.response : ai;

      let parsed;
      try {
        parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        parsed = extractFirstJson(raw) || null;
      }

      if (!parsed || typeof parsed !== "object" || !parsed.findings) {
        parsed = {
          id: key,
          area: meta.area || "unspecified",
          findings: [
            {
              label: "Unstructured model output",
              severity: "note",
              detail: "Model response could not be parsed as schema JSON.",
              confidenceBase: 60,
              evidence: [],
              riskCues: [],
              flags: { lowImageQuality: false },
            },
          ],
          quickChecks: [],
          cautions: [],
          model,
        };
      }

      parsed.id ??= key;
      parsed.area ??= meta.area || "unspecified";
      parsed.model ??= model;
      parsed.findings ??= [];
      parsed.quickChecks ??= [];
      parsed.cautions ??= [];

      const format = (url.searchParams.get("format") || "json").toLowerCase();
      if (format === "human") {
        await Promise.allSettled(uploadTasks);
        return textResponse(summarizeHuman(parsed), 200, req);
      }
      if (format === "json") {
        if (env.JSON_TOKEN) {
          const token = url.searchParams.get("token");
          if (!token || token !== env.JSON_TOKEN) {
            await Promise.allSettled(uploadTasks);
            return jsonResponse({ error: "forbidden" }, 403, req);
          }
        }
        await Promise.allSettled(uploadTasks);
        return jsonResponse(parsed, 200, req);
      }

      await Promise.allSettled(uploadTasks);
      return jsonResponse(parsed, 200, req);
    }

    return withSecurityHeaders(new Response("Not found", { status: 404 }), corsOrigin(new URL(req.url), req));
  },
};
