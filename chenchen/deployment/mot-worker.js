import motModule from "../mot/engine.js";

const { MotEngine, empty, overview, validateState } = motModule;
const VERSION = "mot.v1";
const clone = value => structuredClone(value);
const failure = (code, statusCode = 422) => Object.assign(new Error(code), { code, statusCode });

class DurableMotRepository {
  constructor(storage) { this.storage = storage; }
  key(ownerId) { return `mot:owner:${ownerId}`; }
  async read(ownerId) { return clone(validateState(await this.storage.get(this.key(ownerId)) || empty(ownerId), ownerId)); }
  async transact(ownerId, fn) {
    return this.storage.transaction(async txn => {
      const state = validateState(await txn.get(this.key(ownerId)) || empty(ownerId), ownerId);
      const result = await fn(state);
      await txn.put(this.key(ownerId), state);
      return clone(result);
    });
  }
  async owners() {
    const rows = await this.storage.list({ prefix: "mot:owner:" });
    return [...rows.keys()].map(key => key.slice("mot:owner:".length));
  }
}

function equal(left, right) {
  const a = String(left || ""), b = String(right || "");
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}

function authenticate(request, env) {
  let grants;
  try { grants = JSON.parse(env.MOT_AUTH_TOKENS_JSON || "[]"); }
  catch { throw failure("AUTH_CONFIGURATION_INVALID", 503); }
  if (!Array.isArray(grants) || !grants.length) throw failure("AUTH_UNAVAILABLE", 503);
  const token = request.headers.get("X-Mot-Key");
  const grant = grants.find(item => item && typeof item.owner_id === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(item.owner_id) &&
    typeof item.token === "string" && item.token.length >= 24 && equal(token, item.token));
  if (!grant) throw failure("AUTHENTICATION_REQUIRED", 401);
  return { owner_id: grant.owner_id, roles: Array.isArray(grant.roles) ? grant.roles : [] };
}

function role(actor, expected) { if (!actor.roles.includes(expected)) throw failure("PERMISSION_DENIED", 403); }
function json(status, value, request, responseHeaders) {
  return new Response(JSON.stringify(value), { status, headers: { ...responseHeaders(request),
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
async function body(request) {
  if (Number(request.headers.get("Content-Length")) > 1_000_000) throw failure("BODY_TOO_LARGE", 413);
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("empty body");
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); throw failure("BODY_TOO_LARGE", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const input = JSON.parse(new TextDecoder().decode(bytes));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    return input;
  } catch (cause) { if (cause.code === "BODY_TOO_LARGE") throw cause; throw failure("INVALID_JSON", 400); }
}

class MotWorker {
  constructor(storage, env, responseHeaders) {
    this.repository = new DurableMotRepository(storage);
    this.engine = new MotEngine(this.repository);
    this.env = env;
    this.responseHeaders = responseHeaders;
  }

  async handle(request) {
    try {
      const url = new URL(request.url);
      const route = url.pathname.slice("/api/mot".length);
      if (route === "/internal/tick") {
        if (request.method !== "POST" || !this.env.MOT_CRON_SECRET ||
            this.env.MOT_CRON_SECRET.length < 24 || !equal(request.headers.get("X-Mot-Cron-Key"), this.env.MOT_CRON_SECRET))
          throw failure("AUTHENTICATION_REQUIRED", 401);
        const bucket = Math.floor(Date.now() / 900_000);
        const results = [];
        for (const owner of await this.repository.owners()) results.push(await this.engine.check(owner,
          { trigger: "scheduled", requestKey: `scheduled-${bucket}` }));
        return json(200, { contract_version: VERSION, checked: results.length, results }, request, this.responseHeaders);
      }
      const actor = authenticate(request, this.env), owner = actor.owner_id;
      if (request.method === "GET") role(actor, "read");
      let result, status = 200;
      if (request.method === "GET" && route === "/health") {
        result = { service: "mot", contract_version: VERSION, status: "ok", mode: "TOKEN",
          build_sha: this.env.MOT_BUILD_SHA || null,
          persistence: "REVIEW_SERVICE_DURABLE_OBJECT", scheduler_interval_seconds: 900,
          core_risk: "UNAVAILABLE", cron_secret_configured: Boolean(this.env.MOT_CRON_SECRET),
          external_notifications: false, execution_allowed: false };
      } else if (request.method === "GET" && route === "/overview") {
        result = await this.engine.read(owner, state => overview(state, this.engine.now()));
      } else if (request.method === "GET" && ["/stores", "/accounts", "/transactions", "/alerts", "/tasks", "/inbox", "/runs", "/audit", "/memory", "/monitors", "/notification-events"].includes(route)) {
        const field = { "/stores": "stores", "/accounts": "accounts", "/transactions": "transactions",
          "/alerts": "inbox", "/tasks": "tasks", "/inbox": "inbox", "/runs": "checks", "/audit": "audit", "/memory": "memory",
          "/notification-events": "notification_events", "/monitors": "monitors" }[route];
        result = await this.engine.read(owner, state => ({ contract_version: VERSION, owner_id: owner,
          revision: state.revision, items: state[field].slice(-200) }));
      } else if (request.method === "GET" && /^\/tasks\/[^/]+$/.test(route)) {
        result = await this.engine.getTask(owner, decodeURIComponent(route.slice(7)));
      } else if (request.method === "POST" && route === "/events/ingest") {
        role(actor, "ingestor"); const input = await body(request);
        const ingest = await this.engine.ingest(owner, input.snapshot, input.idempotency_key, "event");
        const check = await this.engine.check(owner, { trigger: "event", requestKey: `event-${input.idempotency_key}` });
        result = { ...ingest, check };
      } else if (request.method === "POST" && route === "/check") {
        role(actor, "operator"); const input = await body(request);
        result = await this.engine.check(owner, { trigger: "manual", requestKey: input.idempotency_key });
      } else if (request.method === "POST" && route === "/monitors") {
        role(actor, "operator"); result = await this.engine.createMonitor(owner, await body(request)); status = 201;
      } else if (request.method === "POST" && /^\/monitors\/[^/]+$/.test(route)) {
        role(actor, "operator"); result = await this.engine.changeMonitor(owner, decodeURIComponent(route.slice(10)), await body(request));
      } else if (request.method === "POST" && route === "/pool/configure") {
        role(actor, "approver"); result = await this.engine.configurePool(owner, await body(request));
      } else if (request.method === "POST" && route === "/reservations/propose") {
        role(actor, "operator"); result = await this.engine.proposeReservation(owner, await body(request)); status = 201;
      } else if (request.method === "POST" && route === "/payments/propose") {
        role(actor, "operator"); result = await this.engine.proposePayment(owner, await body(request)); status = 201;
      } else if (request.method === "POST" && route === "/memory") {
        role(actor, "approver"); result = await this.engine.memory(owner, await body(request)); status = 201;
      } else if (request.method === "POST" && /^\/tasks\/[^/]+\/approval$/.test(route)) {
        role(actor, "approver"); result = await this.engine.decideApproval(owner, decodeURIComponent(route.split("/")[2]), (await body(request)).decision);
      } else if (request.method === "POST" && /^\/tasks\/[^/]+\/simulate$/.test(route)) {
        role(actor, "operator"); result = await this.engine.simulate(owner, decodeURIComponent(route.split("/")[2]), (await body(request)).idempotency_key);
      } else throw failure("MOT_ROUTE_NOT_FOUND", 404);
      return json(status, result, request, this.responseHeaders);
    } catch (cause) {
      return json(cause.statusCode || 503, { contract_version: VERSION,
        error: { code: cause.code || "MOT_UNAVAILABLE", message: cause.code || "MOT_UNAVAILABLE" },
        execution_allowed: false }, request, this.responseHeaders);
    }
  }
}

export { DurableMotRepository, MotWorker, authenticate };
