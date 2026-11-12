import appModule from "../app/router.js";
import { authenticate } from "./mot-worker.js";

const { answer, motContext } = appModule;
const agents = new Set(["mot", "merchant", "investment", "risk"]);
const key = value => typeof value === "string" && /^[a-zA-Z0-9._-]{8,100}$/.test(value);
const id = value => typeof value === "string" && /^[a-zA-Z0-9-]{10,80}$/.test(value);
const failure = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const payload = (status, value) => new Response(JSON.stringify(value), { status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

class AppWorker {
  constructor(storage, motRuntime, env) { this.storage = storage; this.runtime = motRuntime; this.env = env; }
  storageKey(owner) { return `app:owner:${owner}`; }
  async read(owner) {
    const state = await this.storage.get(this.storageKey(owner)) || { version: "app.v1", owner_id: owner, conversations: [] };
    if (state.version !== "app.v1" || state.owner_id !== owner || !Array.isArray(state.conversations)) throw failure("CONVERSATION_STORAGE_UNAVAILABLE", 503);
    return state;
  }
  async change(owner, update) {
    return this.storage.transaction(async txn => {
      const state = await txn.get(this.storageKey(owner)) || { version: "app.v1", owner_id: owner, conversations: [] };
      if (state.version !== "app.v1" || state.owner_id !== owner || !Array.isArray(state.conversations)) throw failure("CONVERSATION_STORAGE_UNAVAILABLE", 503);
      const result = update(state);
      await txn.put(this.storageKey(owner), state);
      return structuredClone(result);
    });
  }
  async body(request) {
    if (Number(request.headers.get("Content-Length")) > 10000) throw failure("BODY_TOO_LARGE", 413);
    const chunks = []; let size = 0;
    for await (const chunk of request.body || []) {
      size += chunk.byteLength;
      if (size > 10000) throw failure("BODY_TOO_LARGE", 413);
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    try { const body = JSON.parse(new TextDecoder().decode(bytes)); if (!body || Array.isArray(body) || typeof body !== "object") throw new Error(); return body; }
    catch { throw failure("INVALID_JSON", 400); }
  }
  async handle(request) {
    try {
      const actor = authenticate(request, this.env);
      if (!actor.roles.includes("read")) throw failure("PERMISSION_DENIED", 403);
      const owner = actor.owner_id;
      const route = new URL(request.url).pathname.slice("/api/app".length);
      let result, status = 200;
      if (request.method === "GET" && route === "/bootstrap") {
        const state = await this.read(owner), mot = await motContext(this.runtime, owner);
        result = { contract_version: "app.v1", owner_id: owner, mode: "STAGING_SESSION",
          agents: [{ agent_id: "mot", name: "MOT · 财务总助手", connection_status: "AVAILABLE", data_mode: "SYNTHETIC",
            ...Object.fromEntries(["status", "last_check_at", "next_check_at", "unresolved_count", "pending_approval_count", "last_result", "core_risk"].map(name => [name, mot[name]])) },
            { agent_id: "merchant", name: "店主财务专员", status: "UNAVAILABLE", connection_status: "UNAVAILABLE", data_mode: "NONE" },
            { agent_id: "investment", name: "持仓分析专员", status: "DEMO_DATA", connection_status: "AVAILABLE", data_mode: "FIXED_DEMO_SNAPSHOT" },
            { agent_id: "risk", name: "风险审核专员", status: "UNAVAILABLE", connection_status: "UNAVAILABLE", data_mode: "NONE" }],
          voice_capabilities: { dictation: "BROWSER_DEPENDENT", realtime_call: "UNAVAILABLE", telephony: "DISABLED" },
          conversations: state.conversations.map(row => ({ conversation_id: row.conversation_id, agent_id: row.agent_id,
            title: row.title, created_at: row.created_at, updated_at: row.updated_at })).reverse(),
          task_runs: state.conversations.flatMap(row => row.messages.flatMap(item => (item.tool_results || [])
            .filter(result => result.kind === "run").map(result => result.run))).slice(-50).reverse() };
      } else if (request.method === "GET" && route === "/context/mot") {
        result = await motContext(this.runtime, owner);
      } else if (request.method === "POST" && route === "/conversations") {
        const input = await this.body(request);
        if (!agents.has(input.agent_id) || !key(input.request_id)) throw failure("INVALID_CONVERSATION_REQUEST");
        result = await this.change(owner, state => {
          const prior = state.conversations.find(row => row.create_request_id === input.request_id);
          if (prior) { if (prior.agent_id !== input.agent_id) throw failure("IDEMPOTENCY_CONFLICT", 409); return prior; }
          const at = new Date().toISOString();
          const row = { conversation_id: crypto.randomUUID(), owner_id: owner, agent_id: input.agent_id,
            title: input.agent_id === "mot" ? "MOT 对话" : "新对话", create_request_id: input.request_id,
            created_at: at, updated_at: at, messages: [] };
          state.conversations.push(row);
          if (state.conversations.length > 100) state.conversations.splice(0, state.conversations.length - 100);
          return row;
        });
        status = 201;
      } else if (request.method === "GET" && /^\/conversations\/[^/]+$/.test(route)) {
        const conversationId = route.split("/")[2];
        if (!id(conversationId)) throw failure("INVALID_CONVERSATION_ID");
        result = (await this.read(owner)).conversations.find(row => row.conversation_id === conversationId);
        if (!result) throw failure("CONVERSATION_NOT_FOUND", 404);
      } else if (request.method === "POST" && /^\/conversations\/[^/]+\/messages$/.test(route)) {
        if (!actor.roles.includes("operator")) throw failure("PERMISSION_DENIED", 403);
        const conversationId = route.split("/")[2], input = await this.body(request);
        if (!id(conversationId) || !key(input.request_id) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 2000) throw failure("INVALID_MESSAGE");
        const current = (await this.read(owner)).conversations.find(row => row.conversation_id === conversationId);
        if (!current) throw failure("CONVERSATION_NOT_FOUND", 404);
        const prior = current.messages.find(row => row.message_type === "user" && row.request_id === input.request_id);
        if (prior) {
          if (prior.text !== input.text.trim()) throw failure("IDEMPOTENCY_CONFLICT", 409);
          return payload(200, { conversation_id: conversationId, replayed: true, messages: current.messages.slice(-2) });
        }
        const reply = await answer({ text: input.text, conversationId, agentId: current.agent_id, owner,
          runtime: this.runtime, merchant: null, requestId: input.request_id });
        result = await this.change(owner, state => {
          const row = state.conversations.find(item => item.conversation_id === conversationId);
          if (!row) throw failure("CONVERSATION_NOT_FOUND", 404);
          const existing = row.messages.find(item => item.message_type === "user" && item.request_id === input.request_id);
          if (existing) {
            if (existing.text !== input.text.trim()) throw failure("IDEMPOTENCY_CONFLICT", 409);
            return { conversation_id: conversationId, replayed: true, messages: row.messages.slice(-2) };
          }
          const at = new Date().toISOString();
          row.messages.push({ message_id: crypto.randomUUID(), conversation_id: conversationId, agent_id: row.agent_id,
            task_id: null, message_type: "user", status: "RECORDED", source: "USER", as_of: at,
            text: input.text.trim(), tool_results: [], actions: [], audit_ref: null, request_id: input.request_id }, reply);
          if (row.messages.length > 200) row.messages.splice(0, row.messages.length - 200);
          if (["MOT 对话", "新对话"].includes(row.title)) row.title = input.text.trim().slice(0, 32);
          row.updated_at = at;
          return { conversation_id: conversationId, replayed: false, messages: row.messages.slice(-2) };
        });
      } else throw failure("APP_ROUTE_NOT_FOUND", 404);
      return payload(status, result);
    } catch (cause) {
      return payload(cause.statusCode || 503, { contract_version: "app.v1", error: { code: cause.code || "APP_UNAVAILABLE" } });
    }
  }
}

export { AppWorker };
