"use strict";

const { createHash } = require("node:crypto");

const VERSION = "mot.v1";
const STATES = new Set(["CREATED", "CHECKING", "NEEDS_ATTENTION", "PENDING_APPROVAL", "RESOLVED", "BLOCKED", "FAILED", "CANCELLED", "UNKNOWN"]);
const clone = value => structuredClone(value);
const id = prefix => `${prefix}${globalThis.crypto.randomUUID()}`;
const validId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(value);
const money = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000;
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sum = rows => rows.reduce((total, value) => total + value, 0);
const error = (code, statusCode = 422) => Object.assign(new Error(code), { code, statusCode });

function empty(ownerId) {
  return { schema_version: VERSION, owner_id: ownerId, revision: 0, stores: [], terminals: [], accounts: [],
    transactions: [], reservations: [], tasks: [], inbox: [], notification_events: [], audit: [],
    memory: [], checks: [], ingests: [], pool_configs: [], monitors: [], observed_transaction_keys: [],
    last_check_at: null, last_check_error: null };
}

function validateState(state, ownerId) {
  if (!state || state.schema_version !== VERSION || state.owner_id !== ownerId ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !["stores", "terminals", "accounts", "transactions", "reservations", "tasks", "inbox",
        "notification_events", "audit", "memory", "checks", "ingests", "pool_configs",
        "observed_transaction_keys"].every(key => Array.isArray(state[key])) ||
      state.tasks.some(task => task.owner_id !== ownerId || !STATES.has(task.state)) ||
      state.reservations.some(row => row.owner_id !== ownerId || !money(row.amount_minor)))
    throw error("PERSISTENCE_CORRUPT", 503);
  // Older mot.v1 records predate persistent monitors.
  if (state.monitors === undefined) state.monitors = [];
  if (!Array.isArray(state.monitors) || state.monitors.some(row => row.owner_id !== ownerId)) throw error("PERSISTENCE_CORRUPT", 503);
  return state;
}

function fixture(at = new Date().toISOString()) {
  const before = minutes => new Date(Date.parse(at) - minutes * 60_000).toISOString();
  const after = minutes => new Date(Date.parse(at) + minutes * 60_000).toISOString();
  const stores = [{ store_id: "store-east", name: "东店", source_system: "POS_A" },
    { store_id: "store-west", name: "西店", source_system: "POS_B" }];
  const terminals = ["east-1", "east-2", "east-3", "west-1", "west-2"].map((terminal_id, index) => ({
    terminal_id, store_id: index < 3 ? "store-east" : "store-west" }));
  const accounts = [{ account_id: "bank-main", name: "运营账户", pool: true, balance_minor: 800_000, as_of: at, revision: 1 },
    { account_id: "bank-west", name: "西店账户", pool: false, balance_minor: 400_000, as_of: at, revision: 1 },
    { account_id: "bank-reserve", name: "预备账户", pool: false, balance_minor: 300_000, as_of: at, revision: 1 }]
    .map(account => ({ ...account, currency: "CNY", verified: true, source_system: "SYNTHETIC_BANK" }));
  const tx = (source_system, external_transaction_id, transaction_type, amount_minor, status, account_id, store_id,
    terminal_id, occurred_at, due_at = null, related_transaction_id = null, transfer_id = null) => ({
    store_id, terminal_id, account_id, source_system, external_transaction_id, amount_minor, currency: "CNY",
    transaction_type, status, occurred_at, settled_at: status === "SETTLED" ? occurred_at : null,
    as_of: at, revision: 1, due_at, related_transaction_id, transfer_id });
  const transactions = [
    tx("POS_A", "sale-100", "RECEIPT", 20_000, "SETTLED", "bank-main", "store-east", "east-1", before(120)),
    tx("BANK_A", "settle-100", "SETTLEMENT", 20_000, "SETTLED", "bank-main", "store-east", null, before(60), null, "POS_A:sale-100"),
    tx("POS_B", "sale-200", "RECEIPT", 55_000, "PENDING", "bank-west", "store-west", "west-1", before(15), after(60)),
    tx("POS_A", "sale-101", "RECEIPT", 30_000, "SETTLED", "bank-main", "store-east", "east-2", before(90)),
    tx("BANK_A", "settle-101", "SETTLEMENT", 29_000, "SETTLED", "bank-main", "store-east", null, before(50), null, "POS_A:sale-101"),
    tx("ERP_A", "rent-next", "PAYMENT", 1_350_000, "PENDING", "bank-main", "store-east", null, before(5), after(1440)),
    tx("BANK_A", "transfer-out", "INTERNAL_TRANSFER", 50_000, "SETTLED", "bank-main", null, null, before(180), null, null, "internal-1"),
    tx("BANK_B", "transfer-in", "INTERNAL_TRANSFER", 50_000, "SETTLED", "bank-west", null, null, before(180), null, null, "internal-1")
  ];
  return { stores, terminals, accounts, transactions };
}

function validateFixture(data) {
  if (!data || !Array.isArray(data.stores) || !Array.isArray(data.terminals) || !Array.isArray(data.accounts) ||
      !Array.isArray(data.transactions) || data.stores.length > 50 || data.terminals.length > 500 ||
      data.accounts.length > 100 || data.transactions.length > 10_000) throw error("INVALID_INGEST");
  const stores = new Set();
  for (const store of data.stores) {
    if (!validId(store.store_id) || stores.has(store.store_id) || !validId(store.source_system)) throw error("INVALID_STORE");
    stores.add(store.store_id);
  }
  const terminals = new Set();
  for (const terminal of data.terminals) {
    if (!validId(terminal.terminal_id) || terminals.has(terminal.terminal_id) || !stores.has(terminal.store_id)) throw error("INVALID_TERMINAL");
    terminals.add(terminal.terminal_id);
  }
  const accounts = new Set();
  for (const account of data.accounts) {
    if (!validId(account.account_id) || accounts.has(account.account_id) || !money(account.balance_minor) ||
        account.currency !== "CNY" || !iso(account.as_of) || !Number.isSafeInteger(account.revision) ||
        account.revision < 1 || account.verified !== true || typeof account.pool !== "boolean") throw error("INVALID_ACCOUNT");
    accounts.add(account.account_id);
  }
  for (const tx of data.transactions) {
    if (!validId(tx.source_system) || !validId(tx.external_transaction_id) || !accounts.has(tx.account_id) ||
        (tx.store_id !== null && !stores.has(tx.store_id)) ||
        (tx.terminal_id !== null && (!terminals.has(tx.terminal_id) ||
          data.terminals.find(t => t.terminal_id === tx.terminal_id).store_id !== tx.store_id)) ||
        !money(tx.amount_minor) || tx.amount_minor === 0 || tx.currency !== "CNY" ||
        !["RECEIPT", "PAYMENT", "REFUND", "INTERNAL_TRANSFER", "SETTLEMENT"].includes(tx.transaction_type) ||
        !["PENDING", "SETTLED", "CANCELLED"].includes(tx.status) || !iso(tx.occurred_at) ||
        (tx.settled_at !== null && !iso(tx.settled_at)) || !iso(tx.as_of) ||
        !Number.isSafeInteger(tx.revision) || tx.revision < 1 || (tx.due_at !== null && !iso(tx.due_at))) throw error("INVALID_TRANSACTION");
  }
}

function audit(state, at, eventType, taskId, evidence = {}) {
  const event = { audit_id: id("mot-audit-"), owner_id: state.owner_id, task_id: taskId,
    event_type: eventType, at, state_revision: state.revision + 1, evidence: clone(evidence) };
  state.audit.push(event);
  return event;
}

function transition(task, to, at, evidence) {
  if (!STATES.has(to)) throw error("INVALID_TASK_STATE");
  task.state = to;
  task.updated_at = at;
  task.evidence.push({ at, state: to, ...clone(evidence) });
}

function overview(state, at) {
  const verified = state.accounts.filter(a => a.verified);
  const pool = verified.filter(a => a.pool);
  const total = sum(verified.map(a => a.balance_minor));
  const poolTotal = sum(pool.map(a => a.balance_minor));
  const held = sum(state.reservations.filter(r => r.status === "ACTIVE").map(r => r.amount_minor));
  // Source and Worker clocks may differ slightly; larger future timestamps remain unknown.
  const isFresh = a => {
    const age = Date.parse(at) - Date.parse(a.as_of);
    return age <= 24 * 3600_000 && age >= -5 * 60_000;
  };
  const fresh = pool.length > 0 && pool.every(isFresh);
  const totalFresh = verified.length === state.accounts.length && verified.length > 0 && verified.every(isFresh);
  return { schema_version: VERSION, owner_id: state.owner_id, revision: state.revision,
    as_of: verified.length ? verified.map(a => a.as_of).sort()[0] : null,
    pool_as_of: pool.length ? pool.map(a => a.as_of).sort()[0] : null, evaluated_at: at,
    stores: state.stores.length, terminals: state.terminals.length, accounts: state.accounts.length,
    total_verified_minor: totalFresh ? total : null, total_balance_fresh: totalFresh,
    pool_account_ids: pool.map(a => a.account_id), pool_balance_minor: fresh ? poolTotal : null,
    reserved_minor: held, available_minor: fresh ? Math.max(0, poolTotal - held) : null,
    pending_settlement_minor: sum(state.transactions.filter(t => t.transaction_type === "RECEIPT" && t.status === "PENDING").map(t => t.amount_minor)),
    balance_fresh: fresh, execution_allowed: false, mode: "SIMULATION_ONLY" };
}

function findings(state, at) {
  const result = [];
  const bySource = new Map();
  for (const tx of state.transactions) {
    const key = `${tx.source_system}:${tx.external_transaction_id}`;
    if (!bySource.has(key)) bySource.set(key, tx);
  }
  for (const tx of state.transactions.filter(t => t.transaction_type === "RECEIPT" && t.status === "SETTLED")) {
    const key = `${tx.source_system}:${tx.external_transaction_id}`;
    const settlements = state.transactions.filter(t => t.transaction_type === "SETTLEMENT" && t.related_transaction_id === key);
    if (sum(settlements.map(t => t.amount_minor)) !== tx.amount_minor)
      result.push({ key: `SETTLEMENT_MISMATCH:${key}`, kind: "SETTLEMENT_MISMATCH", severity: "HIGH",
        evidence: { source_transaction_id: key, expected_minor: tx.amount_minor, settled_minor: sum(settlements.map(t => t.amount_minor)) } });
  }
  const seen = new Map();
  for (const tx of state.transactions.filter(t => t.transaction_type === "RECEIPT")) {
    const signature = `${tx.store_id}:${tx.terminal_id}:${tx.amount_minor}:${Math.floor(Date.parse(tx.occurred_at) / 60_000)}`;
    const first = seen.get(signature);
    if (first && first.external_transaction_id !== tx.external_transaction_id)
      result.push({ key: `SUSPECT_DUPLICATE:${signature}`, kind: "SUSPECT_DUPLICATE", severity: "MEDIUM",
        evidence: { first: first.external_transaction_id, second: tx.external_transaction_id, amount_minor: tx.amount_minor } });
    else seen.set(signature, tx);
  }
  const view = overview(state, at);
  const due = state.transactions.filter(t => t.transaction_type === "PAYMENT" && t.status === "PENDING" &&
    t.due_at && Date.parse(t.due_at) <= Date.parse(at) + 7 * 86400_000);
  const dueTotal = sum(due.map(t => t.amount_minor));
  if (view.available_minor !== null && dueTotal > view.available_minor)
    result.push({ key: "FUNDING_SHORTFALL:POOL", kind: "FUNDING_SHORTFALL", severity: "HIGH",
      evidence: { due_minor: dueTotal, available_minor: view.available_minor,
        shortfall_minor: dueTotal - view.available_minor, payment_ids: due.map(t => t.external_transaction_id) } });
  if (!view.balance_fresh && state.accounts.length)
    result.push({ key: "BALANCE_UNKNOWN:POOL", kind: "BALANCE_UNKNOWN", severity: "HIGH",
      evidence: { pool_account_ids: view.pool_account_ids } });
  return result;
}

class MotEngine {
  constructor(repository, { now = () => new Date().toISOString(), coreRisk = null } = {}) {
    this.repository = repository;
    this.now = now;
    this.coreRisk = coreRisk;
  }

  async read(ownerId, selector = state => state) {
    const state = await this.repository.read(ownerId);
    return clone(selector(state || empty(ownerId)));
  }

  async ingest(ownerId, data, requestKey, trigger = "manual") {
    if (!validId(requestKey) || requestKey.length > 80) throw error("IDEMPOTENCY_KEY_REQUIRED");
    validateFixture(data);
    return this.repository.transact(ownerId, state => {
      const previous = state.ingests.find(i => i.request_key === requestKey);
      const digest = JSON.stringify(data);
      if (previous) {
        if (previous.digest !== digest && trigger !== "demo") throw error("IDEMPOTENCY_CONFLICT", 409);
        return { imported: 0, duplicates: data.transactions.length, revision: state.revision, replayed: true };
      }
      if (state.stores.length && JSON.stringify(state.stores) !== JSON.stringify(data.stores)) throw error("STORE_SET_CHANGED", 409);
      if (state.terminals.length && JSON.stringify(state.terminals) !== JSON.stringify(data.terminals)) throw error("TERMINAL_SET_CHANGED", 409);
      if (state.accounts.length) {
        const old = new Map(state.accounts.map(a => [a.account_id, a]));
        if (old.size !== data.accounts.length) throw error("ACCOUNT_SET_CHANGED", 409);
        for (const account of data.accounts) {
          const prior = old.get(account.account_id);
          if (!prior || prior.currency !== account.currency ||
              prior.source_system !== account.source_system || account.revision < prior.revision ||
              Date.parse(account.as_of) < Date.parse(prior.as_of) ||
              (account.revision === prior.revision &&
                JSON.stringify({ ...account, pool: prior.pool }) !== JSON.stringify(prior)))
            throw error("ACCOUNT_SNAPSHOT_CHANGED", 409);
        }
      }
      const poolByAccount = new Map(state.accounts.map(a => [a.account_id, a.pool]));
      state.stores = clone(data.stores); state.terminals = clone(data.terminals);
      state.accounts = clone(data.accounts).map(a => ({ ...a, pool: poolByAccount.get(a.account_id) ?? a.pool }));
      const existing = new Map(state.transactions.map(t => [`${t.source_system}:${t.external_transaction_id}`, t]));
      let imported = 0, duplicates = 0;
      for (const tx of data.transactions) {
        const key = `${tx.source_system}:${tx.external_transaction_id}`;
        if (existing.has(key)) {
          if (JSON.stringify(existing.get(key)) !== JSON.stringify(tx)) throw error("TRANSACTION_ID_CONFLICT", 409);
          duplicates++; continue;
        }
        state.transactions.push(clone(tx)); existing.set(key, tx); imported++;
      }
      state.revision++;
      const at = this.now();
      state.ingests.push({ request_key: requestKey, digest, imported, at });
      audit(state, at, "ledger.ingested", null, { imported, duplicates, trigger });
      return { imported, duplicates, revision: state.revision, replayed: false };
    });
  }

  async ingestDemo(ownerId, requestKey = "mot-demo-v1") {
    return this.ingest(ownerId, fixture(this.now()), requestKey, "demo");
  }

  async check(ownerId, { trigger = "manual", requestKey } = {}) {
    if (!["manual", "scheduled", "event"].includes(trigger) || !validId(requestKey) || requestKey.length > 90) throw error("INVALID_CHECK_REQUEST");
    return this.repository.transact(ownerId, state => {
      const previous = state.checks.find(c => c.request_key === requestKey);
      if (previous) return { ...clone(previous.result), replayed: true };
      const at = this.now();
      const active = new Set();
      const detected = findings(state, at);
      const evaluatedMonitorIds = new Set();
      for (const monitor of state.monitors || []) {
        if (monitor.status !== "ACTIVE" || (trigger === "scheduled" && Date.parse(monitor.next_run_at) > Date.parse(at))) continue;
        evaluatedMonitorIds.add(monitor.monitor_id);
        const view = overview(state, at);
        const current = monitor.scope === "POOL" ? view.available_minor : null;
        if (current === null) detected.push({ key: `MONITOR_UNKNOWN:${monitor.monitor_id}`, kind: "MONITOR_UNKNOWN", severity: "HIGH",
          evidence: { monitor_id: monitor.monitor_id, reason: "BALANCE_NOT_VERIFIED", as_of: view.as_of } });
        else if (current < monitor.threshold_minor) detected.push({ key: `MONITOR_BELOW_THRESHOLD:${monitor.monitor_id}`,
          kind: "MONITOR_BELOW_THRESHOLD", severity: "HIGH", evidence: { monitor_id: monitor.monitor_id,
            scope: monitor.scope, current_minor: current, threshold_minor: monitor.threshold_minor, as_of: view.as_of } });
        monitor.last_run_at = at;
        monitor.next_run_at = this.scheduler?.nextRunAt ||
          new Date(Math.ceil((Date.parse(at) + 1) / 900_000) * 900_000).toISOString();
        monitor.updated_at = at;
      }
      const observed = new Set(state.observed_transaction_keys);
      const fresh = state.transactions.filter(t => !observed.has(`${t.source_system}:${t.external_transaction_id}`));
      const newReceipts = fresh.filter(t => t.transaction_type === "RECEIPT").length;
      const newPayments = fresh.filter(t => t.transaction_type === "PAYMENT").length;
      state.observed_transaction_keys = state.transactions.map(t => `${t.source_system}:${t.external_transaction_id}`);
      const created = [];
      for (const finding of detected) {
        active.add(finding.key);
        let task = state.tasks.find(t => t.finding_key === finding.key && !["RESOLVED", "CANCELLED"].includes(t.state));
        if (!task) {
          task = { task_id: id("mot-task-"), owner_id: ownerId, source: trigger, finding_key: finding.key,
            kind: finding.kind, severity: finding.severity, state: "CREATED", created_at: at, updated_at: at,
            ledger_revision: state.revision, evidence: [], approval: null, review: { status: "UNAVAILABLE", execution_allowed: false } };
          state.tasks.push(task);
          transition(task, "CHECKING", at, { finding: finding.evidence });
          transition(task, "NEEDS_ATTENTION", at, { finding: finding.evidence, core_risk: "UNAVAILABLE" });
          const event = audit(state, at, "task.created", task.task_id, finding.evidence);
          state.inbox.push({ inbox_id: id("mot-inbox-"), task_id: task.task_id, owner_id: ownerId,
            status: "OPEN", created_at: at, updated_at: at, audit_id: event.audit_id });
          state.notification_events.push({ event_id: id("mot-notify-"), task_id: task.task_id,
            owner_id: ownerId, kind: "INBOX_ALERT", status: "QUEUED", created_at: at });
          created.push(task.task_id);
        }
      }
      for (const task of state.tasks) {
        if (task.finding_key?.startsWith("MONITOR_") && !active.has(task.finding_key)) {
          const monitorId = task.finding_key.split(":")[1];
          const monitor = state.monitors.find(row => row.monitor_id === monitorId);
          if (monitor?.status === "ACTIVE" && !evaluatedMonitorIds.has(monitorId)) continue;
        }
        if (!active.has(task.finding_key) && task.finding_key && task.state === "NEEDS_ATTENTION") {
          transition(task, "RESOLVED", at, { reason: "finding_cleared" });
          for (const item of state.inbox.filter(i => i.task_id === task.task_id)) { item.status = "RESOLVED"; item.updated_at = at; }
          audit(state, at, "task.resolved", task.task_id, { reason: "finding_cleared" });
        }
      }
      state.last_check_at = at; state.last_check_error = null; state.revision++;
      const result = { check_id: id("mot-check-"), owner_id: ownerId, trigger, at, findings: detected.length,
        tasks_created: created, new_receipts: newReceipts, new_payments: newPayments,
        ledger_revision: state.revision, replayed: false };
      state.checks.push({ request_key: requestKey, result });
      audit(state, at, "runtime.checked", null, { trigger, findings: detected.length,
        new_receipts: newReceipts, new_payments: newPayments, tasks_created: created });
      return result;
    });
  }

  async getTask(ownerId, taskId) {
    const task = await this.read(ownerId, state => state.tasks.find(t => t.task_id === taskId) || null);
    if (!task) throw error("TASK_NOT_FOUND", 404);
    return task;
  }

  async createMonitor(ownerId, input) {
    const { scope, threshold_minor, frequency_minutes, channel, timezone, request_key } = input || {};
    if (scope !== "POOL" || !money(threshold_minor) || threshold_minor <= 0 || frequency_minutes !== 15 ||
        channel !== "INBOX_ONLY" || timezone !== "Asia/Shanghai" || !validId(request_key)) throw error("INVALID_MONITOR");
    return this.repository.transact(ownerId, state => {
      state.monitors ||= [];
      const prior = state.monitors.find(row => row.request_key === request_key);
      if (prior) {
        if (prior.threshold_minor !== threshold_minor || prior.scope !== scope) throw error("IDEMPOTENCY_CONFLICT", 409);
        return clone(prior);
      }
      const at = this.now();
      const record = { monitor_id: id("mot-monitor-"), owner_id: ownerId, scope, threshold_minor,
        frequency_minutes, channel, timezone, status: "ACTIVE", request_key, created_at: at, updated_at: at,
        next_run_at: this.scheduler?.nextRunAt || new Date(Math.ceil(Date.parse(at) / 900_000) * 900_000).toISOString(), last_run_at: null };
      state.monitors.push(record); state.revision++;
      audit(state, at, "monitor.created", null, { monitor_id: record.monitor_id, threshold_minor, scope });
      return clone(record);
    });
  }

  async changeMonitor(ownerId, monitorId, { action, threshold_minor, request_key } = {}) {
    if (!validId(monitorId) || !validId(request_key) || !["PAUSE", "RESUME", "CANCEL", "UPDATE"].includes(action) ||
        (action === "UPDATE" && (!money(threshold_minor) || threshold_minor <= 0))) throw error("INVALID_MONITOR_CHANGE");
    return this.repository.transact(ownerId, state => {
      state.monitors ||= [];
      const monitor = state.monitors.find(row => row.monitor_id === monitorId);
      if (!monitor) throw error("MONITOR_NOT_FOUND", 404);
      const prior = state.audit.find(row => row.event_type === "monitor.changed" && row.evidence.request_key === request_key);
      if (prior) {
        if (prior.evidence.monitor_id !== monitorId || prior.evidence.action !== action ||
            prior.evidence.threshold_minor !== (action === "UPDATE" ? threshold_minor : null)) throw error("IDEMPOTENCY_CONFLICT", 409);
        return clone(monitor);
      }
      if (monitor.status === "CANCELLED") throw error("MONITOR_CANCELLED", 409);
      const at = this.now();
      if (action === "PAUSE") monitor.status = "PAUSED";
      const nextScheduled = this.scheduler?.nextRunAt || new Date(Math.ceil(Date.parse(at) / 900_000) * 900_000).toISOString();
      if (action === "RESUME") { monitor.status = "ACTIVE"; monitor.next_run_at = nextScheduled; }
      if (action === "CANCEL") monitor.status = "CANCELLED";
      if (action === "UPDATE") { monitor.threshold_minor = threshold_minor; monitor.next_run_at = nextScheduled; }
      monitor.updated_at = at; state.revision++;
      audit(state, at, "monitor.changed", null, { monitor_id: monitorId, action, threshold_minor: action === "UPDATE" ? threshold_minor : null, request_key });
      return clone(monitor);
    });
  }

  async memory(ownerId, { type, key, value, consent, request_key }) {
    if (consent !== true || !["store_rule", "preference", "exception_record"].includes(type) ||
        !validId(key) || !validId(request_key) || typeof value !== "object" || value === null || Array.isArray(value) ||
        JSON.stringify(value).length > 2000 || /balance|cash|account/i.test(`${key} ${JSON.stringify(value)}`)) throw error("INVALID_MEMORY");
    return this.repository.transact(ownerId, state => {
      const previous = state.memory.find(record => record.request_key === request_key);
      if (previous) {
        if (previous.type !== type || previous.key !== key || JSON.stringify(previous.value) !== JSON.stringify(value))
          throw error("IDEMPOTENCY_CONFLICT", 409);
        return clone(previous);
      }
      const at = this.now();
      const record = { memory_id: id("mot-memory-"), owner_id: ownerId, type, key, value: clone(value),
        request_key, source: "USER_CONFIRMED", at };
      state.memory.push(record); state.revision++;
      audit(state, at, "memory.saved", null, { memory_id: record.memory_id, type, key });
      return record;
    });
  }

  async configurePool(ownerId, { account_ids, expected_revision, request_key }) {
    if (!Array.isArray(account_ids) || ![1, 3].includes(account_ids.length) ||
        new Set(account_ids).size !== account_ids.length || !account_ids.every(validId) ||
        !Number.isSafeInteger(expected_revision) || !validId(request_key)) throw error("INVALID_POOL_CONFIG");
    return this.repository.transact(ownerId, state => {
      const prior = state.pool_configs.find(x => x.request_key === request_key);
      if (prior) {
        if (JSON.stringify(prior.account_ids) !== JSON.stringify(account_ids)) throw error("IDEMPOTENCY_CONFLICT", 409);
        return clone(prior.result);
      }
      if (state.revision !== expected_revision) throw error("STALE_LEDGER", 409);
      if (account_ids.some(id => !state.accounts.some(a => a.account_id === id && a.verified))) throw error("ACCOUNT_NOT_VERIFIED", 409);
      for (const account of state.accounts) account.pool = account_ids.includes(account.account_id);
      const at = this.now();
      state.revision++;
      const result = { contract_version: VERSION, owner_id: ownerId, account_ids: clone(account_ids),
        revision: state.revision, at, mode: "SIMULATION_ONLY" };
      state.pool_configs.push({ request_key, account_ids: clone(account_ids), result });
      audit(state, at, "pool.configured", null, { account_ids });
      return result;
    });
  }

  async proposeReservation(ownerId, { amount_minor, account_ids, request_key }) {
    if (!money(amount_minor) || amount_minor === 0 || !Array.isArray(account_ids) ||
        ![1, 3].includes(account_ids.length) || new Set(account_ids).size !== account_ids.length ||
        !account_ids.every(validId) || !validId(request_key)) throw error("INVALID_RESERVATION_PROPOSAL");
    return this.repository.transact(ownerId, async state => {
      const existing = state.tasks.find(t => t.proposal?.request_key === request_key);
      if (existing) {
        if (existing.proposal.amount_minor !== amount_minor || JSON.stringify(existing.proposal.account_ids) !== JSON.stringify(account_ids)) throw error("IDEMPOTENCY_CONFLICT", 409);
        return clone(existing);
      }
      const view = overview(state, this.now());
      if (!view.balance_fresh ||
          JSON.stringify([...account_ids].sort()) !== JSON.stringify([...view.pool_account_ids].sort()) ||
          amount_minor > view.available_minor) throw error("FUNDING_UNAVAILABLE", 409);
      const at = this.now();
      const task = { task_id: id("mot-task-"), owner_id: ownerId, source: "user_proposal", kind: "RESERVATION_PROPOSAL",
        state: "CREATED", created_at: at, updated_at: at, ledger_revision: state.revision + 1,
        evidence: [], approval: null, review: { status: "PENDING", execution_allowed: false },
        proposal: { amount_minor, account_ids: clone(account_ids), request_key, mode: "SIMULATION_ONLY" } };
      state.tasks.push(task);
      transition(task, "CHECKING", at, { available_minor: view.available_minor, ledger_revision: state.revision });
      if (this.coreRisk) {
        try {
          const review = await this.coreRisk.review({ owner_id: ownerId, task_id: task.task_id,
            ledger_revision: task.ledger_revision, proposal: clone(task.proposal), overview: view });
          if (review?.status === "VERIFIED" && review.risk === "APPROVE" && review.verified === true &&
              validId(review.core_task_id) && validId(review.risk_check_id) && validId(review.proof_id) &&
              review.mode === "SIMULATION_ONLY") {
            task.review = { ...clone(review), execution_allowed: false };
            transition(task, "PENDING_APPROVAL", at, { core_task_id: review.core_task_id, risk_check_id: review.risk_check_id });
          } else {
            task.review = { status: review?.status || "UNAVAILABLE", core: review?.core || "UNAVAILABLE",
              risk: review?.risk || "UNAVAILABLE", execution_allowed: false };
            transition(task, "BLOCKED", at, { reason: "CORE_RISK_NOT_VERIFIED" });
          }
        } catch {
          task.review = { status: "UNKNOWN", core: "UNKNOWN", risk: "UNKNOWN", execution_allowed: false };
          transition(task, "UNKNOWN", at, { reason: "CORE_RISK_OUTCOME_UNKNOWN" });
        }
      } else {
        // No trusted merchant connector is present on main. A proposed action remains blocked.
        transition(task, "BLOCKED", at, { reason: "CORE_RISK_UNAVAILABLE" });
        task.review = { status: "UNAVAILABLE", core: "UNAVAILABLE", risk: "UNAVAILABLE", execution_allowed: false };
      }
      state.revision++;
      audit(state, at, "reservation.proposed", task.task_id, { amount_minor, account_ids, review: task.review });
      return clone(task);
    });
  }

  async proposePayment(ownerId, { amount_minor, account_id, payee_id, currency, request_key }) {
    if (!money(amount_minor) || amount_minor === 0 || !validId(account_id) || !validId(payee_id) ||
        currency !== "CNY" || !validId(request_key)) throw error("INVALID_PAYMENT_PROPOSAL");
    return this.repository.transact(ownerId, async state => {
      const proposal = { amount_minor, account_id, payee_id, currency, request_key, mode: "SIMULATION_ONLY" };
      const fingerprint = createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
      const existing = state.tasks.find(task => task.proposal?.request_key === request_key);
      if (existing) {
        if (existing.kind !== "PAYMENT_PROPOSAL" || existing.proposal_fingerprint !== fingerprint)
          throw error("IDEMPOTENCY_CONFLICT", 409);
        return clone(existing);
      }
      const account = state.accounts.find(row => row.account_id === account_id);
      const view = overview(state, this.now());
      if (!account?.verified || !account.pool || !view.balance_fresh ||
          amount_minor > account.balance_minor || amount_minor > view.available_minor)
        throw error("FUNDING_UNAVAILABLE", 409);
      const at = this.now();
      const task = { task_id: id("mot-task-"), owner_id: ownerId, source: "user_proposal", kind: "PAYMENT_PROPOSAL",
        state: "CREATED", created_at: at, updated_at: at, ledger_revision: state.revision + 1,
        evidence: [], approval: null, review: { status: "PENDING", execution_allowed: false },
        proposal, proposal_fingerprint: fingerprint };
      state.tasks.push(task);
      transition(task, "CHECKING", at, { account_balance_minor: account.balance_minor,
        pool_available_minor: view.available_minor, ledger_revision: state.revision, proposal_fingerprint: fingerprint });
      if (this.coreRisk) {
        try {
          const review = await this.coreRisk.review({ owner_id: ownerId, task_id: task.task_id,
            ledger_revision: task.ledger_revision, proposal: clone(proposal), proposal_fingerprint: fingerprint,
            overview: view });
          if (review?.status === "VERIFIED" && review.risk === "APPROVE" && review.verified === true &&
              validId(review.core_task_id) && validId(review.risk_check_id) && validId(review.proof_id) &&
              review.proposal_fingerprint === fingerprint && review.mode === "SIMULATION_ONLY") {
            task.review = { ...clone(review), execution_allowed: false };
            transition(task, "PENDING_APPROVAL", at, { core_task_id: review.core_task_id,
              risk_check_id: review.risk_check_id, proposal_fingerprint: fingerprint });
          } else {
            task.review = { status: review?.status || "UNAVAILABLE", risk: review?.risk || "UNAVAILABLE",
              execution_allowed: false };
            transition(task, "BLOCKED", at, { reason: "CORE_RISK_NOT_VERIFIED" });
          }
        } catch {
          task.review = { status: "UNKNOWN", risk: "UNKNOWN", execution_allowed: false };
          transition(task, "UNKNOWN", at, { reason: "CORE_RISK_OUTCOME_UNKNOWN" });
        }
      } else {
        task.review = { status: "UNAVAILABLE", core: "UNAVAILABLE", risk: "UNAVAILABLE", execution_allowed: false };
        transition(task, "BLOCKED", at, { reason: "CORE_RISK_UNAVAILABLE" });
      }
      state.revision++;
      audit(state, at, "payment.proposed", task.task_id, { proposal, proposal_fingerprint: fingerprint, review: task.review });
      return clone(task);
    });
  }

  async proposeTransfer(ownerId, { amount_minor, from_account_id, to_account_id, request_key }) {
    if (!money(amount_minor) || amount_minor === 0 || !validId(from_account_id) ||
        !validId(to_account_id) || from_account_id === to_account_id || !validId(request_key))
      throw error("INVALID_TRANSFER_PROPOSAL");
    return this.repository.transact(ownerId, state => {
      const existing = state.tasks.find(t => t.proposal?.request_key === request_key);
      if (existing) {
        if (existing.kind !== "TRANSFER_PROPOSAL" || existing.proposal.amount_minor !== amount_minor ||
            existing.proposal.from_account_id !== from_account_id || existing.proposal.to_account_id !== to_account_id)
          throw error("IDEMPOTENCY_CONFLICT", 409);
        return clone(existing);
      }
      const view = overview(state, this.now());
      const source = state.accounts.find(account => account.account_id === from_account_id);
      const target = state.accounts.find(account => account.account_id === to_account_id);
      if (!source?.verified || !target?.verified || !view.balance_fresh || !source.pool ||
          amount_minor > view.available_minor) throw error("FUNDING_UNAVAILABLE", 409);
      const at = this.now();
      const task = { task_id: id("mot-task-"), owner_id: ownerId, source: "user_proposal", kind: "TRANSFER_PROPOSAL",
        state: "CREATED", created_at: at, updated_at: at, ledger_revision: state.revision + 1,
        evidence: [], approval: null, review: { status: "UNAVAILABLE", core: "UNAVAILABLE", risk: "UNAVAILABLE", execution_allowed: false },
        proposal: { amount_minor, from_account_id, to_account_id, request_key, mode: "SIMULATION_ONLY" } };
      state.tasks.push(task);
      transition(task, "CHECKING", at, { available_minor: view.available_minor, ledger_revision: state.revision });
      transition(task, "BLOCKED", at, { reason: "TRANSFER_CORE_RISK_CONTRACT_UNAVAILABLE" });
      state.revision++;
      audit(state, at, "transfer.proposed", task.task_id, { proposal: task.proposal, review: task.review });
      return clone(task);
    });
  }

  async decideApproval(ownerId, taskId, decision) {
    if (!["APPROVE", "REJECT"].includes(decision)) throw error("INVALID_DECISION");
    return this.repository.transact(ownerId, async state => {
      const task = state.tasks.find(t => t.task_id === taskId);
      if (!task) throw error("TASK_NOT_FOUND", 404);
      if (task.approval) {
        if (task.approval.decision !== decision) throw error("IDEMPOTENCY_CONFLICT", 409);
        return clone(task);
      }
      const at = this.now();
      if (decision === "REJECT" && ["BLOCKED", "UNKNOWN", "PENDING_APPROVAL", "NEEDS_ATTENTION"].includes(task.state)) {
        task.approval = { decision, at, owner_id: ownerId, evidence: "OWNER_REJECTED" };
        transition(task, "CANCELLED", at, { decision });
      } else {
        if (task.state !== "PENDING_APPROVAL" || task.review?.status !== "VERIFIED" ||
            task.review?.risk !== "APPROVE" || !this.coreRisk?.approve) throw error("APPROVAL_NOT_READY", 409);
        if (task.ledger_revision !== state.revision) throw error("STALE_TASK", 409);
        let approval;
        try { approval = await this.coreRisk.approve({ owner_id: ownerId, task_id: taskId,
          ledger_revision: state.revision, review: clone(task.review), decision }); }
        catch { transition(task, "UNKNOWN", at, { reason: "APPROVAL_OUTCOME_UNKNOWN" }); state.revision++;
          audit(state, at, "approval.unknown", taskId); return clone(task); }
        if (approval?.verified !== true || approval?.decision !== "APPROVE" ||
            approval?.task_id !== taskId || approval?.ledger_revision !== state.revision || !validId(approval.proof_id))
          throw error("APPROVAL_NOT_VERIFIED", 409);
        if (task.kind === "PAYMENT_PROPOSAL" && approval.proposal_fingerprint !== task.proposal_fingerprint)
          throw error("APPROVAL_NOT_VERIFIED", 409);
        task.approval = { ...clone(approval), at, owner_id: ownerId, ledger_revision: state.revision + 1,
          ...(task.kind === "PAYMENT_PROPOSAL" ? { expires_at: new Date(Date.parse(at) + 5 * 60_000).toISOString() } : {}) };
      }
      state.revision++;
      audit(state, at, "approval.recorded", taskId, { decision });
      return clone(task);
    });
  }

  async simulate(ownerId, taskId, requestKey) {
    if (!validId(requestKey)) throw error("IDEMPOTENCY_KEY_REQUIRED");
    return this.repository.transact(ownerId, state => {
      const task = state.tasks.find(t => t.task_id === taskId);
      if (!task) throw error("TASK_NOT_FOUND", 404);
      if (task.simulation?.request_key === requestKey) return clone(task.simulation);
       if (!["RESERVATION_PROPOSAL", "PAYMENT_PROPOSAL"].includes(task.kind) || task.state !== "PENDING_APPROVAL" ||
          task.approval?.decision !== "APPROVE" || task.review?.status !== "VERIFIED" ||
          task.review?.risk !== "APPROVE" || task.approval.ledger_revision !== state.revision)
        throw error("SIMULATION_BLOCKED", 409);
      const view = overview(state, this.now());
       if (!view.balance_fresh || task.proposal.amount_minor > view.available_minor)
         throw error("FUNDING_UNAVAILABLE", 409);
       if (task.kind === "RESERVATION_PROPOSAL" &&
           JSON.stringify([...task.proposal.account_ids].sort()) !== JSON.stringify([...view.pool_account_ids].sort()))
         throw error("FUNDING_UNAVAILABLE", 409);
       if (task.kind === "PAYMENT_PROPOSAL") {
         const source = state.accounts.find(row => row.account_id === task.proposal.account_id);
         if (!source?.verified || !source.pool || source.balance_minor < task.proposal.amount_minor ||
             !task.approval.expires_at || Date.parse(task.approval.expires_at) <= Date.parse(this.now()) ||
             task.review.proposal_fingerprint !== task.proposal_fingerprint ||
             task.approval.proposal_fingerprint !== task.proposal_fingerprint) throw error("SIMULATION_BLOCKED", 409);
         const at = this.now();
         const before_minor = source.balance_minor;
         source.balance_minor -= task.proposal.amount_minor;
         source.revision++;
         source.as_of = at;
         const transactionId = id("paper-payment-");
         state.transactions.push({ store_id: null, terminal_id: null, account_id: source.account_id,
           source_system: "PAPER_SIMULATION", external_transaction_id: transactionId,
           amount_minor: task.proposal.amount_minor, currency: "CNY", transaction_type: "PAYMENT",
           status: "SETTLED", occurred_at: at, settled_at: at, as_of: at, revision: 1, due_at: null,
           related_transaction_id: null, transfer_id: null, payee_id: task.proposal.payee_id,
           task_id: taskId, mode: "SIMULATION_ONLY" });
         task.simulation = { receipt_id: id("mot-receipt-"), task_id: taskId, owner_id: ownerId,
           request_key: requestKey, transaction_id: transactionId, account_id: source.account_id,
           payee_id: task.proposal.payee_id, amount_minor: task.proposal.amount_minor, currency: "CNY",
           balance_before_minor: before_minor, balance_after_minor: source.balance_minor,
           proposal_fingerprint: task.proposal_fingerprint, mode: "SIMULATION_ONLY", side_effects: false, at };
         transition(task, "RESOLVED", at, { receipt_id: task.simulation.receipt_id });
         state.revision++;
         audit(state, at, "payment.simulated", taskId, task.simulation);
         return clone(task.simulation);
       }
      const at = this.now();
      const reservation = { reservation_id: id("mot-reservation-"), task_id: taskId, owner_id: ownerId,
        account_ids: clone(task.proposal.account_ids), amount_minor: task.proposal.amount_minor,
        status: "ACTIVE", mode: "PAPER", created_at: at };
      state.reservations.push(reservation);
      task.simulation = { receipt_id: id("mot-receipt-"), task_id: taskId, owner_id: ownerId,
        request_key: requestKey, reservation_id: reservation.reservation_id, amount_minor: reservation.amount_minor,
        mode: "SIMULATION_ONLY", side_effects: false, at };
      transition(task, "RESOLVED", at, { receipt_id: task.simulation.receipt_id });
      state.revision++;
      audit(state, at, "simulation.recorded", taskId, task.simulation);
      return clone(task.simulation);
    });
  }
}

module.exports = { VERSION, MotEngine, empty, fixture, overview, findings, validateFixture, validateState, error };
