import backend, { ReviewService } from "./worker.js";
import { appHtml, appCss, appJs } from "./app-assets.js";

export { ReviewService };

const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encode = value => b64(new TextEncoder().encode(value));
const decode = value => new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)));
const same = (a, b) => {
  const x = String(a || ""), y = String(b || ""); let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
};
const json = (status, code) => new Response(JSON.stringify({ error: { code } }), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const html = (body, status = 200) => new Response(body, { status,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" } });
const loginPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Banking · Staging 登录</title><style>body{font-family:system-ui,sans-serif;background:#f4f8f4;color:#183629;margin:0;display:grid;place-items:center;min-height:100vh}main{width:min(90vw,380px);background:white;border:1px solid #dce9dc;border-radius:18px;padding:30px;box-shadow:0 20px 50px #16382013}h1{margin:0 0 10px}p{line-height:1.6;color:#647868}label{display:block;margin:24px 0 7px}input{width:100%;padding:12px;border:1px solid #bdd1c0;border-radius:10px;box-sizing:border-box}button{margin-top:16px;width:100%;padding:12px;border:0;border-radius:10px;background:#27765c;color:white;font-weight:700}</style></head><body><main><h1>AI Banking</h1><p>受控 Staging · 合成资金数据。请输入演示访问口令。</p><form method="post" action="/api/app/login"><label for="password">访问口令</label><input id="password" name="password" type="password" required autocomplete="current-password"><button type="submit">进入统一前端</button></form></main></body></html>`;

async function mac(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}
const configured = env => typeof env.APP_STAGING_PASSWORD === "string" && env.APP_STAGING_PASSWORD.length >= 24 &&
  typeof env.APP_STAGING_COOKIE_KEY === "string" && env.APP_STAGING_COOKIE_KEY.length >= 32 &&
  typeof env.APP_STAGING_OWNER_ID === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(env.APP_STAGING_OWNER_ID);
const sameOrigin = request => request.headers.get("Origin") === new URL(request.url).origin;
async function ownerFromCookie(request, env) {
  if (!configured(env)) return null;
  const value = /(?:^|;\s*)app_staging_session=([^;]+)/.exec(request.headers.get("Cookie") || "")?.[1];
  if (!value) return null;
  const [data, signature] = value.split(".");
  if (!data || !signature || data.length > 500 || !same(signature, await mac(data, env.APP_STAGING_COOKIE_KEY))) return null;
  try {
    const ticket = JSON.parse(decode(data));
    return ticket.owner_id === env.APP_STAGING_OWNER_ID && Number.isSafeInteger(ticket.exp) && ticket.exp > Date.now() ? ticket.owner_id : null;
  } catch { return null; }
}
function ownerToken(env, owner) {
  try {
    const grants = JSON.parse(env.MOT_AUTH_TOKENS_JSON || "[]");
    const grant = grants.find(item => item.owner_id === owner && item.roles?.includes("read") && item.roles?.includes("operator"));
    return typeof grant?.token === "string" && grant.token.length >= 24 ? grant.token : null;
  } catch { return null; }
}
async function login(request, env) {
  if (!configured(env)) return json(503, "STAGING_AUTH_UNAVAILABLE");
  if (!sameOrigin(request) || Number(request.headers.get("Content-Length")) > 2000) return json(403, "LOGIN_REJECTED");
  let form; try { form = await request.formData(); } catch { return json(400, "INVALID_LOGIN"); }
  const password = form.get("password");
  if (typeof password !== "string" || !same(password, env.APP_STAGING_PASSWORD)) return html(loginPage.replace("请输入演示访问口令。", "口令不正确，请重试。"), 401);
  if (!ownerToken(env, env.APP_STAGING_OWNER_ID)) return json(503, "STAGING_OWNER_UNAVAILABLE");
  const data = encode(JSON.stringify({ owner_id: env.APP_STAGING_OWNER_ID, exp: Date.now() + 12 * 3600_000, nonce: crypto.randomUUID() }));
  const cookie = `${data}.${await mac(data, env.APP_STAGING_COOKIE_KEY)}`;
  return new Response(null, { status: 303, headers: { Location: "/app",
    "Set-Cookie": `app_staging_session=${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`,
    "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), route = url.pathname;
    if (request.method === "GET" && route === "/versions/app.css") return new Response(appCss, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" } });
    if (request.method === "GET" && route === "/versions/app.js") return new Response(appJs, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } });
    if (request.method === "POST" && route === "/api/app/login") return login(request, env);
    if (request.method === "POST" && route === "/api/app/logout") {
      if (!sameOrigin(request)) return json(403, "ORIGIN_MISMATCH");
      return new Response(null, { status: 303, headers: { Location: "/app", "Set-Cookie": "app_staging_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0", "Cache-Control": "no-store" } });
    }
    const owner = await ownerFromCookie(request, env);
    if (request.method === "GET" && ["/", "/app", "/index.html"].includes(route)) return html(owner ? appHtml : loginPage);
    const legacy = { "/mot": "mot", "/merchant": "merchant", "/investment": "investment", "/risk-workbench": "risk" };
    if (request.method === "GET" && legacy[route]) return Response.redirect(`${url.origin}/app?agent=${legacy[route]}`, 302);
    if (route.startsWith("/api/mot/") || route.startsWith("/api/app/")) {
      if (!request.headers.get("X-Mot-Key") && owner) {
        if (request.method === "POST" && !sameOrigin(request)) return json(403, "ORIGIN_MISMATCH");
        const token = ownerToken(env, owner);
        if (!token) return json(503, "STAGING_OWNER_UNAVAILABLE");
        const headers = new Headers(request.headers); headers.set("X-Mot-Key", token);
        return backend.fetch(new Request(request, { headers }), env, ctx);
      }
      return backend.fetch(request, env, ctx);
    }
    return json(404, "NOT_FOUND");
  },
  scheduled(event, env, ctx) { return backend.scheduled(event, env, ctx); }
};
