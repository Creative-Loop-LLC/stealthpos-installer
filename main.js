const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const CLOUD_URL = "https://stealthpos.net";
const INSTALL_DIR = "C:\\StealthPOS";
const SERVICE_NAME = "StealthPOSConnector";
const NSSM_URL = "https://nssm.cc/release/nssm-2.24.zip";

// The connector (edge.cjs) ships bundled inside this installer — see the
// extraResources entry in electron-builder.yml. No external repo dependency.
function bundledEdgePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "edge.cjs")
    : path.join(__dirname, "resources", "edge.cjs");
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 540,
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

function powershell(command) {
  // Run a PowerShell command synchronously, throwing on a non-zero exit.
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { windowsHide: true, encoding: "utf8" }
  );
}

function nssm(args) {
  // Invoke the bundled nssm.exe; returns stdout, throws on failure.
  return execFileSync(path.join(INSTALL_DIR, "nssm.exe"), args, {
    windowsHide: true,
    encoding: "utf8",
  });
}

function nssmQuiet(args) {
  // Same as nssm() but swallows errors (used for best-effort stop/remove).
  try {
    nssm(args);
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

// Scan known Passport XML locations, return the first that exists.
ipcMain.handle("detect-folder", () => {
  const candidates = [
    "C:\\Passport\\XMLGateway\\BOOutbox",
    "C:\\Program Files\\Passport\\XMLGateway\\BOOutbox",
    "C:\\Program Files (x86)\\Passport\\XMLGateway\\BOOutbox",
    "C:\\Passport\\XMLGateway\\Processed",
    "\\\\PassportServer\\XMLGateway\\BOOutbox",
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { found: true, path: candidate };
    } catch {
      /* ignore unreadable path */
    }
  }
  return { found: false, path: "" };
});

// Manual folder picker fallback.
ipcMain.handle("browse-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select the Passport XML folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return { path: "" };
  return { path: result.filePaths[0] };
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
      password: payload.password,
      stores: [
        {
          code: "main",
          name: payload.storeName,
          city: payload.city,
          state: payload.state,
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

    // --- Step 3: download + unpack nssm ----------------------------------
    send(3, "running", "Downloading the Windows service manager…");
    const zipPath = path.join(INSTALL_DIR, "nssm.zip");
    const nssmRes = await fetch(NSSM_URL);
    if (!nssmRes.ok) throw new Error(`Could not download nssm (${nssmRes.status})`);
    fs.writeFileSync(zipPath, Buffer.from(await nssmRes.arrayBuffer()));

    const extractDir = path.join(INSTALL_DIR, "nssm_extract");
    powershell(
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`
    );
    const nssmSrc = path.join(extractDir, "nssm-2.24", "win64", "nssm.exe");
    fs.copyFileSync(nssmSrc, path.join(INSTALL_DIR, "nssm.exe"));
    send(3, "done", "Service manager ready.");

    // --- Step 4: install + start the service -----------------------------
    send(4, "running", `Installing the ${SERVICE_NAME} service…`);

    // Clean any prior install so re-running the wizard is safe.
    nssmQuiet(["stop", SERVICE_NAME]);
    nssmQuiet(["remove", SERVICE_NAME, "confirm"]);

    nssm(["install", SERVICE_NAME, "node.exe", "C:\\StealthPOS\\edge.cjs"]);
    nssm(["set", SERVICE_NAME, "AppDirectory", "C:\\StealthPOS"]);
    nssm(["set", SERVICE_NAME, "AppStdout", "C:\\StealthPOS\\stdout.log"]);
    nssm(["set", SERVICE_NAME, "AppStderr", "C:\\StealthPOS\\stderr.log"]);
    nssm(["set", SERVICE_NAME, "Start", "SERVICE_AUTO_START"]);
    nssm([
      "set",
      SERVICE_NAME,
      "AppEnvironmentExtra",
      `BOS_EDGE_SECRET=${secret}`,
      `BOS_STORE_ID=${storeId}`,
      `BOS_CLOUD_URL=${cloud}`,
      `BOS_WATCH_DIR=${watchDir}`,
      `BOS_MODE=${mode}`,
    ]);
    nssm(["start", SERVICE_NAME]);
    send(4, "done", "Service installed and started.");

    // --- Step 5: watch the log for first activity ------------------------
    send(5, "running", "Waiting for the connector to come online…");
    const logPath = path.join(INSTALL_DIR, "stdout.log");
    const deadline = Date.now() + 30000;
    let cursor = 0;
    let connected = false;

    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        if (!fs.existsSync(logPath)) continue;
        const content = fs.readFileSync(logPath, "utf8");
        if (content.length > cursor) {
          const fresh = content.slice(cursor).split(/\r?\n/).filter(Boolean);
          for (const line of fresh) send(5, "running", line);
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
      send(5, "done", "Connected — your store data is flowing to StealthPOS.");
    } else {
      send(
        5,
        "done",
        "Service is running. Data will upload automatically as POS files arrive."
      );
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
