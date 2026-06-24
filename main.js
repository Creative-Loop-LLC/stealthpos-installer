const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { smartDetect } = require("./detect.cjs");

const CLOUD_URL = "https://stealthpos.net";
const INSTALL_DIR = "C:\\StealthPOS";
const SERVICE_NAME = "StealthPOSConnector";

// The connector (edge.cjs) ships bundled inside this installer — see the
// extraResources entry in electron-builder.yml. No external repo dependency.
function bundledEdgePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "edge.cjs")
    : path.join(__dirname, "resources", "edge.cjs");
}

// nssm.exe ships bundled alongside edge.cjs so we never hit the network during
// install. Add nssm-2.24/win64/nssm.exe to extraResources in electron-builder.yml.
function bundledNssmPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "nssm.exe")
    : path.join(__dirname, "resources", "nssm.exe");
}

// node.exe ships bundled in resources/ so the connector runs on any PC
// regardless of whether Node.js is installed system-wide.
function bundledNodePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "node.exe")
    : path.join(__dirname, "resources", "node.exe");
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 580,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: "StealthPOS Connector",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Check for updates silently; notify renderer when one is downloaded.
  autoUpdater.checkForUpdatesAndNotify().catch(() => { /* offline or no release */ });
  autoUpdater.on("update-downloaded", () => {
    if (mainWindow) mainWindow.webContents.send("update-downloaded");
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { res, data };
}

async function getJson(url) {
  const res = await fetch(url);
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { res, data };
}

function powershell(command) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { windowsHide: true, encoding: "utf8" }
  );
}

function nssm(args) {
  return execFileSync(path.join(INSTALL_DIR, "nssm.exe"), args, {
    windowsHide: true,
    encoding: "utf8",
  });
}

function nssmQuiet(args) {
  try {
    nssm(args);
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Check if a local filesystem path exists. Fast — safe to call synchronously.
function localExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// Locate node.exe — prefers bundled runtime, then PATH, then common installs.
function findNodeExe() {
  // Bundled node takes priority — guaranteed to exist and version-matched.
  const bundled = bundledNodePath();
  if (localExists(bundled)) return bundled;

  // Fall back to system Node if somehow bundled copy is missing.
  try {
    const r = spawnSync("where.exe", ["node.exe"], {
      windowsHide: true, encoding: "utf8", timeout: 3000,
    });
    if (r.status === 0 && r.stdout.trim()) {
      return r.stdout.trim().split(/\r?\n/)[0].trim();
    }
  } catch {
    /* not on PATH */
  }

  const candidates = [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files (x86)\\nodejs\\node.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs\\nodejs\\node.exe"),
    path.join(process.env.APPDATA || "", "nvm\\current\\node.exe"),
  ];
  for (const p of candidates) {
    if (localExists(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

// Smart, network-aware discovery of the POS XML folder (see detect.cjs).
// Streams progress lines to the renderer ("Scanning local drives…",
// "Searching the network…") and returns the best match plus ranked
// alternatives and a suggested back-office mode. Time-bounded end to end.
ipcMain.handle("detect-folder", async (event) => {
  const onProgress = (msg) => {
    try { event.sender.send("detect-progress", msg); } catch { /* window gone */ }
  };
  try {
    const result = await smartDetect({ onProgress });
    return result;
  } catch (err) {
    return { found: false, path: "", candidates: [], mode: "mirror", error: String(err) };
  }
});

// Manual folder picker fallback.
ipcMain.handle("browse-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select the POS data folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return { path: "" };
  return { path: result.filePaths[0] };
});

// Lightweight account lookup — checks if an email is registered.
// Returns { found: bool, storeName?: string }.
// If the backend endpoint doesn't exist yet the caller handles the 404 gracefully.
ipcMain.handle("lookup-email", async (_event, { email }) => {
  try {
    const { res, data } = await getJson(
      `${CLOUD_URL}/api/edge/lookup-email?email=${encodeURIComponent(email)}`
    );
    if (res.status === 404 || res.status === 405) {
      // Endpoint not yet deployed — degrade gracefully.
      return { found: null, degraded: true };
    }
    if (!res.ok) return { found: false };
    return { found: true, storeName: data.storeName || "" };
  } catch {
    return { found: null, degraded: true };
  }
});

// Current Windows account (so the wizard can pre-fill it — the client should
// never have to know/type their Windows username format). Returns DOMAIN\user
// (or .\user for a local account).
ipcMain.handle("get-windows-user", () => {
  const name = process.env.USERNAME || "";
  const domain = process.env.USERDOMAIN || "";
  const compName = process.env.COMPUTERNAME || "";
  if (!name) return { user: "", display: "" };
  // Local account → DOMAIN equals the computer name; show ".\name" which nssm
  // accepts and reads as "this PC's local account".
  const isLocal = !domain || domain.toUpperCase() === compName.toUpperCase();
  const user = isLocal ? `.\\${name}` : `${domain}\\${name}`;
  const display = isLocal ? name : `${domain}\\${name}`;
  return { user, display };
});

// Address autocomplete (proxied through the cloud so the Google key stays
// server-side). Returns [] gracefully if the backend has no key configured.
ipcMain.handle("address-autocomplete", async (_event, { q }) => {
  try {
    const { data } = await getJson(
      `${CLOUD_URL}/api/util/address?q=${encodeURIComponent(q || "")}`
    );
    return { suggestions: data.suggestions || [] };
  } catch {
    return { suggestions: [] };
  }
});
ipcMain.handle("address-details", async (_event, { placeId }) => {
  try {
    const { data } = await getJson(
      `${CLOUD_URL}/api/util/address?placeId=${encodeURIComponent(placeId || "")}`
    );
    return { details: data.details || {} };
  } catch {
    return { details: {} };
  }
});

// Existing-account login.
ipcMain.handle("api-login", async (_event, { username, password }) => {
  try {
    const { res, data } = await postJson(`${CLOUD_URL}/api/edge/login`, {
      username,
      password,
    });
    if (!res.ok) {
      return {
        ok: false,
        message: data.message || data.error || `Login failed (${res.status})`,
      };
    }
    return {
      ok: true,
      edgeSecret: data.edgeSecret,
      session: data.session || {},
    };
  } catch (err) {
    return { ok: false, message: err.message || "Network error" };
  }
});

// New-account signup.
ipcMain.handle("api-signup", async (_event, payload) => {
  try {
    const body = {
      legalName: payload.legalName,
      displayName: payload.displayName,
      email: payload.email,
      phone: payload.phone || "",
      password: payload.password,
      stores: [
        {
          code: "main",
          name: payload.storeName,
          address: payload.address || "",
          city: payload.city,
          state: payload.state,
          zip: payload.zip || "",
          phone: payload.phone || "",
        },
      ],
      posType: payload.posType || "passport",
      runningModisoft: payload.runningModisoft || "no",
      plan: "pro",
    };
    const { res, data } = await postJson(`${CLOUD_URL}/api/onboard/start`, body);
    if (!res.ok) {
      return {
        ok: false,
        message: data.message || data.error || `Signup failed (${res.status})`,
      };
    }
    return {
      ok: true,
      bosEdgeSecret: data.bosEdgeSecret,
      stores: data.stores || [],
    };
  } catch (err) {
    return { ok: false, message: err.message || "Network error" };
  }
});

// ---------------------------------------------------------------------------
// Install helpers
// ---------------------------------------------------------------------------

const EDGE_PATH = path.join(INSTALL_DIR, "edge.cjs");
const STDOUT_LOG = path.join(INSTALL_DIR, "stdout.log");
const LAUNCHER_PATH = path.join(INSTALL_DIR, "run-connector.ps1");

// Connector log when running as a logon task (writes to the user's profile).
function taskLogPath() {
  const local = process.env.LOCALAPPDATA || path.join(INSTALL_DIR, "logs");
  return path.join(local, "StealthPOS", "connector.log");
}

// Keep the PC awake so syncing never stops — a sleeping CPU runs nothing.
// Best-effort: never standby / never hibernate on both AC and battery.
function powerNeverSleep() {
  for (const c of [
    "powercfg /change standby-timeout-ac 0",
    "powercfg /change standby-timeout-dc 0",
    "powercfg /change hibernate-timeout-ac 0",
    "powercfg /change hibernate-timeout-dc 0",
    "powercfg /hibernate off",
  ]) {
    try { powershell(c); } catch { /* best effort */ }
  }
}

function envKeys(o) {
  return [
    `BOS_EDGE_SECRET=${o.secret}`,
    `BOS_STORE_ID=${o.storeId}`,
    `BOS_CLOUD_URL=${o.cloud}`,
    `BOS_WATCH_DIR=${o.watchDir}`,
    `BOS_MODE=${o.mode}`,
  ];
}

function nssmBaseInstall(nodePath) {
  nssmQuiet(["stop", SERVICE_NAME]);
  nssmQuiet(["remove", SERVICE_NAME, "confirm"]);
  nssm(["install", SERVICE_NAME, nodePath, EDGE_PATH]);
  nssm(["set", SERVICE_NAME, "AppDirectory", INSTALL_DIR]);
  nssm(["set", SERVICE_NAME, "AppStdout", STDOUT_LOG]);
  nssm(["set", SERVICE_NAME, "AppStderr", path.join(INSTALL_DIR, "stderr.log")]);
  nssm(["set", SERVICE_NAME, "Start", "SERVICE_AUTO_START"]);
}

// LOCAL folder → plain LocalSystem service (no network credentials needed).
function installSystemService(nodePath, env) {
  removeLogonTask();
  nssmBaseInstall(nodePath);
  nssm(["set", SERVICE_NAME, "AppEnvironmentExtra", ...envKeys(env)]);
  nssm(["start", SERVICE_NAME]);
}

// NETWORK share → service running AS THE USER. Survives logout/reboot/sleep,
// runs with a full token (no UAC filtering), and authenticates to the share
// as that user. Requires the user's Windows password (collected in the wizard).
function installUserService(nodePath, env, winUser, winPass) {
  removeLogonTask();
  nssmBaseInstall(nodePath);
  // nssm grants the "Log on as a service" right to the account automatically.
  nssm(["set", SERVICE_NAME, "ObjectName", winUser, winPass]);
  nssm(["set", SERVICE_NAME, "AppEnvironmentExtra", ...envKeys(env)]);
  nssm(["start", SERVICE_NAME]);
}

function removeLogonTask() {
  try {
    powershell(`Unregister-ScheduledTask -TaskName '${SERVICE_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`);
  } catch { /* none */ }
}

// NETWORK share, no stored password → elevated logon task. No password needed;
// runs in the user's session at logon (and now). Works whenever the user is
// logged in (always true for an always-on register PC). MUST be RunLevel
// Highest — at standard level Windows blocks file reads from the share.
function installLogonTask(nodePath, env) {
  nssmQuiet(["stop", SERVICE_NAME]);
  nssmQuiet(["remove", SERVICE_NAME, "confirm"]);
  const launcher = [
    '$ErrorActionPreference="Continue"',
    ...envKeys(env).map((kv) => {
      const i = kv.indexOf("=");
      return `$env:${kv.slice(0, i)}=${JSON.stringify(kv.slice(i + 1))}`;
    }),
    '$l=Join-Path $env:LOCALAPPDATA "StealthPOS"; New-Item -ItemType Directory -Force $l | Out-Null',
    `& ${JSON.stringify(nodePath)} ${JSON.stringify(EDGE_PATH)} *>> (Join-Path $l "connector.log")`,
  ].join("\r\n");
  fs.writeFileSync(LAUNCHER_PATH, launcher, "utf8");
  const setup = [
    `$u = (Get-CimInstance Win32_ComputerSystem).UserName`,
    `$act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${LAUNCHER_PATH}"'`,
    `$trg = New-ScheduledTaskTrigger -AtLogOn -User $u`,
    `$prn = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Highest`,
    `$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)`,
    `Register-ScheduledTask -TaskName "${SERVICE_NAME}" -Action $act -Trigger $trg -Principal $prn -Settings $set -Force | Out-Null`,
    `Start-ScheduledTask -TaskName "${SERVICE_NAME}"`,
  ].join("; ");
  powershell(setup);
}

// Install + start the background connector. Picks the run context based on
// whether the watch dir is a network share and whether Windows creds were
// provided — see installSystemService / installUserService / installLogonTask.
ipcMain.handle("install-edge", async (event, opts) => {
  const send = (step, status, log) =>
    event.sender.send("install-progress", { step, status, log });

  const { secret, storeId, watchDir, mode, cloudUrl, winUser, winPass } = opts;
  const cloud = cloudUrl || CLOUD_URL;
  const env = { secret, storeId, cloud, watchDir, mode };
  const isUnc = /^\\\\/.test(watchDir || "");

  try {
    // --- Step 1: create install directory --------------------------------
    send(1, "running", `Creating ${INSTALL_DIR}…`);
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    send(1, "done", "Install folder ready.");

    // --- Step 2: install the bundled connector ---------------------------
    send(2, "running", "Installing the StealthPOS connector…");
    fs.copyFileSync(bundledEdgePath(), EDGE_PATH);
    send(2, "done", `Connector installed (${fs.statSync(EDGE_PATH).size.toLocaleString()} bytes).`);

    // --- Step 3: install the bundled service manager (nssm) --------------
    send(3, "running", "Setting up the Windows service manager…");
    const nssmSrc = bundledNssmPath();
    if (!localExists(nssmSrc)) {
      throw new Error(
        "nssm.exe is missing from the installer bundle. Please re-download the installer from stealthpos.net/download."
      );
    }
    fs.copyFileSync(nssmSrc, path.join(INSTALL_DIR, "nssm.exe"));
    send(3, "done", "Service manager ready.");

    // --- Step 4: locate Node.js ------------------------------------------
    send(4, "running", "Locating Node.js runtime…");
    const nodePath = findNodeExe();
    if (!nodePath) {
      throw new Error(
        "Could not locate a Node.js runtime. " +
        "Please re-download the installer from stealthpos.net/download and try again."
      );
    }
    send(4, "done", `Node.js found: ${nodePath}`);

    // --- Step 5: keep the PC awake so syncing never stops ----------------
    send(5, "running", "Setting the PC to stay awake so data keeps syncing…");
    powerNeverSleep();
    send(5, "done", "Power settings: never sleep, never hibernate.");

    // --- Step 6: install the connector in the right run context ----------
    let runMode;
    if (!isUnc) {
      send(6, "running", `Installing the ${SERVICE_NAME} background service…`);
      installSystemService(nodePath, env);
      runMode = "service";
    } else if (winUser && winPass) {
      send(6, "running", `Installing the always-on service (runs as ${winUser})…`);
      installUserService(nodePath, env, winUser, winPass);
      runMode = "user-service";
    } else {
      send(6, "running", "Installing the auto-start connector…");
      installLogonTask(nodePath, env);
      runMode = "logon-task";
    }
    send(6, "done", "Connector installed and started.");

    // --- Step 7: confirm it can READ the folder and is flowing -----------
    send(7, "running", "Confirming the connector can read your POS folder…");
    const logPath = runMode === "logon-task" ? taskLogPath() : STDOUT_LOG;
    const deadline = Date.now() + 35000;
    let cursor = 0;
    let connected = false;
    let permError = false;

    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        if (!localExists(logPath)) continue;
        const content = fs.readFileSync(logPath, "utf8");
        if (content.length > cursor) {
          const fresh = content.slice(cursor).split(/\r?\n/).filter(Boolean);
          for (const line of fresh) send(7, "running", line);
          cursor = content.length;
        }
        if (/EPERM|operation not permitted|readdir failed/i.test(content)) {
          permError = true;
          break;
        }
        if (/uploaded|Connector starting/i.test(content)) {
          connected = true;
          break;
        }
      } catch {
        /* log not ready yet */
      }
    }

    if (permError) {
      // The run context can't read the share — the classic LocalSystem-on-a-
      // network-share case. Tell the user how to fix it (provide Windows creds).
      send(7, "error",
        "The connector started but can't read your network folder with the current account. " +
        "Re-run setup and enter your Windows username + password on the network-folder step so it can run as you."
      );
      return { ok: false, runMode, permError: true };
    }
    if (connected) {
      send(7, "done", "Connected — your store data is flowing to StealthPOS.");
    } else {
      send(7, "done", "Connector is running. Data will upload automatically as POS files arrive.");
    }
    return { ok: true, runMode };
  } catch (err) {
    send(0, "error", err.message || String(err));
    return { ok: false, message: err.message || String(err) };
  }
});

// Open the cloud dashboard in the default browser.
ipcMain.handle("open-dashboard", () => {
  shell.openExternal(`${CLOUD_URL}/admin`);
  return { ok: true };
});

// Open a support channel (folder-not-found "get help").
ipcMain.handle("open-support", () => {
  shell.openExternal("mailto:support@stealthpos.net?subject=StealthPOS%20Connector%20setup%20help");
  return { ok: true };
});
