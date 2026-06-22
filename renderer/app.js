// StealthPOS Connector — wizard renderer logic.
// No framework: screens are <section data-screen> toggled with .is-active.

const state = {
  accountType: "", // "login" | "signup"
  email: "",
  secret: "",
  storeId: "",
  storeName: "",
  posType: "",
  mode: "",
  watchDir: "",
};

// Which step-indicator dot (1-6) each screen maps to.
const SCREEN_STEP = {
  welcome: 1,
  account: 2,
  login: 3,
  signup: 3,
  pos: 4,
  backoffice: 5,
  folder: 6,
  installing: 6,
  done: 6,
};

const screens = {};
document.querySelectorAll("[data-screen]").forEach((el) => {
  screens[el.dataset.screen] = el;
});

let detectRan = false;

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.remove("is-active"));
  const el = screens[name];
  if (!el) return;
  el.classList.add("is-active");
  updateStepbar(SCREEN_STEP[name] || 1, name === "done");

  if (name === "folder" && !detectRan) {
    detectRan = true;
    runDetect();
  }
  if (name === "installing") {
    startInstall();
  }
}

function updateStepbar(active, allDone) {
  document.querySelectorAll("[data-stepdot]").forEach((dot) => {
    const n = Number(dot.dataset.stepdot);
    dot.classList.toggle("is-active", n === active && !allDone);
    dot.classList.toggle("is-done", n < active || allDone);
  });
}

// --- Generic "Back / go to screen" buttons ---------------------------------
document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.go));
});

// --- Screen 2: account choice ----------------------------------------------
document.querySelectorAll("[data-account]").forEach((card) => {
  card.addEventListener("click", () => {
    state.accountType = card.dataset.account;
    showScreen(card.dataset.account); // "login" or "signup"
  });
});

// --- Screen 3a: login ------------------------------------------------------
const loginSubmit = document.getElementById("loginSubmit");
const loginError = document.getElementById("loginError");
const loginStoreFound = document.getElementById("loginStoreFound");
let loggedIn = false;

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}
function clearError(el) {
  el.hidden = true;
  el.textContent = "";
}

loginSubmit.addEventListener("click", async () => {
  if (loggedIn) {
    showScreen("pos");
    return;
  }
  clearError(loginError);
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  if (!email || !password) {
    showError(loginError, "Enter your email and password.");
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.textContent = "Logging in…";
  const res = await window.stealth.apiLogin({ username: email, password });
  loginSubmit.disabled = false;

  if (!res.ok) {
    loginSubmit.textContent = "Log in";
    showError(loginError, res.message || "Login failed.");
    return;
  }

  state.email = email;
  state.secret = res.edgeSecret;
  state.storeId = (res.session && res.session.storeId) || "";
  state.storeName = (res.session && res.session.storeName) || "Your store";
  state.watchDir = (res.session && res.session.posSharePath) || "";

  document.getElementById("loginStoreName").textContent = state.storeName;
  loginStoreFound.hidden = false;
  loginSubmit.textContent = "Continue";
  loggedIn = true;
});

// --- Screen 3b: signup -----------------------------------------------------
const signupSubmit = document.getElementById("signupSubmit");
const signupError = document.getElementById("signupError");

signupSubmit.addEventListener("click", async () => {
  clearError(signupError);
  const payload = {
    legalName: document.getElementById("suBusiness").value.trim(),
    displayName: document.getElementById("suBusiness").value.trim(),
    email: document.getElementById("suEmail").value.trim(),
    password: document.getElementById("suPassword").value,
    storeName: document.getElementById("suStore").value.trim(),
    city: document.getElementById("suCity").value.trim(),
    state: document.getElementById("suState").value.trim(),
    // Backend onboard/start validates posType ∈ {passport,commander,radiant,other}.
    // POS is chosen on a later screen; default the signup record to the most common.
    posType: "passport",
    runningModisoft: "no",
  };

  if (payload.password && payload.password.length < 8) {
    showError(signupError, "Password must be at least 8 characters.");
    return;
  }

  if (
    !payload.legalName ||
    !payload.email ||
    !payload.password ||
    !payload.storeName ||
    !payload.city ||
    !payload.state
  ) {
    showError(signupError, "Please fill in every field.");
    return;
  }

  signupSubmit.disabled = true;
  signupSubmit.textContent = "Creating…";
  const res = await window.stealth.apiSignup(payload);
  signupSubmit.disabled = false;
  signupSubmit.textContent = "Create account";

  if (!res.ok) {
    showError(signupError, res.message || "Could not create your account.");
    return;
  }

  state.email = payload.email;
  state.secret = res.bosEdgeSecret;
  state.storeId = (res.stores[0] && res.stores[0].id) || "";
  state.storeName = (res.stores[0] && res.stores[0].displayName) || payload.storeName;
  showScreen("pos");
});

// --- Screen 4: POS type ----------------------------------------------------
document.querySelectorAll("[data-pos]").forEach((card) => {
  card.addEventListener("click", () => {
    document.querySelectorAll("[data-pos]").forEach((c) => c.classList.remove("is-selected"));
    card.classList.add("is-selected");
    state.posType = card.dataset.pos;
    setTimeout(() => showScreen("backoffice"), 180);
  });
});
document.getElementById("posBack").addEventListener("click", () => {
  showScreen(state.accountType === "signup" ? "signup" : "login");
});

// --- Screen 5: back office mode --------------------------------------------
document.querySelectorAll("[data-mode]").forEach((card) => {
  card.addEventListener("click", () => {
    document.querySelectorAll("[data-mode]").forEach((c) => c.classList.remove("is-selected"));
    card.classList.add("is-selected");
    state.mode = card.dataset.mode;
    setTimeout(() => showScreen("folder"), 180);
  });
});

// --- Screen 6: folder ------------------------------------------------------
const detectPending = document.getElementById("detectPending");
const detectFound = document.getElementById("detectFound");
const detectMissing = document.getElementById("detectMissing");
const folderPath = document.getElementById("folderPath");
const folderContinue = document.getElementById("folderContinue");

function setWatchDir(p) {
  state.watchDir = p;
  folderPath.textContent = p;
  detectPending.hidden = true;
  detectMissing.hidden = true;
  detectFound.hidden = false;
  folderContinue.disabled = false;
}

async function runDetect() {
  detectPending.hidden = false;
  detectFound.hidden = true;
  detectMissing.hidden = true;
  const res = await window.stealth.detectFolder();
  detectPending.hidden = true;
  if (res.found) {
    setWatchDir(res.path);
  } else {
    detectMissing.hidden = false;
  }
}

document.getElementById("browseBtn").addEventListener("click", async () => {
  const res = await window.stealth.browseFolder();
  if (res.path) setWatchDir(res.path);
});

folderContinue.addEventListener("click", () => showScreen("installing"));

// --- Screen 7: installing --------------------------------------------------
const installLog = document.getElementById("installLog");
let installStarted = false;

function setStep(step, status) {
  const li = document.querySelector(`[data-instep="${step}"]`);
  if (!li) return;
  li.classList.remove("is-running", "is-done", "is-error");
  if (status === "running") li.classList.add("is-running");
  if (status === "done") li.classList.add("is-done");
  if (status === "error") li.classList.add("is-error");
}

function appendLog(line) {
  installLog.textContent += (installLog.textContent ? "\n" : "") + line;
  installLog.scrollTop = installLog.scrollHeight;
}

window.stealth.onInstallProgress((d) => {
  if (d.step >= 1 && d.step <= 5) setStep(d.step, d.status);
  if (d.status === "error") {
    setStep(d.step || 1, "error");
    appendLog("ERROR: " + d.log);
  } else if (d.log) {
    appendLog(d.log);
  }
});

async function startInstall() {
  if (installStarted) return;
  installStarted = true;
  const res = await window.stealth.installEdge({
    secret: state.secret,
    storeId: state.storeId,
    watchDir: state.watchDir,
    mode: state.mode,
    cloudUrl: "https://stealthpos.net",
  });
  if (res.ok) {
    document.getElementById("doneStoreName").textContent = state.storeName || "Your store";
    setTimeout(() => showScreen("done"), 900);
  } else {
    appendLog("");
    appendLog("Installation did not complete. Please contact StealthPOS support.");
  }
}

// --- Screen 8: done --------------------------------------------------------
document.getElementById("openDashboard").addEventListener("click", () => {
  window.stealth.openDashboard();
});

// Boot.
showScreen("welcome");
