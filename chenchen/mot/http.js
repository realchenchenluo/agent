"use strict";

const { timingSafeEqual } = require("node:crypto");
const { MotEngine, overview, error } = require("./engine");
const { FileRepository } = require("./file-repository");
const os = require("node:os");
const path = require("node:path");

function equal(a, b) {
  const left = Buffer.from(String(a || "")), right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticate(request, env) {
  const host = String(request.headers.host || "").split(":")[0];
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  const origin = request.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === request.headers.host; } catch { /* malformed Origin is denied */ }
    if (!sameOrigin) throw error("ORIGIN_MISMATCH", 403);
  }
  if (env.MOT_LOCAL_DEMO === "true" && env.PUBLIC_ACCESS !== "true" && local)
    return { owner_id: "mot-local-demo", roles: ["read", "operator", "approver", "ingestor"], mode: "LOCAL_DEMO" };
  let grants;
  try { grants = JSON.parse(env.MOT_AUTH_TOKENS_JSON || "[]"); }
  catch { throw error("AUTH_CONFIGURATION_INVALID", 503); }
  if (!Array.isArray(grants) || !grants.length) throw error("AUTH_UNAVAILABLE", 503);
  const token = request.headers["x-mot-key"];
  const grant = grants.find(item => item && typeof item.owner_id === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(item.owner_id) &&
    typeof item.token === "string" && item.token.length >= 24 && equal(token, item.token));
  if (!grant) throw error("AUTHENTICATION_REQUIRED", 401);
  return { owner_id: grant.owner_id, roles: Array.isArray(grant.roles) ? grant.roles : [], mode: "TOKEN" };
}

function requireRole(actor, role) {
  if (!actor.roles.includes(role)) throw error("PERMISSION_DENIED", 403);
}

function respond(response, status, result) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(result));
}

function makeMotHttp(env = process.env, engine = null) {
  const directory = env.MOT_DATA_DIR || (env.MOT_LOCAL_DEMO === "true" ? path.join(os.tmpdir(), "ai-banking-mot-local") : null);
  const runtime = engine || (directory ? new MotEngine(new FileRepository(directory)) : null);
  async function handle(request, response, pathname, url, body) {
    if (!pathname.startsWith("/api/mot/")) return false;
    try {
      if (!runtime) throw error("PERSISTENCE_UNAVAILABLE", 503);
      const actor = authenticate(request, env);
      const owner = actor.owner_id;
      const method = request.method;
      const route = pathname.slice("/api/mot".length);
      if (method === "GET") requireRole(actor, "read");
      let result, status = 200;
      if (method === "GET" && route === "/health") {
        result = { service: "mot", contract_version: "mot.v1", status: "ok", mode: actor.mode,
          persistence: "LOCAL_ATOMIC_FILE", scheduler_interval_seconds: 900,
          scheduler_enabled: Boolean(runtime.scheduler?.timer), scheduler_last_error: runtime.scheduler?.lastError || null,
          external_notifications: false,
          core_risk: runtime.coreRisk ? "ADAPTER_CONFIGURED" : "UNAVAILABLE", execution_allowed: false };
      } else if (method === "GET" && route === "/overview") {
        result = await runtime.read(owner, state => overview(state, runtime.now()));
      } else if (method === "GET" && ["/stores", "/accounts", "/transactions", "/alerts", "/tasks", "/inbox", "/runs", "/audit", "/memory", "/monitors", "/notification-events"].includes(route)) {
        const field = { "/stores": "stores", "/accounts": "accounts", "/transactions": "transactions",
          "/alerts": "inbox", "/tasks": "tasks", "/inbox": "inbox", "/runs": "checks", "/audit": "audit", "/memory": "memory",
          "/notification-events": "notification_events", "/monitors": "monitors" }[route];
        result = await runtime.read(owner, state => ({ contract_version: "mot.v1", owner_id: owner,
          revision: state.revision, items: state[field].slice(-200) }));
      } else if (method === "GET" && /^\/tasks\/[^/]+$/.test(route)) {
        result = await runtime.getTask(owner, decodeURIComponent(route.slice(7)));
      } else if (method === "POST" && route === "/demo/ingest") {
        requireRole(actor, "ingestor");
        if (actor.mode !== "LOCAL_DEMO") throw error("DEMO_ROUTE_DISABLED", 403);
        result = await runtime.ingestDemo(owner, body.idempotency_key || "mot-demo-v1");
      } else if (method === "POST" && route === "/events/ingest") {
        requireRole(actor, "ingestor");
        const ingest = await runtime.ingest(owner, body.snapshot, body.idempotency_key, "event");
        const check = await runtime.check(owner, { trigger: "event", requestKey: `event-${body.idempotency_key}` });
        result = { ...ingest, check };
      } else if (method === "POST" && route === "/check") {
        requireRole(actor, "operator");
        result = await runtime.check(owner, { trigger: "manual", requestKey: body.idempotency_key });
      } else if (method === "POST" && route === "/monitors") {
        requireRole(actor, "operator"); result = await runtime.createMonitor(owner, body); status = 201;
      } else if (method === "POST" && /^\/monitors\/[^/]+$/.test(route)) {
        requireRole(actor, "operator"); result = await runtime.changeMonitor(owner, decodeURIComponent(route.slice(10)), body);
      } else if (method === "POST" && route === "/pool/configure") {
        requireRole(actor, "approver");
        result = await runtime.configurePool(owner, body);
      } else if (method === "POST" && route === "/reservations/propose") {
        requireRole(actor, "operator");
        result = await runtime.proposeReservation(owner, body); status = 201;
      } else if (method === "POST" && route === "/payments/propose") {
        requireRole(actor, "operator");
        result = await runtime.proposePayment(owner, body); status = 201;
      } else if (method === "POST" && route === "/memory") {
        requireRole(actor, "approver");
        result = await runtime.memory(owner, body); status = 201;
      } else if (method === "POST" && /^\/tasks\/[^/]+\/approval$/.test(route)) {
        requireRole(actor, "approver");
        result = await runtime.decideApproval(owner, decodeURIComponent(route.split("/")[2]), body.decision);
      } else if (method === "POST" && /^\/tasks\/[^/]+\/simulate$/.test(route)) {
        requireRole(actor, "operator");
        result = await runtime.simulate(owner, decodeURIComponent(route.split("/")[2]), body.idempotency_key);
      } else throw error("MOT_ROUTE_NOT_FOUND", 404);
      respond(response, status, result);
    } catch (cause) {
      respond(response, cause.statusCode || 500, { contract_version: "mot.v1",
        error: { code: cause.code || "MOT_INTERNAL_ERROR", message: cause.code || "MOT_INTERNAL_ERROR" },
        execution_allowed: false });
    }
    return true;
  }
  return { handle, runtime };
}

module.exports = { makeMotHttp, authenticate };
