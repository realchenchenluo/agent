"use strict";

const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { authenticate } = require("../mot/http");
const { ConversationStore } = require("./conversations");
const { answer, motContext, fail } = require("./router");

const agents = new Set(["mot", "merchant", "investment", "risk"]);
const validKey = value => typeof value === "string" && /^[a-zA-Z0-9._-]{8,100}$/.test(value);
const validId = value => typeof value === "string" && /^[a-zA-Z0-9-]{10,80}$/.test(value);
function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
function makeAppHttp({ env = process.env, mot, merchantFor }) {
  const directory = env.APP_DATA_DIR || (env.MOT_LOCAL_DEMO === "true" ? path.join(env.MOT_DATA_DIR || path.join(os.tmpdir(), "ai-banking-mot-local"), "app-conversations") : null);
  const store = directory ? new ConversationStore(directory) : null;
  async function handle(request, response, pathname, body) {
    if (!pathname.startsWith("/api/app/")) return false;
    try {
      if (!store) fail("CONVERSATION_STORAGE_UNAVAILABLE", 503);
      const actor = authenticate(request, env);
      if (!actor.roles.includes("read")) fail("PERMISSION_DENIED", 403);
      const owner = actor.owner_id;
      const method = request.method;
      const route = pathname.slice("/api/app".length);
      let result, status = 200;
      if (method === "GET" && route === "/bootstrap") {
        const state = await store.read(owner);
        const motStatus = await motContext(mot.runtime, owner);
        result = { contract_version: "app.v1", owner_id: owner, mode: actor.mode,
          agents: [{ agent_id: "mot", name: "MOT · 财务总助手", connection_status: "AVAILABLE", data_mode: "SYNTHETIC",
            ...Object.fromEntries(["status", "last_check_at", "next_check_at", "unresolved_count", "pending_approval_count", "last_result", "core_risk"].map(key => [key, motStatus[key]])) },
            { agent_id: "merchant", name: "店主财务专员", status: "LOCAL_SESSION", connection_status: "AVAILABLE", data_mode: "LOCAL_SESSION_SYNTHETIC" },
            { agent_id: "investment", name: "持仓分析专员", status: "DEMO_DATA", connection_status: "AVAILABLE", data_mode: "FIXED_DEMO_SNAPSHOT" },
            { agent_id: "risk", name: "风险审核专员", status: "UNAVAILABLE", connection_status: "UNAVAILABLE", data_mode: "NONE" }],
          voice_capabilities: { dictation: "BROWSER_DEPENDENT", realtime_call: "UNAVAILABLE", telephony: "DISABLED" },
          conversations: state.conversations.map(row => ({ conversation_id: row.conversation_id, agent_id: row.agent_id,
            title: row.title, created_at: row.created_at, updated_at: row.updated_at })).reverse(),
          task_runs: state.conversations.flatMap(row => row.messages.flatMap(item => (item.tool_results || [])
            .filter(result => result.kind === "run").map(result => result.run))).slice(-50).reverse() };
      } else if (method === "GET" && route === "/context/mot") {
        result = await motContext(mot.runtime, owner);
      } else if (method === "POST" && route === "/conversations") {
        if (!agents.has(body.agent_id) || !validKey(body.request_id)) fail("INVALID_CONVERSATION_REQUEST");
        result = await store.transact(owner, state => {
          const prior = state.conversations.find(row => row.create_request_id === body.request_id);
          if (prior) { if (prior.agent_id !== body.agent_id) fail("IDEMPOTENCY_CONFLICT", 409); return prior; }
          const at = new Date().toISOString();
          const row = { conversation_id: randomUUID(), owner_id: owner, agent_id: body.agent_id,
            title: body.agent_id === "mot" ? "MOT 对话" : "新对话", create_request_id: body.request_id,
            created_at: at, updated_at: at, messages: [] };
          state.conversations.push(row);
          if (state.conversations.length > 100) state.conversations.splice(0, state.conversations.length - 100);
          return row;
        });
        status = 201;
      } else if (method === "GET" && /^\/conversations\/[^/]+$/.test(route)) {
        const id = route.split("/")[2];
        if (!validId(id)) fail("INVALID_CONVERSATION_ID");
        result = (await store.read(owner)).conversations.find(row => row.conversation_id === id);
        if (!result) fail("CONVERSATION_NOT_FOUND", 404);
      } else if (method === "POST" && /^\/conversations\/[^/]+\/messages$/.test(route)) {
        if (!actor.roles.includes("operator")) fail("PERMISSION_DENIED", 403);
        const id = route.split("/")[2];
        if (!validId(id) || !validKey(body.request_id) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 2000) fail("INVALID_MESSAGE");
        result = await store.transact(owner, async state => {
          const row = state.conversations.find(item => item.conversation_id === id);
          if (!row) fail("CONVERSATION_NOT_FOUND", 404);
          const prior = row.messages.find(item => item.request_id === body.request_id && item.message_type === "user");
          if (prior) {
            if (prior.text !== body.text.trim()) fail("IDEMPOTENCY_CONFLICT", 409);
            return { conversation_id: id, replayed: true, messages: row.messages.slice(-2) };
          }
          const at = new Date().toISOString();
          const reply = await answer({ text: body.text, conversationId: id, agentId: row.agent_id,
            owner, runtime: mot.runtime, merchant: merchantFor(request, response), requestId: body.request_id });
          row.messages.push({ message_id: randomUUID(), conversation_id: id, agent_id: row.agent_id,
            task_id: null, message_type: "user", status: "RECORDED", source: "USER", as_of: at,
            text: body.text.trim(), tool_results: [], actions: [], audit_ref: null, request_id: body.request_id }, reply);
          if (row.messages.length > 200) row.messages.splice(0, row.messages.length - 200);
          if (row.title === "MOT 对话" || row.title === "新对话") row.title = body.text.trim().slice(0, 32);
          row.updated_at = at;
          return { conversation_id: id, replayed: false, messages: row.messages.slice(-2) };
        });
      } else fail("APP_ROUTE_NOT_FOUND", 404);
      send(response, status, result);
    } catch (cause) {
      send(response, cause.statusCode || 500, { contract_version: "app.v1", error: { code: cause.code || cause.message || "APP_INTERNAL_ERROR" } });
    }
    return true;
  }
  return { handle, store };
}

module.exports = { makeAppHttp };
