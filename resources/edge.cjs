/**
 * StealthPOS Connector (BOS Edge) — zero-dependency single-file build.
 *
 * Uses only Node built-ins (fs, path, crypto, http/s — fetch is built-in
 * since Node 18). No chokidar, no npm install required. Polls the watch
 * directory every BOS_POLL_MS for new files.
 *
 * Required env:
 *   BOS_EDGE_SECRET   shared secret matching the cloud's BOS_EDGE_SECRET
 *   BOS_STORE_ID      integer store ID
 *   BOS_CLOUD_URL     e.g. https://stealthpos.net
 *   BOS_WATCH_DIR     absolute path to folder Passport drops XML into
 *
 * Optional env:
 *   BOS_MODE         "owner" | "mirror"   default "mirror" for side-by-side
 *   BOS_POLL_MS      default 5000
 *   BOS_RETRY_MS     default 30000
 *   BOS_GLOB         file pattern (suffix match), default ".xml"
 *   BOS_OUTBOX_DIR   default $BOS_WATCH_DIR/.outbox
 *   BOS_SEEN_DB      default $BOS_WATCH_DIR/.bos-seen.log
 */
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const config = {
  secret: required("BOS_EDGE_SECRET"),
  storeId: parseInt(required("BOS_STORE_ID"), 10),
  cloudUrl: required("BOS_CLOUD_URL").replace(/\/+$/, ""),
  watchDir: path.resolve(required("BOS_WATCH_DIR")),
  mode: process.env.BOS_MODE || "mirror",
  pollMs: parseInt(process.env.BOS_POLL_MS || "5000", 10),
  retryMs: parseInt(process.env.BOS_RETRY_MS || "30000", 10),
  glob: (process.env.BOS_GLOB || ".xml").toLowerCase(),
  // Min file age before we grab it. Default 2s avoids reading a half-written
  // file. Set 0 to grab the instant it appears (XMLGateway drops complete
  // files atomically) — needed to win the race vs another consumer (Modisoft)
  // that deletes files seconds after Passport writes them.
  minAgeMs: parseInt(process.env.BOS_MIN_AGE_MS || "2000", 10),
};
// Work dirs default to a LOCAL folder — never inside the watch dir — so in
// mirror mode we never write a single byte into the shared POS folder.
const DATA_DIR = path.join(os.homedir() || os.tmpdir(), ".stealthpos-connector");
config.outboxDir = process.env.BOS_OUTBOX_DIR
  ? path.resolve(process.env.BOS_OUTBOX_DIR)
  : path.join(DATA_DIR, "outbox");
config.seenDb = process.env.BOS_SEEN_DB
  ? path.resolve(process.env.BOS_SEEN_DB)
  : path.join(DATA_DIR, "seen.log");

if (!["owner", "mirror"].includes(config.mode)) {
  console.error(`BOS_MODE must be "owner" or "mirror" (got "${config.mode}")`);
  process.exit(1);
}
if (!Number.isFinite(config.storeId) || config.storeId < 1) {
  console.error("BOS_STORE_ID must be a positive integer");
  process.exit(1);
}

// SAFETY (mirror mode = running side-by-side with Modisoft): never write inside
// the shared watch dir. If the outbox/seen paths resolve under it, refuse to
// start so we can't disturb the POS share or another consumer's files.
if (config.mode === "mirror") {
  const inside = (p) =>
    p === config.watchDir || p.startsWith(config.watchDir + path.sep);
  if (inside(config.outboxDir) || inside(config.seenDb)) {
    console.error(
      "Refusing to start: in mirror mode BOS_OUTBOX_DIR and BOS_SEEN_DB must be " +
        "LOCAL paths OUTSIDE BOS_WATCH_DIR, so the Edge never writes to the shared " +
        "POS folder. Point them at e.g. C:\\StealthPOS\\outbox and C:\\StealthPOS\\seen.log.",
    );
    process.exit(1);
  }
}

// Owner mode MOVES files out of the watch dir — never run it against a network
// share another app (Modisoft) owns, or we'd starve their consumer.
if (config.mode === "owner") {
  const isUnc = /^(\\\\|\/\/)/.test(process.env.BOS_WATCH_DIR || "");
  if (isUnc && process.env.BOS_ALLOW_OWNER_ON_SHARE !== "1") {
    console.error(
      "Refusing owner mode on a network share (it MOVES files and would starve " +
        "Modisoft). Use BOS_MODE=mirror, or set BOS_ALLOW_OWNER_ON_SHARE=1 only if this " +
        "Edge truly owns the share.",
    );
    process.exit(1);
  }
}

const INGEST_URL = `${config.cloudUrl}/api/app/passportBos/ingest`;
const HEARTBEAT_URL = `${config.cloudUrl}/api/app/passportBos/heartbeat`;
config.heartbeatMs = parseInt(process.env.BOS_HEARTBEAT_MS || "120000", 10);

function log(msg, extra) {
  const stamp = new Date().toISOString();
  if (extra) console.log(`[${stamp}] ${msg}`, JSON.stringify(extra));
  else console.log(`[${stamp}] ${msg}`);
}

async function ensureDir(p) {
  try {
    await fs.mkdir(p, { recursive: true });
  } catch (e) {
    /* ignore — exists or unreachable */
  }
}

// ------------------------------------------------------------------------- //
// Seen-file dedupe (mirror mode only)
// ------------------------------------------------------------------------- //
const seenMirror = new Set();
async function loadSeen() {
  if (config.mode !== "mirror") return;
  try {
    const text = await fs.readFile(config.seenDb, "utf-8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t) seenMirror.add(t);
    }
    log(`loaded ${seenMirror.size} seen entries`);
  } catch (e) {
    /* first run */
  }
}
function seenKey(name, mtimeMs) {
  return `${name}\t${Math.floor(mtimeMs)}`;
}
async function recordSeen(key) {
  seenMirror.add(key);
  await fs.appendFile(config.seenDb, key + "\n");
}

// ------------------------------------------------------------------------- //
// Upload
// ------------------------------------------------------------------------- //
async function uploadFile(absPath) {
  const buf = await fs.readFile(absPath);
  const fileName = path.basename(absPath);
  const body = JSON.stringify({
    storeId: config.storeId,
    fileName,
    fileBase64: buf.toString("base64"),
  });
  const resp = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bos-Edge-Secret": config.secret,
    },
    body,
  });
  const text = await resp.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${resp.status}): ${text.slice(0, 200)}`);
  }
  if (!resp.ok || !parsed.status) {
    throw new Error(
      `Cloud rejected (${resp.status}): ${parsed.message || "unknown"}`,
    );
  }
  return parsed;
}

// ------------------------------------------------------------------------- //
// Heartbeat — tells the cloud the connector is alive even when there are no
// new files, so the dashboard shows "Connected" instead of "Idle/Offline".
// Best-effort: a failed heartbeat is logged quietly and retried next tick.
// ------------------------------------------------------------------------- //
async function sendHeartbeat() {
  try {
    const resp = await fetch(HEARTBEAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bos-Edge-Secret": config.secret,
      },
      body: JSON.stringify({
        storeId: config.storeId,
        mode: config.mode,
        watchDir: config.watchDir,
        version: 3,
        ts: new Date().toISOString(),
      }),
    });
    if (resp.ok) log("heartbeat ok");
  } catch (err) {
    log("heartbeat failed (will retry)", {
      err: String(err && err.message ? err.message : err),
    });
  }
}

// ------------------------------------------------------------------------- //
// File handlers
// ------------------------------------------------------------------------- //
async function tryUploadOutbox(outboxPath) {
  const fileName = path.basename(outboxPath);
  try {
    const result = await uploadFile(outboxPath);
    log("uploaded", {
      file: fileName,
      type: result.documentType,
      rows: result.rowsWritten,
      duplicate: result.duplicate,
    });
    await fs.unlink(outboxPath).catch(() => undefined);
    return true;
  } catch (err) {
    log("upload failed; will retry", {
      file: fileName,
      err: String(err && err.message ? err.message : err),
    });
    return false;
  }
}

async function handleNewMirror(absPath) {
  const fileName = path.basename(absPath);
  let st;
  try {
    st = await fs.stat(absPath);
  } catch {
    return;
  }
  const key = seenKey(fileName, st.mtimeMs);
  if (seenMirror.has(key)) return;

  // Grab our own copy FAST, then mark it captured. The UPLOAD happens
  // asynchronously via retryOutbox — so the capture loop never waits on the
  // network. That's what wins the race when another consumer (Modisoft) is
  // also collecting from this folder and deletes files seconds later.
  // fs.copyFile opens the source shared (read/delete), so we can never block
  // that other consumer's own collection.
  const outboxPath = path.join(config.outboxDir, `${Date.now()}_${fileName}`);
  try {
    await fs.copyFile(absPath, outboxPath);
  } catch (err) {
    // Source may have been collected by the other consumer mid-copy — fine.
    log("copy skipped (file gone/busy)", {
      file: fileName,
      err: String(err && err.message ? err.message : err),
    });
    return;
  }
  await recordSeen(key);
}

async function handleNewOwner(absPath) {
  const fileName = path.basename(absPath);
  const outboxPath = path.join(config.outboxDir, fileName);
  try {
    await fs.rename(absPath, outboxPath);
  } catch (err) {
    log("rename to outbox failed; will retry", {
      file: fileName,
      err: String(err && err.message ? err.message : err),
    });
    return;
  }
  await tryUploadOutbox(outboxPath);
}

// ------------------------------------------------------------------------- //
// Polling watcher (Node built-in fs.watch is unreliable on SMB shares;
// polling is dumb but works everywhere).
// ------------------------------------------------------------------------- //
const lastSeenMtime = new Map();

async function pollWatchDir() {
  let entries;
  try {
    entries = await fs.readdir(config.watchDir);
  } catch (err) {
    log("readdir failed", { err: String(err && err.message ? err.message : err) });
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (!name.toLowerCase().endsWith(config.glob)) continue;
    const full = path.join(config.watchDir, name);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    // Skip very recently modified files (< 2 sec); Passport may still be writing.
    if (Date.now() - st.mtimeMs < config.minAgeMs) continue;
    const prev = lastSeenMtime.get(name);
    if (prev === st.mtimeMs) continue; // unchanged since last poll
    lastSeenMtime.set(name, st.mtimeMs);

    log("file detected", { file: name, mode: config.mode });
    if (config.mode === "owner") {
      await handleNewOwner(full);
    } else {
      await handleNewMirror(full);
    }
  }
}

async function retryOutbox() {
  let entries;
  try {
    entries = await fs.readdir(config.outboxDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = path.join(config.outboxDir, name);
    try {
      const s = await fs.stat(full);
      if (!s.isFile()) continue;
    } catch {
      continue;
    }
    await tryUploadOutbox(full);
  }
}

async function main() {
  log("StealthPOS Connector starting", {
    mode: config.mode,
    storeId: config.storeId,
    watchDir: config.watchDir,
    cloudUrl: config.cloudUrl,
    pollMs: config.pollMs,
  });
  // In mirror mode the watch dir is the POS's shared folder — we only READ it,
  // never create or write anything there. Only owner mode (we own the dir) mkdirs it.
  if (config.mode === "owner") await ensureDir(config.watchDir);
  await ensureDir(config.outboxDir);
  await ensureDir(path.dirname(config.seenDb));
  await loadSeen();
  await retryOutbox();

  setInterval(() => {
    pollWatchDir().catch((err) =>
      log("poll error", { err: String(err && err.message ? err.message : err) }),
    );
  }, config.pollMs);
  setInterval(() => {
    retryOutbox().catch(() => undefined);
  }, config.retryMs);
  setInterval(() => {
    sendHeartbeat().catch(() => undefined);
  }, config.heartbeatMs);

  // Kick off an immediate first pass + heartbeat
  pollWatchDir().catch(() => undefined);
  sendHeartbeat().catch(() => undefined);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log(`${sig} received — shutting down`);
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
