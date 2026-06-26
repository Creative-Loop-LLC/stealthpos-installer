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
 *
 *   --- FTP-pull mode (optional) — pull NAXML straight off the POS FTP server,
 *       exactly the way Modisoft does, so no mounted SMB share is needed ---
 *   BOS_FTP_HOST     enables FTP-pull when set (e.g. 192.168.3.194)
 *   BOS_FTP_PORT     default 21
 *   BOS_FTP_USER     e.g. BackOffice
 *   BOS_FTP_PASS     password
 *   BOS_FTP_TLS      "1" for explicit FTPS (AUTH TLS + PROT P)
 *   BOS_FTP_DIRS     comma-separated remote dirs to scan (default ".")
 *   BOS_FTP_POLL_MS  default 15000
 *   When BOS_FTP_HOST is set, BOS_WATCH_DIR becomes optional (FTP-only client).
 *   FTP-pull is READ-ONLY: it never deletes server files, so it coexists with
 *   Modisoft (both pull; the cloud dedups any file pulled twice).
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

// BOS_WATCH_DIR drives the file-watch (SMB) path. It is REQUIRED normally, but
// OPTIONAL when FTP-pull mode is on (BOS_FTP_HOST) — an FTP-only client has no
// mounted share to watch.
const ftpHostEnv = (process.env.BOS_FTP_HOST || "").trim();
const watchDirEnv = ftpHostEnv
  ? (process.env.BOS_WATCH_DIR || "").trim()
  : required("BOS_WATCH_DIR");

const config = {
  secret: required("BOS_EDGE_SECRET"),
  storeId: parseInt(required("BOS_STORE_ID"), 10),
  cloudUrl: required("BOS_CLOUD_URL").replace(/\/+$/, ""),
  watchDir: watchDirEnv ? path.resolve(watchDirEnv) : "",
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
// The SMB/file-watch path only runs when a watch dir is configured.
config.watchEnabled = !!config.watchDir;

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
if (config.mode === "mirror" && config.watchEnabled) {
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
if (config.mode === "owner" && config.watchEnabled) {
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
async function uploadBuffer(fileName, buf) {
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

async function uploadFile(absPath) {
  const buf = await fs.readFile(absPath);
  return uploadBuffer(path.basename(absPath), buf);
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
        version: 4,
        // Folder census so the cloud can distinguish "connected" from "actually
        // has data to send". Unknown fields are ignored by older backends.
        census,
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
// Folder census — the honest "is there anything to send?" answer. Reported once
// on the first scan (so the installer & connector.log never imply data is
// flowing when the folder is empty/wrong) and shipped on every heartbeat so the
// cloud can surface "connected, but folder empty".
let firstScanReported = false;
let census = { xmlFiles: 0, newestFile: null, newestMtimeMs: 0, checkedAt: null };

async function pollWatchDir() {
  let entries;
  try {
    entries = await fs.readdir(config.watchDir);
  } catch (err) {
    log("readdir failed", { err: String(err && err.message ? err.message : err) });
    if (!firstScanReported) {
      firstScanReported = true;
      log("WATCH FOLDER UNREADABLE — connected to the cloud, but cannot read the POS folder", {
        watchDir: config.watchDir,
      });
    }
    return;
  }
  const xmlNames = entries.filter(
    (n) => !n.startsWith(".") && n.toLowerCase().endsWith(config.glob),
  );
  let newestMtimeMs = 0;
  let newestFile = null;
  for (const name of xmlNames) {
    const full = path.join(config.watchDir, name);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs > newestMtimeMs) {
      newestMtimeMs = st.mtimeMs;
      newestFile = name;
    }
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
  census = { xmlFiles: xmlNames.length, newestFile, newestMtimeMs, checkedAt: Date.now() };
  if (!firstScanReported) {
    firstScanReported = true;
    if (xmlNames.length === 0) {
      // The single most common "connector connects but no data" cause: the
      // watch folder has no POS files. Say it plainly so it is never mistaken
      // for working — the installer keys its honest verdict off this line.
      log("WATCH FOLDER HAS NO POS FILES — connected, but there is nothing to upload yet", {
        watchDir: config.watchDir,
        xmlFiles: 0,
      });
    } else {
      const ageMin = newestMtimeMs
        ? Math.round((Date.now() - newestMtimeMs) / 60000)
        : null;
      log("watch folder scan", {
        watchDir: config.watchDir,
        xmlFiles: xmlNames.length,
        newestFile,
        newestAgeMinutes: ageMin,
      });
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

// ------------------------------------------------------------------------- //
// FTP-pull mode (optional) — pull NAXML files straight off the POS's FTP
// server, exactly the way Modisoft does. Enabled by setting BOS_FTP_HOST.
//
// Zero-dependency: a minimal FTP client over Node's net/tls. Passive mode.
// Supports plain FTP and explicit FTPS (AUTH TLS / PROT P) via BOS_FTP_TLS=1.
// READ-ONLY: never deletes anything on the server, so Modisoft and this Edge
// can both pull from the same gateway (the cloud dedups any double-pull).
// ------------------------------------------------------------------------- //
const net = require("net");
const tls = require("tls");

const ftpConfig = {
  host: ftpHostEnv,
  port: parseInt(process.env.BOS_FTP_PORT || "21", 10),
  user: process.env.BOS_FTP_USER || "anonymous",
  pass: process.env.BOS_FTP_PASS || "",
  tls: process.env.BOS_FTP_TLS === "1",
  dirs: (process.env.BOS_FTP_DIRS || ".")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  pollMs: parseInt(process.env.BOS_FTP_POLL_MS || "15000", 10),
};
const ftpEnabled = !!ftpConfig.host;

// A small Promise-based FTP client. Responses and commands are matched FIFO;
// responses that arrive before a waiter is registered are buffered, so the
// 150-then-226 sequence of a transfer never races.
class FtpClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.ctrl = null;
    this.buf = "";
    this.waiters = [];
    this.responses = [];
    this.closed = false;
  }
  _attach(sock) {
    sock.setEncoding("latin1");
    sock.on("data", (chunk) => {
      this.buf += chunk;
      this._drain();
    });
    sock.on("error", (e) => this._failAll(e));
    sock.on("close", () => {
      if (!this.closed) this._failAll(new Error("control socket closed"));
    });
  }
  _failAll(err) {
    const ws = this.waiters.splice(0);
    for (const w of ws) w.reject(err);
  }
  _codeOf(chunk) {
    const lines = chunk.split("\r\n").filter((l) => l.length);
    const last = lines[lines.length - 1] || "";
    return parseInt(last.slice(0, 3), 10);
  }
  _findResponseEnd(buf) {
    const i = buf.indexOf("\r\n");
    if (i < 0) return -1;
    const first = buf.slice(0, i);
    const m = /^(\d{3})([ -])/.exec(first);
    if (!m) return i + 2; // not a response line — skip to resync
    if (m[2] === " ") return i + 2; // single-line response
    const code = m[1];
    const lines = buf.split("\r\n");
    let pos = 0;
    for (let k = 0; k < lines.length - 1; k++) {
      const line = lines[k];
      if (line.startsWith(code + " ")) return pos + line.length + 2;
      pos += line.length + 2;
    }
    return -1; // multi-line not finished yet
  }
  _drain() {
    for (;;) {
      const end = this._findResponseEnd(this.buf);
      if (end < 0) return;
      const chunk = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      const resp = { code: this._codeOf(chunk), text: chunk };
      const w = this.waiters.shift();
      if (w) w.resolve(resp);
      else this.responses.push(resp);
    }
  }
  _next() {
    if (this.responses.length) return Promise.resolve(this.responses.shift());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async _send(cmd) {
    this.ctrl.write(cmd + "\r\n");
    return this._next();
  }
  async _expect(cmd, okCodes) {
    const r = await this._send(cmd);
    if (okCodes && !okCodes.includes(r.code)) {
      throw new Error(`FTP ${cmd.split(" ")[0]} -> ${r.code}: ${r.text.trim()}`);
    }
    return r;
  }
  _startTls(sock) {
    return new Promise((resolve, reject) => {
      sock.removeAllListeners("data");
      sock.removeAllListeners("close");
      sock.removeAllListeners("error");
      const sec = tls.connect(
        { socket: sock, servername: this.cfg.host, rejectUnauthorized: false },
        () => {
          // Capture the control session so PROT-P data channels can RESUME it.
          // Many FTPS servers require the data TLS session to match the control
          // session and will hand back an empty/refused data channel otherwise.
          this.tlsSession = sec.getSession();
          this._attach(sec);
          resolve(sec);
        },
      );
      sec.on("session", (s) => {
        this.tlsSession = s;
      });
      sec.once("error", reject);
    });
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.ctrl = net.connect(this.cfg.port, this.cfg.host, resolve);
      this.ctrl.once("error", reject);
    });
    this._attach(this.ctrl);
    await this._next(); // 220 banner (unsolicited)
    if (this.cfg.tls) {
      const r = await this._send("AUTH TLS");
      if (r.code !== 234 && r.code !== 334) {
        throw new Error(`AUTH TLS -> ${r.code}: ${r.text.trim()}`);
      }
      this.ctrl = await this._startTls(this.ctrl);
    }
    await this._expect(`USER ${this.cfg.user}`, [331, 230]);
    if (this.cfg.pass) await this._expect(`PASS ${this.cfg.pass}`, [230, 202]);
    if (this.cfg.tls) {
      await this._send("PBSZ 0");
      await this._send("PROT P");
    }
    await this._expect("TYPE I", [200]);
  }
  _parsePasv(text) {
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(text);
    if (!m) throw new Error(`bad PASV reply: ${text.trim()}`);
    // Reuse the control host (robust against a NAT/LAN address in the reply).
    return { port: (parseInt(m[5], 10) << 8) + parseInt(m[6], 10) };
  }
  async _openData() {
    const pasv = await this._expect("PASV", [227]);
    const { port } = this._parsePasv(pasv.text);
    let data = await new Promise((resolve, reject) => {
      const s = net.connect(port, this.cfg.host, () => resolve(s));
      s.once("error", reject);
    });
    if (this.cfg.tls) {
      data = await new Promise((resolve, reject) => {
        const s = tls.connect(
          {
            socket: data,
            servername: this.cfg.host,
            rejectUnauthorized: false,
            session: this.tlsSession, // resume the control session (FTPS req.)
          },
          () => resolve(s),
        );
        s.once("error", reject);
      });
    }
    return data;
  }
  async list(dir) {
    const data = await this._openData();
    const chunks = [];
    const done = new Promise((resolve, reject) => {
      data.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "latin1")));
      data.on("end", resolve);
      data.on("close", resolve);
      data.on("error", reject);
    });
    const cmd = dir && dir !== "." ? `NLST ${dir}` : "NLST";
    const pre = await this._send(cmd);
    if (pre.code >= 400) {
      data.destroy();
      if (pre.code === 450 || pre.code === 550) return []; // empty/no such dir
      throw new Error(`${cmd} -> ${pre.code}: ${pre.text.trim()}`);
    }
    await done;
    await this._next(); // 226 transfer complete
    return Buffer.concat(chunks)
      .toString("latin1")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split("/").pop()); // bare filename even if server returns a path
  }
  async retr(remotePath) {
    const data = await this._openData();
    const chunks = [];
    const done = new Promise((resolve, reject) => {
      data.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, "latin1")));
      data.on("end", resolve);
      data.on("close", resolve);
      data.on("error", reject);
    });
    const pre = await this._send(`RETR ${remotePath}`);
    if (pre.code >= 400) {
      data.destroy();
      throw new Error(`RETR ${remotePath} -> ${pre.code}: ${pre.text.trim()}`);
    }
    await done;
    await this._next(); // 226 transfer complete
    return Buffer.concat(chunks);
  }
  close() {
    this.closed = true;
    try {
      if (this.ctrl) this.ctrl.destroy();
    } catch {
      /* ignore */
    }
  }
}

// FTP dedupe — keyed by remote path so we don't re-upload the same file each
// poll. Persisted to its own file; cloud dedup is the backstop on a cold start.
const ftpSeenDb = config.seenDb + ".ftp";
const ftpSeen = new Set();
let ftpFirstReported = false;
async function loadFtpSeen() {
  try {
    const text = await fs.readFile(ftpSeenDb, "utf-8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t) ftpSeen.add(t);
    }
    log(`loaded ${ftpSeen.size} FTP-seen entries`);
  } catch {
    /* first run */
  }
}
async function recordFtpSeen(key) {
  ftpSeen.add(key);
  await fs.appendFile(ftpSeenDb, key + "\n").catch(() => undefined);
}

async function ftpPullOnce() {
  const client = new FtpClient(ftpConfig);
  let listed = 0;
  let pulled = 0;
  try {
    await client.connect();
    for (const dir of ftpConfig.dirs) {
      let names;
      try {
        names = await client.list(dir);
      } catch (err) {
        log("ftp list failed", { dir, err: String(err && err.message ? err.message : err) });
        continue;
      }
      const xml = names.filter((n) => n.toLowerCase().endsWith(config.glob));
      listed += xml.length;
      for (const name of xml) {
        const remote = dir === "." ? name : `${dir.replace(/\/+$/, "")}/${name}`;
        if (ftpSeen.has(remote)) continue;
        let buf;
        try {
          buf = await client.retr(remote);
        } catch (err) {
          log("ftp retr failed", { remote, err: String(err && err.message ? err.message : err) });
          continue;
        }
        try {
          const result = await uploadBuffer(name, buf);
          await recordFtpSeen(remote);
          pulled++;
          log("ftp pulled+uploaded", {
            file: name,
            type: result.documentType,
            rows: result.rowsWritten,
            duplicate: result.duplicate,
          });
        } catch (err) {
          // Leave it un-seen so the next poll retries the upload.
          log("ftp upload failed; will retry", {
            file: name,
            err: String(err && err.message ? err.message : err),
          });
        }
      }
    }
    // Feed the heartbeat census so the dashboard reflects FTP activity too.
    census = {
      xmlFiles: listed,
      newestFile: census.newestFile,
      newestMtimeMs: census.newestMtimeMs,
      checkedAt: Date.now(),
    };
    if (!ftpFirstReported) {
      ftpFirstReported = true;
      if (listed === 0) {
        log("FTP connected + logged in, but NO POS files in the configured dirs", {
          host: ftpConfig.host,
          dirs: ftpConfig.dirs,
        });
      } else {
        log("FTP scan ok", { host: ftpConfig.host, dirs: ftpConfig.dirs, xmlFiles: listed, pulled });
      }
    }
  } finally {
    client.close();
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
  await ensureDir(config.outboxDir);
  await ensureDir(path.dirname(config.seenDb));

  if (config.watchEnabled) {
    // In mirror mode the watch dir is the POS's shared folder — we only READ it,
    // never create or write anything there. Only owner mode (we own the dir) mkdirs it.
    if (config.mode === "owner") await ensureDir(config.watchDir);
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
    pollWatchDir().catch(() => undefined);
  }

  if (ftpEnabled) {
    log("FTP-pull mode enabled", {
      host: ftpConfig.host,
      port: ftpConfig.port,
      user: ftpConfig.user,
      tls: ftpConfig.tls,
      dirs: ftpConfig.dirs,
      pollMs: ftpConfig.pollMs,
    });
    await loadFtpSeen();
    setInterval(() => {
      ftpPullOnce().catch((err) =>
        log("ftp poll error", { err: String(err && err.message ? err.message : err) }),
      );
    }, ftpConfig.pollMs);
    ftpPullOnce().catch(() => undefined);
  }

  if (!config.watchEnabled && !ftpEnabled) {
    log("NOTHING TO DO — set BOS_WATCH_DIR (file-watch) and/or BOS_FTP_HOST (FTP-pull)");
  }

  setInterval(() => {
    sendHeartbeat().catch(() => undefined);
  }, config.heartbeatMs);

  // Kick off an immediate first heartbeat
  sendHeartbeat().catch(() => undefined);

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log(`${sig} received — shutting down`);
      process.exit(0);
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

// Exported for tests (no-op when run directly as the connector).
module.exports = { FtpClient, ftpConfig };
