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
 *        bytes = current snapshot size; tail = sha256 of its last 256 bytes.
 *   POST /api/ingest/transcript/:sid?mode=append|truncate
 *        header X-Expected-Offset: N
 *        - mode=truncate: replace the file with the body (start of a rewrite)
 *        - mode=append:   only if current size === N, else 409 (lost race /
 *          stale offset); the client re-syncs on its next turn.
 *   Writes are serialized per sessionId so two uploaders can't interleave.
 *
 * Mounted under /api/ingest AFTER the /api tokenGuard, so every call requires
 * the dashboard token (unlike /api/hooks which is token-exempt).
 */
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { getTranscriptSnapshotDir } = require("../lib/claude-home");

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // one chunk (client caps at 4 MB) + margin
const TAIL_BYTES = 256;

function snapshotPath(sid) {
  return path.join(getTranscriptSnapshotDir(), `${sid}.jsonl`);
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// sha256 of the last TAIL_BYTES bytes of a file (or null if empty/absent).
function tailHash(p) {
  const size = fileSize(p);
  if (size === 0) return null;
  const start = Math.max(0, size - TAIL_BYTES);
  const len = size - start;
  const buf = Buffer.allocUnsafe(len);
  let fd;
  try {
    fd = fs.openSync(p, "r");
    let got = 0;
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
  return crypto.createHash("sha256").update(buf).digest("hex");
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let killed = false;
    req.on("data", (c) => {
      if (killed) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        killed = true;
        const e = new Error("payload too large");
        e.statusCode = 413;
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => !killed && resolve(Buffer.concat(chunks)));
    req.on("error", (e) => !killed && reject(e));
  });
}

// GET /api/ingest/transcript/:sid/size
router.get("/transcript/:sid/size", (req, res) => {
  const sid = req.params.sid;
  if (!UUID_RE.test(sid)) {
    return res.status(400).json({ error: { code: "EBADSID", message: "invalid session id" } });
  }
  const p = snapshotPath(sid);
  return res.json({ bytes: fileSize(p), tail: tailHash(p) });
});

// POST /api/ingest/transcript/:sid?mode=append|truncate
router.post("/transcript/:sid", async (req, res) => {
  const sid = req.params.sid;
  if (!UUID_RE.test(sid)) {
    return res.status(400).json({ error: { code: "EBADSID", message: "invalid session id" } });
  }
  const mode = req.query.mode === "truncate" ? "truncate" : "append";
  const expected = Number.parseInt(req.get("X-Expected-Offset") || "0", 10) || 0;

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    const code = e.statusCode === 413 ? 413 : 400;
    return res.status(code).json({ error: { code: "EBODY", message: e.message } });
  }

  try {
    const result = await withLock(sid, () => {
      const p = snapshotPath(sid);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const current = fileSize(p);

      if (mode === "truncate") {
        fs.writeFileSync(p, body);
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
    return res.json({ bytes: result.bytes, tail: result.tail });
  } catch (e) {
    return res.status(500).json({ error: { code: "EWRITE", message: e.message } });
  }
});

module.exports = router;
