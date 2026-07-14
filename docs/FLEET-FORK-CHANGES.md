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

Touched:
- `client/src/lib/types.ts` — `effectiveAgentStatus` / `effectiveSessionStatus`,
  `IDLE_STATUS`, `STATUS_CONFIG` / `SESSION_STATUS_CONFIG` colors.
- `client/src/components/{StatusBadge,SessionCard,AgentCard}.tsx`,
  `client/src/pages/KanbanBoard.tsx` — columns `等待中 → 活跃 → 空闲中 → 完成 →
  错误 → 废弃`.
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

## Verification

`npm run test:client` (253) and `npm run test:server` (636, incl. the new
transcript-ingest token test) pass. Screen snapshots regenerated for the status
color/label changes.
