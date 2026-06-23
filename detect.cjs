/**
 * detect.cjs — smart, network-aware discovery of the POS XML export folder.
 *
 * Pure Node built-ins so it runs inside the Electron main process AND can be
 * run standalone for testing:  node detect.cjs
 *
 * Why this exists: real Gilbarco Passport sites almost never keep the XML
 * Gateway on the back-office PC. It lives on the Passport *server* and is
 * reached over SMB (e.g. \\192.168.3.194\XMLGateway). A fixed list of local
 * paths can't find that. This module instead DISCOVERS it:
 *
 *   1. Standard local install paths            (instant)
 *   2. Local filesystem signature scan         (bounded-depth)
 *   3. Mapped network drives / SMB mappings    (instant)
 *   4. LAN discovery of the Passport server    (ARP + net view + port-445 sweep)
 *   5. Freshness/empties ranking               (which feed folder is live)
 *   6. Mode + watch-folder recommendation
 *
 * EVERY external call is time-bounded, so the scan can never hang — that was
 * the original v1.0.0 freeze (fs.existsSync on an unreachable UNC path).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { spawnSync } = require("child_process");

// --- NAXML / Passport signatures ------------------------------------------
// Folder that holds the gateway, the feed subfolders Passport creates, and the
// SMB share names a Passport server commonly exposes.
const GATEWAY_DIR_NAMES = ["xmlgateway", "xml gateway"];
const FEED_SUBFOLDERS = ["BOOutbox", "Processed", "BOInbox"];
const GATEWAY_SHARE_NAMES = ["XMLGateway", "Gilbarco", "PPXMLData", "ClientOutBox"];

// Standard local install roots (fast first pass).
const LOCAL_KNOWN_BASES = [
  "C:\\Passport\\XMLGateway",
  "C:\\Program Files\\Passport\\XMLGateway",
  "C:\\Program Files (x86)\\Passport\\XMLGateway",
  "C:\\Gilbarco\\Passport\\XMLGateway",
  "C:\\Gilbarco\\XMLGateway",
  "D:\\Passport\\XMLGateway",
];

// Dirs we never descend into during the local scan (noise / system).
const SKIP_DIRS = new Set([
  "windows", "$recycle.bin", "node_modules", "appdata", "programdata",
  "$winreagent", "system volume information", "perflogs", "windows.old",
  "$sysreset", "recovery", "msocache",
]);

const isWindows = () => process.platform === "win32";
const isUnc = (p) => /^\\\\/.test(p || "");

// --------------------------------------------------------------------------
// Bounded primitives
// --------------------------------------------------------------------------

function ps(command, timeoutMs = 5000) {
  // PowerShell one-liner → stdout ("" on any error/timeout). Never throws.
  try {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }
    );
    return r && r.status === 0 ? r.stdout || "" : "";
  } catch {
    return "";
  }
}

// Exists check that is SAFE on network paths. Local → fs (instant). UNC →
// PowerShell Test-Path with a hard timeout so an unreachable host can't hang us.
function existsBounded(p, timeoutMs = 2500) {
  if (!isUnc(p)) {
    try { return fs.existsSync(p); } catch { return false; }
  }
  return ps(`(Test-Path -LiteralPath '${p.replace(/'/g, "''")}').ToString()`, timeoutMs).trim() === "True";
}

// Does this folder hold at least one *.xml? Streams entries so it returns the
// instant it finds one — safe even on a Processed folder with 100k+ files.
function peekHasXml(p) {
  let dir;
  try { dir = fs.opendirSync(p); } catch { return false; }
  try {
    let ent, scanned = 0;
    while ((ent = dir.readSync()) && scanned < 8000) {
      scanned++;
      if (ent.name.toLowerCase().endsWith(".xml")) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    try { dir.closeSync(); } catch { /* ignore */ }
  }
}

// Count + newest mtime for a SMALL folder (BOOutbox/BOInbox are transient).
// Capped so we never stat a giant archive. {count, newestMs, capped}.
function inventorySmall(p, cap = 2000) {
  let names;
  try { names = fs.readdirSync(p); } catch { return { count: 0, newestMs: 0, capped: false }; }
  const capped = names.length > cap;
  let count = 0, newestMs = 0;
  for (const name of names.slice(0, cap)) {
    if (!name.toLowerCase().endsWith(".xml")) continue;
    count++;
    try {
      const st = fs.statSync(path.join(p, name));
      if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
    } catch { /* ignore */ }
  }
  return { count, newestMs, capped };
}

// --------------------------------------------------------------------------
// Strategy 2: local filesystem signature scan
// --------------------------------------------------------------------------

function fixedDrives() {
  const drives = [];
  for (let c = 67; c <= 90; c++) { // C: .. Z:
    const root = String.fromCharCode(c) + ":\\";
    try { if (fs.existsSync(root)) drives.push(root); } catch { /* ignore */ }
  }
  return drives;
}

// Bounded DFS for folders named XMLGateway, OR folders that directly contain a
// feed subfolder (BOOutbox/Processed/BOInbox). Returns gateway base dirs.
function scanLocalGateways(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const found = new Set();
  const stack = fixedDrives().map((d) => ({ dir: d, depth: 0 }));
  while (stack.length && Date.now() < deadline) {
    const { dir, depth } = stack.pop();
    if (depth > 4) continue;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const childNames = new Set(ents.filter((e) => e.isDirectory()).map((e) => e.name.toLowerCase()));
    // A dir that contains a feed subfolder is itself a gateway base.
    if (FEED_SUBFOLDERS.some((s) => childNames.has(s.toLowerCase()))) {
      found.add(dir);
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const lower = e.name.toLowerCase();
      if (SKIP_DIRS.has(lower)) continue;
      const full = path.join(dir, e.name);
      if (GATEWAY_DIR_NAMES.includes(lower)) { found.add(full); continue; }
      stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return [...found];
}

// --------------------------------------------------------------------------
// Strategy 3: mapped network drives
// --------------------------------------------------------------------------

function mappedGatewayBases() {
  const out = ps(
    "Get-CimInstance Win32_MappedLogicalDisk | Select-Object -ExpandProperty ProviderName", 4000
  );
  const bases = [];
  for (const line of out.split(/\r?\n/)) {
    const unc = line.trim();
    if (unc.startsWith("\\\\")) bases.push(unc);
  }
  return bases;
}

// --------------------------------------------------------------------------
// Strategy 4: LAN discovery of the Passport server
// --------------------------------------------------------------------------

function localSubnets() {
  const subnets = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) {
        const m = ni.address.match(/^(\d+\.\d+\.\d+)\.(\d+)$/);
        if (m) subnets.push({ base: m[1], self: Number(m[2]) });
      }
    }
  }
  return subnets;
}

function arpHosts() {
  const out = ps('(arp -a) -join "`n"', 4000);
  const hosts = new Set();
  const re = /(\d+\.\d+\.\d+\.\d+)/g;
  let m;
  while ((m = re.exec(out))) {
    const ip = m[1];
    if (!ip.endsWith(".255") && !ip.endsWith(".0") && !ip.startsWith("224.") && !ip.startsWith("239.")) {
      hosts.add(ip);
    }
  }
  return [...hosts];
}

function netViewHosts() {
  const out = ps('(net view) -join "`n"', 5000);
  const hosts = new Set();
  const re = /\\\\([^\s\\]+)/g;
  let m;
  while ((m = re.exec(out))) hosts.add(m[1]);
  return [...hosts];
}

function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(ok); } };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

// Fast parallel port-445 sweep of the local /24 — finds SMB servers (the
// Passport box) even if they're not yet in the ARP table.
async function smbHostsOnSubnet(timeoutMs = 400, concurrency = 64) {
  const hosts = [];
  for (const { base, self } of localSubnets()) {
    for (let i = 1; i <= 254; i++) if (i !== self) hosts.push(`${base}.${i}`);
  }
  const open = [];
  let idx = 0;
  async function worker() {
    while (idx < hosts.length) {
      const h = hosts[idx++];
      if (await tcpOpen(h, 445, timeoutMs)) open.push(h);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return open;
}

// --------------------------------------------------------------------------
// Candidate selection + ranking
// --------------------------------------------------------------------------

// For a gateway base, choose the feed subfolder to WATCH and infer the mode.
// Logic learned from the field:
//  - BOOutbox with fresh files  → live outbox (read it directly)
//  - BOOutbox empty but Processed has data → Modisoft already drained BOOutbox;
//    the data lands in Processed → watch Processed in MIRROR mode
function selectWatchDir(base, isNetwork) {
  const join = (sub) => (isNetwork ? `${base}\\${sub}` : path.join(base, sub));
  const boPath = join("BOOutbox");
  const procPath = join("Processed");

  const candidates = [];

  if (existsBounded(boPath, 2000)) {
    const inv = inventorySmall(boPath);
    candidates.push({
      path: boPath, count: inv.count, newestMs: inv.newestMs,
      kind: inv.count > 0 ? "live-outbox" : "empty-outbox",
    });
  }
  if (existsBounded(procPath, 2000)) {
    const hasData = peekHasXml(procPath);
    candidates.push({
      path: procPath, count: hasData ? -1 : 0, newestMs: 0,
      kind: hasData ? "processed-archive" : "empty-processed",
    });
  }
  // Fallback: gateway root itself holds *.xml (some single-folder setups)
  if (candidates.length === 0 && existsBounded(base, 2000) && peekHasXml(base)) {
    candidates.push({ path: base, count: -1, newestMs: 0, kind: "gateway-root" });
  }
  if (candidates.length === 0) return null;

  // Prefer a live outbox with recent files; else a non-empty Processed; else
  // an existing (possibly empty) outbox that will fill.
  const recentMs = Date.now() - 14 * 24 * 3600 * 1000;
  const live = candidates.find((c) => c.kind === "live-outbox" && c.newestMs >= recentMs);
  const processed = candidates.find((c) => c.kind === "processed-archive");
  const anyOutbox = candidates.find((c) => c.kind === "empty-outbox");
  const chosen = live || processed || anyOutbox || candidates[0];

  // Network share + reading from Processed (Modisoft pattern) ⇒ mirror.
  // A directly-owned live outbox on a local disk can be owner mode.
  const mode = isNetwork || chosen.kind === "processed-archive" ? "mirror" : "owner";
  return { ...chosen, base, isNetwork, mode };
}

// Score a chosen watch dir so the best floats to the top.
function scoreCandidate(c) {
  let s = 0;
  if (c.kind === "live-outbox") s = 1_000_000 + Math.floor(c.newestMs / 1000);
  else if (c.kind === "processed-archive") s = 500_000;
  else if (c.kind === "gateway-root") s = 400_000;
  else if (c.kind === "empty-outbox") s = 100_000;
  if (c.isNetwork) s += 10_000; // network gateways are the common real-world case
  return s;
}

// --------------------------------------------------------------------------
// Orchestrator
// --------------------------------------------------------------------------

async function smartDetect(opts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  if (!isWindows()) return { found: false, path: "", candidates: [], mode: "mirror" };

  const bases = []; // { base, isNetwork }
  const seen = new Set();
  const addBase = (base, isNetwork) => {
    const key = base.toLowerCase();
    if (!seen.has(key)) { seen.add(key); bases.push({ base, isNetwork }); }
  };

  // 1. Standard local paths (these ARE gateway bases already).
  onProgress("Checking standard Passport locations…");
  for (const b of LOCAL_KNOWN_BASES) if (existsBounded(b, 1200)) addBase(b, false);

  // 2. Local filesystem signature scan.
  onProgress("Scanning local drives…");
  for (const b of scanLocalGateways(8000)) addBase(b, false);

  // 3. Mapped network drives.
  onProgress("Checking mapped network drives…");
  for (const b of mappedGatewayBases()) addBase(b, true);

  // 4. LAN discovery of the Passport server.
  //    Probe a host only if it actually listens on SMB (445), then look for a
  //    gateway share. Stop at the first gateway share per host. Cheap calls.
  const probeHosts = async (hostList) => {
    for (const host of hostList) {
      if (!(await tcpOpen(host, 445, 500))) continue; // skip non-SMB hosts fast
      for (const share of GATEWAY_SHARE_NAMES) {
        const root = `\\\\${host}\\${share}`;
        if (existsBounded(root, 1500)) {
          addBase(root, true);
          const nested = `${root}\\XMLGateway`; // some sites nest it
          if (existsBounded(nested, 1500)) addBase(nested, true);
          break;
        }
      }
    }
  };

  // Phase A: hosts we already know about (ARP table + workgroup) — cheap.
  onProgress("Searching the network for your Passport server…");
  await probeHosts(new Set([...arpHosts(), ...netViewHosts()]));

  // Phase B: only if nothing networked turned up, sweep the local subnet for
  // SMB servers (the Passport box may not be in ARP yet).
  if (!bases.some((b) => b.isNetwork)) {
    onProgress("Scanning the local network…");
    try { await probeHosts(await smbHostsOnSubnet(400, 96)); } catch { /* ignore */ }
  }

  // 5. Resolve each base → best watch folder, then rank.
  onProgress("Checking which folder has live data…");
  const candidates = [];
  for (const { base, isNetwork } of bases) {
    const sel = selectWatchDir(base, isNetwork);
    if (sel) candidates.push({ ...sel, score: scoreCandidate(sel) });
  }
  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0] || null;
  return {
    found: !!best,
    path: best ? best.path : "",
    mode: best ? best.mode : "mirror",
    isNetwork: best ? best.isNetwork : false,
    candidates: candidates.map((c) => ({
      path: c.path,
      mode: c.mode,
      isNetwork: c.isNetwork,
      kind: c.kind,
      note:
        c.kind === "live-outbox" ? "Live POS outbox (active files)" :
        c.kind === "processed-archive" ? "Processed feed (mirrors Modisoft)" :
        c.kind === "gateway-root" ? "POS export folder" :
        c.kind === "empty-outbox" ? "POS outbox (currently empty)" : "POS folder",
    })),
  };
}

module.exports = { smartDetect, existsBounded, scanLocalGateways };

// Standalone test: node detect.cjs
if (require.main === module) {
  smartDetect({ onProgress: (m) => console.error("…", m) })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e); process.exit(1); });
}
