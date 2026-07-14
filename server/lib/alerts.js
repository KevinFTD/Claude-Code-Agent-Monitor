/**
 * @file Rules-based alerting engine. Evaluates user-defined alert rules against
 * live activity: event-driven rules (event_pattern, token_threshold) run on
 * every hook ingest, time-based rules (inactivity, status_duration) run on a
 * periodic sweep. Fired alerts are persisted to alert_events with per-scope
 * cooldown dedup and broadcast to clients as `alert_triggered`.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { db, stmts } = require("../db");
const { broadcast } = require("../websocket");

const RULE_TYPES = ["event_pattern", "inactivity", "status_duration", "token_threshold"];
// fleet-monitor: EFFECTIVE agent statuses a status_duration rule may watch —
// "waiting" = blocked on the user (awaiting_reason=action), "idle" = plain
// turn-end wait. Same split the UI shows, so rules can't diverge from it.
const AGENT_STATUSES = ["working", "waiting", "idle"];

// Enabled-rules cache. Hook ingest is hot — re-querying alert_rules on every
// event would be wasted work since rules only change through the CRUD routes,
// which call invalidateRuleCache().
let rulesCache = null;

function invalidateRuleCache() {
  rulesCache = null;
}

function loadEnabledRules() {
  if (rulesCache) return rulesCache;
  rulesCache = stmts.listEnabledAlertRules.all().map((row) => {
    let config = {};
    try {
      config = JSON.parse(row.config || "{}");
    } catch {
      /* tolerate hand-edited bad JSON — rule simply never matches */
    }
    return { ...row, config };
  });
  return rulesCache;
}

/**
 * Validate and normalize a rule config for its type. Returns
 * `{ ok: true, config }` with defaults applied, or `{ ok: false, error }`.
 */
function validateRuleConfig(ruleType, config) {
  if (!RULE_TYPES.includes(ruleType)) {
    return { ok: false, error: `rule_type must be one of: ${RULE_TYPES.join(", ")}` };
  }
  const cfg = config && typeof config === "object" && !Array.isArray(config) ? config : null;
  if (!cfg) return { ok: false, error: "config must be an object" };

  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

  switch (ruleType) {
    case "event_pattern": {
      const out = {};
      for (const key of ["event_type", "tool_name", "summary_contains"]) {
        if (cfg[key] != null) {
          if (typeof cfg[key] !== "string" || !cfg[key].trim()) {
            return { ok: false, error: `${key} must be a non-empty string` };
          }
          out[key] = cfg[key].trim();
        }
      }
      if (!out.event_type && !out.tool_name && !out.summary_contains) {
        return {
          ok: false,
          error: "event_pattern needs at least one of event_type, tool_name, summary_contains",
        };
      }
      const count = cfg.count == null ? 1 : num(cfg.count);
      if (!count || !Number.isInteger(count)) {
        return { ok: false, error: "count must be a positive integer" };
      }
      out.count = count;
      if (count > 1) {
        const window = cfg.window_minutes == null ? 5 : num(cfg.window_minutes);
        if (!window) return { ok: false, error: "window_minutes must be a positive number" };
        out.window_minutes = window;
      }
      return { ok: true, config: out };
    }
    case "inactivity": {
      const minutes = num(cfg.minutes);
      if (!minutes) return { ok: false, error: "minutes must be a positive number" };
      return { ok: true, config: { minutes } };
    }
    case "status_duration": {
      if (!AGENT_STATUSES.includes(cfg.status)) {
        return { ok: false, error: `status must be one of: ${AGENT_STATUSES.join(", ")}` };
      }
      const minutes = num(cfg.minutes);
      if (!minutes) return { ok: false, error: "minutes must be a positive number" };
      return { ok: true, config: { status: cfg.status, minutes } };
    }
    case "token_threshold": {
      const total = num(cfg.total_tokens);
      if (!total || !Number.isInteger(total)) {
        return { ok: false, error: "total_tokens must be a positive integer" };
      }
      return { ok: true, config: { total_tokens: total } };
    }
    default:
      return { ok: false, error: "unsupported rule_type" };
  }
}

/**
 * Fire an alert unless the same rule already fired for the same scope inside
 * its cooldown window. Persists the alert row and broadcasts it. Returns the
 * inserted row, or null when suppressed by cooldown.
 */
function fireAlert(rule, { sessionId = null, agentId = null, message, details = null }) {
  const last = stmts.lastAlertFor.get(rule.id, sessionId, agentId);
  if (last) {
    const elapsedMs = Date.now() - new Date(last.triggered_at).getTime();
    if (elapsedMs < rule.cooldown_seconds * 1000) return null;
  }

  const info = stmts.insertAlertEvent.run(
    rule.id,
    rule.name,
    rule.rule_type,
    sessionId,
    agentId,
    message,
    details ? JSON.stringify(details) : null
  );
  const alert = stmts.getAlertEvent.get(info.lastInsertRowid);
  broadcast("alert_triggered", alert);

  // Fan out to configured webhook targets. Detached and fail-safe — webhook
  // delivery must never slow or break alert firing. Lazy-required to keep the
  // module graph acyclic and tolerate any load-order edge case.
  try {
    const { dispatchAlert } = require("./webhooks");
    Promise.resolve(dispatchAlert(alert)).catch(() => {});
  } catch (err) {
    console.warn("[ALERTS] webhook dispatch failed:", err?.message || err);
  }

  return alert;
}

// Dynamic count-in-window queries vary by which pattern fields a rule sets;
// cache prepared statements by their SQL so hot rules don't re-prepare.
const countStmtCache = new Map();

function countMatchingEvents(sessionId, cfg) {
  const where = ["session_id = ?", "created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)"];
  const params = [sessionId, `-${cfg.window_minutes * 60} seconds`];
  if (cfg.event_type) {
    where.push("event_type = ?");
    params.push(cfg.event_type);
  }
  if (cfg.tool_name) {
    where.push("tool_name = ?");
    params.push(cfg.tool_name);
  }
  if (cfg.summary_contains) {
    where.push("LOWER(COALESCE(summary, '')) LIKE ?");
    params.push(`%${cfg.summary_contains.toLowerCase()}%`);
  }
  const sql = `SELECT COUNT(*) as count FROM events WHERE ${where.join(" AND ")}`;
  let stmt = countStmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    countStmtCache.set(sql, stmt);
  }
  return stmt.get(...params).count;
}

function matchesPattern(event, cfg) {
  if (cfg.event_type && event.event_type !== cfg.event_type) return false;
  if (cfg.tool_name && event.tool_name !== cfg.tool_name) return false;
  if (
    cfg.summary_contains &&
    !(event.summary || "").toLowerCase().includes(cfg.summary_contains.toLowerCase())
  ) {
    return false;
  }
  return true;
}

// Token totals only move on hooks that read the transcript — skip the SUM
// query for the rest of the event stream.
const TOKEN_BEARING_EVENTS = new Set(["PostToolUse", "Stop", "SubagentStop", "SessionEnd"]);

// Sweep queries are static — prepare once at module load instead of on every
// 60s tick. The time window arrives as a strftime modifier parameter.
const staleSessionsStmt = db.prepare(
  `SELECT id, name FROM sessions
   WHERE status = 'active'
     AND updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`
);
const stuckAgentsStmt = db.prepare(
  // Match on the EFFECTIVE status (fleet-monitor): base "waiting" splits into
  // "waiting" (awaiting_reason=action) vs "idle", mirroring the UI so a rule
  // watching "waiting" only fires on genuinely-blocked agents.
  `SELECT a.id, a.session_id, a.name FROM agents a
   JOIN sessions s ON s.id = a.session_id
   WHERE s.status = 'active'
     AND (CASE
            WHEN a.status = 'waiting' AND a.awaiting_reason = 'action' THEN 'waiting'
            WHEN a.status = 'waiting' THEN 'idle'
            ELSE a.status
          END) = ?
     AND a.updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`
);

/**
 * Evaluate event-driven rules against one freshly ingested event. Must never
 * throw — hook ingestion stays fail-safe regardless of rule misconfiguration.
 */
function evaluateEvent(event) {
  if (!event || !event.session_id) return;
  let rules;
  try {
    rules = loadEnabledRules();
  } catch (err) {
    console.warn("[ALERTS] rule load failed:", err?.message || err);
    return;
  }

  for (const rule of rules) {
    try {
      if (rule.rule_type === "event_pattern") {
        const cfg = rule.config;
        if (!matchesPattern(event, cfg)) continue;
        if (cfg.count > 1) {
          const seen = countMatchingEvents(event.session_id, cfg);
          if (seen < cfg.count) continue;
          fireAlert(rule, {
            sessionId: event.session_id,
            agentId: event.agent_id || null,
            message: `${rule.name}: ${seen} matching events in ${cfg.window_minutes} min (threshold ${cfg.count})`,
            details: { matched: cfg, observed_count: seen, last_event_type: event.event_type },
          });
        } else {
          fireAlert(rule, {
            sessionId: event.session_id,
            agentId: event.agent_id || null,
            message: `${rule.name}: event matched (${event.event_type}${event.tool_name ? ` · ${event.tool_name}` : ""})`,
            details: { matched: cfg, summary: event.summary || null },
          });
        }
      } else if (rule.rule_type === "token_threshold") {
        if (!TOKEN_BEARING_EVENTS.has(event.event_type)) continue;
        const totals = stmts.sessionTokenTotals.get(event.session_id);
        const total =
          totals.input_tokens +
          totals.output_tokens +
          totals.cache_read_tokens +
          totals.cache_write_tokens;
        if (total < rule.config.total_tokens) continue;
        fireAlert(rule, {
          sessionId: event.session_id,
          message: `${rule.name}: session used ${total.toLocaleString()} tokens (threshold ${rule.config.total_tokens.toLocaleString()})`,
          details: { total_tokens: total, threshold: rule.config.total_tokens },
        });
      }
    } catch (err) {
      console.warn(`[ALERTS] rule "${rule.name}" evaluation failed:`, err?.message || err);
    }
  }
}

/**
 * Evaluate time-based rules (inactivity, status_duration). Called by the
 * periodic sweep; exported so tests can invoke it deterministically.
 */
function sweepTimeRules() {
  let rules;
  try {
    rules = loadEnabledRules();
  } catch (err) {
    console.warn("[ALERTS] rule load failed:", err?.message || err);
    return;
  }

  for (const rule of rules) {
    try {
      if (rule.rule_type === "inactivity") {
        // sessions.updated_at is bumped on every ingested event (touchSession),
        // so "stale updated_at on an active session" ≡ "no events for N min".
        const stale = staleSessionsStmt.all(`-${rule.config.minutes * 60} seconds`);
        for (const session of stale) {
          fireAlert(rule, {
            sessionId: session.id,
            message: `${rule.name}: no activity on "${session.name || session.id}" for ${rule.config.minutes} min`,
            details: { minutes: rule.config.minutes },
          });
        }
      } else if (rule.rule_type === "status_duration") {
        // agents.updated_at moves on any agent update (status flips, tool
        // changes), so this detects agents *stuck* in a status with no
        // activity — the hung-agent case the rule exists for.
        const stuck = stuckAgentsStmt.all(
          rule.config.status,
          `-${rule.config.minutes * 60} seconds`
        );
        for (const agent of stuck) {
          fireAlert(rule, {
            sessionId: agent.session_id,
            agentId: agent.id,
            message: `${rule.name}: agent "${agent.name}" stuck in ${rule.config.status} for ${rule.config.minutes} min`,
            details: { status: rule.config.status, minutes: rule.config.minutes },
          });
        }
      }
    } catch (err) {
      console.warn(`[ALERTS] rule "${rule.name}" sweep failed:`, err?.message || err);
    }
  }
}

// Periodic sweep for the time-based rules. unref'd so it never keeps the
// process (or the test runner) alive — same pattern as the hooks watchdog.
const SWEEP_INTERVAL_MS = 60_000;
const sweepTimer = setInterval(sweepTimeRules, SWEEP_INTERVAL_MS);
if (sweepTimer.unref) sweepTimer.unref();

module.exports = {
  RULE_TYPES,
  validateRuleConfig,
  evaluateEvent,
  sweepTimeRules,
  fireAlert,
  invalidateRuleCache,
};
