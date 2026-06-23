const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
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

// Locate node.exe — tries PATH first, then common install directories.
function findNodeExe() {
  // where.exe searches PATH
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

// Install + start the background connector service.
ipcMain.handle("install-edge", async (event, opts) => {
  const send = (step, status, log) =>
    event.sender.send("install-progress", { step, status, log });

  const { secret, storeId, watchDir, mode, cloudUrl } = opts;
  const cloud = cloudUrl || CLOUD_URL;

  try {
    // --- Step 1: create install directory --------------------------------
    send(1, "running", `Creating ${INSTALL_DIR}…`);
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    send(1, "done", "Install folder ready.");

    // --- Step 2: install the bundled connector ---------------------------
    send(2, "running", "Installing the StealthPOS connector…");
    const edgeDest = path.join(INSTALL_DIR, "edge.cjs");
    fs.copyFileSync(bundledEdgePath(), edgeDest);
    send(2, "done", `Connector installed (${fs.statSync(edgeDest).size.toLocaleString()} bytes).`);

    // --- Step 3: install the bundled service manager (nssm) --------------
    send(3, "running", "Setting up the Windows service manager…");
    const nssmSrc = bundledNssmPath();
    const nssmDest = path.join(INSTALL_DIR, "nssm.exe");
    if (!localExists(nssmSrc)) {
      throw new Error(
        "nssm.exe is missing from the installer bundle. Please re-download the installer from stealthpos.net/download."
      );
    }
    fs.copyFileSync(nssmSrc, nssmDest);
    send(3, "done", "Service manager ready.");

    // --- Step 4: locate Node.js ------------------------------------------
    send(4, "running", "Locating Node.js runtime…");
    const nodePath = findNodeExe();
    if (!nodePath) {
      throw new Error(
        "Node.js is not installed on this machine. " +
        "Please install it from nodejs.org (LTS version), then run this installer again."
      );
    }
    send(4, "done", `Node.js found: ${nodePath}`);

    // --- Step 5: install + start the service -----------------------------
    send(5, "running", `Installing the ${SERVICE_NAME} service…`);
    nssmQuiet(["stop", SERVICE_NAME]);
    nssmQuiet(["remove", SERVICE_NAME, "confirm"]);

    nssm(["install", SERVICE_NAME, nodePath, "C:\\StealthPOS\\edge.cjs"]);
    nssm(["set", SERVICE_NAME, "AppDirectory", "C:\\StealthPOS"]);
    nssm(["set", SERVICE_NAME, "AppStdout", "C:\\StealthPOS\\stdout.log"]);
    nssm(["set", SERVICE_NAME, "AppStderr", "C:\\StealthPOS\\stderr.log"]);
    nssm(["set", SERVICE_NAME, "Start", "SERVICE_AUTO_START"]);
    nssm([
      "set", SERVICE_NAME, "AppEnvironmentExtra",
      `BOS_EDGE_SECRET=${secret}`,
      `BOS_STORE_ID=${storeId}`,
      `BOS_CLOUD_URL=${cloud}`,
      `BOS_WATCH_DIR=${watchDir}`,
      `BOS_MODE=${mode}`,
    ]);
    nssm(["start", SERVICE_NAME]);
    send(5, "done", "Service installed and started.");

    // --- Step 6: watch the log for first activity ------------------------
    send(6, "running", "Waiting for the connector to come online…");
    const logPath = path.join(INSTALL_DIR, "stdout.log");
    const deadline = Date.now() + 30000;
    let cursor = 0;
    let connected = false;

    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        if (!localExists(logPath)) continue;
        const content = fs.readFileSync(logPath, "utf8");
        if (content.length > cursor) {
          const fresh = content.slice(cursor).split(/\r?\n/).filter(Boolean);
          for (const line of fresh) send(6, "running", line);
          cursor = content.length;
        }
        if (/uploaded|Connector starting/i.test(content)) {
          connected = true;
          break;
        }
      } catch {
        /* log not ready yet */
      }
    }

    if (connected) {
      send(6, "done", "Connected — your store data is flowing to StealthPOS.");
    } else {
      send(6, "done", "Service is running. Data will upload automatically as POS files arrive.");
    }

    return { ok: true };
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
