// StealthPOS Connector — wizard renderer logic.
// Screens are <section data-screen> toggled with .is-active.

const state = {
  accountType: "", // "login" | "signup"
  email: "",
  secret: "",
  storeId: "",
  storeName: "",
  posType: "",   // set on POS screen — "passport" | "commander" | "other"
  mode: "",
  watchDir: "",
};

// Which step-indicator dot (1-6) each screen maps to.
const SCREEN_STEP = {
  welcome:    1,
  account:    2,
  login:      3,
  signup:     3,
  pos:        4,
  backoffice: 5,
  folder:     6,
  installing: 6,
  done:       6,
};

const screens = {};
document.querySelectorAll("[data-screen]").forEach((el) => {
  screens[el.dataset.screen] = el;
});

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.remove("is-active"));
  const el = screens[name];
  if (!el) return;
  el.classList.add("is-active");
  updateStepbar(SCREEN_STEP[name] || 1, name === "done");

  if (name === "folder") onFolderScreenEnter();
  if (name === "installing") startInstall();
}

function updateStepbar(active, allDone) {
  document.querySelectorAll("[data-stepdot]").forEach((dot) => {
    const n = Number(dot.dataset.stepdot);
    dot.classList.toggle("is-active", n === active && !allDone);
    dot.classList.toggle("is-done", n < active || allDone);
  });
}

// --- Generic "go to screen" buttons ----------------------------------------
document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => showScreen(btn.dataset.go));
});

// --- Screen 2: account choice -----------------------------------------------
document.querySelectorAll("[data-account]").forEach((card) => {
  card.addEventListener("click", () => {
    state.accountType = card.dataset.account;
    showScreen(card.dataset.account);
  });
});

// ---------------------------------------------------------------------------
// Screen 3a: login — two-step flow
// Step 1: enter email → lookup → show step 2
// Step 2: enter password → sign in
// ---------------------------------------------------------------------------
const loginStep1       = document.getElementById("loginStep1");
const loginStep2       = document.getElementById("loginStep2");
const loginEmailInput  = document.getElementById("loginEmail");
const loginEmailPill   = document.getElementById("loginEmailPill");
const loginEmailError  = document.getElementById("loginEmailError");
const loginPasswordInput = document.getElementById("loginPassword");
const loginPasswordError = document.getElementById("loginPasswordError");
const loginStoreFound  = document.getElementById("loginStoreFound");
const loginNextBtn     = document.getElementById("loginNextBtn");
const loginSubmit      = document.getElementById("loginSubmit");
const loginChangeEmail = document.getElementById("loginChangeEmailBtn");

let loginAuthed = false; // true after successful API login

function showLoginStep(n) {
  loginStep1.hidden = n !== 1;
  loginStep2.hidden = n !== 2;
}

function showErr(el, msg)  { el.textContent = msg; el.hidden = false; }
function clearErr(el)       { el.hidden = true; el.textContent = ""; }

// Whenever the login screen becomes active, reset to step 1 unless already authed.
function resetLogin() {
  if (loginAuthed) return;
  showLoginStep(1);
  clearErr(loginEmailError);
  clearErr(loginPasswordError);
  loginStoreFound.hidden = true;
  loginSubmit.textContent = "Sign in";
  loginSubmit.disabled = false;
}

// Step 1 → Continue
loginNextBtn.addEventListener("click", async () => {
  clearErr(loginEmailError);
  const email = loginEmailInput.value.trim();
  if (!email || !loginEmailInput.validity.valid) {
    showErr(loginEmailError, "Please enter a valid email address.");
    return;
  }

  loginNextBtn.disabled = true;
  loginNextBtn.textContent = "Checking…";

  // Try the email-lookup endpoint; if it doesn't exist yet, proceed anyway.
  const lookup = await window.stealth.lookupEmail({ email });
  loginNextBtn.disabled = false;
  loginNextBtn.textContent = "Continue";

  if (!lookup.degraded && lookup.found === false) {
    showErr(loginEmailError, "No account found with that email. Check for typos or sign up instead.");
    return;
  }

  // Show step 2
  loginEmailPill.textContent = email;
  loginPasswordInput.value = "";
  clearErr(loginPasswordError);
  loginStoreFound.hidden = true;
  loginSubmit.textContent = "Sign in";
  loginSubmit.disabled = false;
  loginAuthed = false;
  showLoginStep(2);
  setTimeout(() => loginPasswordInput.focus(), 50);
});

// Step 2 → back to step 1
loginChangeEmail.addEventListener("click", () => {
  loginAuthed = false;
  showLoginStep(1);
  setTimeout(() => loginEmailInput.focus(), 50);
});

// Forgot password link — opens dashboard in browser
document.getElementById("forgotPasswordLink").addEventListener("click", (e) => {
  e.preventDefault();
  window.stealth.openDashboard(); // opens stealthpos.net/admin; backend handles /forgot-password redirect
});

// Step 2 → Sign in
loginSubmit.addEventListener("click", async () => {
  if (loginAuthed) { showScreen("pos"); return; }

  clearErr(loginPasswordError);
  const email    = loginEmailInput.value.trim();
  const password = loginPasswordInput.value;
  if (!password) { showErr(loginPasswordError, "Please enter your password."); return; }

  loginSubmit.disabled = true;
  loginSubmit.textContent = "Signing in…";

  const res = await window.stealth.apiLogin({ username: email, password });
  loginSubmit.disabled = false;

  if (!res.ok) {
    loginSubmit.textContent = "Sign in";
    showErr(loginPasswordError, res.message || "Incorrect password. Please try again.");
    return;
  }

  state.email     = email;
  state.secret    = res.edgeSecret;
  state.storeId   = (res.session && res.session.storeId)    || "";
  state.storeName = (res.session && res.session.storeName)  || "Your store";
  state.watchDir  = (res.session && res.session.posSharePath) || "";

  document.getElementById("loginStoreName").textContent = state.storeName;
  loginStoreFound.hidden = false;
  loginSubmit.textContent = "Continue →";
  loginAuthed = true;
});

// ---------------------------------------------------------------------------
// Screen 3b: signup
// ---------------------------------------------------------------------------
const signupSubmit = document.getElementById("signupSubmit");
const signupError  = document.getElementById("signupError");

signupSubmit.addEventListener("click", async () => {
  clearErr(signupError);

  const payload = {
    legalName:   document.getElementById("suBusiness").value.trim(),
    displayName: document.getElementById("suBusiness").value.trim(),
    email:       document.getElementById("suEmail").value.trim(),
    password:    document.getElementById("suPassword").value,
    storeName:   document.getElementById("suStore").value.trim(),
    phone:       document.getElementById("suPhone").value.trim(),
    city:        document.getElementById("suCity").value.trim(),
    state:       document.getElementById("suState").value.trim(),
    posType:     state.posType || "passport",
    runningModisoft: "no",
  };

  if (!payload.legalName || !payload.email || !payload.password ||
      !payload.storeName  || !payload.city  || !payload.state) {
    showErr(signupError, "Please fill in all required fields.");
    return;
  }
  if (payload.password.length < 8) {
    showErr(signupError, "Password must be at least 8 characters.");
    return;
  }

  signupSubmit.disabled = true;
  signupSubmit.textContent = "Creating…";
  const res = await window.stealth.apiSignup(payload);
  signupSubmit.disabled = false;
  signupSubmit.textContent = "Create account";

  if (!res.ok) {
    showErr(signupError, res.message || "Could not create your account.");
    return;
  }

  state.email     = payload.email;
  state.secret    = res.bosEdgeSecret;
  state.storeId   = (res.stores[0] && res.stores[0].id)           || "";
  state.storeName = (res.stores[0] && res.stores[0].displayName)  || payload.storeName;
  showScreen("pos");
});

// ---------------------------------------------------------------------------
// Screen 4: POS type
// ---------------------------------------------------------------------------
const POS_SUBTITLE = {
  passport:  "We'll scan for the Gilbarco Passport XML export folder automatically.",
  commander: "We'll scan for the Verifone Commander export folder automatically.",
  other:     "We'll scan for known POS data folders, or you can pick one manually.",
};

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

// ---------------------------------------------------------------------------
// Screen 5: back office mode
// ---------------------------------------------------------------------------
document.querySelectorAll("[data-mode]").forEach((card) => {
  card.addEventListener("click", () => {
    document.querySelectorAll("[data-mode]").forEach((c) => c.classList.remove("is-selected"));
    card.classList.add("is-selected");
    state.mode = card.dataset.mode;
    setTimeout(() => showScreen("folder"), 180);
  });
});

// ---------------------------------------------------------------------------
// Screen 6: folder (smart, network-aware detection)
// ---------------------------------------------------------------------------
const detectPending     = document.getElementById("detectPending");
const detectPendingText = document.getElementById("detectPendingText");
const detectFound       = document.getElementById("detectFound");
const detectFoundTitle  = document.getElementById("detectFoundTitle");
const detectNote        = document.getElementById("detectNote");
const detectMissing     = document.getElementById("detectMissing");
const detectCandidates  = document.getElementById("detectCandidates");
const candidateList     = document.getElementById("candidateList");
const folderPath        = document.getElementById("folderPath");
const folderContinue    = document.getElementById("folderContinue");
const retryDetectBtn    = document.getElementById("retryDetectBtn");
const folderSubtitle    = document.getElementById("folderSubtitle");

const isUncPath = (p) => /^\\\\/.test(p || "");

// Live progress lines streamed from the main-process scan.
if (window.stealth && window.stealth.onDetectProgress) {
  window.stealth.onDetectProgress((msg) => {
    detectPendingText.textContent = msg;
  });
}

function resetFolderUI() {
  detectPending.hidden = true;
  detectFound.hidden   = true;
  detectMissing.hidden = true;
  detectCandidates.hidden = true;
  retryDetectBtn.hidden = true;
  detectNote.hidden = true;
  folderContinue.disabled = true;
  folderPath.textContent = "—";
  candidateList.innerHTML = "";
}

// Apply a chosen watch dir + optional metadata.
function setWatchDir(p, meta) {
  if (!p) return; // guard against empty path enabling the button
  meta = meta || {};
  state.watchDir = p;
  folderPath.textContent = p;

  // A network share can only be read in MIRROR mode — owner mode MOVES files
  // and would starve a back-office system like Modisoft (and the connector
  // refuses owner mode on a UNC path). Enforce it automatically.
  if (meta.isNetwork || isUncPath(p)) {
    state.mode = "mirror";
  } else if (meta.mode && !state.mode) {
    state.mode = meta.mode;
  }

  if (meta.note) {
    detectNote.textContent =
      meta.note + ((meta.isNetwork || isUncPath(p)) ? " · network share · mirror mode" : "");
    detectNote.hidden = false;
  } else {
    detectNote.hidden = true;
  }

  detectPending.hidden = true;
  detectMissing.hidden = true;
  detectFound.hidden   = false;
  retryDetectBtn.hidden = false; // allow a re-scan even after a hit
  folderContinue.disabled = false;
}

// Render the ranked alternatives (everything except the current pick).
function renderCandidates(candidates, chosenPath) {
  candidateList.innerHTML = "";
  const others = (candidates || []).filter((c) => c.path !== chosenPath);
  if (others.length === 0) { detectCandidates.hidden = true; return; }
  for (const c of others) {
    const btn = document.createElement("button");
    btn.className = "candidate";
    const code = document.createElement("code");
    code.textContent = c.path;
    const note = document.createElement("span");
    note.textContent = c.note || "";
    btn.appendChild(code);
    btn.appendChild(note);
    btn.addEventListener("click", () => {
      detectFoundTitle.textContent = "Folder selected";
      setWatchDir(c.path, c);
      renderCandidates(candidates, c.path);
    });
    candidateList.appendChild(btn);
  }
  detectCandidates.hidden = false;
}

async function runDetect() {
  resetFolderUI();
  detectPending.hidden = false;
  detectPendingText.textContent = "Scanning…";

  folderSubtitle.textContent = POS_SUBTITLE[state.posType] || POS_SUBTITLE.other;

  // If login already returned a posSharePath, trust it.
  if (state.watchDir) {
    detectFoundTitle.textContent = "Folder found";
    setWatchDir(state.watchDir, { note: "From your account", isNetwork: isUncPath(state.watchDir) });
    return;
  }

  const res = await window.stealth.detectFolder();
  detectPending.hidden = true;

  if (res && res.found) {
    detectFoundTitle.textContent = "Folder found";
    const best = (res.candidates && res.candidates[0]) || { mode: res.mode, isNetwork: res.isNetwork };
    setWatchDir(res.path, best);
    renderCandidates(res.candidates, res.path);
  } else {
    detectMissing.hidden  = false;
    retryDetectBtn.hidden = false;
  }
}

function onFolderScreenEnter() {
  runDetect();
}

retryDetectBtn.addEventListener("click", () => {
  state.watchDir = ""; // force a fresh scan
  runDetect();
});

document.getElementById("browseBtn").addEventListener("click", async () => {
  const res = await window.stealth.browseFolder();
  if (res.path) {
    detectFoundTitle.textContent = "Folder selected";
    setWatchDir(res.path, { note: "Chosen manually", isNetwork: isUncPath(res.path) });
  }
});

folderContinue.addEventListener("click", () => {
  if (!state.watchDir) return; // should never happen given the disabled state
  showScreen("installing");
});

// ---------------------------------------------------------------------------
// Screen 7: installing
// ---------------------------------------------------------------------------
const installLog = document.getElementById("installLog");
let installStarted = false;

function setStep(step, status) {
  const li = document.querySelector(`[data-instep="${step}"]`);
  if (!li) return;
  li.classList.remove("is-running", "is-done", "is-error");
  if (status === "running") li.classList.add("is-running");
  if (status === "done")    li.classList.add("is-done");
  if (status === "error")   li.classList.add("is-error");
}

function appendLog(line) {
  installLog.textContent += (installLog.textContent ? "\n" : "") + line;
  installLog.scrollTop = installLog.scrollHeight;
}

if (window.stealth && window.stealth.onInstallProgress) {
  window.stealth.onInstallProgress((d) => {
    if (d.step >= 1 && d.step <= 6) setStep(d.step, d.status);
    if (d.status === "error") {
      setStep(d.step || 1, "error");
      appendLog("ERROR: " + d.log);
    } else if (d.log) {
      appendLog(d.log);
    }
  });
}

async function startInstall() {
  if (installStarted) return;
  installStarted = true;
  const res = await window.stealth.installEdge({
    secret:   state.secret,
    storeId:  state.storeId,
    watchDir: state.watchDir,
    mode:     state.mode,
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

// ---------------------------------------------------------------------------
// Screen 8: done
// ---------------------------------------------------------------------------
document.getElementById("openDashboard").addEventListener("click", () => {
  window.stealth.openDashboard();
});

// Boot — reset login step on initial load
showLoginStep(1);
showScreen("welcome");
