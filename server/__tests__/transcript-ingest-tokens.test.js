/**
 * @file Tests that the fleet transcript-ingest route populates token usage (and
 * therefore cost) from the UPLOADED snapshot. Remote/fleet sessions send hook
 * events whose `transcript_path` points at the originating machine's disk, so
 * the hooks path can never read it here; the uploaded snapshot is the only copy
 * of the transcript on the central host. This verifies the ingest write extracts
 * `usage` records into token_usage, stays a no-op (no throw) when the session
 * row doesn't exist yet, and backfills on a later flush once it does.
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-ingest-tokens-"));
process.env.DASHBOARD_DATA_DIR = TMP;
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.DASHBOARD_TOKEN = "test-token-123"; // ingest fails closed without one

const { createApp, startServer } = require("../index");
const { stmts } = require("../db");

let server;
let BASE;

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// Two assistant turns with usage — the shape TranscriptCache.extract() reads
// (entry.message.model + entry.message.usage).
function transcriptBody() {
  const lines = [
    { type: "user", message: { role: "user", content: "hi" } },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 1500, output_tokens: 400, cache_read_input_tokens: 0 },
      },
    },
  ];
  return Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function postTranscript(sid, body, { mode = "truncate", offset = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/ingest/transcript/${sid}?mode=${mode}`, BASE);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          Authorization: "Bearer test-token-123",
          "X-Expected-Offset": String(offset),
          "Content-Length": body.length,
        },
      },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sessionOutputTokens(sid) {
  return stmts.getTokensBySession.all(sid).reduce((sum, r) => sum + (r.output_tokens || 0), 0);
}

describe("transcript-ingest → token_usage", () => {
  before(async () => {
    const app = createApp();
    server = await startServer(app, 0);
    const addr = server.address();
    BASE = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    if (server) server.close();
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("stores the snapshot but writes NO token rows when the session doesn't exist yet", async () => {
    const res = await postTranscript(SID, transcriptBody());
    assert.equal(res.status, 200, res.body);
    // File landed…
    assert.ok(fs.existsSync(path.join(TMP, "transcripts", `${SID}.jsonl`)));
    // …but token_usage stays empty (FK guard: session row not created yet).
    assert.equal(sessionOutputTokens(SID), 0);
  });

  it("populates token_usage from the snapshot once the session exists", async () => {
    stmts.insertSession.run(SID, "Fleet session", "active", "/tmp/proj", "claude-opus-4-8", null);
    // A later flush (truncate rewrite is what the client sends on resync) now
    // extracts usage from the already-present transcript.
    const res = await postTranscript(SID, transcriptBody());
    assert.equal(res.status, 200, res.body);

    const rows = stmts.getTokensBySession.all(SID);
    assert.ok(rows.length >= 1, "expected at least one token_usage bucket");
    // 200 + 400 output tokens across the two assistant turns.
    assert.equal(sessionOutputTokens(SID), 600);
    const totalInput = rows.reduce((s, r) => s + (r.input_tokens || 0), 0);
    assert.equal(totalInput, 2500);
  });

  it("is idempotent — re-ingesting the same transcript does not double-count", async () => {
    const res = await postTranscript(SID, transcriptBody());
    assert.equal(res.status, 200, res.body);
    assert.equal(sessionOutputTokens(SID), 600); // unchanged, not 1200
  });
});
