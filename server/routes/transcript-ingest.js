/**
 * @file transcript-ingest.js
 * @description Fleet add-on (claude-fleet-monitor): receives Claude Code
 * transcript JSONL pushed from OTHER machines/containers and writes it into the
 * dashboard's durable snapshot store (`getTranscriptSnapshotDir()/<sid>.jsonl`),
 * which the Conversation view already falls back to when no live transcript is
 * on this host. This is what makes full conversation replay work for remote
 * sessions.
 *
 * Upload protocol (incremental, safe under concurrent uploaders):
 *   GET  /api/ingest/transcript/:sid/size  -> { bytes, tail }
 *        bytes = current snapshot size; tail = sha256 of its last TAIL_BYTES.
 *   POST /api/ingest/transcript/:sid?mode=append|truncate
 *        Content-Type: application/octet-stream, header X-Expected-Offset: N
 *        - mode=truncate: replace the file with the body (start of a rewrite),
 *          written atomically (tmp + rename) so readers never see a half file
 *        - mode=append:   only if current size === N, else 409 (lost race /
 *          stale offset); the client re-syncs on its next turn.
 *   Writes are serialized per sessionId so two uploaders can't interleave.
 *
 * Mounted under /api/ingest AFTER the /api tokenGuard. As defense against a
 * misconfigured central server (no DASHBOARD_TOKEN => tokenGuard is a no-op and
 * the whole API is open on the bound interface), ingest additionally FAILS
 * CLOSED with 503 when no token is configured.
 *
 * Beyond durable replay, each write also extracts token usage from the snapshot
 * and persists it (see extractSnapshotTokens), which is what gives remote/fleet
 * sessions a non-zero cost — their hook events point at a transcript_path that
 * only exists on the originating machine, so this uploaded copy is the sole
 * source of `usage` records on the central host.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { getTranscriptSnapshotDir } = require("../lib/claude-home");
const { getDashboardToken } = require("../lib/security");
const { stmts } = require("../db");
const { broadcast } = require("../websocket");
const TranscriptCache = require("../lib/transcript-cache");

const router = express.Router();

// Shared, path-keyed cache so token extraction over a session's snapshot is
// INCREMENTAL across flushes (reads only the appended delta), mirroring how
// hooks.js reuses one TranscriptCache for the live transcript. Fleet sessions'
// hook events carry a `transcript_path` that lives on the REMOTE machine and is
// unreadable here, so the hooks path never extracts tokens for them; the
// uploaded snapshot below is the only copy of the transcript on this host, so
// we extract usage from it right after each write. Without this, cost is always
// 0 for remote sessions even though the transcript (with its `usage` records)
// has arrived. Extraction is idempotent: replaceTokenUsage is a compaction-aware
// UPSERT, so re-running over the same/regrown file never double-counts.
const snapshotTokenCache = new TranscriptCache();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // one chunk (client caps at 4 MB) + margin
const TAIL_BYTES = 4096; // rewrite-detection overlap window (must match the client)

// Normalize + validate a session id; returns the lowercase UUID or null. Lower-
// casing keeps one snapshot file per session on case-sensitive filesystems.
function normSid(raw) {
  const sid = String(raw || "").toLowerCase();
  return UUID_RE.test(sid) ? sid : null;
}

function snapshotPath(sid) {
  return path.join(getTranscriptSnapshotDir(), `${sid}.jsonl`);
}

/**
 * Parse token usage out of a session's freshly-written snapshot and persist it,
 * so remote (fleet) sessions get non-zero cost. Best-effort and fully guarded:
 * a snapshot write must never fail because token extraction did. No-ops when the
 * session row doesn't exist yet (token_usage.session_id is a FK) — the next
 * flush retries once the hook events have created the session. Returns true when
 * at least one token bucket was written.
 * @param {string} sid Lowercased session UUID.
 * @param {string} p Absolute path to the snapshot JSONL on THIS host.
 */
function extractSnapshotTokens(sid, p) {
  try {
    if (!stmts.getSession.get(sid)) return false; // session not created yet
    const result = snapshotTokenCache.extract(p);
    if (!result || !result.tokensByModel) return false;
    let wrote = false;
    for (const tokens of Object.values(result.tokensByModel)) {
      stmts.replaceTokenUsage.run(
        sid,
        tokens.model,
        tokens.speed,
        tokens.geo,
        tokens.tier,
        tokens.input,
        tokens.output,
        tokens.cacheRead,
        tokens.cacheWrite,
        tokens.cacheWrite1h,
        tokens.webSearch,
        tokens.webFetch,
        tokens.codeExec
      );
      wrote = true;
    }
    if (wrote) {
      // Nudge the UI to recompute cost. The session row itself carries no cost
      // field (the sessions route derives it on read), so this just prompts a
      // refresh; the new total lands on the next /api/sessions fetch.
      const row = stmts.getSession.get(sid);
      if (row) broadcast("session_updated", row);
    }
    return wrote;
  } catch {
    // Never let cost extraction break transcript ingestion.
    return false;
  }
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// sha256 of the last TAIL_BYTES bytes of a file (or null if empty/absent). Only
// the bytes actually read are hashed, so a concurrent truncate can't fold
// uninitialized buffer memory into the digest.
function tailHash(p) {
  const size = fileSize(p);
  if (size === 0) return null;
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  let fd;
  try {
    fd = fs.openSync(p, "r");
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got);
      if (n === 0) break;
      got += n;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return crypto.createHash("sha256").update(buf.subarray(0, got)).digest("hex");
}

// Per-session write serialization: chain each op after the previous one.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // run fn regardless of prior outcome
  const guarded = run.catch(() => {});
  locks.set(key, guarded);
  guarded.then(() => {
    if (locks.get(key) === guarded) locks.delete(key);
  });
  return run;
}

// Fail closed when the server has no token configured (see file header).
function requireToken(res) {
  if (!getDashboardToken()) {
    res
      .status(503)
      .json({ error: { code: "ENOTOKEN", message: "ingest disabled: set DASHBOARD_TOKEN" } });
    return false;
  }
  return true;
}

// GET /api/ingest/transcript/:sid/size
router.get("/transcript/:sid/size", (req, res) => {
  if (!requireToken(res)) return;
  const sid = normSid(req.params.sid);
  if (!sid) {
    return res.status(400).json({ error: { code: "EBADSID", message: "invalid session id" } });
  }
  const p = snapshotPath(sid);
  return res.json({ bytes: fileSize(p), tail: tailHash(p) });
});

// POST /api/ingest/transcript/:sid?mode=append|truncate
// express.raw buffers the octet-stream body (enforcing the size limit with a
// clean 413) and, crucially, skips requests express.json already consumed —
// so an accidental application/json POST yields a non-Buffer body we reject,
// rather than hanging on a stream that will never emit 'end' again.
router.post(
  "/transcript/:sid",
  express.raw({ type: () => true, limit: MAX_BODY_BYTES }),
  async (req, res) => {
    if (!requireToken(res)) return;
    const sid = normSid(req.params.sid);
    if (!sid) {
      return res.status(400).json({ error: { code: "EBADSID", message: "invalid session id" } });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      return res
        .status(400)
        .json({ error: { code: "EBODY", message: "send raw bytes (application/octet-stream)" } });
    }
    const mode = req.query.mode === "truncate" ? "truncate" : "append";
    const expected = Number.parseInt(req.get("X-Expected-Offset") || "0", 10) || 0;

    try {
      const result = await withLock(sid, () => {
        const p = snapshotPath(sid);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const current = fileSize(p);

        if (mode === "truncate") {
          // Atomic replace so watchdog / Conversation readers never see a half
          // file mid-rewrite.
          const tmp = `${p}.tmp`;
          fs.writeFileSync(tmp, body);
          fs.renameSync(tmp, p);
        } else {
          if (current !== expected) {
            return { conflict: true, current };
          }
          fs.appendFileSync(p, body);
        }
        const size = fileSize(p);
        return { conflict: false, bytes: size, tail: tailHash(p) };
      });

      if (result.conflict) {
        return res.status(409).json({
          error: { code: "EOFFSET", message: "offset mismatch", currentSize: result.current },
        });
      }
      // Populate token usage / cost from the snapshot we just wrote (the only
      // readable copy of a remote session's transcript on this host).
      extractSnapshotTokens(sid, snapshotPath(sid));
      return res.json({ bytes: result.bytes, tail: result.tail });
    } catch (e) {
      return res.status(500).json({ error: { code: "EWRITE", message: e.message } });
    }
  }
);

module.exports = router;
