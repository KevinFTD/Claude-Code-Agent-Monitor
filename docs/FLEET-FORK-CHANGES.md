# Fleet-fork changes (`fleet-monitor` branch)

This branch is a personal fork of CCAM adapted to run as the **central dashboard
for a Tailscale fleet** (many machines / devcontainers reporting into one server).
The overall system design lives in the sibling `claude-fleet-monitor` repo
(`DESIGN.md`); this file records the changes made **inside this repo**, so the
delta from upstream is auditable in one place.

Deployment target: a tailnet-only VPS, fronted by Caddy (HTTPS via Cloudflare
DNS-01). See `claude-fleet-monitor/deploy/` for the compose/Caddy layer.

## 1. Remote transcript ingest → snapshot store

`server/routes/transcript-ingest.js` (added earlier for conversation replay)
receives transcript JSONL pushed from other machines and writes it to the durable
snapshot store (`getTranscriptSnapshotDir()/<sid>.jsonl`), the same store the
replay route already falls back to. Upload protocol: incremental, expected-offset
CAS + tail hash, per-session serialized, fails closed without a token.

## 2. Token usage / cost from the uploaded snapshot

**Problem:** remote sessions showed `cost = 0`. Token usage is parsed from the
transcript, but `hooks.js` reads `data.transcript_path` — a path on the
*reporting* machine that doesn't exist on the central host — so extraction always
no-ops and `token_usage` stays empty.

**Fix (`server/routes/transcript-ingest.js`):** after each snapshot write, run the
existing `TranscriptCache.extract()` + `stmts.replaceTokenUsage` against the
**snapshot file** (which does exist here). A module-level, path-keyed
`TranscriptCache` keeps extraction incremental across flushes; `replaceTokenUsage`
is an idempotent, compaction-aware UPSERT so re-ingesting never double-counts.
Guarded so a snapshot write never fails on extraction, and a no-op until the
session row exists (FK). Server-only — no reporter change, all fleet machines get
cost automatically. Existing snapshots are backfilled by re-running extraction
over `data/transcripts/*.jsonl`.

Test: `server/__tests__/transcript-ingest-tokens.test.js`.

## 3. First-class `waiting` vs `idle` status split

Upstream conflated two very different situations under "waiting". This fork makes
them two first-class statuses, computed identically on client and server from
`awaiting_reason`:

- **waiting (需操作)** — a permission/decision request; the user is blocked *now*
  (`awaiting_reason === "action"`). Rendered red, pulsing.
- **idle (空闲中)** — Claude finished its turn, plain output, not blocking
  (`awaiting_reason === "idle"` or legacy null). Rendered neutral gray.

`awaiting_reason` is stamped in `server/routes/hooks.js` from two hook signals:
the **`PermissionRequest`** hook (fires the moment a tool-permission dialog
appears — the reliable needs-action signal → `action`) and the **`Notification`**
hook (best-effort; classified into action/idle/null). `Notification` alone was
unreliable — it fires "after the notification occurs" and often not at all for a
focused-terminal permission prompt — so machines must also register a
`PermissionRequest` hook pointing at the reporter. The needs-action browser
notification and the broadcast both gate on the server-computed `awaiting_reason`
(no client-side re-classification).

**Subagent hook events must not clear it.** Claude Code stamps `agent_id`
(+ `agent_type`) on every hook payload emitted from inside a subagent
(PreToolUse / PostToolUse / PermissionRequest / SubagentStop of an Agent-tool
child); main-thread payloads carry neither. A backgrounded subagent keeps
issuing tool calls while the main thread sits blocked on a permission prompt, and
upstream's blanket "any PreToolUse/PostToolUse clears awaiting" turned that into
a false 活跃 within seconds of the dialog appearing (seen 2026-09-03: main blocked
on Bash, a `favie-executor` subagent editing files). `server/routes/hooks.js`
now keeps an in-memory per-session set of agents with an open dialog
(`pendingPermissions`, keyed `"main"` or the subagent's `agent_id`, filled by
`PermissionRequest`): a main-thread tool event clears 等待中 unless another
agent's dialog is still open; a subagent's tool event clears it only when *its
own* dialog was the last one open. `SubagentStop` drops the ending agent's key
so a torn-down subagent cannot pin 等待中. Subagent events also no longer promote
the main agent to `working` or overwrite its `current_tool`. In-memory by design:
after a restart the set is empty, which degrades to "only main-thread events
clear" — never to a false 活跃.

Touched:
- `client/src/lib/types.ts` — `effectiveAgentStatus` / `effectiveSessionStatus`,
  `IDLE_STATUS`, `STATUS_CONFIG` / `SESSION_STATUS_CONFIG` colors.
- `client/src/components/{StatusBadge,SessionCard,AgentCard}.tsx`,
  `client/src/pages/KanbanBoard.tsx` — columns `等待中 → 活跃 → 空闲中 → 完成 →
  错误 → 废弃`.
- `server/routes/hooks.js` — `pendingPermissions` / `toolEventResolvesAwaiting`
  (subagent-originated hook events, see above); regression tests in
  `server/__tests__/api.test.js` ("keeps 等待中 while a background subagent…").
- `server/lib/alerts.js` — stuck-agent match uses the **effective** status via a
  SQL CASE (so `AGENT_STATUSES` includes `idle`), keeping alerts in lockstep with
  the UI — no front/back divergence.
- `client/src/lib/event-grouping.ts` — the Activity-feed **event-category** axis
  is separate from session status; its neutral bucket was renamed `waiting → idle`
  (PostToolUse/Stop/default) so event badges stay gray instead of turning red.
  Mirrored in `EventFilters.tsx` / `EventFiltersInfo.tsx` and i18n.
- i18n `common.json` / `kanban.json` across en/zh/vi/ko.

## 4. Notifications behind a token + local-notification fallback

The dashboard's push calls used raw `fetch` and bypassed the `x-dashboard-token`
header that `api.ts` injects, so every `/api/push/*` call 401'd once a
`DASHBOARD_TOKEN` was set (as on the fleet server).

- `client/src/lib/push.ts`, `client/src/hooks/useNotifications.ts`,
  `client/src/pages/Settings.tsx` — all push calls now send `x-dashboard-token`.
- Server-relayed Web Push can't reach Chrome from a mainland-China VPS
  (`fcm.googleapis.com` is blocked), so `notify()` now inspects the
  `/api/push/send` response and, when nothing was actually delivered
  (`pushed < 1`) — or the request threw — falls back to a **local** notification
  (`showLocalNotification`, exported from `push.ts`). The "Send Test" button shows
  a local notification directly. Local notifications require the dashboard tab to
  be open; a fully-closed tab still relies on server push (unavailable here).

## 5. Session-detail endpoint no longer embeds the full event log

`GET /api/sessions/:id` returned **every** event row for the session
(`listEventsBySession.all()`). A long-lived session accumulated 5k+ events →
a 24 MB JSON response, which on a slow Mac↔VPS tailnet link (~130 KB/s
observed) took minutes to download — the session-detail page sat on its
skeleton forever ("刷不出来"). The client never even used the field: the detail
page pulls events through the paginated `/api/events` endpoint.

- `server/routes/sessions.js` — the detail response is now
  `{ session, agents, workflows }` (24 MB → ~16 KB for the worst session).
- `server/openapi.js` — `SessionDetailResponse` schema updated to match.
- `client/src/lib/api.ts` — `sessions.get` return type updated.
- `bin/ccam.js` — the CLI's "Recent events" block now fetches
  `/api/events?session_id=<id>&limit=10` instead of reading the embedded array.

## Verification

`npm run test:client` (253) and `npm run test:server` (637, incl. the new
transcript-ingest token test) pass. Screen snapshots regenerated for the status
color/label changes.
