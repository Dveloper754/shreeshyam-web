// Main app: login gate + the Transaction Report screen.
import { isConfigured } from "./supabaseClient.js";
import { currentSession, onAuthChange, signIn, signOut, changePassword, usernameToEmail } from "./auth.js";
import * as api from "./api.js";
import { inr, ddmmyyyy, todayISO, esc, balanceMeta, setDecimals } from "./format.js?v=26";
import { ledgerHTML, downloadLedgerPDF, downloadTrialPDF, trialSplit, downloadDayBookPDF, deliverPdf } from "./print.js";
import { sheetToXlsxBlob } from "./xlsx.js";
import { BUSINESS_NAME, VOICE_AI, VOICE_CLOUD, SUPABASE_URL, SUPABASE_ANON_KEY, APP_VERSION } from "../config.js";

const $ = (id) => document.getElementById(id);
const state = {
  session: null,
  party: null,        // selected party (from party_balances)
  rows: [],           // current ledger rows
  parties: [],        // party list
  selectedEntryId: null,
  capitalName: "Capital Account",   // custom name for the Capital account
  voiceLang: "en-IN",  // mic language (set in User Settings)
  amountUnit: 100,     // book unit: box amount = real rupees ÷ this (1/10/100/1000); amount only
  trSession: null,     // open trading session
  trades: [],          // trades in the open session
  trSelectedId: null,  // selected trade row
  trEditSessionId: null,   // match being edited
  trEditTradeId: null,
  matches: [],             // all matches (Match Report)
  matchSelectedId: null,
  sessions: [],            // sessions of the open match (Session Report)
  srSelectedId: null,      // selected session row
  runSession: null,        // open session (for runs)
  rightMode: "report",     // right screen: "report" | "session"
  bookOpen: false,         // Match Book overlay open?
  trMax: null,             // which screen is maximised: "main" | "right" | null
  syBets: [],              // SESSION (runs) bets for the open session
  sySelectedId: null,
  syEditId: null,
};

// Sorting helpers.
// Names beginning with "*" always float to the top of any list.
const starRank = (p) => (String(p.name || "").trim().startsWith("*") ? 0 : 1);
const byStarThenName = (a, b) => starRank(a) - starRank(b) || a.name.localeCompare(b.name);
// Newest entry first (used inside a party's ledger view).
const byNewest = (a, b) =>
  String(b.entry_date).localeCompare(String(a.entry_date)) ||
  String(b.created_at).localeCompare(String(a.created_at));

// White-label: apply a client's business name across the title/header/home.
// Falls back to the configured default before login / when no profile is set.
function applyBrand(name) {
  const b = (name && String(name).trim()) || BUSINESS_NAME;
  window.__BRAND = b;
  document.title = b;
  if ($("brandName2")) $("brandName2").textContent = b;
  if ($("homeBizName")) $("homeBizName").textContent = b;
}

// ---------------- boot ----------------
// ---- "Update available" notice (never auto-refreshes) ----------------------
// The desktop app loads its screen from the live site, so a deploy reaches every PC.
// We must NOT refresh on our own — an ongoing match must not change under the user.
// Instead we watch for a newer APP_VERSION on the server and show a button; the user
// taps "Update now" only when it's safe (between matches). "Later" dismisses it for
// this session (the next time the app is opened it loads the latest anyway).
let _updateShown = false;
let _configUrl = null;
try { _configUrl = new URL("../config.js", import.meta.url).href; } catch (e) { _configUrl = "config.js"; }

function showUpdateButton() {
  if (_updateShown || !document.body) return;
  _updateShown = true;
  if (!document.getElementById("updateBarCss")) {
    const style = document.createElement("style");
    style.id = "updateBarCss";
    style.textContent =
      "#updateBar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;background:#1f4e5f;color:#fff;padding:10px 14px;border-radius:10px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 28px rgba(0,0,0,.35);font-size:14px;font-weight:600;max-width:92vw}"
      + "#updateBar button{border:none;border-radius:7px;padding:6px 12px;font-weight:700;cursor:pointer}"
      + "#updateNowBtn{background:#f4b400;color:#1f2d33}#updateLaterBtn{background:transparent;color:#cfe0ec;text-decoration:underline}";
    document.head.appendChild(style);
  }
  const bar = document.createElement("div");
  bar.id = "updateBar";
  bar.innerHTML = "<span>🔄 A new version is available.</span>"
    + "<button id='updateNowBtn'>Update now</button>"
    + "<button id='updateLaterBtn'>Later</button>";
  document.body.appendChild(bar);
  const now = document.getElementById("updateNowBtn");
  const later = document.getElementById("updateLaterBtn");
  if (now) now.onclick = () => { doUpdateNow(now); };
  if (later) later.onclick = () => { bar.remove(); };   // keep _updateShown true → no nagging this session
}

// "Update now": a plain location.reload() can re-serve the cached app.js/config.js
// (so the version never changes and the banner returns). Force-refresh the shell
// files past the HTTP cache first, clear any cache storage, then reload.
async function doUpdateNow(btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Updating…"; }
  const base = (location.pathname.replace(/[^/]*$/, "")) || "/";
  const bust = { cache: "reload" };
  const urls = [
    base, base + "index.html", base + "config.js", base + "css/styles.css",
    base + "js/app.js", base + "js/format.js", base + "js/print.js",
    base + "js/api.js", base + "js/auth.js", base + "js/xlsx.js",
    base + "js/supabaseClient.js",
  ];
  try { await Promise.all(urls.map((u) => fetch(u, bust).catch(() => {}))); } catch (e) {}
  try { if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } } catch (e) {}
  location.reload();
}

async function checkForUpdate() {
  if (_updateShown) return;
  try {
    const res = await fetch(_configUrl + "?nocache=" + Date.now(), { cache: "no-store" });
    if (!res.ok) return;
    const txt = await res.text();
    const m = txt.match(/APP_VERSION\s*=\s*["']([^"']+)["']/);
    if (m && m[1] && m[1] !== APP_VERSION) showUpdateButton();
  } catch (e) { /* offline or unreachable — ignore, try again later */ }
}

function startUpdateCheck() {
  if (!/^https?:/i.test(location.protocol)) return;     // only when loaded from the live site (not offline file://)
  setTimeout(checkForUpdate, 20000);                    // shortly after opening
  setInterval(checkForUpdate, 5 * 60 * 1000);           // then every 5 minutes
  window.addEventListener("focus", checkForUpdate);     // and whenever they return to the app
}

// Desktop only: the Electron shell (electron-updater) downloads a new EXE in the
// background and then tells the page it's ready. We show a Restart button; the app
// is replaced only when the user taps it, so an ongoing match is never disturbed.
function ensureUpdateBarCss() {
  if (document.getElementById("updateBarCss")) return;
  const style = document.createElement("style");
  style.id = "updateBarCss";
  style.textContent =
    "#updateBar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;background:#1f4e5f;color:#fff;padding:10px 14px;border-radius:10px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 28px rgba(0,0,0,.35);font-size:14px;font-weight:600;max-width:92vw}"
    + "#updateBar button{border:none;border-radius:7px;padding:6px 12px;font-weight:700;cursor:pointer}"
    + "#updateNowBtn{background:#f4b400;color:#1f2d33}#updateLaterBtn{background:transparent;color:#cfe0ec;text-decoration:underline}";
  document.head.appendChild(style);
}
let _restartShown = false;
function showRestartButton(ver) {
  if (_restartShown || !document.body || !(window.electronAPI && window.electronAPI.restartToUpdate)) return;
  _restartShown = true;
  ensureUpdateBarCss();
  const old = document.getElementById("updateBar"); if (old) old.remove();   // supersede the content-update bar if shown
  const bar = document.createElement("div");
  bar.id = "updateBar";
  bar.innerHTML = "<span>⬇️ App update ready" + (ver ? (" (v" + ver + ")") : "") + ".</span>"
    + "<button id='updateNowBtn'>Restart now</button>"
    + "<button id='updateLaterBtn'>Later</button>";
  document.body.appendChild(bar);
  const now = document.getElementById("updateNowBtn");
  const later = document.getElementById("updateLaterBtn");
  if (now) now.onclick = () => { try { window.electronAPI.restartToUpdate(); } catch (e) {} };
  if (later) later.onclick = () => { bar.remove(); };   // applies on next normal close anyway
}

function boot() {
  window.__BRAND = BUSINESS_NAME;
  document.title = BUSINESS_NAME;
  if ($("brandName")) $("brandName").textContent = BUSINESS_NAME;
  if ($("brandName2")) $("brandName2").textContent = BUSINESS_NAME;
  if ($("homeBizName")) $("homeBizName").textContent = BUSINESS_NAME;

  if (!isConfigured) {
    $("configWarning").style.display = "block";
    $("loginView").style.display = "none";
    return;
  }
  wireStaticEvents();
  startUpdateCheck();
  onAuthChange((session) => renderAuth(session));
  currentSession().then((s) => renderAuth(s));
}

let _authedUid = null;
async function renderAuth(session) {
  state.session = session;
  if (session) {
    // Supabase re-fires this on token refresh / tab focus. If the SAME user is
    // already signed in, do nothing — don't reset the open page back to the dashboard.
    if (_authedUid === session.user.id) {
      if (window.electronAPI && window.electronAPI.setCloseGuard) window.electronAPI.setCloseGuard(true);
      return;
    }
    // Desktop: this device's licence is bound to ONE client — reject any other login.
    if (window.electronAPI && window.electronAPI.licenseState) {
      try {
        const st = await window.electronAPI.licenseState();
        const lu = (st && st.payload && st.payload.client_user) ? String(st.payload.client_user).toLowerCase() : "";
        const full = (session.user.email || "").toLowerCase();
        const who = full.split("@")[0];
        if (lu && lu !== who && lu !== full) {
          toast(`This device is licensed for "${lu}". Please sign in with that account.`, true);
          if (window.electronAPI.setCloseGuard) window.electronAPI.setCloseGuard(false);
          await signOut();
          return;
        }
      } catch (e) { /* if the check fails, fall through */ }
    }
    _authedUid = session.user.id;   // mark signed-in only after the licence check passes
    // Desktop: only intercept the window X (to back up) while signed in.
    if (window.electronAPI && window.electronAPI.setCloseGuard) window.electronAPI.setCloseGuard(true);
    $("loginView").style.display = "none";
    $("appView").style.display = "block";
    $("userEmail").textContent = (session.user.email || "").split("@")[0];
    _navStack = [];
    // Make sure this user has their own settings + Capital account, then load.
    api.ensureUserSetup()
      .catch(() => {})
      .finally(() => {
        refreshParties();
        api.getSettings().then((s) => { if (s && s.voice_lang) state.voiceLang = s.voice_lang; }).catch(() => {});
        // White-label: show this client's own business name + remember mobile entitlement.
        api.getProfile().then((pr) => {
          if (pr) { applyBrand(pr.business_name); state.mobileEnabled = !!pr.mobile_enabled; }
          checkSubscription(pr);
        }).catch(() => {});
      });
    showView("home");
    maybeAutoBackup();
    updateLicenseBadge();
  } else {
    _authedUid = null;
    if (window.electronAPI && window.electronAPI.setCloseGuard) window.electronAPI.setCloseGuard(false);
    $("appView").style.display = "none";
    $("loginView").style.display = "flex";
  }
}

// Subscription gate (UX): the database already blocks data when expired; this
// shows a clear "renew" screen instead of a confusing empty app.
function checkSubscription(pr) {
  const el = $("subExpiredView");
  if (!el) return;
  const until = pr && pr.access_until ? Date.parse(pr.access_until) : 0;
  const expired = until > 0 && until <= Date.now();
  if (expired) {
    $("appView").style.display = "none";
    el.style.display = "flex";
    return;
  }
  el.style.display = "none";
  // Gentle reminder when renewal is near.
  if (until > 0) {
    const days = Math.ceil((until - Date.now()) / 86400000);
    if (days <= 15) toast(`Subscription: ${days} day${days === 1 ? "" : "s"} left — please renew soon.`);
  }
}

// Desktop only: show how many days are left on this device's licence.
async function updateLicenseBadge() {
  const el = $("licBadge");
  if (!el) return;
  if (!(window.electronAPI && window.electronAPI.licenseState)) { el.style.display = "none"; return; }
  try {
    const st = await window.electronAPI.licenseState();
    if (!st || !st.enabled || !st.ok || st.daysLeft == null) { el.style.display = "none"; return; }
    const d = st.daysLeft;
    el.textContent = d <= 0 ? "Licence expired" : `Licence: ${d} day${d === 1 ? "" : "s"} left`;
    el.className = "lic-badge" + (d <= 7 ? " crit" : (d <= 30 ? " warn" : ""));
    el.title = st.payload && st.payload.expires_at ? ("Expires " + ddmmyyyy(st.payload.expires_at.slice(0, 10))) : "";
    el.style.display = "";
  } catch (e) { el.style.display = "none"; }
}

// ---------------- toast ----------------
let toastTimer;
function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3200);
}

// ---------------- login ----------------
function wireStaticEvents() {
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("loginUser").value.trim();
    const pass = $("loginPassword").value;
    if (!username || !pass) return toast("Enter username and password", true);
    const email = usernameToEmail(username);
    try {
      await signIn(email, pass);
    } catch (err) {
      toast("Login failed", true);
    }
  });

  $("logoutBtn").addEventListener("click", () => openLogoutPage(false));
  if ($("homeLogout")) $("homeLogout").addEventListener("click", () => openLogoutPage(false));
  if ($("logoutCancel")) $("logoutCancel").addEventListener("click", closeLogoutPage);
  if ($("logoutConfirm")) $("logoutConfirm").addEventListener("click", performLogout);
  if ($("subLogoutBtn")) $("subLogoutBtn").addEventListener("click", () => { $("subExpiredView").style.display = "none"; signOut(); });
  // Desktop (Electron): pressing the window's X shows the logout page instead of quitting.
  if (window.electronAPI && window.electronAPI.onCloseRequested)
    window.electronAPI.onCloseRequested(() => openLogoutPage(true));
  // Desktop: a new app version finished downloading → offer a Restart button.
  if (window.electronAPI && window.electronAPI.onAppUpdateReady)
    window.electronAPI.onAppUpdateReady((info) => showRestartButton(info && info.version));
  $("backBtn").addEventListener("click", goBack);

  // Party selection — type a name at the top to open a ledger
  $("partyInput").addEventListener("change", (e) => openByName(e.target.value));
  $("partyInput").addEventListener("keydown", (e) => { if (e.key === "Enter") openByName(e.target.value); });
  $("newPartyBtn").addEventListener("click", () => openNewParty());
  $("savePartyBtn").addEventListener("click", saveNewParty);
  if ($("addAgentBtn")) $("addAgentBtn").addEventListener("click", addAgent);
  if ($("agentsList")) $("agentsList").addEventListener("click", onAgentsListClick);
  if ($("addPartnerBtn")) $("addPartnerBtn").addEventListener("click", addPartner);
  if ($("partnersList")) $("partnersList").addEventListener("click", onPartnersListClick);
  if ($("npManagePartners")) $("npManagePartners").addEventListener("click", openPartnersModal);
  if ($("incCommMatchType")) $("incCommMatchType").addEventListener("change", updateMatchCommLabels);

  // Entry bar
  $("btnSubmit").addEventListener("click", () => addEntry());
  // Enter moves forward through the fields (like Tab); Enter on the last submits.
  const entrySeq = ["entryParty", "entryAmount", "entryRemark", "entryDate"];
  entrySeq.forEach((id, i) => {
    $(id).addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (i < entrySeq.length - 1) $(entrySeq[i + 1]).focus();
      else addEntry();
    });
  });

  // Toolbar
  $("btnExit").addEventListener("click", backToSettlement);
  $("btnPrint").addEventListener("click", openLedgerRange);
  $("showLedgerBtn").addEventListener("click", doShowLedger);
  $("printLedgerBtn").addEventListener("click", saveLedgerPdf);
  $("btnModify").addEventListener("click", openModify);
  $("btnDelete").addEventListener("click", doDelete);
  $("btnMondayFinal").addEventListener("click", doMondayFinal);
  $("btnOldRecord").addEventListener("click", openOldRecord);
  $("saveModifyBtn").addEventListener("click", saveModify);
  $("btnSetCapital").addEventListener("click", () => {
    $("capOpening").value = state.party?.opening_balance ?? 0;
    openModal("capitalModal");
  });
  $("saveCapitalBtn").addEventListener("click", saveCapital);

  // Tab navigation (nav buttons + home cards)
  document.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => showView(b.getAttribute("data-view"))));

  // old-app menu bar
  document.querySelectorAll(".menubar .menu-top").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = btn.parentElement;
      const act = btn.getAttribute("data-act");
      const wasOpen = menu.classList.contains("open");
      document.querySelectorAll(".menubar .menu").forEach((m) => m.classList.remove("open"));
      if (act) return menuAction(act);                 // top-level item with a direct action
      if (!wasOpen) menu.classList.add("open");          // otherwise toggle its dropdown
    }));
  document.querySelectorAll(".menu-drop button[data-act]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".menubar .menu").forEach((m) => m.classList.remove("open"));
      menuAction(b.getAttribute("data-act"));
    }));
  document.addEventListener("click", () => document.querySelectorAll(".menubar .menu").forEach((m) => m.classList.remove("open")));
  // Keyboard shortcuts (match the old app's menu accelerators)
  document.addEventListener("keydown", (e) => {
    // don't hijack keys while typing in a field
    const t = e.target, tag = (t && t.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (t && t.isContentEditable)) return;
    let act = null;
    if (e.ctrlKey && e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === "u") act = "usersettings";
      else if (k === "b") act = "backup";
    } else if (e.ctrlKey && !e.altKey && e.key === "F3") act = "tossReport";
    else if (!e.ctrlKey && !e.altKey && !e.shiftKey) {
      const map = { F1: "newParty", F2: "newMatch", F3: "matchReport", F4: "sessionReport",
        F5: "cupReport", F6: "connect", F7: "backup", F8: "findSauda", F9: "hawala", F10: "partyReport", F11: "settlementReport", F12: "trial" };
      act = map[e.key] || null;
    }
    if (act) { e.preventDefault(); menuAction(act); }
  });
  // Quick ENTRY shortcuts: jump into the MATCH entry box (left) or the SESSION entry
  // box (right) so you can type a sauda at once. The keys are a per-device preference
  // (Configure → User Settings), defaulting to Ctrl+M / Ctrl+S. They fire even while
  // another field is focused, and override the browser's own combo (e.g. Ctrl+S save).
  state.shortcuts = { match: readShortcut("match"), session: readShortcut("session") };
  const focusEntry = (id) => {
    const el = $(id);
    if (!el || el.disabled || el.offsetParent === null) return false;
    setTimeout(() => { try { el.focus(); if (el.select) el.select(); } catch (e) {} }, 0);
    return true;
  };
  document.addEventListener("keydown", (e) => {
    if (e.metaKey) return;
    const sc = state.shortcuts || {};
    if (sc.match && matchShortcut(e, sc.match)) {
      e.preventDefault();
      if (state.trSession) {
        if (state.trMax === "right") { state.trMax = "main"; applyPanes(); }   // bring the match pane forward
        if (!focusEntry("trRate")) menuAction("matchReport");
      } else menuAction("matchReport");
    } else if (sc.session && matchShortcut(e, sc.session)) {
      e.preventDefault();
      if (state.runSession) {
        if (state.trMax === "main") { state.trMax = "right"; applyPanes(); }    // bring the session pane forward
        if (!focusEntry("syRate")) menuAction("sessionReport");
      } else menuAction("sessionReport");
    }
  });
  // In full screen, Tab toggles between the Match and Session windows.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!state.trMax) return;                 // only while a pane is maximised
    e.preventDefault();
    const to = state.trMax === "main" ? "right" : "main";
    state.trMax = to;
    applyPanes();
    // land the cursor in the first entry field of the window we switched to
    const first = to === "main" ? "trRate" : "syAmount";
    const el = $(first);
    if (el && !el.disabled && el.offsetParent !== null) setTimeout(() => el.focus(), 0);
  });
  if ($("brandName2")) $("brandName2").addEventListener("click", () => showView("home"));
  if ($("drPdf")) $("drPdf").addEventListener("click", doDayReportPdf);
  if ($("drShare")) $("drShare").addEventListener("click", shareDayReportWhatsApp);
  if ($("drImg")) $("drImg").addEventListener("click", () => copyElementAsImage("drSheet", "DayBook"));
  if ($("drRefresh")) $("drRefresh").addEventListener("click", renderDayReport);
  if ($("drExit")) $("drExit").addEventListener("click", () => showView("home"));
  if ($("usSave")) $("usSave").addEventListener("click", saveUserSettings);
  if ($("usClose")) $("usClose").addEventListener("click", () => showView("home"));
  if ($("usOneTime")) $("usOneTime").addEventListener("click", () => toast("OneTime — not used in the web build"));
  if ($("hgMatch")) $("hgMatch").addEventListener("change", (e) => renderHomeGtTable(e.target.value));
  if ($("hgRefresh")) $("hgRefresh").addEventListener("click", () => renderHomeGt(true));

  // voice bet entry — mic button auto-fills, then you press Enter to add
  if ($("trMicBtn")) $("trMicBtn").addEventListener("click", () => startVoice("match"));
  if ($("syMicBtn")) $("syMicBtn").addEventListener("click", () => startVoice("session"));
  readAmountUnit();  // load the saved amount unit for this device

  // Party-name fields accept ONLY existing clients: flag unknown names in red as
  // you type (the Submit buttons also block them). Autocomplete lists real parties.
  // Sauda party boxes: NO dropdown list. Inline autocomplete instead — as you type
  // initials, the best-matching client fills in with the added letters highlighted,
  // so the next keystroke narrows it. Right client → submit; wrong → type on.
  ["trParty", "syParty"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.setAttribute("autocomplete", "off");
    el.removeAttribute("list");
    el.addEventListener("input", (e) => {
      const del = e.inputType && /delete/i.test(e.inputType);   // don't fight backspace
      if (!del) {
        const typed = el.value;
        if (typed) {
          const lc = typed.toLowerCase();
          const hit = partyNamesSorted().find((n) => n.toLowerCase().startsWith(lc));
          if (hit && hit.length > typed.length) {
            el.value = typed + hit.slice(typed.length);
            try { el.setSelectionRange(typed.length, hit.length); } catch (_) {}
          }
        }
      }
      markPartyValidity(el);
    });
  });


  // Trial balance + settings
  $("btnTrialRefresh").addEventListener("click", renderTrial);
  $("btnTrialPdf").addEventListener("click", doTrialPdf);
  $("btnTrialExcel").addEventListener("click", doTrialExcel);
  $("stRefresh").addEventListener("click", renderSettlement);
  $("stMondayFinal").addEventListener("click", doSettlementMondayFinal);
  $("stNewBtn").addEventListener("click", () => openNewParty());
  $("stSearch").addEventListener("input", () => { clearTimeout(stDebounce); stDebounce = setTimeout(renderSettlement, 250); });
  $("stSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") openFromSearch(); });
  $("stSelectAll").addEventListener("change", (e) =>
    document.querySelectorAll(".st-check").forEach((c) => (c.checked = e.target.checked)));
  $("savePassBtn").addEventListener("click", doChangePassword);
  $("saveCapBtn").addEventListener("click", doSaveCapitalOpening);
  $("entriesResetBtn").addEventListener("click", doEntriesReset);
  $("resetKeepBtn").addEventListener("click", doResetKeep);
  $("fullResetBtn").addEventListener("click", doFullReset);
  $("addClientBtn").addEventListener("click", doAddClient);
  $("clientSearch").addEventListener("input", pickClientFromSearch);
  $("clientSearch").addEventListener("change", pickClientFromSearch);
  $("saveClientBtn").addEventListener("click", doSaveClient);
  $("deleteClientBtn").addEventListener("click", doDeleteClient);

  // Trading — Match Report (level 1)
  $("mrNewBtn").addEventListener("click", () => openMatchModal(null));
  $("mrSelectBtn").addEventListener("click", () => {
    if (!state.matchSelectedId) return toast("Tap a match first", true);
    openMatch(state.matchSelectedId);
  });
  $("mrModifyBtn").addEventListener("click", () => {
    if (!state.matchSelectedId) return toast("Tap a match first", true);
    openMatchModal(state.matchSelectedId);
  });
  $("mrDeleteBtn").addEventListener("click", () => {
    if (!state.matchSelectedId) return toast("Tap a match first", true);
    doDeleteMatch(state.matchSelectedId);
  });
  $("mrDeclareBtn").addEventListener("click", () => {
    if (!state.matchSelectedId) return toast("Tap a match first", true);
    openMatchDeclare(state.matchSelectedId);
  });
  $("mrUnDeclareBtn").addEventListener("click", () => {
    if (!state.matchSelectedId) return toast("Tap a match first", true);
    doUnDeclareMatch(state.matchSelectedId);
  });
  $("saveMatchDeclareBtn").addEventListener("click", () => guardClick("declareMatch", $("saveMatchDeclareBtn"), doDeclareMatch));
  $("mrExitBtn").addEventListener("click", () => showView("home"));
  $("mrConnectBtn").addEventListener("click", showConnect);
  // no Connect button — ticking and the date filters update everything live.
  // changing a date auto-turns-on the Date filter so it takes effect at once.
  const cnDateFilterRun = () => { if ($("cnDate")) $("cnDate").checked = true; runConnect(); };
  if ($("cnFrom")) $("cnFrom").addEventListener("change", cnDateFilterRun);
  if ($("cnTo")) $("cnTo").addEventListener("change", cnDateFilterRun);
  if ($("cnDate")) $("cnDate").addEventListener("change", runConnect);
  // ticking a session/match row re-tallies the Transactions live
  if ($("cnMatches")) $("cnMatches").addEventListener("change", (e) => { if (e.target.classList.contains("cn-ck")) computeConnectTx(); });
  if ($("cnSessions")) $("cnSessions").addEventListener("change", (e) => { if (e.target.classList.contains("cn-ck")) computeConnectTx(); });
  if ($("cnMatch")) $("cnMatch").addEventListener("change", computeConnectTx);
  if ($("cnSession")) $("cnSession").addEventListener("change", computeConnectTx);
  if ($("cnAllMatches")) $("cnAllMatches").addEventListener("change", (e) => {
    $("cnMatches").querySelectorAll("input[data-mid]").forEach((c) => { c.checked = e.target.checked; }); computeConnectTx();
  });
  if ($("cnAllSessions")) $("cnAllSessions").addEventListener("change", (e) => {
    $("cnSessions").querySelectorAll("input[data-sid]").forEach((c) => { c.checked = e.target.checked; }); computeConnectTx();
  });
  $("cnExitBtn").addEventListener("click", () => { $("connectView").style.display = "none"; $("matchReport").style.display = ""; });
  $("cnPrintBtn").addEventListener("click", printConnect);
  $("saveMatchBtn").addEventListener("click", doSaveMatch);
  ["mmTeam1", "mmTeam2"].forEach((id) => { const el = $(id); if (el) el.addEventListener("input", syncHorsesFromTeams); });
  if ($("mmType")) $("mmType").addEventListener("change", syncHorsesFromTeams);
  // Session Report (level 2) + Session form
  $("saveSessionBtn").addEventListener("click", doSaveSession);
  $("srNewBtn").addEventListener("click", () => openSessionModal(null));
  $("srSelectBtn").addEventListener("click", () => {
    if (!state.srSelectedId) return toast("Tap a session first", true);
    openSessionRuns(state.srSelectedId);
  });
  $("srModifyBtn").addEventListener("click", () => {
    if (!state.srSelectedId) return toast("Tap a session first", true);
    openSessionModal(state.srSelectedId);
  });
  $("srDeleteBtn").addEventListener("click", () => {
    if (!state.srSelectedId) return toast("Tap a session first", true);
    doDeleteSession(state.srSelectedId);
  });
  if ($("srBookBtn")) $("srBookBtn").addEventListener("click", openSessionBook);
  // Reports
  $("rpHawala").addEventListener("click", openHawala);
  $("rpFind").addEventListener("click", openFindSauda);
  $("rpTrial").addEventListener("click", () => showView("trial"));
  $("rpCup").addEventListener("click", () => openTypeReport("CUP", "Cup Report"));
  $("rpToss").addEventListener("click", () => openTypeReport("TOSS", "Toss Report"));
  $("rpSettle").addEventListener("click", () => openTypeReport("", "Settlement Report"));
  $("tyShow").addEventListener("click", renderTypeReport);
  $("tyPrint").addEventListener("click", () => window.print());
  $("tyExit").addEventListener("click", () => showView("home"));
  $("rpParty").addEventListener("click", openPartyReport);
  if ($("rpDayClient")) $("rpDayClient").addEventListener("click", openDayClientReport);
  if ($("rpMatchReport")) $("rpMatchReport").addEventListener("click", openMatchReport);
  if ($("dcrShow")) $("dcrShow").addEventListener("click", runDayClientReport);
  if ($("dcrShare")) $("dcrShare").addEventListener("click", shareDayClientWhatsApp);
  if ($("dcrImg")) $("dcrImg").addEventListener("click", () => copyElementAsImage("dcrSheet", "ClientReport"));
  if ($("dcrExit")) $("dcrExit").addEventListener("click", () => showView("reports"));
  if ($("mcrMatch")) $("mcrMatch").addEventListener("change", (e) => runMatchReport(e.target.value));
  if ($("mcrImg")) $("mcrImg").addEventListener("click", () => copyElementAsImage("mcrSheet", "MatchReport"));
  if ($("mcrShare")) $("mcrShare").addEventListener("click", shareMatchReportWhatsApp);
  if ($("mcrExit")) $("mcrExit").addEventListener("click", () => showView("reports"));
  $("prModify").addEventListener("click", prModifySelected);
  $("prDelete").addEventListener("click", prDeleteSelected);
  $("prNew").addEventListener("click", openNewParty);
  $("prPrint").addEventListener("click", () => window.print());
  $("prExit").addEventListener("click", showReportsHome);
  $("prSearch").addEventListener("input", () => { clearTimeout(state._prDeb); state._prDeb = setTimeout(renderPartyReport, 200); });
  $("prBody").addEventListener("dblclick", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) { state.prSelectedId = tr.getAttribute("data-id"); prModifySelected(); } });
  $("hwShow").addEventListener("click", renderHawala);
  $("hwExit").addEventListener("click", showReportsHome);
  $("hwPrint").addEventListener("click", () => window.print());
  $("fsExitBtn").addEventListener("click", showReportsHome);
  $("fsMatchBtn").addEventListener("click", fsSearchMatch);
  $("fsSessionBtn").addEventListener("click", fsSearchSession);
  $("srDeclareBtn").addEventListener("click", openDeclareModal);
  // All-sessions report toolbar
  if ($("asSelect")) $("asSelect").addEventListener("click", () => openSessionFromAll());
  if ($("asDeclare")) $("asDeclare").addEventListener("click", async () => { await openSessionFromAll(); if (state.runSession) openDeclareModal(); });
  if ($("asUnDeclare")) $("asUnDeclare").addEventListener("click", async () => { await openSessionFromAll(); if (state.srSelectedId) await doUnDeclare(); });
  if ($("asDelete")) $("asDelete").addEventListener("click", async () => {
    if (!state._asSelId) return toast("Tap a session first", true);
    const row = (state._allSessions || []).find((x) => x.s.id === state._asSelId);
    if (!row) return;
    if (!(await confirmAsk(`Delete session "${row.s.name}" and its saudas?`, "Delete"))) return;
    try { await api.deleteSession(state._asSelId); state._asSelId = null; toast("Session deleted"); await renderAllSessions(); } catch (e) { toast(e.message, true); }
  });
  if ($("asRefresh")) $("asRefresh").addEventListener("click", renderAllSessions);
  if ($("asExit")) $("asExit").addEventListener("click", () => showView("home"));
  $("srUnDeclareBtn").addEventListener("click", doUnDeclare);
  $("saveDeclareBtn").addEventListener("click", () => guardClick("declareSession", $("saveDeclareBtn"), doSaveDeclare));
  // MATCH (team betting)
  $("trSubmit").addEventListener("click", doSubmitTrade);
  $("trCancelEdit").addEventListener("click", cancelEdit);
  // Rate auto-decimal: show 0.56 after typing 56 (unless a "." was typed).
  const fixRate = (id) => $(id).addEventListener("blur", () => {
    const v = normalizeRate($(id).value);
    // Keep a decimal point so an even-money rate stays 1.00 and is NOT re-read as paisa
    // on submit: 100 / 1.0 -> "1.00"; 90 -> "0.9"; 110 -> "1.1"; bare 1 -> "0.01".
    if (!isNaN(v)) $(id).value = Number.isInteger(v) ? v.toFixed(2) : String(v);
  });
  fixRate("trRate");
  $("trModifyBtn").addEventListener("click", startModify);
  $("trRefreshBtn").addEventListener("click", async () => {
    if (!state.trSession) return;
    await loadTrades(); toast("Refreshed");
  });
  $("trDeleteBtn").addEventListener("click", doDeleteTrade);
  $("trPrintBtn").addEventListener("click", printTradingSession);
  $("trBookBtn").addEventListener("click", toggleBook);
  if ($("trWithdrawBtn")) $("trWithdrawBtn").addEventListener("click", openWithdrawModal);
  if ($("wdTabNow")) $("wdTabNow").addEventListener("click", () => wdSwitchTab("now"));
  if ($("wdTabAuto")) $("wdTabAuto").addEventListener("click", () => wdSwitchTab("auto"));
  if ($("wdDoNow")) $("wdDoNow").addEventListener("click", wdDoNow);
  if ($("wdSaveAuto")) $("wdSaveAuto").addEventListener("click", wdSaveAutoRule);
  if ($("wdClearAll")) $("wdClearAll").addEventListener("click", wdClearAll);
  if ($("trBooks")) $("trBooks").addEventListener("click", onTrBooksClick);
  $("bookClose").addEventListener("click", () => { state.bookOpen = false; $("trPaneBook").classList.remove("full"); $("trPaneBook").style.display = "none"; });
  $("bookMax").addEventListener("click", () => $("trPaneBook").classList.toggle("full"));
  $("syBackBtn").addEventListener("click", backToSessions);
  document.querySelectorAll(".pane-max").forEach((btn) =>
    btn.addEventListener("click", () => maximisePane(btn.getAttribute("data-pane"))));
  $("trExitBtn").addEventListener("click", closeMatch);
  // SESSION (runs) screen
  $("sySubmit").addEventListener("click", doSubmitSession);
  $("syCancelEdit").addEventListener("click", cancelSessionEdit);
  $("syModifyBtn").addEventListener("click", startSessionModify);
  $("syDeleteBtn").addEventListener("click", doDeleteSessionBet);
  $("syRefreshBtn").addEventListener("click", async () => { if (state.runSession) { await loadSessionBets(); toast("Refreshed"); } });
  if ($("syFullBtn")) $("syFullBtn").addEventListener("click", () => maximisePane("right"));
  if ($("syExitBtn")) $("syExitBtn").addEventListener("click", backToSessions);
  if ($("syPrintBtn")) $("syPrintBtn").addEventListener("click", () => { try { window.print(); } catch (e) {} });
  $("syLayFrom").addEventListener("input", () => {
    renderSession();
    const c = $("syLadder").parentElement; if (c) c.scrollTop = 0;   // show lay-From run at the top
  });
  ["syAmount", "syRate", "syRun", "syMode"].forEach((id) =>
    $(id).addEventListener("input", updateSessionPreview));
  // Badla (BD) mode: show the extra client-run box, hide Rate (no commission).
  if ($("syMode")) $("syMode").addEventListener("change", syncSyMode);
  // Book average follows the match team dropdown.
  if ($("trTeam")) $("trTeam").addEventListener("change", updateBookAverage);
  const sySeq = ["syRate", "syAmount", "syRun", "syMode", "syParty"];   // Rate first, then Amount
  sySeq.forEach((id, i) => {
    $(id).addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (i < sySeq.length - 1) $(sySeq[i + 1]).focus();
      else doSubmitSession();
    });
  });
  // Live preview of this trade's effect as you type.
  ["trQty", "trRate", "trMode"].forEach((id) =>
    $(id).addEventListener("input", updateTradePreview));
  // Enter moves through the trade fields; Enter on the last submits.
  const trSeq = ["trRate", "trQty", "trMode", "trTeam", "trParty"];
  trSeq.forEach((id, i) => {
    $(id).addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (i < trSeq.length - 1) $(trSeq[i + 1]).focus();
      else doSubmitTrade();
    });
  });
  $("autoBackupChk").addEventListener("change", (e) => api.setAutoBackup(e.target.checked)
    .then(() => toast(e.target.checked ? "Auto-backup on" : "Auto-backup off"))
    .catch((err) => toast(err.message, true)));
  $("backupNowBtn").addEventListener("click", doBackupNow);
  $("exportBtn").addEventListener("click", doExport);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", doImport);

  // Close-modal buttons (delegated)
  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => closeModal(b.getAttribute("data-close"))));

  // ESC = go back one level (close any open modal first)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const openModalEl = document.querySelector(".modal.show");
    if (openModalEl) { closeModal(openModalEl.id); return; }
    if ($("trPaneBook") && $("trPaneBook").style.display !== "none") {   // Match Book overlay open
      state.bookOpen = false; $("trPaneBook").classList.remove("full"); $("trPaneBook").style.display = "none"; return;
    }
    if ($("reportsView").style.display !== "none") {         // inside a Reports sub-screen → back to cards, else dashboard
      if ($("reportsHome").style.display === "none") { showReportsHome(); return; }
      showView("home"); return;
    }
    if ($("tradingView").style.display === "none") {          // any non-trading screen → straight to dashboard
      if (currentView() !== "home") showView("home");
      return;
    }
    if ($("connectView").style.display !== "none") { $("connectView").style.display = "none"; $("matchReport").style.display = ""; return; }
    if (state.runSession) { backToSessions(); return; }       // SESSION → Session Report
    if (state.trSession) { closeMatch(); return; }            // match open → Match Report
    showView("home");                                          // Match Report → Home
  });

  // Row selection for Modify/Delete (from the Received / Paid tables)
  ["recvBody", "paidBody"].forEach((id) =>
    $(id).addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      state.selectedEntryId = tr.getAttribute("data-id");
      highlightSelected();
    }));

  // Confirmation dialog buttons
  $("confirmOk").addEventListener("click", () => resolveConfirm(true));
  $("confirmCancel").addEventListener("click", () => resolveConfirm(false));

  // Auto log out after 4 hours of inactivity (signOut() saves a backup first).
  setupIdleLogout();
}

// ---------------- auto log out when idle ----------------
const IDLE_LOGOUT_MS = 4 * 60 * 60 * 1000;   // 4 hours
let _idleTimer = null;
function setupIdleLogout() {
  const reset = () => {
    clearTimeout(_idleTimer);
    const cv = currentView();
    if (!cv || cv === "login") return;   // not logged in → don't arm
    _idleTimer = setTimeout(async () => {
      try { await signOut(); } catch (e) { /* ignore */ }
      try { toast("Signed out after 4 hours of inactivity."); } catch (e) {}
    }, IDLE_LOGOUT_MS);
  };
  ["click", "keydown", "mousemove", "scroll", "touchstart"].forEach(
    (ev) => document.addEventListener(ev, reset, { passive: true }));
  reset();
}

// ---------------- in-app confirm (works in sandboxed previews too) ----------------
let _confirmResolve = null;
function confirmAsk(message, okLabel = "Confirm", danger = true) {
  $("confirmMsg").textContent = message;
  const ok = $("confirmOk");
  ok.textContent = okLabel;
  ok.className = "btn " + (danger ? "danger" : "primary");
  openModal("confirmModal");
  return new Promise((res) => { _confirmResolve = res; });
}
function resolveConfirm(v) {
  closeModal("confirmModal");
  if (_confirmResolve) { _confirmResolve(v); _confirmResolve = null; }
}

// ---------------- views / navigation ----------------
const VIEWS = ["home", "settling", "settlement", "trial", "dayReport", "dayClient", "matchClient", "trading", "reports", "settings", "usersettings"];
let _navStack = [];      // history of visited views for the Back button
let _suppressNav = false; // true while navigating Back (don't re-record)

function currentView() {
  return VIEWS.find((v) => { const el = $(v + "View"); return el && el.style.display !== "none"; });
}
function updateBackBtn() {
  const cur = currentView();
  const show = cur === "settling" || _navStack.length > 0;
  if ($("backBtn")) $("backBtn").style.display = show ? "" : "none";
}
function goBack() {
  const cur = currentView();
  if (cur === "settling") { backToSettlement(); return; }  // sub-screen -> its list
  if (_navStack.length) {
    _suppressNav = true;
    showView(_navStack.pop());
    _suppressNav = false;
  } else {
    showView("home");
  }
  updateBackBtn();
}

function showView(name) {
  const cur = currentView();
  if (!_suppressNav && cur && cur !== name) _navStack.push(cur);
  VIEWS.forEach((v) => {
    const el = $(v + "View");
    if (el) el.style.display = v === name ? "" : "none";
  });
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.getAttribute("data-view") === name));
  // Logout + disclaimer live only on the dashboard (home) — hidden elsewhere
  if ($("logoutBtn")) $("logoutBtn").style.display = (name === "home") ? "" : "none";
  const _disc = document.querySelector(".disclaimer-bar");
  if (_disc) _disc.style.display = (name === "home") ? "" : "none";
  const _top = document.querySelector(".topbar");
  if (_top) _top.style.display = (name === "home") ? "" : "none";
  document.body.classList.toggle("no-disclaimer", name !== "home");
  if (name === "settling") deselect();   // start fresh — no ledger open
  if (name === "settlement") { $("stSearch").value = ""; renderSettlement(); }
  if (name === "trial") renderTrial();
  if (name === "dayReport") renderDayReport();
  if (name === "trading") enterTrading();
  if (name === "reports") showReportsHome();
  if (name === "settings") loadSettings();
  if (name === "usersettings") loadUserSettings();
  if (name === "home") renderHomeGt();
  updateBackBtn();
}

// Open a party's ledger from another screen (bypasses Settling's auto-reset).
async function openPartyInSettling(id) {
  VIEWS.forEach((v) => { const el = $(v + "View"); if (el) el.style.display = v === "settling" ? "" : "none"; });
  // Settling is now a sub-screen of Settlement — keep that tab highlighted.
  document.querySelectorAll(".tab-btn").forEach((b) =>
    b.classList.toggle("active", b.getAttribute("data-view") === "settlement"));
  await selectParty(id);
  updateBackBtn();
}

function backToSettlement() {
  deselect();
  showView("settlement");
}

// ---------------- settlement (Monday Final status list) ----------------
let stDebounce;
async function renderSettlement() {
  let parties;
  try { parties = await api.listParties($("stSearch").value.trim()); }
  catch (err) { return toast(err.message, true); }
  parties.sort(byStarThenName);   // "*" names pinned to the top

  // "Tallied" (Yes) = no pending current entries; "Pending" (No) = has entries to finalise.
  const pending = parties.filter((p) => p.entry_count > 0).length;
  $("stSummary").textContent = `${parties.length} parties · ${pending} pending · ${parties.length - pending} tallied`;

  $("settlementBody").innerHTML = parties.length
    ? parties.map((p) => {
        const tallied = p.entry_count === 0;
        const m = balanceMeta(p.balance);
        return `<tr>
          <td class="pname clickable" data-open="${p.id}">${esc(p.name)}</td>
          <td class="num ${m.cls}">${inr(Math.abs(p.balance))}<span class="tag"> ${m.label}</span></td>
          <td><span class="mf-badge ${tallied ? "yes" : "no"}">${tallied ? "Yes" : "No"}</span></td>
          <td class="sel-col"><input type="checkbox" class="st-check" value="${p.id}"></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" class="muted" style="text-align:center;padding:18px">No parties.</td></tr>`;

  $("stSelectAll").checked = false;
  $("settlementBody").querySelectorAll("[data-open]").forEach((el) =>
    el.addEventListener("click", () => openPartyInSettling(el.getAttribute("data-open"))));
}

// Enter in the search box opens the matching customer's ledger.
async function openFromSearch() {
  const q = $("stSearch").value.trim();
  if (!q) return;
  let list;
  try { list = await api.listParties(q); } catch (err) { return toast(err.message, true); }
  const target = list.find((p) => p.name.toLowerCase() === q.toLowerCase()) || list[0];
  if (!target) {
    toast(`No customer named "${q}" — use + New to add.`, true);
    $("stSearch").value = "";
    renderSettlement();   // clear the box and show the full list again
    return;
  }
  openPartyInSettling(target.id);
}

async function doSettlementMondayFinal() {
  const ids = Array.from(document.querySelectorAll(".st-check:checked")).map((c) => c.value);
  if (!ids.length) return toast("Tick the customers to finalise first", true);
  if (!(await confirmAsk(`Run Monday Final on ${ids.length} selected customer(s)? This carries each balance forward and files the entries into Old Record.`, "Monday Final"))) return;
  try {
    for (const id of ids) await api.mondayFinal(id);
    toast(`Monday Final done for ${ids.length}`);
    await refreshParties();
    renderSettlement();
  } catch (err) { toast(err.message, true); }
}

// ---------------- trial balance ----------------
async function renderTrial() {
  let parties;
  try { parties = await api.listParties(); }
  catch (err) { return toast(err.message, true); }

  // "Check Me > 9" hides small balances (|balance| <= 9), like the Final Trial Balance.
  const minAbs = 0.005;
  // balance > 0  -> we received net from them -> we owe them -> TO PAY
  // balance < 0  -> we paid net to them       -> they owe us -> TO RECEIVE
  const pay = parties.filter((p) => p.balance > minAbs)
    .sort((a, b) => starRank(a) - starRank(b) || a.name.localeCompare(b.name));
  const receive = parties.filter((p) => p.balance < -minAbs)
    .sort((a, b) => starRank(a) - starRank(b) || a.name.localeCompare(b.name));

  const payTotal = pay.reduce((s, p) => s + p.balance, 0);          // positive
  const recTotal = receive.reduce((s, p) => s + p.balance, 0);      // negative (signed)

  // Signed amounts, like the old app: Cr side positive, Dr side negative (minus).
  const rowsFor = (list) => list.length
    ? list.map((p) => `<tr><td class="pname">${esc(p.name)}</td>
        <td class="num">${inr(p.balance)}</td></tr>`).join("")
    : `<tr><td colspan="2" class="muted" style="text-align:center;padding:16px">None</td></tr>`;
  const totalRow = (amt) => `<tr class="total-row"><td><b>Total</b></td><td class="num"><b>${inr(amt)}</b></td></tr>`;

  $("payBody").innerHTML = rowsFor(pay) + totalRow(payTotal);
  $("receiveBody").innerHTML = rowsFor(receive) + totalRow(recTotal);
  $("payTotal").textContent = inr(payTotal);
  $("receiveTotal").textContent = inr(recTotal);
  const net = payTotal + recTotal;   // sum of all balances
  $("trialNet").textContent =
    `Net position: ${inr(net)} · Cr ${pay.length}, Dr ${receive.length}.`;
}

// ---- Day Report (Day Book) — every party's net Dena / Lena for the day ----
let _dayReportData = null;   // kept for the PDF button
async function renderDayReport() {
  // Day Book = TODAY'S lena-dena only (not the all-time outstanding balances —
  // that is the Trial report). Sum only the entries dated today, per party.
  const day = todayISO();
  let dayRows;
  try { dayRows = await api.listDayEntries(day); }
  catch (err) { return toast(err.message, true); }

  // received (+) increases what we owe them (Dena); paid (−) is what they owe us (Lena)
  const net = {};
  dayRows.forEach((e) => {
    const s = e.type === "received" ? Number(e.amount) : -Number(e.amount);
    net[e.party_name] = (net[e.party_name] || 0) + s;
  });
  const pay = [], recv = [];
  Object.keys(net).forEach((name) => {
    const bal = Math.round(net[name] * 100) / 100;
    if (bal > 0) pay.push({ name, balance: bal });
    else if (bal < 0) recv.push({ name, balance: bal });
  });
  pay.sort((a, b) => a.name.localeCompare(b.name));
  recv.sort((a, b) => a.name.localeCompare(b.name));
  const totPay = pay.reduce((s, p) => s + p.balance, 0);
  const totRecv = recv.reduce((s, p) => s + Math.abs(p.balance), 0);
  _dayReportData = { pay, recv, totPay, totRecv };

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = ddmmyyyy(todayISO());
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  $("drBrand").textContent = window.__BRAND || BUSINESS_NAME;
  $("drFor").textContent = `Day Book For ${dateStr}`;
  $("drMeta").innerHTML =
    `Date : ${dateStr}<br>Time : ${timeStr}<br>Page No. :&nbsp;&nbsp;&nbsp;1`;

  const rows = (list, abs) => list.length
    ? list.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${inr(abs ? Math.abs(p.balance) : p.balance)}</td></tr>`).join("")
    : `<tr><td colspan="2" class="dr-empty">—</td></tr>`;

  $("drDenaBody").innerHTML = rows(pay, false);
  $("drLenaBody").innerHTML = rows(recv, true);
  $("drDenaTot").textContent = inr(totPay);
  $("drLenaTot").textContent = inr(totRecv);
}

async function doDayReportPdf() {
  try {
    if (!_dayReportData) await renderDayReport();
    const ok = downloadDayBookPDF(_dayReportData, window.__BRAND || BUSINESS_NAME);
    toast(ok ? "PDF downloaded" : "PDF could not be created", !ok);
  } catch (err) { toast(err.message, true); }
}

// Build a plain-text version of the Day Book for WhatsApp (links share text, not files).
function buildDayReportText() {
  const d = _dayReportData || {};
  const pay = d.pay || [], recv = d.recv || [];
  const brand = window.__BRAND || BUSINESS_NAME;
  const L = [];
  L.push(`*${brand}*`);
  L.push(`Day Book — ${ddmmyyyy(todayISO())}`);
  L.push("");
  L.push("*DENA (you give):*");
  pay.length ? pay.forEach((p) => L.push(`${p.name} : ${inr(p.balance)}`)) : L.push("—");
  L.push(`*Total Dena : ${inr(d.totPay || 0)}*`);
  L.push("");
  L.push("*LENA (you get):*");
  recv.length ? recv.forEach((p) => L.push(`${p.name} : ${inr(Math.abs(p.balance))}`)) : L.push("—");
  L.push(`*Total Lena : ${inr(d.totRecv || 0)}*`);
  return L.join("\n");
}

// Copy the report to the clipboard and open WhatsApp Web (the user's logged-in session),
// so they just pick a chat and paste. This is reliable regardless of which browser opens,
// unlike a wa.me text link which forces a fresh WhatsApp page.
// Reliable copy on a user click (works in the desktop app too). execCommand is
// synchronous and tells us if it truly succeeded; the async clipboard API is a fallback.
function copyToClipboard(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.left = "0"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) {}
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) return true;
  } catch (e) {}
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; } } catch (e) {}
  return false;
}

function shareTextToWhatsApp(text) {
  const copied = copyToClipboard(text);
  toast(copied
    ? "Report COPIED ✓ — in WhatsApp open the chat, press Ctrl+V to paste, then Send"
    : "Couldn't copy — use the Image button to share instead", !copied);
  window.open("https://web.whatsapp.com/", "_blank");
}

// Copy an image to the clipboard by selecting it in a hidden editable box and running the
// classic copy command — works in Electron without any app rebuild (deploys via the site).
function copyImageViaExec(dataURL) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const div = document.createElement("div");
          div.contentEditable = "true";
          div.style.position = "fixed"; div.style.left = "-9999px"; div.style.top = "0"; div.style.opacity = "0";
          div.appendChild(img);
          document.body.appendChild(div);
          const range = document.createRange();
          range.selectNode(div);
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(range);
          const ok = document.execCommand("copy");
          sel.removeAllRanges(); div.remove();
          resolve(!!ok);
        } catch (e) { resolve(false); }
      };
      img.onerror = () => resolve(false);
      img.src = dataURL;
    } catch (e) { resolve(false); }
  });
}

// Render a report sheet to an image and COPY it to the clipboard, so the user just opens
// WhatsApp, picks a chat and pastes (Ctrl+V). Falls back to downloading the PNG if the
// browser won't allow copying an image.
async function copyElementAsImage(elId, baseName) {
  const el = $(elId);
  if (!el) return;
  if (!window.html2canvas) return toast("Image tool not loaded — try again", true);
  toast("Making image…");
  let canvas;
  try { canvas = await window.html2canvas(el, { backgroundColor: "#ffffff", scale: 2, useCORS: true, logging: false }); }
  catch (e) { return toast("Could not make the image", true); }
  const okMsg = "Image COPIED ✓ — in WhatsApp open the chat, press Ctrl+V, then Send";
  // DESKTOP app: copy through Electron's native clipboard (reliable in the installed app).
  try {
    if (window.electronAPI && window.electronAPI.copyImage) {
      const ok = await window.electronAPI.copyImage(canvas.toDataURL("image/png"));
      if (ok) { toast(okMsg); return; }
    }
  } catch (e) { /* fall through */ }
  // WEBSITE / browser: the Clipboard API image write.
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      const blob = await new Promise((res) => { try { canvas.toBlob(res, "image/png"); } catch (e) { res(null); } });
      if (blob) { await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]); toast(okMsg); return; }
    }
  } catch (e) { /* clipboard image not allowed — try the exec path */ }
  // Older-browser / Electron path that needs no app rebuild: select the image and copy it.
  try { if (await copyImageViaExec(canvas.toDataURL("image/png"))) { toast(okMsg); return; } } catch (e) {}
  // Fallback: download the PNG so the user can attach it.
  try {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${baseName}_${todayISO()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    toast("Couldn't copy the image here — saved it instead; attach it in WhatsApp", true);
  } catch (e) { toast("Could not make the image", true); }
}

// Day Book → WhatsApp.
async function shareDayReportWhatsApp() {
  try {
    if (!_dayReportData) await renderDayReport();
    shareTextToWhatsApp(buildDayReportText());
  } catch (err) { toast(err.message, true); }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function doTrialPdf() {
  try {
    const parties = await api.listParties();
    if (!downloadTrialPDF(parties)) toast("PDF could not be created", true);
    else toast("PDF downloaded");
  } catch (err) { toast(err.message, true); }
}

async function doTrialExcel() {
  try {
    const parties = await api.listParties();
    const { pay, recv, totPay, totRecv } = trialSplit(parties);
    const r2 = (x) => Math.round(x * 100) / 100;
    const rows = [
      [window.__BRAND || BUSINESS_NAME],
      [`Trial Balance as on ${ddmmyyyy(todayISO())}`],
      [],
      ["Party", "Dena (we owe)", "Lena (owed to us)"],
      ...pay.map((p) => [p.name, r2(p.balance), ""]),
      ...recv.map((p) => [p.name, "", r2(Math.abs(p.balance))]),
      ["Total", r2(totPay), r2(totRecv)],
    ];
    downloadBlob(sheetToXlsxBlob("Trial Balance", rows), `Trial_Balance_${todayISO()}.xlsx`);
    toast("Excel downloaded");
  } catch (err) { toast(err.message, true); }
}

// ---------------- old-app menu actions ----------------
async function menuAction(act) {
  switch (act) {
    case "settings": showView("settings"); break;
    case "usersettings": showView("usersettings"); break;
    case "backup": try { await api.createBackup("", "manual"); toast("Backup saved"); } catch (e) { toast(e.message, true); } break;
    case "logout": openLogoutPage(false); break;
    case "clearData": if (await confirmAsk("Clear all entries & saudas but keep every party and their closing balance?", "Clear")) { try { await api.resetKeepParties(); toast("Data cleared — balances kept"); refreshParties && refreshParties(); } catch (e) { toast(e.message, true); } } break;
    case "clearAll": if (await confirmAsk("Clear all match & session saudas? (client ledger and balances are kept)", "Clear Saudas")) { try { await api.entriesReset(); toast("Match & session saudas cleared"); refreshParties && refreshParties(); } catch (e) { toast(e.message, true); } } break;
    case "clearProg": if (await confirmAsk("Clear programe — erase EVERYTHING (parties, ledger, matches & saudas)?", "Erase All")) { try { await api.fullReset(); toast("Programe cleared"); refreshParties && refreshParties(); } catch (e) { toast(e.message, true); } } break;
    case "newParty": openNewParty(); break;
    case "manageAgents": openAgentsModal(); break;
    case "managePartners": openPartnersModal(); break;
    case "partyReport": showView("reports"); await openPartyReport(); break;
    case "newMatch": showView("trading"); openMatchModal(null); break;
    case "matchReport": showView("trading"); break;
    case "sessionReport": showView("reports"); await openAllSessionsReport(); break;
    case "cupReport": showView("reports"); await openTypeReport("CUP", "Cup Report"); break;
    case "tossReport": showView("reports"); await openTypeReport("TOSS", "Toss Reports"); break;
    case "settlementReport": showView("settlement"); break;   // same as the dashboard Settlement card
    case "connect": showView("trading"); showConnect(); break;
    case "dayReport": showView("dayReport"); break;
    case "dayClient": await openDayClientReport(); break;
    case "matchClient": await openMatchReport(); break;
    case "trial": showView("trial"); break;
    case "hawala": showView("reports"); await openHawala(); break;
    case "findSauda": showView("reports"); await openFindSauda(); break;
    case "status": showView("settlement"); break;
    case "importData": toast("Import Data isn't available in this build yet"); break;
    case "support": toast("Support File — contact your software provider"); break;
    case "getApp": window.open("download.html", "_blank"); break;
  }
}

// ---------------- User Settings (Configure → User Settings) ----------------
function setRadio(name, val) { const el = document.querySelector(`input[name="${name}"][value="${val}"]`); if (el) el.checked = true; }
function getRadio(name) { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : ""; }
async function loadUserSettings() {
  try { const cap = await api.getCapitalParty(); if (cap && $("usCapHolder")) $("usCapHolder").value = cap.name || ""; } catch (e) {}
  if ($("usPassword")) $("usPassword").value = "";
  try {
    const s = (await api.getSettings()) || {};
    setRadio("usDecimal", String(s.decimals === 3 ? 3 : 2));
    setRadio("usBlockGadda", s.block_gadda === false ? "no" : "yes");
    setRadio("usRegular", s.regular_format ? "yes" : "no");
    setRadio("usTwoMindi", s.two_mindi_hide ? "yes" : "no");
    const vl = s.voice_lang || state.voiceLang || "en-IN";
    if ($("usVoiceLang")) $("usVoiceLang").value = vl;
    state.voiceLang = vl;
  } catch (e) {}
  // Amount unit (saved on this device).
  const unit = readAmountUnit();
  if ($("usAmountUnit")) $("usAmountUnit").value = String(unit);
  // Client credit limit (0 = off), saved on this device.
  if ($("usCreditLimit")) $("usCreditLimit").value = String(creditLimit());
  // Keyboard shortcuts (per device). Show current combos + wire the capture fields.
  if ($("usScMatch")) { $("usScMatch").value = shortcutLabel(readShortcut("match")); wireShortcutCapture("usScMatch", "match"); }
  if ($("usScSession")) { $("usScSession").value = shortcutLabel(readShortcut("session")); wireShortcutCapture("usScSession", "session"); }
  const defBtn = (btnId, which, inputId) => {
    const b = $(btnId); if (!b || b._scWired) return; b._scWired = true;
    b.addEventListener("click", () => {
      const other = which === "match" ? "session" : "match";
      if (sameCombo(SC_DEFAULT[which], (state.shortcuts || {})[other])) {
        return toast("Default (" + shortcutLabel(SC_DEFAULT[which]) + ") is in use for the " + other + " shortcut — change that first", true);
      }
      writeShortcut(which, SC_DEFAULT[which]);
      state.shortcuts = state.shortcuts || {}; state.shortcuts[which] = Object.assign({}, SC_DEFAULT[which]);
      if ($(inputId)) $(inputId).value = shortcutLabel(SC_DEFAULT[which]);
      toast((which === "match" ? "Match" : "Session") + " shortcut reset to " + shortcutLabel(SC_DEFAULT[which]));
    });
  };
  defBtn("usScMatchDef", "match", "usScMatch");
  defBtn("usScSessionDef", "session", "usScSession");
}
async function saveUserSettings() {
  try {
    const cap = ($("usCapHolder").value || "").trim();
    if (cap) await api.setCapitalName(cap);
    const pw = $("usPassword").value;
    if (pw) await changePassword(pw);
    const dp = parseInt(getRadio("usDecimal"), 10) || 2;
    setDecimals(dp);                         // apply .00 / .000 to all money displays
    state.decimals = dp;
    const vl = ($("usVoiceLang") && $("usVoiceLang").value) || "en-IN";
    state.voiceLang = vl;
    // Amount unit (box amount = real rupees ÷ this)
    if ($("usAmountUnit")) writeAmountUnit($("usAmountUnit").value);
    // Client credit limit (0 = off)
    if ($("usCreditLimit")) setCreditLimit($("usCreditLimit").value);
    const prefs = { decimals: dp, block_gadda: getRadio("usBlockGadda") === "yes", regular_format: getRadio("usRegular") === "yes", two_mindi_hide: getRadio("usTwoMindi") === "yes", voice_lang: vl };
    if (api.saveSettings) { try { await api.saveSettings(prefs); } catch (e) {} }
    toast("User settings saved");
    showView("home");
  } catch (err) { toast(err.message, true); }
}

// ---------------- settings ----------------

async function loadSettings() {
  $("setPass1").value = ""; $("setPass2").value = "";
  try {
    const cap = await api.getCapitalParty();
    if (cap) {
      $("setCapOpening").value = cap.opening_balance;
      $("setCapName").value = cap.name;
      state.capitalName = cap.name;
    }
    const s = await api.getSettings();
    $("autoBackupChk").checked = !!s.auto_backup;
  } catch (err) { /* ignore */ }
  loadBackups();
  loadClients();
}

// ---- Client management (Settings): search box + edit form ----
let _clients = [];
let _editClientId = null;
async function loadClients() {
  try { _clients = await api.listParties(); }
  catch (err) { return; }
  _clients.sort(byStarThenName);
  const dl = $("clientDatalist");
  if (!dl) return;
  dl.innerHTML = _clients.map((p) => `<option value="${esc(p.name)}">`).join("");
}

// Match whatever is typed in the search box to a client and show its edit form.
function pickClientFromSearch() {
  const q = ($("clientSearch").value || "").trim().toLowerCase();
  const p = _clients.find((x) => x.name.toLowerCase() === q);
  if (p) {
    _editClientId = p.id;
    $("editClientName").value = p.name;
    $("editClientOpening").value = p.opening_balance;
    $("clientEdit").style.display = "";
  } else {
    _editClientId = null;
    $("clientEdit").style.display = "none";
  }
}

async function doSaveClient() {
  if (!_editClientId) return;
  const name = $("editClientName").value.trim();
  if (!name) return toast("Name cannot be empty", true);
  try {
    await api.updateParty(_editClientId, { name, opening_balance: parseFloat($("editClientOpening").value) || 0 });
    toast("Client updated");
    $("clientSearch").value = name;
    await refreshParties();
    await loadClients();
  } catch (err) {
    toast(err.message && err.message.includes("duplicate") ? "Another client already has that name" : err.message, true);
  }
}

async function doDeleteClient() {
  if (!_editClientId) return;
  if (!(await confirmAsk("Delete this client and all of its entries? This cannot be undone.", "Delete client"))) return;
  try {
    await api.deleteParty(_editClientId);
    toast("Client deleted");
    _editClientId = null;
    $("clientSearch").value = "";
    $("clientEdit").style.display = "none";
    await refreshParties();
    await loadClients();
  } catch (err) { toast(err.message, true); }
}

async function doAddClient() {
  const name = $("newClientName").value.trim();
  if (!name) return toast("Enter a client name", true);
  try {
    await api.createParty({ name, opening_balance: parseFloat($("newClientOpening").value) || 0 });
    $("newClientName").value = ""; $("newClientOpening").value = "";
    toast(`Client "${name}" added`);
    await refreshParties();
    await loadClients();
  } catch (err) {
    toast(err.message && err.message.includes("duplicate") ? "That client already exists" : err.message, true);
  }
}

async function doResetKeep() {
  if (!(await confirmAsk(
    "Reset all entries and balances to zero, keeping only the client names? This cannot be undone.",
    "Reset (keep clients)"))) return;
  try {
    await api.resetKeepParties();
    toast("Reset done — clients kept, everything else cleared");
    deselect();
    await refreshParties();
    loadSettings();
  } catch (err) { toast(err.message, true); }
}

async function loadBackups() {
  let list;
  try { list = await api.listBackups(); }
  catch (err) { return; }
  const el = $("backupList");
  if (!list.length) { el.innerHTML = `<p class="hint" style="padding:10px 0">No backups yet.</p>`; return; }
  el.innerHTML = list.map((b) => `
    <div class="bk-item">
      <span><span class="bk-when">${fmtWhen(b.created_at)}</span>
        <span class="bk-kind"> ${esc(b.kind)}${b.note ? " · " + esc(b.note) : ""}</span></span>
      <button class="btn ghost sm" data-restore="${b.id}">Restore</button>
    </div>`).join("");
  el.querySelectorAll("[data-restore]").forEach((btn) =>
    btn.addEventListener("click", () => doRestoreBackup(btn.getAttribute("data-restore"))));
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

async function doBackupNow() {
  try { await api.createBackup("", "manual"); toast("Backup saved"); loadBackups(); }
  catch (err) { toast(err.message, true); }
}

async function doRestoreBackup(id) {
  if (!(await confirmAsk("Restore this backup? It replaces ALL current data with the backup.", "Restore"))) return;
  try {
    await api.restoreBackup(id);
    toast("Backup restored");
    deselect(); await refreshParties(); loadSettings();
  } catch (err) { toast(err.message, true); }
}

async function doExport() {
  try {
    const data = await api.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `accounts-backup-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("Exported to file");
  } catch (err) { toast(err.message, true); }
}

// ---------------- Logout / safe close (with backup to PC + cloud) ----------------
let _logoutThenQuit = false;
let _logoutBusy = false;

function openLogoutPage(thenQuit) {
  _logoutThenQuit = !!thenQuit;
  const st = $("logoutStatus");
  if (st) { st.textContent = ""; st.className = "logout-status"; }
  const cfm = $("logoutConfirm"), cnl = $("logoutCancel");
  if (cfm) { cfm.disabled = false; cfm.textContent = "Backup & Logout"; }
  if (cnl) cnl.disabled = false;
  const msg = $("logoutMsg");
  if (msg) msg.textContent = thenQuit
    ? "Before closing, a backup will be saved to this computer and to the cloud, then the app will close."
    : "A backup will be saved to this computer and to the cloud, then you'll be signed out.";
  $("logoutView").style.display = "flex";
}

function closeLogoutPage() {
  if (_logoutBusy) return;
  $("logoutView").style.display = "none";
}

function _logStatus(text, kind) {
  const st = $("logoutStatus");
  if (st) { st.textContent = text; st.className = "logout-status" + (kind ? " " + kind : ""); }
}

async function performLogout() {
  if (_logoutBusy) return;
  _logoutBusy = true;
  const cfm = $("logoutConfirm"), cnl = $("logoutCancel");
  if (cfm) cfm.disabled = true;
  if (cnl) cnl.disabled = true;

  // 1) Cloud backup (Supabase)
  _logStatus("Saving backup to the cloud…");
  try { await api.createBackup("Logout backup", "auto"); }
  catch (e) { /* best effort — keep going so logout always completes */ }

  // 2) Local backup file (beside the app on desktop, or a download in the browser)
  _logStatus("Saving backup to this computer…");
  let localNote = "";
  try {
    const data = await api.exportData();
    const json = JSON.stringify(data, null, 2);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${todayISO()}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const fname = `accounts-backup-${stamp}.json`;
    if (window.electronAPI && window.electronAPI.saveBackup) {
      const res = await window.electronAPI.saveBackup(fname, json);   // writes to /backups next to the exe
      localNote = (res && res.path) ? `Saved to ${res.path}` : "Saved on this computer";
    } else {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      localNote = "Backup file downloaded";
    }
  } catch (e) { localNote = "Local backup skipped (" + (e.message || "error") + ")"; }

  // 3) Sign out, then quit if this came from the window's X
  _logStatus("Signing out…");
  try { await signOut(); } catch (e) { /* ignore */ }

  if (_logoutThenQuit && window.electronAPI && window.electronAPI.quit) {
    _logStatus("Backup done. Closing… " + localNote, "ok");
    setTimeout(() => window.electronAPI.quit(), 400);
    return;   // app is closing
  }

  _logStatus("Done. " + localNote, "ok");
  _logoutBusy = false;
  $("logoutView").style.display = "none";   // onAuthChange shows the login screen
}

async function doImport(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { return toast("That file is not a valid backup", true); }
  if (!data || !Array.isArray(data.parties)) return toast("That file is not a valid backup", true);
  if (!(await confirmAsk("Import this file? It replaces ALL current data with the file's data.", "Import"))) return;
  try {
    await api.createBackup("Before import", "auto"); // safety snapshot
    await api.restoreData(data);
    toast("Imported successfully");
    deselect(); await refreshParties(); loadSettings();
  } catch (err) { toast(err.message, true); }
}

async function maybeAutoBackup() {
  try {
    const s = await api.getSettings();
    if (!s.auto_backup) return;
    const list = await api.listBackups();
    const last = list && list[0];
    const stale = !last || (Date.now() - new Date(last.created_at).getTime()) > 20 * 3600 * 1000;
    if (stale) await api.createBackup("Automatic daily backup", "auto");
  } catch (err) { /* ignore */ }
}

async function doChangePassword() {
  const p1 = $("setPass1").value, p2 = $("setPass2").value;
  if (p1.length < 6) return toast("Password must be at least 6 characters", true);
  if (p1 !== p2) return toast("Passwords do not match", true);
  try {
    await changePassword(p1);
    $("setPass1").value = ""; $("setPass2").value = "";
    toast("Password updated");
  } catch (err) { toast(err.message, true); }
}

async function doSaveCapitalOpening() {
  try {
    await api.setOpeningCapital(parseFloat($("setCapOpening").value) || 0);
    await api.setCapitalName($("setCapName").value);
    state.capitalName = ($("setCapName").value || "").trim() || "Capital Account";
    toast("Capital settings saved");
    refreshParties();
  } catch (err) { toast(err.message, true); }
}

async function doEntriesReset() {
  const ok = await confirmAsk(
    "Entries Reset: delete ALL entries and keep every party with their current closing balance as the new opening balance? This cannot be undone.",
    "Reset entries");
  if (!ok) return;
  try {
    await api.entriesReset();
    toast("Entries reset — balances carried forward");
    deselect();
    await refreshParties();
    loadSettings();
  } catch (err) { toast(err.message, true); }
}

async function doFullReset() {
  const ok = await confirmAsk(
    "Full Reset: permanently delete ALL parties, entries and capital, returning the app to blank? This cannot be undone.",
    "Delete everything");
  if (!ok) return;
  try {
    await api.fullReset();
    toast("Full reset done — the app is blank");
    deselect();
    await refreshParties();
    loadSettings();
  } catch (err) { toast(err.message, true); }
}

// ---------------- parties ----------------
async function refreshParties() {
  try {
    state.parties = await api.listParties();
  } catch (err) { return toast(err.message, true); }
  state.parties.sort(byStarThenName);   // "*" names first
  await loadAgentsPartners();            // agents + global partners master lists

  // Top party box + entry-bar autocomplete: all parties (the Capital account is
  // now a normal party, so it's included automatically).
  const names = state.parties.map((p) => `<option value="${esc(p.name)}">`).join("");
  $("topPartyList").innerHTML = names;
  $("partyDatalist").innerHTML = names;

  if (state.party && !state.party._capital) {
    const fresh = state.parties.find((p) => p.id === state.party.id);
    if (fresh) state.party = fresh;
  }
}

// Resolve a typed name to a party (or the Capital account) and open it.
async function openByName(name) {
  const n = (name || "").trim();
  if (!n) return deselect();
  const match = state.parties.find((p) => p.name.toLowerCase() === n.toLowerCase());
  if (!match) return toast(`No party named "${n}". Use “+ New” to add it.`, true);
  selectParty(match.id);
}

async function selectParty(partyId) {
  if (!partyId) return deselect();
  if (partyId === "__capital__") return selectCapital();
  try {
    state.party = await api.getParty(partyId);
    state.rows = await api.getLedger(partyId);
  } catch (err) { return toast(err.message, true); }
  state.selectedEntryId = null;
  $("partyInput").value = state.party.name;
  $("entryParty").value = "";
  renderReport();
  // Put the cursor on the entry "Party name" box so an entry can be typed at once
  // (also runs after each Submit, since addEntry re-opens the ledger here).
  $("entryParty").focus();
}

async function selectCapital() {
  let cap, rows;
  try { cap = await api.getCapital(); rows = await api.getCapitalLedger(); }
  catch (err) { return toast(err.message, true); }
  state.party = {
    id: "__capital__", name: state.capitalName || "Capital Account", _capital: true, phone: "",
    opening_balance: Number(cap.opening_capital),
    balance: Number(cap.balance),
    total_received: Number(cap.total_received),
    total_paid: Number(cap.total_paid),
  };
  state.rows = rows;
  state.selectedEntryId = null;
  $("partyInput").value = state.capitalName || "Capital Account";
  $("entryParty").value = "";
  renderReport();
}

function deselect() {
  state.party = null; state.rows = []; state.selectedEntryId = null;
  $("partyInput").value = "";
  $("entryParty").value = "";
  // Clear the closing-balance header so it never shows a previous party.
  $("selectedPartyName").textContent = "—";
  $("closingLabel").textContent = "Closing Balance";
  $("closingValue").textContent = "";
  $("closingValue").className = "closing-value";
  $("closingSub").textContent = "";
  $("reportArea").style.display = "none";
  $("emptyHint").style.display = "block";
}

function num(id) { const v = parseFloat($(id).value); return isNaN(v) ? 0 : v; }
function collectPartyConfig() {
  return {
    dhara: $("npDhara").value, status: $("npStatus").value,
    balance_limit: num("incLimit"),
    self: { match: num("ssMatch"), session: num("ssSession"), abandon: num("ssAbandon"), tie: num("ssTie"), akd: num("ssAkd") },
    inc: { comm_match: num("incCommMatch"), comm_match_type: $("incCommMatchType") ? $("incCommMatchType").value : "", comm_agent: num("incCommAgent") },
    // ONE agent per client (chosen from the master list); % set here on the client.
    agent: { name: ($("agName").value || "").trim(), match: num("agMatch"), session: num("agSession"), abandon: num("agAbandon"), tie: num("agTie"), akd: num("agAkd") },
    comm_session: { test: num("csTest"), "50-50": num("cs5050"), "40-40": num("cs4040"), "20-20": num("cs2020"), galli: $("csGalli").checked },
    comm_session_90110: { test: num("cs90Test"), "50-50": num("cs905050"), "40-40": num("cs904040"), "20-20": num("cs902020") },
    comm_session_agent: { test: num("csaTest"), "50-50": num("csa5050"), "40-40": num("csa4040"), "20-20": num("csa2020") },
    comm_session_agent_90110: { test: num("csa90Test"), "50-50": num("csa905050"), "40-40": num("csa904040"), "20-20": num("csa902020") },
  };
}

// ====== Agents (master list) & Partners (global) ======
// state.agents = ["HP", ...]   state.partners = [{name,match,session,abandon,tie,akd}]
async function loadAgentsPartners() {
  let s = {}; try { s = (await api.getSettings()) || {}; } catch (e) {}
  if (Array.isArray(s.agents)) state.agents = s.agents.slice();
  else {   // migrate: distinct agent names across all clients
    const set = new Set();
    (state.parties || []).forEach((p) => cfgAgents(p.config || {}).forEach((a) => { const n = (a.name || "").trim(); if (n) set.add(n); }));
    state.agents = [...set];
  }
  if (Array.isArray(s.partners)) state.partners = s.partners.slice();
  else {   // migrate: distinct per-client partners from old configs
    const by = {};
    (state.parties || []).forEach((p) => { const pt = (p.config || {}).partner || {}; const n = (pt.name || "").trim();
      if (n && !by[n.toLowerCase()]) by[n.toLowerCase()] = { name: n, match: pt.match || 0, session: pt.session || 0, abandon: pt.abandon || 0, tie: pt.tie || 0, akd: pt.akd || 0 }; });
    state.partners = Object.values(by);
  }
}
async function saveAgentsPartners() { try { await api.updateSettings({ agents: state.agents, partners: state.partners }); } catch (e) {} }

function populateAgentSelect(selected) {
  const sel = $("agName"); if (!sel) return;
  const names = state.agents || [];
  sel.innerHTML = ['<option value="">— none —</option>'].concat(names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)).join("");
  if (selected) {
    if (!names.some((n) => n.toLowerCase() === selected.toLowerCase()))
      sel.insertAdjacentHTML("beforeend", `<option value="${esc(selected)}">${esc(selected)} (not in list)</option>`);
    sel.value = selected;
  } else sel.value = "";
}
function renderNpPartnersInfo() {
  const el = $("npPartnersInfo"); if (!el) return;
  const ps = globalPartners();
  el.innerHTML = ps.length
    ? "Current partners: " + ps.map((p) => `<b>${esc(p.name)}</b> (${p.match || 0}% / ${p.session || 0}%)`).join(", ")
    : '<span style="color:#9aa8af">No partners yet — add some in Manage partners.</span>';
}

// ---- Manage Agents ----
async function openAgentsModal() { openModal("agentsModal"); await renderAgentsList(); }
async function renderAgentsList() {
  const box = $("agentsList"); if (!box) return;
  let loginMap = {};
  try { const { agents } = await api.agentFn({ action: "agent_names" }); (agents || []).forEach((a) => { loginMap[(a.agent_name || "").toLowerCase()] = a; }); } catch (e) {}
  const clientsOf = {};
  (state.parties || []).forEach((p) => cfgAgents(p.config || {}).forEach((a) => { const n = (a.name || "").trim().toLowerCase(); if (n) (clientsOf[n] = clientsOf[n] || []).push(p.name); }));
  if (!(state.agents || []).length) { box.innerHTML = '<div class="muted">No agents yet. Add one above.</div>'; return; }
  box.innerHTML = `<table class="mini"><thead><tr><th>Agent</th><th>App login</th><th>Clients</th><th></th></tr></thead><tbody>` +
    state.agents.map((n) => {
      const st = loginMap[n.toLowerCase()], cl = clientsOf[n.toLowerCase()] || [];
      const login = st ? (st.has_login ? `✓ <b>${esc(st.code)}</b>` : '<span class="muted">no login</span>') : '<span class="muted">—</span>';
      return `<tr data-agent="${esc(n)}"><td><b>${esc(n)}</b></td><td>${login}</td><td>${cl.map(esc).join(", ") || '<span class="muted">none</span>'}</td>
        <td style="white-space:nowrap"><input class="ag-pw" type="text" placeholder="password" style="width:104px">
          <button class="btn ghost sm" data-agx="login">${st && st.has_login ? "Reset pw" : "Give login"}</button>
          <button class="btn danger sm" data-agx="del">Remove</button></td></tr>`;
    }).join("") + `</tbody></table>`;
}
async function addAgent() {
  const name = ($("newAgentName").value || "").trim(), pw = ($("newAgentPass").value || "").trim();
  if (!name) return toast("Enter an agent name", true);
  if ((state.agents || []).some((n) => n.toLowerCase() === name.toLowerCase())) return toast("That agent already exists", true);
  state.agents = (state.agents || []).concat(name); await saveAgentsPartners();
  if (pw) {
    if (pw.length < 6) toast("Agent added. Give a login later — password must be 6+ chars.");
    else { try { const r = await api.agentFn({ action: "ensure_agent", agent_name: name, password: pw }); alert(`Share with ${name}:\n\nUsername: ${r.code}\nPassword: ${pw}`); } catch (e) { toast("Agent added. App login needs the live server."); } }
  } else toast(`Agent "${name}" added`);
  $("newAgentName").value = ""; $("newAgentPass").value = "";
  await renderAgentsList();
}
async function onAgentsListClick(e) {
  const btn = e.target.closest("button[data-agx]"); if (!btn) return;
  const row = btn.closest("tr[data-agent]"), nm = row.getAttribute("data-agent"), act = btn.getAttribute("data-agx");
  if (act === "del") {
    const clients = (state.parties || []).filter((p) => cfgAgents(p.config || {}).some((a) => (a.name || "").toLowerCase() === nm.toLowerCase()));
    if (clients.length) return toast(`Can't remove — ${nm} still has clients: ${clients.map((c) => c.name).join(", ")}`, true);
    if (!confirm(`Remove agent "${nm}"? This also removes his app login.`)) return;
    try { await api.agentFn({ action: "delete_agent", agent_name: nm }); } catch (e) {}
    state.agents = (state.agents || []).filter((n) => n.toLowerCase() !== nm.toLowerCase()); await saveAgentsPartners();
    toast(`Agent "${nm}" removed`); await renderAgentsList();
  } else {   // login / reset
    const pw = (row.querySelector(".ag-pw").value || "").trim();
    if (pw.length < 6) return toast("Password must be at least 6 characters", true);
    try { const r = await api.agentFn({ action: "ensure_agent", agent_name: nm, password: pw }); alert(`Share with ${nm}:\n\nUsername: ${r.code}\nPassword: ${pw}`); await renderAgentsList(); }
    catch (err) { toast("App login needs the live server (agent Edge Function).", true); }
  }
}

// ---- Manage Partners (global) ----
function openPartnersModal() { openModal("partnersModal"); renderPartnersList(); }
function renderPartnersList() {
  const box = $("partnersList"); if (!box) return;
  const ps = globalPartners();
  if (!ps.length) { box.innerHTML = '<div class="muted">No partners yet. Add one above.</div>'; return; }
  box.innerHTML = `<table class="mini"><thead><tr><th>Partner</th><th class="num">Match%</th><th class="num">Session%</th><th class="num">Abandon%</th><th class="num">Tie%</th><th class="num">AKD</th><th></th></tr></thead><tbody>` +
    ps.map((p, i) => `<tr><td><b>${esc(p.name)}</b></td><td class="num">${p.match || 0}</td><td class="num">${p.session || 0}</td><td class="num">${p.abandon || 0}</td><td class="num">${p.tie || 0}</td><td class="num">${p.akd || 0}</td>
      <td><button class="btn danger sm" data-ptx="del" data-i="${i}">Remove</button></td></tr>`).join("") + `</tbody></table>`;
}
async function addPartner() {
  const name = ($("newPartnerName").value || "").trim();
  if (!name) return toast("Enter a partner name", true);
  if (globalPartners().some((p) => (p.name || "").toLowerCase() === name.toLowerCase())) return toast("That partner already exists", true);
  state.partners = globalPartners().concat({ name, match: num("newPartnerMatch"), session: num("newPartnerSession"), abandon: num("newPartnerAbandon"), tie: num("newPartnerTie"), akd: num("newPartnerAkd") });
  await saveAgentsPartners();
  ["newPartnerName", "newPartnerMatch", "newPartnerSession", "newPartnerAbandon", "newPartnerTie", "newPartnerAkd"].forEach((id) => { if ($(id)) $(id).value = ""; });
  renderPartnersList(); renderNpPartnersInfo();
  toast(`Partner "${name}" added`);
}
async function onPartnersListClick(e) {
  const btn = e.target.closest("button[data-ptx]"); if (!btn) return;
  const i = parseInt(btn.getAttribute("data-i"), 10);
  const p = globalPartners()[i]; if (!p) return;
  if (!confirm(`Remove partner "${p.name}"?`)) return;
  state.partners = globalPartners().filter((_, k) => k !== i); await saveAgentsPartners();
  renderPartnersList(); renderNpPartnersInfo();
}

function openNewParty() {
  state._editPartyId = null;
  $("npTitle").textContent = "New Party";
  ["npName", "npPhone", "npNotes", "incLimit", "ssMatch", "ssSession", "ssAbandon", "ssTie", "ssAkd",
   "incCommMatch", "incCommAgent",
   "agMatch", "agSession", "agAbandon", "agTie", "agAkd", "csTest", "cs5050", "cs4040", "cs2020",
   "cs90Test", "cs905050", "cs904040", "cs902020",
   "csaName", "csaTest", "csa5050", "csa4040", "csa2020",
   "csa90Test", "csa905050", "csa904040", "csa902020"].forEach((id) => { if ($(id)) $(id).value = ""; });
  $("npOpening").value = "0";
  $("npDhara").value = "NGP"; $("npStatus").value = "Regular";
  if ($("incCommMatchType")) $("incCommMatchType").value = "";
  updateMatchCommLabels();
  ["csGalli"].forEach((id) => { if ($(id)) $(id).checked = false; });
  populateAgentSelect("");
  renderNpPartnersInfo();
  openModal("newPartyModal");
}

// Match-commission fields are a % for losing/lost-bets, but a ₹ rate for turnover.
// Relabel them to match the selected type so the unit is never ambiguous.
function updateMatchCommLabels() {
  const type = $("incCommMatchType") ? $("incCommMatchType").value : "";
  const unit = type === "turnover" ? "(per 1,000)" : "%";
  if ($("lblCommMatch")) $("lblCommMatch").textContent = `Client's match commission ${unit}`;
  if ($("lblCommAgent")) $("lblCommAgent").textContent = `Agent's match commission ${unit}`;
}
function setVal(id, v) { if ($(id)) $(id).value = (v == null ? "" : v); }
function fillPartyConfig(c) {
  c = c || {};
  const agentsArr = cfgAgents(c);
  const self = c.self || {}, inc = c.inc || {}, ag = agentsArr[0] || {},
        cs = c.comm_session || {}, csa = c.comm_session_agent || {};
  if ($("npDhara")) $("npDhara").value = c.dhara || "NGP";
  if ($("npStatus")) $("npStatus").value = c.status || "Regular";
  setVal("incLimit", c.balance_limit || "");
  setVal("ssMatch", self.match); setVal("ssSession", self.session); setVal("ssAbandon", self.abandon); setVal("ssTie", self.tie); setVal("ssAkd", self.akd);
  setVal("incCommMatch", inc.comm_match); setVal("incCommAgent", inc.comm_agent);
  if ($("incCommMatchType")) $("incCommMatchType").value = inc.comm_match_type || "";
  updateMatchCommLabels();
  populateAgentSelect(ag.name || "");
  renderNpPartnersInfo();
  setVal("agMatch", ag.match); setVal("agSession", ag.session); setVal("agAbandon", ag.abandon); setVal("agTie", ag.tie); setVal("agAkd", ag.akd);
  setVal("csTest", cs.test); setVal("cs5050", cs["50-50"]); setVal("cs4040", cs["40-40"]); setVal("cs2020", cs["20-20"]);
  const cs9 = c.comm_session_90110 || {};
  setVal("cs90Test", cs9.test); setVal("cs905050", cs9["50-50"]); setVal("cs904040", cs9["40-40"]); setVal("cs902020", cs9["20-20"]);
  setVal("csaTest", csa.test); setVal("csa5050", csa["50-50"]); setVal("csa4040", csa["40-40"]); setVal("csa2020", csa["20-20"]);
  const csa9 = c.comm_session_agent_90110 || {};
  setVal("csa90Test", csa9.test); setVal("csa905050", csa9["50-50"]); setVal("csa904040", csa9["40-40"]); setVal("csa902020", csa9["20-20"]);
  if ($("csGalli")) $("csGalli").checked = !!cs.galli;
}

async function editParty(id) {
  let p;
  try { p = await api.getParty(id); } catch (e) { return toast(e.message, true); }
  if (!p) return;
  state._editPartyId = id;
  $("npTitle").textContent = "Edit Party";
  setVal("npName", p.name);
  setVal("npPhone", p.phone);
  setVal("npNotes", p.notes);
  setVal("npOpening", p.opening_balance != null ? p.opening_balance : 0);
  fillPartyConfig(p.config);
  openModal("newPartyModal");
}

async function saveNewParty() {
  const name = $("npName").value.trim();
  if (!name) return toast("Enter a party name", true);
  const editing = state._editPartyId;
  try {
    if (editing) {
      await api.updateParty(editing, {
        name,
        phone: $("npPhone").value.trim(),
        opening_balance: parseFloat($("npOpening").value) || 0,
        notes: $("npNotes").value.trim(),
        config: collectPartyConfig(),
      });
      state._editPartyId = null;
      closeModal("newPartyModal");
      await refreshParties();
      if ($("partyReportView") && $("partyReportView").style.display !== "none") await renderPartyReport();
      toast(`Party "${name}" updated`);
      return;
    }
    const p = await api.createParty({
      name,
      phone: $("npPhone").value.trim(),
      opening_balance: parseFloat($("npOpening").value) || 0,
      notes: $("npNotes").value.trim(),
      config: collectPartyConfig(),
    });
    closeModal("newPartyModal");
    ["npName", "npPhone", "npNotes"].forEach((id) => ($(id).value = ""));
    $("npOpening").value = "0";
    await refreshParties();
    showView("home");                 // back to the dashboard after creating a party
    toast(`Party "${p.name}" added`);
  } catch (err) {
    toast(err.message.includes("duplicate") ? "That party already exists" : err.message, true);
  }
}

// ---------------- entries ----------------
// The open party (top) is the subject. "Received" = money into the open party,
// "Paid" = money out of the open party. If an "Other account" is filled, it's a
// TRANSFER between the two accounts; if blank, it's a plain cash entry.
// ---- Double-submit guard ---------------------------------------------------
// Stops the SAME save from running twice when a user double-clicks / double-taps
// the button, presses Enter twice, or the first (slow) network write is still in
// flight. Without it, the input fields are still filled during the second call,
// so an identical duplicate entry/sauda gets written. Keyed per action.
const _writeBusy = new Set();
function beginWrite(key) { if (_writeBusy.has(key)) return false; _writeBusy.add(key); return true; }
function endWrite(key) { _writeBusy.delete(key); }
// Wrap a button handler so a double-click can't run it twice (e.g. a settlement
// declare that posts many entries). Disables the button until the action settles.
async function guardClick(key, btn, fn) {
  if (!beginWrite(key)) return;
  if (btn) btn.disabled = true;
  try { await fn(); }
  catch (e) { try { toast((e && e.message) || "Something went wrong", true); } catch (_) {} }
  finally { endWrite(key); if (btn) btn.disabled = false; }
}

async function addEntry() {
  if (!state.party) return toast("Open a party first — type a name at the top.", true);
  if (state.party._capital) return toast("Open a party (not the Capital account) to add entries.", true);

  const open = state.party.name;
  const other = $("entryParty").value.trim();
  const raw = parseFloat($("entryAmount").value);
  if (!other) return toast("Enter a party name.", true);
  if (other.toLowerCase() === open.toLowerCase())
    return toast("Party name must be different from the open ledger.", true);
  if (!raw || Number.isNaN(raw)) return toast("Enter an amount — positive for received (lena), negative for paid (dena).", true);

  // Sign decides direction, applied to the TYPED (other) party:
  //   negative = "<other> ko dena"  -> other becomes DENA (we must give them);  open becomes Lena.
  //   positive = "<other> se lena"  -> other becomes LENA (they owe us);        open becomes Dena.
  const isDena = raw < 0;
  const amount = Math.abs(raw);
  const date = $("entryDate").value || todayISO();
  const remark = $("entryRemark").value.trim();

  if (!beginWrite("entry")) return;                 // already saving — ignore the repeat
  const _b = $("btnSubmit"); if (_b) _b.disabled = true;
  try {
    // transfer(from,to): the payer(from) becomes Dena, the receiver(to) becomes Lena.
    if (isDena) await api.transfer({ from: other, to: open, amount, date, remark });   // other = Dena
    else        await api.transfer({ from: open, to: other, amount, date, remark });   // other = Lena
    toast(`${other}: ${isDena ? "Dena" : "Lena"} ${inr(amount)}`);
    $("entryAmount").value = ""; $("entryRemark").value = ""; $("entryParty").value = "";
    await refreshParties();
    selectParty(state.party.id);
  } catch (err) { toast(err.message, true); }
  finally { endWrite("entry"); if (_b) _b.disabled = false; }
}

function openModify() {
  const row = state.rows.find((r) => r.id === state.selectedEntryId);
  if (!row) return toast("Click an entry in the list first", true);
  // Show the signed amount as seen in this ledger (received = +, paid = −).
  const signed = row.type === "received" ? Number(row.amount) : -Number(row.amount);
  $("mfAmount").value = signed;
  $("mfDate").value = row.entry_date.slice(0, 10);
  $("mfRemark").value = row.remark || "";
  openModal("modifyModal");
}

async function saveModify() {
  const raw = $("mfAmount").value.trim();
  const val = parseFloat(raw);
  try {
    if (raw === "" || val === 0 || Number.isNaN(val)) {
      // Blank/zero amount => delete the entry completely (no mark).
      await api.hardDeleteEntry(state.selectedEntryId);
      state.selectedEntryId = null;
      closeModal("modifyModal");
      toast("Entry deleted");
    } else {
      await api.editEntrySigned(state.selectedEntryId, {
        signed: val,
        date: $("mfDate").value,
        remark: $("mfRemark").value.trim(),
      });
      closeModal("modifyModal");
      toast("Entry updated");
    }
    await refreshParties();
    selectParty(state.party.id);
  } catch (err) { toast(err.message, true); }
}

async function doDelete() {
  if (!state.selectedEntryId) return toast("Tap an entry in Received or Paid first", true);
  if (!(await confirmAsk("Delete this entry? If it is a transfer, both sides are removed.", "Delete"))) return;
  try {
    await api.deleteEntry(state.selectedEntryId);
    state.selectedEntryId = null;
    toast("Entry deleted");
    await refreshParties();
    selectParty(state.party.id);
  } catch (err) { toast(err.message, true); }
}

// ---------------- Capital ----------------
async function saveCapital() {
  try {
    await api.setOpeningCapital(parseFloat($("capOpening").value) || 0);
    closeModal("capitalModal");
    toast("Opening capital updated");
    selectCapital();
    refreshParties();
  } catch (err) { toast(err.message, true); }
}

// ---------------- Monday Final ----------------
async function doMondayFinal() {
  if (!state.party) return;
  const msg = `Monday Final for "${state.party.name}"? This locks the current entries into ` +
    `Old Record and carries the closing balance ${inr(state.party.balance)} forward as the new opening balance.`;
  if (!(await confirmAsk(msg, "Close & carry forward", false))) return;
  try {
    const c = await api.mondayFinal(state.party.id);
    toast(`Closed. Carried ${inr(c.closing_balance)} forward.`);
    await refreshParties();
    selectParty(state.party.id);
  } catch (err) { toast(err.message, true); }
}

// ---------------- Old Record ----------------
async function openOldRecord() {
  if (!state.party) return;
  let data;
  try { data = await api.oldRecords(state.party.id); }
  catch (err) { return toast(err.message, true); }

  const byPeriod = {};
  data.entries.forEach((e) => { (byPeriod[e.period_id] ||= []).push(e); });

  // One side of a closed period (positive entries left, negative right), signed.
  const sideTable = (rows, closing, negative) => {
    const body = rows.length
      ? rows.map((e) => `<tr class="${e.deleted ? "del-row" : ""}">
          <td>${ddmmyyyy(e.entry_date)}</td>
          <td class="pname">${esc(e.counterparty) || "-"}</td>
          <td>${esc(e.remark) || "-"}</td>
          <td class="num">${inr(negative ? -Number(e.amount) : Number(e.amount))}</td></tr>`).join("")
      : `<tr><td colspan="4" class="muted" style="text-align:center;padding:10px">None</td></tr>`;
    return `<table class="mini"><thead><tr><th>Date</th><th>Party</th><th>Remark</th><th class="num">Amount</th></tr></thead>
      <tbody>${body}
        <tr class="total-row"><td colspan="3"><b>Closing</b></td><td class="num"><b>${inr(closing)}</b></td></tr>
      </tbody></table>`;
  };

  const body = data.closings.length
    ? data.closings.map((c) => {
        const rows = byPeriod[c.id] || [];
        const dena = rows.filter((e) => e.type === "received").sort(byNewest); // positive side (left)
        const lena = rows.filter((e) => e.type === "paid").sort(byNewest);     // negative side (right)
        return `<div class="period">
          <div class="period-head">Closed ${ddmmyyyy(c.closed_on)} · closing
            <b>${inr(c.closing_balance)}</b></div>
          <div class="split">
            <div class="panel">${sideTable(dena, c.closing_balance, false)}</div>
            <div class="panel">${sideTable(lena, c.closing_balance, true)}</div>
          </div>
        </div>`;
      }).join("")
    : `<p class="muted" style="padding:16px">No closed periods yet. Use “Monday Final” to close the current period.</p>`;

  $("oldRecordTitle").textContent = `Old Record — ${state.party.name}`;
  $("oldRecordBody").innerHTML = body;
  openModal("oldRecordModal");
}

// ---------------- Ledger (printable, date range) ----------------
function openLedgerRange() {
  if (!state.party) return;
  $("lrFrom").value = ""; $("lrTo").value = "";
  openModal("ledgerRangeModal");
}
async function doShowLedger() {
  if (!state.party) return;
  const from = $("lrFrom").value || null;
  const to = $("lrTo").value || null;
  let rows;
  try {
    if (state.party._capital) {
      rows = await api.getCapitalLedger();
      if (from) rows = rows.filter((r) => r.entry_date >= from);
      if (to) rows = rows.filter((r) => r.entry_date <= to);
    } else {
      rows = await api.getStatement(state.party.id, from, to);
    }
  } catch (err) { return toast(err.message, true); }
  closeModal("ledgerRangeModal");
  state.ledgerData = { party: state.party, rows, from, to };
  $("ledgerViewTitle").textContent = "Ledger — " + state.party.name;
  $("ledgerViewBody").innerHTML = ledgerHTML(state.party, rows, from, to);
  openModal("ledgerViewModal");
}

function saveLedgerPdf() {
  const d = state.ledgerData;
  if (!d) return;
  const ok = downloadLedgerPDF(d.party, d.rows, d.from, d.to);
  if (ok) toast("PDF downloaded");
  else window.print(); // fallback if the PDF library didn't load
}

// ---------------- render report ----------------
function renderReport() {
  $("emptyHint").style.display = "none";
  $("reportArea").style.display = "block";

  const p = state.party;
  const isCap = !!p._capital;

  // Toolbar actions depend on mode (party vs capital)
  $("btnMondayFinal").style.display = isCap ? "none" : "";
  $("btnModify").style.display = isCap ? "none" : "";
  $("btnDelete").style.display = isCap ? "none" : "";
  $("btnOldRecord").style.display = isCap ? "none" : "";
  $("btnSetCapital").style.display = isCap ? "" : "none";

  // Signed closing balance (like the old SHREE GAJANAN app): positive = green,
  // negative = red, shown with its sign and no Dena/Lena word.
  $("closingLabel").textContent = "Closing Balance";
  $("closingValue").textContent = inr(p.balance);
  $("closingValue").className = "closing-value " + (p.balance >= 0 ? "bal-pos" : "bal-neg");
  $("closingSub").textContent = "";
  $("selectedPartyName").textContent = p.name;
  $("openingBal").textContent = inr(p.opening_balance || 0);   // OP BAL, signed

  // Two-column split (newest first). The Dena/Lena labels and colours are left
  // off these columns — a "pay" entry lands in the mirror column, which read as a
  // mismatch — so we show just each column's total. The party's true position is
  // the closing balance above (and the Trial Balance).
  const recv = state.rows.filter((r) => r.type === "received").sort(byNewest); // left panel (newest first)
  const paid = state.rows.filter((r) => r.type === "paid").sort(byNewest);     // right panel (newest first)
  $("recvLabel").textContent = ""; $("recvTitle").className = "panel-title";
  $("paidLabel").textContent = ""; $("paidTitle").className = "panel-title";
  $("recvTotal").textContent = inr(p.total_received);      // positive side
  $("paidTotal").textContent = inr(-p.total_paid);         // negative side (shown with minus)
  $("recvBody").innerHTML = splitRows(recv, isCap, false);
  $("paidBody").innerHTML = splitRows(paid, isCap, true);

  highlightSelected();
}

function splitRows(rows, isCap, negative) {
  if (!rows.length) return `<tr><td colspan="4" class="muted" style="text-align:center;padding:12px">None</td></tr>`;
  return rows.map((r) => {
    const party = isCap ? esc(r.party_name) : (esc(r.counterparty) || "-");
    const remark = esc(r.remark) || "-";
    const amt = negative ? -Number(r.amount) : Number(r.amount);  // right column shows the minus
    return `<tr data-id="${r.id}" class="${r.deleted ? "del-row" : ""}">
      <td>${ddmmyyyy(r.entry_date)}</td>
      <td class="pname">${party}</td>
      <td>${remark}</td>
      <td class="num">${inr(amt)}</td></tr>`;
  }).join("");
}

function highlightSelected() {
  document.querySelectorAll("#recvBody tr, #paidBody tr").forEach((tr) => {
    tr.classList.toggle("sel", tr.getAttribute("data-id") === state.selectedEntryId);
  });
}

// ---------------- modals ----------------
function openModal(id) {
  const m = $(id); m.classList.add("show");
  // always open scrolled to the top (the body keeps its last scroll otherwise)
  m.querySelectorAll(".box-body, .box").forEach((el) => { el.scrollTop = 0; });
}
function closeModal(id) { $(id).classList.remove("show"); }

// ================= TRADING =================
// Money/Qty for a trade (from the seller's/buyer's view):
//   L (sell): Money = +qty*rate, Qty = -qty
//   K (buy) : Money = -qty*rate, Qty = +qty
function tradeMoney(t) { const m = Number(t.qty) * Number(t.rate); return t.mode === "L" ? m : -m; }
function tradeQty(t)   { return t.mode === "L" ? -Number(t.qty) : Number(t.qty); }

// Enter Trading → the Match Report (level 1).
async function enterTrading() {
  state.trSession = null; state.runSession = null; state.trMax = null; state.bookOpen = false;
  $("trDetail").style.display = "none";
  $("trPaneBook").style.display = "none";
  $("connectView").style.display = "none";
  $("matchReport").style.display = "";
  await renderMatchReport();
}

// Type "56" -> 0.56; a value with a decimal point ("1.00", "2.10") is taken as-is.
function normalizeRate(str) {
  const s = String(str == null ? "" : str).trim();
  if (!s) return NaN;
  if (s.includes(".")) return parseFloat(s);
  const n = parseInt(s, 10);
  return isNaN(n) ? NaN : n / 100;
}

function matchLabel(m) {
  const vs = `${m.team1 || "?"} VS ${m.team2 || "?"}`;
  return m.type ? `${vs} (${m.type})` : vs;
}

// ---- Level 1: Match Report ----
async function renderMatchReport() {
  let list;
  try { list = await api.listMatches(); }
  catch (err) { return toast(err.message, true); }
  state.matches = list;
  $("mrBody").innerHTML = list.length
    ? list.map((m, i) => {
        const cls = m.id === state.matchSelectedId ? "sel" : "";
        return `<tr data-id="${m.id}" class="${cls}">
          <td>${list.length - i}</td>
          <td><b>${ddmmyyyy(m.trade_date)}</b></td>
          <td>${esc(m.team1) || "-"}</td><td>${esc(m.team2) || "-"}</td>
          <td>${esc(m.type) || "-"}</td><td class="num">${esc(m.result) || ""}</td></tr>`;
      }).join("")
    : `<tr><td colspan="6" class="muted" style="text-align:center;padding:18px">No matches yet — press New Match.</td></tr>`;
  $("mrBody").querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      state.matchSelectedId = tr.getAttribute("data-id");
      $("mrBody").querySelectorAll("tr").forEach((r) => r.classList.remove("sel"));
      tr.classList.add("sel");
    });
    tr.addEventListener("dblclick", () => openMatch(tr.getAttribute("data-id")));
  });
}

// A match's GT columns are its two team names, plus DRW only for TEST matches.
function autoTeams(t1, t2, type) {
  const base = [String(t1 || "").trim() || "1", String(t2 || "").trim() || "2"];
  if (/test/i.test(String(type || ""))) base.push("DRW");
  return base;
}
// Refresh the read-only GT-column preview from Team 1 / Team 2 / Type.
function syncHorsesFromTeams() {
  renderHorses(autoTeams($("mmTeam1").value, $("mmTeam2").value, $("mmType").value));
}

// Read-only preview of the GT columns this match will use. The columns are
// always derived from the team names + type (see autoTeams); they are not hand-
// editable, which keeps the GT, trades and reports perfectly aligned.
function renderHorses(horses) {
  const list = (horses && horses.length) ? horses.slice() : [];
  $("mmHorses").innerHTML = list.map((h) =>
    `<input class="mm-horse" type="text" value="${esc(h)}" readonly tabindex="-1" autocomplete="off">`).join("");
}

function openMatchModal(id) {
  state.trEditSessionId = id || null;
  const m = id ? (state.matches.find((x) => x.id === id) || {}) : {};
  $("matchModalTitle").textContent = id ? "Edit Match" : "New Match";
  $("mmTeam1").value = m.team1 || "";
  $("mmTeam2").value = m.team2 || "";
  $("mmType").value = m.type || "TEST";
  $("mmDate").value = m.trade_date ? m.trade_date.slice(0, 10) : todayISO();
  renderHorses(autoTeams(m.team1, m.team2, m.type || "TEST"));
  openModal("matchModal");
}

async function doSaveMatch() {
  const team1 = $("mmTeam1").value.trim();
  const team2 = $("mmTeam2").value.trim();
  const type = $("mmType").value.trim();
  const trade_date = $("mmDate").value || todayISO();
  if (!team1 || !team2) return toast("Enter Team 1 and Team 2", true);
  // GT columns always derive from the team names + type (DRW only for TEST),
  // so the stored columns can never drift from what the user typed.
  const teams = autoTeams(team1, team2, type);
  try {
    let saved;
    if (state.trEditSessionId) saved = await api.updateMatch(state.trEditSessionId, { team1, team2, type, trade_date, teams });
    else saved = await api.createMatch({ team1, team2, type, trade_date, teams });
    closeModal("matchModal");
    toast("Match saved");
    if (saved && saved.id) state.matchSelectedId = saved.id;
    await renderMatchReport();
    if (state.trSession && saved && saved.id === state.trSession.id) await openMatch(saved.id);
  } catch (err) { toast(err.message, true); }
}

async function doDeleteMatch(id) {
  if (!(await confirmAsk("Delete this match, all its sessions and bets? This cannot be undone.", "Delete match"))) return;
  try {
    await api.deleteMatch(id);
    toast("Match deleted");
    if (state.trSession && state.trSession.id === id) closeMatch();
    else await renderMatchReport();
  } catch (err) { toast(err.message, true); }
}

// Open a match → MATCH window (left) + Session Report (right).
async function openMatch(id) {
  let m = (state.matches || []).find((x) => x.id === id);
  if (!m) { try { state.matches = await api.listMatches(); } catch (e) { return toast(e.message, true); } m = state.matches.find((x) => x.id === id); }
  if (!m) return;
  state.trSession = m; state.trSelectedId = null; state.matchSelectedId = id;
  state.runSession = null; state.srSelectedId = null;
  state.bookOpen = false; state.trMax = null; state.rightMode = "report";
  state._bookDrill = { level: 0 };   // reset the agents/partners book drill-down
  $("matchReport").style.display = "none";
  $("trPaneBook").style.display = "none";
  $("trDetail").style.display = "";
  $("trEntryBar").style.display = "";
  // fill the Team dropdown from the match's teams
  const teams = Array.isArray(m.teams) ? m.teams : [];
  const opts = teams.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  $("trTeam").innerHTML = opts || `<option value="">(no teams)</option>`;
  cancelEdit();
  cancelSessionEdit();
  applyPanes();
  await loadTrades();
  await renderSessionReport();
  applyMatchLock();
  $("trRate").focus();
}

// Exit the match → back to the Match Report.
function closeMatch() {
  state.trSession = null; state.trSelectedId = null; state.runSession = null;
  state.trades = []; state.syBets = []; state.sySelectedId = null; state.srSelectedId = null;
  if (typeof cancelEdit === "function") cancelEdit();
  if (typeof cancelSessionEdit === "function") cancelSessionEdit();
  state.bookOpen = false; state.trMax = null; state.rightMode = "report";
  $("trPaneBook").style.display = "none";
  $("trDetail").style.display = "none";
  $("matchReport").style.display = "";
  renderMatchReport();
}

// ---- Level 2: Session Report (sessions of the open match) ----
async function renderSessionReport() {
  if (!state.trSession) return;
  let list;
  try { list = await api.listSessions(state.trSession.id); }
  catch (err) { return toast(err.message, true); }
  state.sessions = list;
  const openId = state.runSession && state.runSession.id;
  $("srTitle").textContent = `Session Report — ${matchLabel(state.trSession)}`;
  $("srBody").innerHTML = list.length
    ? list.map((s) => {
        const cls = `${s.id === state.srSelectedId ? "sel" : ""} ${s.id === openId ? "open" : ""}`.trim();
        return `<tr data-id="${s.id}" class="${cls}">
          <td><b>${ddmmyyyy(s.session_date)}</b></td><td>${esc(s.name) || "-"}</td>
          <td class="num">${esc(s.result) || ""}</td></tr>`;
      }).join("")
    : `<tr><td colspan="3" class="muted" style="text-align:center;padding:18px">No sessions yet — press New.</td></tr>`;
  $("srBody").querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      state.srSelectedId = tr.getAttribute("data-id");
      $("srBody").querySelectorAll("tr").forEach((r) => r.classList.remove("sel"));
      tr.classList.add("sel");
    });
    tr.addEventListener("dblclick", () => openSessionRuns(tr.getAttribute("data-id")));
  });
}

// The type most recently used for a session in the open match (remembered across saves,
// otherwise derived from the newest existing session) — so a new session pre-fills it.
function lastSessionType() {
  if (state._lastSessionCommType) return state._lastSessionCommType;
  const ss = (state.sessions || []).filter((x) => x.commission_type);
  if (!ss.length) return "";
  ss.sort((a, b) => String(a.created_at || a.id || "").localeCompare(String(b.created_at || b.id || "")));
  return ss[ss.length - 1].commission_type || "";
}

function openSessionModal(id) {
  if (!state.trSession) return toast("Open a match first", true);
  state._editSessionRow = id || null;
  const s = id ? (state.sessions.find((x) => x.id === id) || {}) : {};
  $("sessionModalTitle").textContent = id ? "Edit Session" : "New Session";
  $("seName").value = s.name || "";
  $("seDate").value = s.session_date ? s.session_date.slice(0, 10) : todayISO();
  // New session in the same match: default the type to the last session's type.
  $("seComm").value = s.commission_type || (id ? "" : lastSessionType());
  openModal("sessionModal");
}

async function doSaveSession() {
  if (!state.trSession) return;
  const name = $("seName").value.trim();
  const session_date = $("seDate").value || todayISO();
  const commission_type = $("seComm").value;
  state._lastSessionCommType = commission_type;    // remember for the next new session in this match
  try {
    let saved;
    if (state._editSessionRow) saved = await api.updateSession(state._editSessionRow, { name, session_date, commission_type });
    else saved = await api.createSession({ match_id: state.trSession.id, name, session_date, commission_type });
    closeModal("sessionModal");
    toast("Session saved");
    if (saved && saved.id) state.srSelectedId = saved.id;
    await renderSessionReport();
    if (state.runSession && saved && saved.id === state.runSession.id) await openSessionRuns(saved.id);
  } catch (err) { toast(err.message, true); }
}

// ===== Session Book: per-client P/L across all DECLARED sessions of the open match =====
// Client P/L = the amount posted to his ledger on declare: -(keep·P)+C  (dummy: -P; booky: -(keep·P)-C).
// + = client won (you pay him),  − = client lost (he owes you). Agent/partner shares are YOUR side (not here).
function clientSessionNet(bets, R, cfgByName, ctypeKey) {
  const byParty = {}, toNorm = {}, toSpecial = {};
  (bets || []).forEach((b) => {
    const key = (b.party_name || "").trim(); if (!key) return;
    byParty[key] = (byParty[key] || 0) + sessionPayoff(b, R);
    if (b.mode === "BD") return;
    const keep = (100 - (Number(((cfgByName[key.toLowerCase()] || {}).self || {}).session) || 0)) / 100;
    const stake = Math.abs(Number(b.amount) || 0) * keep;
    const special = Math.abs((Number(b.rate) || 1) - 1) > 0.0001;
    if (special) toSpecial[key] = (toSpecial[key] || 0) + stake;
    else toNorm[key] = (toNorm[key] || 0) + stake;
  });
  const out = {};
  for (const party in byParty) {
    const P = byParty[party];
    const cfg = cfgByName[party.toLowerCase()] || {};
    const status = String(cfg.status || "").toLowerCase();
    const keep = (100 - (Number((cfg.self || {}).session) || 0)) / 100;
    const cs = cfg.comm_session || {}, cs9 = cfg.comm_session_90110 || {}, csa = cfg.comm_session_agent || {}, csa9 = cfg.comm_session_agent_90110 || {};
    const pct = Number(cs[ctypeKey] || 0), pct90 = Number(cs9[ctypeKey] || 0) || pct;
    const apct = Number(csa[ctypeKey] || 0), apct90 = Number(csa9[ctypeKey] || 0);
    const Ctotal = Math.round(((toNorm[party] || 0) * pct + (toSpecial[party] || 0) * pct90)) / 100;
    const Ca = (status === "booky" || status === "dummy") ? 0 : Math.round(((toNorm[party] || 0) * apct + (toSpecial[party] || 0) * apct90)) / 100;
    const C = Math.round((Ctotal - Ca) * 100) / 100;
    let net;
    if (status === "dummy") net = -P;
    else if (status === "booky") net = -(keep * P) - C;
    else net = -(keep * P) + C;
    out[party] = Math.round(net * 100) / 100;
  }
  return out;
}

let _sbData = null;

async function openSessionBook() {
  if (!state.trSession) return toast("Open a match first", true);
  toast("Building book…");
  let cfgByName = {};
  try { (await api.listParties()).forEach((p) => { cfgByName[(p.name || "").toLowerCase()] = p.config || {}; }); }
  catch (e) { return toast("Could not load parties", true); }
  const declared = (state.sessions || []).filter((s) => String(s.result || "").trim() !== "");
  const data = { sessions: [], bets: {}, net: {}, totals: {}, clientSet: new Set() };
  for (const s of declared) {
    let bets = [];
    try { bets = (await fetchSessionBets(s.id)) || []; } catch (e) {}
    bets = bets.filter((b) => !b.deleted);
    const R = parseInt(s.result, 10);
    // FULL postings (clients + agents + partners) so the book tallies with the Capital line.
    const { post, clients } = sessionPostings(bets, R, cfgByName, (s.commission_type || "").toLowerCase());
    clients.forEach((c) => data.clientSet.add(c));
    data.sessions.push({ id: s.id, name: s.name || "", date: s.session_date, R });
    data.bets[s.id] = bets;
    data.net[s.id] = post;
    for (const party in post) data.totals[party] = Math.round(((data.totals[party] || 0) + post[party]) * 100) / 100;
  }
  _sbData = data;
  openModal("sessionBookModal");
  renderSbLevel1();
}

function sbCell(v) { return `<span class="${v < 0 ? "neg" : (v > 0 ? "pos" : "")}">${num2(v)}</span>`; }

function renderSbLevel1() {
  $("sbTitle").textContent = `Session Book — ${matchLabel(state.trSession)}`;
  const names = _sbData ? Object.keys(_sbData.totals) : [];
  if (!names.length) {
    $("sbBody").innerHTML = `<div class="rpt-empty">No declared sessions yet.</div>`;
    return;
  }
  const clients = names.filter((n) => _sbData.clientSet.has(n)).sort((a, b) => a.localeCompare(b));
  const others = names.filter((n) => !_sbData.clientSet.has(n)).sort((a, b) => a.localeCompare(b));
  const sum = (list) => Math.round(list.reduce((a, n) => a + (_sbData.totals[n] || 0), 0) * 100) / 100;
  const cTot = sum(clients), oTot = sum(others);
  const grand = Math.round((cTot + oTot) * 100) / 100;
  const capital = Math.round(-grand * 100) / 100;   // your take — makes the book tally to 0

  const rowFor = (p, cls) =>
    `<tr class="clk ${cls}" data-party="${esc(p)}"><td>${esc(p)}</td><td class="num">${sbCell(_sbData.totals[p])}</td></tr>`;

  const clientsTbl =
    `<div class="rpt-sub">Clients</div>
     <table class="rpt"><thead><tr><th>Client</th><th class="num">P/L</th></tr></thead>
     <tbody>${clients.length ? clients.map((p) => rowFor(p, "sb-row")).join("") : `<tr><td colspan="2" class="rpt-dash">—</td></tr>`}</tbody>
     <tfoot><tr><td>Clients total</td><td class="num">${sbCell(cTot)}</td></tr></tfoot></table>`;

  const othersTbl = others.length ?
    `<div class="rpt-sub">Agents &amp; Partners</div>
     <table class="rpt"><thead><tr><th>Name</th><th class="num">Share</th></tr></thead>
     <tbody>${others.map((p) => rowFor(p, "sb-orow")).join("")}</tbody>
     <tfoot><tr><td>Agents &amp; partners total</td><td class="num">${sbCell(oTot)}</td></tr></tfoot></table>` : "";

  const capitalTbl =
    `<div class="rpt-sub">Your account (tally)</div>
     <table class="rpt"><tbody>
        <tr><td>Capital — You</td><td class="num">${sbCell(capital)}</td></tr>
       </tbody>
       <tfoot><tr><td>GRAND TOTAL</td><td class="num">${sbCell(Math.round((grand + capital) * 100) / 100)}</td></tr></tfoot></table>`;

  $("sbBody").innerHTML =
    `${clientsTbl}${othersTbl}${capitalTbl}`;
  $("sbBody").querySelectorAll(".sb-row").forEach((tr) =>
    tr.addEventListener("click", () => renderSbLevel2(tr.getAttribute("data-party"), true)));
  $("sbBody").querySelectorAll(".sb-orow").forEach((tr) =>
    tr.addEventListener("click", () => renderSbLevel2(tr.getAttribute("data-party"), false)));
}

function renderSbLevel2(party, isClient) {
  const rows = _sbData.sessions.map((s) => {
    const v = (_sbData.net[s.id] || {})[party];
    if (v === undefined) return "";
    const clk = isClient ? "clk sb-srow" : "";
    return `<tr class="${clk}" data-sid="${s.id}"><td>${esc(s.name || "-")}</td><td>${esc(ddmmyyyy(s.date))}</td><td class="num">${s.R}</td><td class="num">${sbCell(v)}</td></tr>`;
  }).filter(Boolean).join("");
  const subLine = isClient ? "Session-wise P/L" : "Session-wise commission / share";
  $("sbBody").innerHTML =
    `<button class="btn ghost sm" id="sbBack">⟵ All</button>
     <div class="rpt-h">${esc(party)} &nbsp;—&nbsp; ${sbCell(_sbData.totals[party])}</div>
     <div class="rpt-sub">${subLine}</div>
     <table class="rpt"><thead><tr><th>Session</th><th>Date</th><th class="num">Runs</th><th class="num">P/L</th></tr></thead>
     <tbody>${rows || `<tr><td colspan="4" class="rpt-dash">No sessions.</td></tr>`}</tbody>
     <tfoot><tr><td colspan="3">TOTAL</td><td class="num">${sbCell(_sbData.totals[party])}</td></tr></tfoot></table>`;
  $("sbBack").addEventListener("click", renderSbLevel1);
  if (isClient) $("sbBody").querySelectorAll(".sb-srow").forEach((tr) =>
    tr.addEventListener("click", () => renderSbLevel3(party, tr.getAttribute("data-sid"))));
}

function renderSbLevel3(party, sid) {
  const s = _sbData.sessions.find((x) => x.id === sid) || {};
  const bets = (_sbData.bets[sid] || []).filter((b) => (b.party_name || "").trim() === party);
  const rows = bets.map((b) => {
    const pay = sessionPayoff(b, s.R);
    const modeLbl = b.mode === "BD" ? `BD ${b.run}/${b.rate}` : `${b.mode} ${b.run}`;
    const dt = saudaDateTime(b);
    return `<tr><td class="num">${inr(Math.abs(b.amount))}</td><td class="num">${b.mode === "BD" ? "-" : b.rate}</td><td>${esc(modeLbl)}</td><td class="num">${sbCell(Math.round(-pay * 100) / 100)}</td><td>${dt.date}</td><td>${dt.time}</td></tr>`;
  }).join("");
  $("sbBody").innerHTML =
    `<button class="btn ghost sm" id="sbBack2">⟵ ${esc(party)}</button>
     <div class="rpt-h">${esc(party)} — ${esc(s.name || "session")} (runs ${s.R})</div>
     <table class="rpt"><thead><tr><th class="num">Amount</th><th class="num">Rate</th><th>Mode/Run</th><th class="num">Win/Loss</th><th>Date</th><th>Time</th></tr></thead>
     <tbody>${rows || `<tr><td colspan="6" class="rpt-dash">No saudas.</td></tr>`}</tbody></table>`;
  $("sbBack2").addEventListener("click", () => renderSbLevel2(party));
}

// ===== Day Client Report: per-client match + session P/L for a day/range =====
// Client MATCH P/L = his ledger change on declare: -(keep·P)+C (dummy -P; booky -(keep·P)-C).
function clientMatchNet(trades, win, cfgByName) {
  const byParty = {}, turnoverBy = {}, lostStakeBy = {};
  (trades || []).forEach((t) => {
    const key = (t.party_name || "").trim(); if (!key) return;
    const isBooky = String((cfgByName[key.toLowerCase()] || {}).status || "").toLowerCase() === "booky";
    const v = (t.team === win) ? tradeMoney(t) : tradeQty(t);
    byParty[key] = (byParty[key] || 0) + v;
    turnoverBy[key] = (turnoverBy[key] || 0) + Math.abs(Number(t.qty) || 0);
    if (isBooky ? v < 0 : v > 0) lostStakeBy[key] = (lostStakeBy[key] || 0) + Math.abs(v);
  });
  const out = {};
  for (const party in byParty) {
    const P = byParty[party];
    const cfg = cfgByName[party.toLowerCase()] || {};
    const status = String(cfg.status || "").toLowerCase();
    const inc = cfg.inc || {};
    const type = inc.comm_match_type || "";
    const s = Number((cfg.self || {}).match) || 0;
    const keep = (100 - s) / 100;
    const lossBase = (status === "booky") ? (P < 0 ? -P : 0) : (P > 0 ? P : 0);
    const commOn = (pct) => {
      if (!pct) return 0;
      if (type === "losing") return lossBase * keep * pct / 100;
      if (type === "turnover") return (turnoverBy[party] || 0) * keep * pct / 100000;
      if (type === "lostbets") return (lostStakeBy[party] || 0) * keep * pct / 100;
      return 0;
    };
    const C = Math.round((commOn(Number(inc.comm_match) || 0) - (status === "booky" || status === "dummy" ? 0 : commOn(Number(inc.comm_agent) || 0))) * 100) / 100;
    let net;
    if (status === "dummy") net = -P;
    else if (status === "booky") net = -(keep * P) - C;
    else net = -(keep * P) + C;
    out[party] = Math.round(net * 100) / 100;
  }
  return out;
}

// Full per-party postings for a declared MATCH (client + agent commission + agent share +
// partners), mirroring doDeclareMatch/settleClient. Returns {post:{name:amt}, clients:Set}.
function matchPostings(trades, win, cfgByName) {
  const byParty = {}, turnoverBy = {}, lostStakeBy = {};
  (trades || []).forEach((t) => {
    const key = (t.party_name || "").trim(); if (!key) return;
    const isBooky = String((cfgByName[key.toLowerCase()] || {}).status || "").toLowerCase() === "booky";
    const v = (t.team === win) ? tradeMoney(t) : tradeQty(t);
    byParty[key] = (byParty[key] || 0) + v;
    turnoverBy[key] = (turnoverBy[key] || 0) + Math.abs(Number(t.qty) || 0);
    if (isBooky ? v < 0 : v > 0) lostStakeBy[key] = (lostStakeBy[key] || 0) + Math.abs(v);
  });
  const post = {}, clients = new Set();
  const add = (name, v) => { const k = (name || "").trim(); if (!k) return; post[k] = Math.round(((post[k] || 0) + v) * 100) / 100; };
  for (const party in byParty) {
    clients.add(party);
    const P = byParty[party];
    const cfg = cfgByName[party.toLowerCase()] || {};
    const status = String(cfg.status || "").toLowerCase();
    const inc = cfg.inc || {}; const type = inc.comm_match_type || "";
    const s = Number((cfg.self || {}).match) || 0; const keep = (100 - s) / 100;
    const lossBase = (status === "booky") ? (P < 0 ? -P : 0) : (P > 0 ? P : 0);
    const commOn = (pct) => { if (!pct) return 0; if (type === "losing") return lossBase * keep * pct / 100; if (type === "turnover") return (turnoverBy[party] || 0) * keep * pct / 100000; if (type === "lostbets") return (lostStakeBy[party] || 0) * keep * pct / 100; return 0; };
    const Ca = Math.round(commOn(Number(inc.comm_agent) || 0) * 100) / 100;
    const C = Math.round((commOn(Number(inc.comm_match) || 0) - (status === "booky" || status === "dummy" ? 0 : Ca)) * 100) / 100;
    if (status === "dummy") { add(party, -P); continue; }
    if (status === "booky") { add(party, -(keep * P) - C); continue; }
    add(party, -(keep * P) + C);
    let rem = Math.round((keep * P - C) * 100) / 100;
    const agents = cfgAgents(cfg).map((a) => ({ name: (a.name || "").trim(), pct: Number(a.match) || 0 })).filter((a) => a.name);
    if (agents[0] && Ca) { add(agents[0].name, Ca); rem = Math.round((rem - Ca) * 100) / 100; }
    for (const ag of agents) if (ag.pct) { const sh = Math.round(rem * ag.pct / 100 * 100) / 100; add(ag.name, sh); rem = Math.round((rem - sh) * 100) / 100; }
    for (const pt of globalPartners()) { const pp = Number(pt.match) || 0, nm = (pt.name || "").trim(); if (nm && pp) { const ps = Math.round(rem * pp / 100 * 100) / 100; add(nm, ps); rem = Math.round((rem - ps) * 100) / 100; } }
  }
  return { post, clients };
}

// Full per-party postings for a declared SESSION, mirroring doSaveDeclare/settleClient.
function sessionPostings(bets, R, cfgByName, ctypeKey) {
  const byParty = {}, toNorm = {}, toSpecial = {};
  (bets || []).forEach((b) => {
    const key = (b.party_name || "").trim(); if (!key) return;
    byParty[key] = (byParty[key] || 0) + sessionPayoff(b, R);
    if (b.mode === "BD") return;
    const keep = (100 - (Number(((cfgByName[key.toLowerCase()] || {}).self || {}).session) || 0)) / 100;
    const stake = Math.abs(Number(b.amount) || 0) * keep;
    const special = Math.abs((Number(b.rate) || 1) - 1) > 0.0001;
    if (special) toSpecial[key] = (toSpecial[key] || 0) + stake; else toNorm[key] = (toNorm[key] || 0) + stake;
  });
  const post = {}, clients = new Set();
  const add = (name, v) => { const k = (name || "").trim(); if (!k) return; post[k] = Math.round(((post[k] || 0) + v) * 100) / 100; };
  for (const party in byParty) {
    clients.add(party);
    const P = byParty[party];
    const cfg = cfgByName[party.toLowerCase()] || {};
    const status = String(cfg.status || "").toLowerCase();
    const keep = (100 - (Number((cfg.self || {}).session) || 0)) / 100;
    const cs = cfg.comm_session || {}, cs9 = cfg.comm_session_90110 || {}, csa = cfg.comm_session_agent || {}, csa9 = cfg.comm_session_agent_90110 || {};
    const pct = Number(cs[ctypeKey] || 0), pct90 = Number(cs9[ctypeKey] || 0) || pct;
    const apct = Number(csa[ctypeKey] || 0), apct90 = Number(csa9[ctypeKey] || 0);
    const Ctotal = Math.round(((toNorm[party] || 0) * pct + (toSpecial[party] || 0) * pct90)) / 100;
    const Ca = (status === "booky" || status === "dummy") ? 0 : Math.round(((toNorm[party] || 0) * apct + (toSpecial[party] || 0) * apct90)) / 100;
    const C = Math.round((Ctotal - Ca) * 100) / 100;
    if (status === "dummy") { add(party, -P); continue; }
    if (status === "booky") { add(party, -(keep * P) - C); continue; }
    add(party, -(keep * P) + C);
    let rem = Math.round((keep * P - C) * 100) / 100;
    const agents = cfgAgents(cfg).map((a) => ({ name: (a.name || "").trim(), pct: Number(a.session) || 0 })).filter((a) => a.name);
    if (agents[0] && Ca) { add(agents[0].name, Ca); rem = Math.round((rem - Ca) * 100) / 100; }
    for (const ag of agents) if (ag.pct) { const sh = Math.round(rem * ag.pct / 100 * 100) / 100; add(ag.name, sh); rem = Math.round((rem - sh) * 100) / 100; }
    for (const pt of globalPartners()) { const pp = Number(pt.session) || 0, nm = (pt.name || "").trim(); if (nm && pp) { const ps = Math.round(rem * pp / 100 * 100) / 100; add(nm, ps); rem = Math.round((rem - ps) * 100) / 100; } }
  }
  return { post, clients };
}

async function computeDayClient(from, to) {
  const inR = (d) => d && d >= from && d <= to;
  const cfgByName = {};
  (await api.listParties()).forEach((p) => { cfgByName[(p.name || "").toLowerCase()] = p.config || {}; });
  let allMatches = [];
  try { allMatches = await api.listMatches(); } catch (e) {}
  const dayMatches = allMatches.filter((m) => inR((m.trade_date || "").slice(0, 10)) && String(m.result || "").trim() !== "");
  let sessions = [];
  for (const m of allMatches) {
    try { const ss = await api.listSessions(m.id); ss.forEach((s) => { s._match = m; }); sessions.push(...ss); } catch (e) {}
  }
  sessions = sessions.filter((s) => inR((s.session_date || "").slice(0, 10)) && String(s.result || "").trim() !== "");
  const per = {};
  const touch = (p) => (per[p] = per[p] || { match: 0, session: 0, isClient: false, mDet: [], sDet: [] });
  const clientNames = new Set();
  for (const m of dayMatches) {
    const validTeams = (Array.isArray(m.teams) && m.teams.length) ? m.teams : [m.team1, m.team2];
    const win = String(m.result);
    if (!validTeams.map(String).includes(win)) continue;    // abandon / tie → void match, no P/L
    let trades = [];
    try { trades = (await fetchTrades(m.id)).filter((t) => !t.deleted); } catch (e) {}
    const { post, clients } = matchPostings(trades, win, cfgByName);
    clients.forEach((c) => clientNames.add(c));
    for (const name in post) {
      const o = touch(name); o.match = Math.round((o.match + post[name]) * 100) / 100;
      const det = { label: matchLabel(m) + " = " + win, v: post[name] };
      if (clients.has(name)) { det.win = win; det.trades = trades.filter((t) => (t.party_name || "").trim() === name); }
      o.mDet.push(det);
    }
  }
  for (const s of sessions) {
    let bets = [];
    try { bets = (await fetchSessionBets(s.id)).filter((b) => !b.deleted); } catch (e) {}
    const R = parseInt(s.result, 10);
    const { post, clients } = sessionPostings(bets, R, cfgByName, (s.commission_type || "").toLowerCase());
    clients.forEach((c) => clientNames.add(c));
    const ml = s._match ? (matchLabel(s._match) + " · ") : "";
    for (const name in post) {
      const o = touch(name); o.session = Math.round((o.session + post[name]) * 100) / 100;
      const det = { label: ml + (s.name || "session") + " (" + s.result + ")", v: post[name] };
      if (clients.has(name)) { det.R = R; det.bets = bets.filter((b) => (b.party_name || "").trim() === name); }
      o.sDet.push(det);
    }
  }
  for (const name in per) per[name].isClient = clientNames.has(name);
  return per;
}

async function openDayClientReport() {
  showView("dayClient");
  const t = todayISO();
  if ($("dcrFrom") && !$("dcrFrom").value) $("dcrFrom").value = t;
  if ($("dcrTo") && !$("dcrTo").value) $("dcrTo").value = t;
  await runDayClientReport();
}

async function runDayClientReport() {
  const from = $("dcrFrom").value || todayISO(), to = $("dcrTo").value || from;
  if ($("dcrBrand")) $("dcrBrand").textContent = window.__BRAND || BUSINESS_NAME;
  if ($("dcrMeta")) $("dcrMeta").innerHTML = `From : ${ddmmyyyy(from)}<br>To : ${ddmmyyyy(to)}`;
  toast("Building report…");
  let per;
  try { per = await computeDayClient(from, to); } catch (e) { return toast(e.message || "Could not build report", true); }
  state._dcrData = per;
  showClientReport(per, "dcrBody");
}

function dcrCell(v) { return `<span class="${v < 0 ? "neg" : (v > 0 ? "pos" : "")}">${num2(v)}</span>`; }

// ---- Shared client-report renderer (used by Day Client Report AND Full Match Report) ----
let _crData = {};
let _crBodyId = "dcrBody";
function showClientReport(per, bodyId) { _crData = per || {}; _crBodyId = bodyId || "dcrBody"; renderCr1(); }
function crBody() { return $(_crBodyId); }

function renderCr1() {
  const per = _crData || {}; const body = crBody(); if (!body) return;
  const names = Object.keys(per);
  if (!names.length) { body.innerHTML = `<div class="rpt-empty">No declared matches or sessions here.</div>`; return; }
  const clients = names.filter((n) => per[n].isClient).sort((a, b) => a.localeCompare(b));
  const others = names.filter((n) => !per[n].isClient).sort((a, b) => a.localeCompare(b));
  const rowFor = (p) => {
    const o = per[p]; const t = Math.round((o.match + o.session) * 100) / 100;
    return `<tr class="clk cr-row" data-party="${esc(p)}"><td>${esc(p)}</td><td class="num">${dcrCell(o.match)}</td><td class="num">${dcrCell(o.session)}</td><td class="num">${dcrCell(t)}</td></tr>`;
  };
  const sub = (list) => { let m = 0, s = 0; list.forEach((p) => { m += per[p].match; s += per[p].session; }); return { m: Math.round(m * 100) / 100, s: Math.round(s * 100) / 100, t: Math.round((m + s) * 100) / 100 }; };
  const cSub = sub(clients), oSub = sub(others);
  const grand = Math.round((cSub.t + oSub.t) * 100) / 100;
  const capital = Math.round(-grand * 100) / 100;
  const clientsTbl =
    `<div class="rpt-sub">Clients</div>
     <table class="rpt"><thead><tr><th>Client</th><th class="num">Match</th><th class="num">Session</th><th class="num">P/L</th></tr></thead>
       <tbody>${clients.length ? clients.map(rowFor).join("") : `<tr><td colspan="4" class="rpt-dash">—</td></tr>`}</tbody>
       <tfoot><tr><td>Clients total</td><td class="num">${dcrCell(cSub.m)}</td><td class="num">${dcrCell(cSub.s)}</td><td class="num">${dcrCell(cSub.t)}</td></tr></tfoot></table>`;
  const othersTbl = others.length ?
    `<div class="rpt-sub">Agents &amp; Partners (their book)</div>
     <table class="rpt"><thead><tr><th>Name</th><th class="num">Match</th><th class="num">Session</th><th class="num">Book</th></tr></thead>
       <tbody>${others.map(rowFor).join("")}</tbody>
       <tfoot><tr><td>Agents / Partners total</td><td class="num">${dcrCell(oSub.m)}</td><td class="num">${dcrCell(oSub.s)}</td><td class="num">${dcrCell(oSub.t)}</td></tr></tfoot></table>` : "";
  const capTbl =
    `<div class="rpt-sub">Your account (tally)</div>
     <table class="rpt"><tbody>
        <tr><td>Capital — You</td><td class="num">${dcrCell(capital)}</td></tr>
       </tbody>
       <tfoot><tr><td>GRAND TOTAL</td><td class="num">${dcrCell(Math.round((cSub.t + oSub.t + capital) * 100) / 100)}</td></tr></tfoot></table>`;
  body.innerHTML = clientsTbl + othersTbl + capTbl;
  body.querySelectorAll(".cr-row").forEach((tr) =>
    tr.addEventListener("click", () => renderCrDetail(tr.getAttribute("data-party"))));
}

function renderCrDetail(party) {
  const body = crBody(); if (!body) return;
  const o = (_crData || {})[party] || { mDet: [], sDet: [], match: 0, session: 0, isClient: false };
  const line = (cls) => (d, i) => {
    const clk = (cls === "m" ? (d.trades && d.trades.length) : (d.bets && d.bets.length)) ? `clk cr-${cls}` : "";
    return `<tr class="${clk}" data-i="${i}"><td>${esc(d.label)}</td><td class="num">${dcrCell(d.v)}</td></tr>`;
  };
  const mrows = o.mDet.length ? o.mDet.map(line("m")).join("") : `<tr><td colspan="2" class="rpt-dash">—</td></tr>`;
  const srows = o.sDet.length ? o.sDet.map(line("s")).join("") : `<tr><td colspan="2" class="rpt-dash">—</td></tr>`;
  const t = Math.round((o.match + o.session) * 100) / 100;
  const role = o.isClient ? "" : " (agent / partner book)";
  body.innerHTML =
    `<button class="btn ghost sm" id="crBack">⟵ Back</button>
     <div class="rpt-h">${esc(party)}${role} &nbsp;—&nbsp; ${dcrCell(t)}</div>
     <div class="rpt-sub">Matches</div>
     <table class="rpt"><thead><tr><th>Match</th><th class="num">${o.isClient ? "P/L" : "Book"}</th></tr></thead><tbody>${mrows}</tbody>
       <tfoot><tr><td>Match total</td><td class="num">${dcrCell(Math.round(o.match * 100) / 100)}</td></tr></tfoot></table>
     <div class="rpt-sub">Sessions</div>
     <table class="rpt"><thead><tr><th>Session</th><th class="num">${o.isClient ? "P/L" : "Book"}</th></tr></thead><tbody>${srows}</tbody>
       <tfoot><tr><td>Session total</td><td class="num">${dcrCell(Math.round(o.session * 100) / 100)}</td></tr></tfoot></table>`;
  $("crBack").addEventListener("click", renderCr1);
  body.querySelectorAll(".cr-m").forEach((tr) =>
    tr.addEventListener("click", () => renderCrSaudas(party, "match", Number(tr.getAttribute("data-i")))));
  body.querySelectorAll(".cr-s").forEach((tr) =>
    tr.addEventListener("click", () => renderCrSaudas(party, "session", Number(tr.getAttribute("data-i")))));
}

function renderCrSaudas(party, kind, i) {
  const body = crBody(); if (!body) return;
  const o = (_crData || {})[party] || {};
  const d = ((kind === "match") ? o.mDet : o.sDet)[i];
  if (!d) return;
  let head, rows;
  if (kind === "match") {
    head = `<tr><th class="num">Amount</th><th class="num">Rate</th><th>Team</th><th>Mode</th><th class="num">Win/Loss</th><th>Date</th><th>Time</th></tr>`;
    rows = (d.trades || []).map((t) => {
      const v = (t.team === d.win) ? tradeMoney(t) : tradeQty(t);
      const dt = saudaDateTime(t);
      return `<tr><td class="num">${inr(Math.abs(t.qty))}</td><td class="num">${t.rate}</td><td>${esc(t.team)}</td><td>${esc(t.mode)}</td><td class="num">${dcrCell(Math.round(-v * 100) / 100)}</td><td>${dt.date}</td><td>${dt.time}</td></tr>`;
    }).join("");
  } else {
    head = `<tr><th class="num">Amount</th><th class="num">Rate</th><th class="num">Run</th><th>Mode</th><th class="num">Win/Loss</th><th>Date</th><th>Time</th></tr>`;
    rows = (d.bets || []).map((b) => {
      const pay = sessionPayoff(b, d.R);
      const dt = saudaDateTime(b);
      return `<tr><td class="num">${inr(Math.abs(b.amount))}</td><td class="num">${b.mode === "BD" ? "-" : b.rate}</td><td class="num">${b.run}</td><td>${esc(b.mode)}</td><td class="num">${dcrCell(Math.round(-pay * 100) / 100)}</td><td>${dt.date}</td><td>${dt.time}</td></tr>`;
    }).join("");
  }
  body.innerHTML =
    `<button class="btn ghost sm" id="crBack2">⟵ ${esc(party)}</button>
     <div class="rpt-h">${esc(d.label)}</div>
     <div class="rpt-sub">${esc(party)} saudas — settled P/L ${dcrCell(d.v)}</div>
     <table class="rpt"><thead>${head}</thead><tbody>${rows || `<tr><td colspan="7" class="rpt-dash">No saudas.</td></tr>`}</tbody></table>`;
  $("crBack2").addEventListener("click", () => renderCrDetail(party));
}

// ===== Full Match Report: pick a declared match → its client report (clients + agents + capital) =====
async function computeMatchClient(matchId) {
  const cfgByName = {};
  (await api.listParties()).forEach((p) => { cfgByName[(p.name || "").toLowerCase()] = p.config || {}; });
  const m = (state._mcrMatches || []).find((x) => x.id === matchId);
  if (!m) return {};
  const per = {};
  const touch = (p) => (per[p] = per[p] || { match: 0, session: 0, isClient: false, mDet: [], sDet: [] });
  const clientNames = new Set();
  const validTeams = (Array.isArray(m.teams) && m.teams.length) ? m.teams : [m.team1, m.team2];
  const win = String(m.result);
  if (String(m.result || "").trim() && validTeams.map(String).includes(win)) {
    let trades = [];
    try { trades = (await fetchTrades(m.id)).filter((t) => !t.deleted); } catch (e) {}
    const { post, clients } = matchPostings(trades, win, cfgByName);
    clients.forEach((c) => clientNames.add(c));
    for (const name in post) {
      const o = touch(name); o.match = Math.round((o.match + post[name]) * 100) / 100;
      const det = { label: matchLabel(m) + " = " + win, v: post[name] };
      if (clients.has(name)) { det.win = win; det.trades = trades.filter((t) => (t.party_name || "").trim() === name); }
      o.mDet.push(det);
    }
  }
  let sessions = [];
  try { sessions = (await api.listSessions(m.id)).filter((s) => String(s.result || "").trim() !== ""); } catch (e) {}
  for (const s of sessions) {
    let bets = [];
    try { bets = (await fetchSessionBets(s.id)).filter((b) => !b.deleted); } catch (e) {}
    const R = parseInt(s.result, 10);
    const { post, clients } = sessionPostings(bets, R, cfgByName, (s.commission_type || "").toLowerCase());
    clients.forEach((c) => clientNames.add(c));
    for (const name in post) {
      const o = touch(name); o.session = Math.round((o.session + post[name]) * 100) / 100;
      const det = { label: (s.name || "session") + " (" + s.result + ")", v: post[name] };
      if (clients.has(name)) { det.R = R; det.bets = bets.filter((b) => (b.party_name || "").trim() === name); }
      o.sDet.push(det);
    }
  }
  for (const name in per) per[name].isClient = clientNames.has(name);
  return per;
}

async function openMatchReport() {
  showView("matchClient");
  if ($("mcrBrand")) $("mcrBrand").textContent = window.__BRAND || BUSINESS_NAME;
  let matches = [];
  try { matches = await api.listMatches(); } catch (e) {}
  matches = (matches || []).filter((m) => String(m.result || "").trim() !== "");   // declared only
  matches.sort((a, b) => String(b.created_at || b.trade_date || "").localeCompare(String(a.created_at || a.trade_date || "")));
  state._mcrMatches = matches;
  const sel = $("mcrMatch");
  if (sel) sel.innerHTML = matches.length
    ? matches.map((m) => `<option value="${m.id}">${esc(matchLabel(m))} · ${esc(ddmmyyyy(m.trade_date))} = ${esc(m.result)}</option>`).join("")
    : `<option value="">No declared matches</option>`;
  if (matches.length) { if (sel) sel.value = matches[0].id; await runMatchReport(matches[0].id); }
  else if ($("mcrBody")) $("mcrBody").innerHTML = `<div class="rpt-empty">No declared matches yet.</div>`;
}

async function runMatchReport(matchId) {
  if (!matchId) return;
  const m = (state._mcrMatches || []).find((x) => x.id === matchId);
  if ($("mcrMeta")) $("mcrMeta").innerHTML = m ? `Match : ${esc(matchLabel(m))}<br>Date : ${ddmmyyyy(m.trade_date)}<br>Result : ${esc(m.result)}` : "";
  toast("Building report…");
  let per;
  try { per = await computeMatchClient(matchId); } catch (e) { return toast(e.message || "Could not build report", true); }
  state._mcrData = per;
  showClientReport(per, "mcrBody");
}

function shareClientReportWhatsApp(title) {
  const per = _crData || {};
  const names = Object.keys(per).sort((a, b) => a.localeCompare(b));
  if (!names.length) return toast("Nothing to share — press Show first.", true);
  const brand = window.__BRAND || BUSINESS_NAME;
  const L = [`*${brand}*`, title || "Client Report", ""];
  names.forEach((p) => { const o = per[p]; const t = Math.round((o.match + o.session) * 100) / 100; L.push(`${p} : ${inr(t)}  (M ${inr(o.match)} / S ${inr(o.session)})`); });
  shareTextToWhatsApp(L.join("\n"));
}
function shareDayClientWhatsApp() {
  const from = $("dcrFrom").value, to = $("dcrTo").value;
  shareClientReportWhatsApp(`Client Report — ${ddmmyyyy(from)}${to !== from ? (" to " + ddmmyyyy(to)) : ""}`);
}
function shareMatchReportWhatsApp() {
  const sel = $("mcrMatch");
  const m = (state._mcrMatches || []).find((x) => x.id === (sel && sel.value));
  shareClientReportWhatsApp(m ? `Match Report — ${matchLabel(m)} = ${m.result}` : "Match Report");
}

async function doDeleteSession(id) {
  if (!(await confirmAsk("Delete this session and all its run bets? This cannot be undone.", "Delete session"))) return;
  try {
    await api.deleteSession(id);
    toast("Session deleted");
    if (state.runSession && state.runSession.id === id) backToSessions();
    else await renderSessionReport();
  } catch (err) { toast(err.message, true); }
}

// ================= REPORTS (Hawala / Find Sauda) =================
// Hide every report sub-screen so only one shows at a time.
function hideAllReportSubs() {
  ["reportsHome", "partyReportView", "typeReportView", "hawalaView2", "findSaudaView", "allSessionsView"]
    .forEach((id) => { const el = $(id); if (el) el.style.display = "none"; });
}

// ---- All Sessions report (every session across every match) ----
async function openAllSessionsReport() {
  hideAllReportSubs();
  $("allSessionsView").style.display = "";
  await renderAllSessions();
}
async function renderAllSessions() {
  let matches; try { matches = await api.listMatches(); } catch (e) { return toast(e.message, true); }
  const list = [];
  for (const m of matches) { try { (await api.listSessions(m.id)).forEach((s) => list.push({ s, m })); } catch (e) {} }
  list.sort((a, b) => String(b.s.session_date).localeCompare(String(a.s.session_date)) || String(b.s.created_at || "").localeCompare(String(a.s.created_at || "")));
  state._allSessions = list;
  $("asBody").innerHTML = list.length ? list.map(({ s, m }) => {
    const declared = String(s.result || "").trim() !== "";
    const sel = s.id === state._asSelId ? "sel" : "";
    return `<tr data-sid="${s.id}" data-mid="${m.id}" class="${sel}">
      <td><b>${ddmmyyyy(s.session_date)}</b></td>
      <td>${esc(matchLabel(m))}</td>
      <td>${esc(s.name) || "-"}</td>
      <td class="num">${declared ? `<span class="as-decl">Declared @ ${esc(s.result)}</span>` : ''}</td></tr>`;
  }).join("") : `<tr><td colspan="4" class="muted" style="text-align:center;padding:16px">No sessions yet.</td></tr>`;
  $("asCount").textContent = `${list.length} ${list.length === 1 ? "session" : "sessions"}`;
  $("asBody").querySelectorAll("tr[data-sid]").forEach((tr) => {
    tr.addEventListener("click", () => {
      state._asSelId = tr.getAttribute("data-sid");
      $("asBody").querySelectorAll("tr").forEach((r) => r.classList.remove("sel"));
      tr.classList.add("sel");
      renderAsEntries(state._asSelId);   // show this session's entries at once
    });
    tr.addEventListener("dblclick", () => openSessionFromAll(tr.getAttribute("data-sid"), tr.getAttribute("data-mid")));
  });
  if ($("asEntries")) $("asEntries").innerHTML = "";
  if (state._asSelId && list.some((x) => x.s.id === state._asSelId)) renderAsEntries(state._asSelId);
}

async function renderAsEntries(sid, party) {
  const box = $("asEntries"); if (!box) return;
  const row = (state._allSessions || []).find((x) => x.s.id === sid);
  if (!row) { box.innerHTML = ""; return; }
  let bets = []; try { bets = await fetchSessionBets(sid); } catch (e) {}
  bets = bets.filter((b) => !b.deleted);
  if (party) bets = bets.filter((b) => (b.party_name || "").trim().toLowerCase() === party.toLowerCase());
  const declNote = String(row.s.result || "").trim() ? ` · declared @ ${esc(row.s.result)}` : "";
  const head = party
    ? `<div class="as-ent-h"><span class="as-back" data-asback="1">← all entries</span> · <b>${esc(party)}</b>'s bets in ${esc(row.s.name)} <span class="muted">(${bets.length})</span></div>`
    : `<div class="as-ent-h">Entries — <b>${esc(row.s.name) || ""}</b> <span class="muted">· ${esc(matchLabel(row.m))}${declNote} · tap a row to see that party's bets</span></div>`;
  if (!bets.length) { box.innerHTML = head + `<div class="muted" style="padding:10px 2px">No entries in this session yet.</div>`; return; }
  const sorted = bets.slice().sort(byNewest);
  const rows = sorted.map((b, i) => {
    const A = Number(b.amount), r = Number(b.rate);
    const yes = b.mode === "L" ? -A * r : A * r;   // runs reach the line
    const no = b.mode === "L" ? A : -A;            // runs stay below
    const clk = party ? "" : ` class="as-ent-row" data-party="${esc(b.party_name || "")}"`;
    return `<tr${clk}><td>${sorted.length - i}</td><td class="num">${num2(b.amount)}</td><td class="num">${Number(b.run)}</td>
      <td class="num">${Number(b.rate)}</td><td>${b.mode}</td><td class="pname">${esc(b.party_name) || "-"}</td>
      <td class="num ${yes < 0 ? "neg" : "pos"}">${num2(yes)}</td><td class="num ${no < 0 ? "neg" : "pos"}">${num2(no)}</td></tr>`;
  }).join("");
  const totAmt = bets.reduce((s, b) => s + Math.abs(Number(b.amount) || 0), 0);
  const totRow = party
    ? `<tr class="total-row"><td><b>Total</b></td><td class="num"><b>${num2(totAmt)}</b></td><td colspan="6"></td></tr>`
    : "";
  box.innerHTML = head + `<div class="tr-scroll"><table class="mini fx-table"><thead><tr>
    <th>Sr</th><th class="num">Amount</th><th class="num">Run</th><th class="num">Rate</th><th>Mode</th><th>Party</th><th class="num">Yes</th><th class="num">No</th>
  </tr></thead><tbody>${rows}${totRow}</tbody></table></div>`;
  // drill: click a row → that party's bets; back link → all entries
  box.querySelectorAll(".as-ent-row").forEach((tr) =>
    tr.addEventListener("click", () => renderAsEntries(sid, tr.getAttribute("data-party"))));
  const back = box.querySelector("[data-asback]");
  if (back) back.addEventListener("click", () => renderAsEntries(sid, null));
}
async function openSessionFromAll(sid, mid) {
  sid = sid || state._asSelId;
  if (!sid) return toast("Tap a session first", true);
  const row = (state._allSessions || []).find((x) => x.s.id === sid);
  mid = mid || (row && row.m.id);
  if (!mid) return;
  await openMatch(mid);          // sets trSession + shows trading
  await renderSessionReport();   // loads state.sessions for this match
  state.srSelectedId = sid;
  await openSessionRuns(sid);
}

function showReportsHome() {
  hideAllReportSubs();
  $("reportsHome").style.display = "";
}

// ---- Type-wise report (Cup / Toss / Settlement) ----
async function openTypeReport(type, title) {
  hideAllReportSubs();
  $("typeReportView").style.display = "";
  $("tyTitle").textContent = title || "Settlement Report";
  $("tyType").value = type || "";
  await renderTypeReport();
}

async function renderTypeReport() {
  const want = ($("tyType").value || "").trim().toUpperCase();
  let matches;
  try { matches = await api.listMatches(); } catch (err) { return toast(err.message, true); }
  if (want) matches = matches.filter((m) => (m.type || "").trim().toUpperCase() === want);
  let grand = 0;
  const byParty = {};
  const rows = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    let sessions = [];
    try { sessions = await api.listSessions(m.id); } catch (e) {}
    let pl = 0;      // book P&L = sum of declared sessions' NP
    for (const s of sessions) {
      if (s.result === "" || s.result == null) continue;
      const R = parseInt(s.result, 10); if (!(R >= 0)) continue;
      let bets = [];
      try { bets = (await fetchSessionBets(s.id)).filter((b) => !b.deleted); } catch (e) {}
      bets.forEach((b) => {
        const p = sessionPayoff(b, R);
        pl += p;                                   // book keeps +payoff
        const key = (b.party_name || "").trim();
        if (key) byParty[key] = (byParty[key] || 0) - p;   // client settles −payoff
      });
    }
    grand += pl;
    rows.push(`<tr><td>${matches.length - i}</td><td>${ddmmyyyy(m.trade_date)}</td>
      <td>${esc(m.name) || "-"}</td><td>${esc(m.type) || "-"}</td>
      <td>${s_or_dash(m.result)}</td>
      <td class="num ${pl < 0 ? "neg" : pl > 0 ? "pos" : ""}">${inr(pl)}</td></tr>`);
  }
  $("tyMatches").innerHTML = rows.length ? rows.join("")
    : `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">No matches of this type.</td></tr>`;
  $("tyTotal").innerHTML = inr(grand);
  $("tyTotal").className = "num " + (grand < 0 ? "neg" : grand > 0 ? "pos" : "");
  const parties = Object.entries(byParty).filter(([, v]) => Math.abs(v) >= 0.005)
    .sort((a, b) => b[1] - a[1]);
  $("tyParties").innerHTML = parties.length
    ? parties.map(([n, v]) => `<tr><td>${esc(n)}</td>
        <td class="num ${v < 0 ? "neg" : v > 0 ? "pos" : ""}">${inr(v)}</td></tr>`).join("")
    : `<tr><td colspan="2" class="muted" style="text-align:center;padding:16px">No declared sessions.</td></tr>`;
}
function s_or_dash(v) { return (v === "" || v == null) ? "-" : esc(String(v)); }

// ---- Party Report (party master list — matches the old app's grid) ----
async function openPartyReport() {
  hideAllReportSubs();
  $("partyReportView").style.display = "";
  state.prSelectedId = null;
  await renderPartyReport();
}

async function renderPartyReport() {
  let parties = [];
  try { parties = await api.listParties($("prSearch").value || ""); } catch (e) { return toast(e.message, true); }
  state._prParties = parties;
  $("prBody").innerHTML = parties.length ? parties.map((p) => {
    const c = p.config || {};
    const ag = cfgAgents(c)[0] || {}, inc = c.inc || {};
    const ps = globalPartners();
    const sel = p.id === state.prSelectedId ? " sel" : "";
    return `<tr data-id="${p.id}" class="${sel}">
      <td class="pname">${esc(p.name)}</td>
      <td>${esc(c.dhara) || "-"}</td>
      <td>${esc(c.status) || "Regular"}</td>
      <td class="num">${num2(c.balance_limit || 0)}</td>
      <td class="num">${num2((inc.comm_match) || 0)}</td>
      <td>${esc(ag.name) || ""}</td>
      <td class="num">${num2(ag.match || ag.session || 0)}</td>
      <td>${ps.map((x) => esc(x.name)).join(", ")}</td>
      <td class="num">${ps.length ? "global" : ""}</td></tr>`;
  }).join("")
    : `<tr><td colspan="9" class="muted" style="text-align:center;padding:16px">No parties.</td></tr>`;
  $("prCount").textContent = `${parties.length} ${parties.length === 1 ? "party" : "parties"}`;
  $("prBody").querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => {
      state.prSelectedId = tr.getAttribute("data-id");
      $("prBody").querySelectorAll("tr").forEach((r) => r.classList.remove("sel"));
      tr.classList.add("sel");
    }));
}

async function prModifySelected() {
  if (!state.prSelectedId) return toast("Tap a party first", true);
  await editParty(state.prSelectedId);
}

async function prDeleteSelected() {
  if (!state.prSelectedId) return toast("Tap a party first", true);
  const p = (state._prParties || []).find((x) => x.id === state.prSelectedId);
  if (p && p.is_capital) return toast("Can't delete the capital account", true);
  try { await api.deleteParty(state.prSelectedId); } catch (e) { return toast(e.message, true); }
  state.prSelectedId = null;
  await renderPartyReport();
  refreshParties && refreshParties();
}

async function openHawala() {
  hideAllReportSubs();
  $("hawalaView2").style.display = "";
  if (!$("hwDate").value) $("hwDate").value = todayISO();
  await renderHawala();
}

async function renderHawala() {
  let rows;
  try { rows = await api.listHawala($("hwDate").value || null); }
  catch (err) { return toast(err.message, true); }
  $("hwBody").innerHTML = rows.length
    ? rows.map((r, i) => `<tr><td>${i + 1}</td><td>${ddmmyyyy(r.date)}</td>
        <td>${esc(r.jama) || "-"}</td><td class="num">${inr(r.amount)}</td>
        <td>${esc(r.nave) || "-"}</td><td>${esc(r.remark) || ""}</td></tr>`).join("")
    : `<tr><td colspan="6" class="muted" style="text-align:center;padding:16px">No hawala entries on this date.</td></tr>`;
}

// ---- Find Sauda Entry (search bets) ----
async function openFindSauda() {
  hideAllReportSubs();
  $("findSaudaView").style.display = "";
  $("fsResults").innerHTML = "";
  let matches;
  try { matches = await api.listMatches(); } catch (err) { return toast(err.message, true); }
  state._fsMatches = matches;
  $("fsMatches").innerHTML = matches.length
    ? matches.map((m, i) => `<tr data-id="${m.id}"><td>${matches.length - i}</td><td>${ddmmyyyy(m.trade_date)}</td>
        <td>${esc(m.team1) || "-"}</td><td>${esc(m.team2) || "-"}</td><td>${esc(m.type) || "-"}</td>
        <td>${esc(m.result) || ""}</td></tr>`).join("")
    : `<tr><td colspan="6" class="muted" style="text-align:center;padding:14px">No matches.</td></tr>`;
  state._fsSelMatch = null;
  if ($("fsSessionSelect")) $("fsSessionSelect").innerHTML = '<option value="">— session —</option>';
  $("fsMatches").querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", async () => {
      state._fsSelMatch = tr.getAttribute("data-id");
      $("fsMatches").querySelectorAll("tr").forEach((r) => r.classList.remove("sel"));
      tr.classList.add("sel");
      // load this match's sessions into the SELECT ALL SESSIONS dropdown
      if ($("fsSessionSelect")) {
        let ss = []; try { ss = await api.listSessions(state._fsSelMatch); } catch (e) {}
        $("fsSessionSelect").innerHTML = '<option value="">— session —</option>' +
          ss.map((s) => `<option value="${s.id}">${esc(s.name) || "-"}</option>`).join("");
      }
    }));
}

function fsMatchName(id) {
  const m = (state._fsMatches || []).find((x) => x.id === id);
  return m ? matchLabel(m) : "";
}

function fsCheckedField(group) {
  const el = document.querySelector(`input[name="${group}"]:checked`);
  return el ? el.value : "name";
}
async function fsSearchMatch() {
  const matches = state._fsMatches || [];
  const list = state._fsSelMatch ? matches.filter((m) => m.id === state._fsSelMatch) : matches;
  const field = fsCheckedField("fsmField");            // only the ticked criterion filters
  const party = $("fsmParty").value.trim().toLowerCase();
  const amount = parseFloat($("fsmAmount").value);
  const rate = $("fsmRate").value.trim();
  const team = $("fsmTeam").value.trim().toLowerCase();
  const keep = (t) => {
    if (field === "name") return !party || (t.party_name || "").toLowerCase().includes(party);
    if (field === "amount") return !(amount > 0) || Number(t.qty) === amount;
    if (field === "rate") return !rate || String(t.rate) === rate || Number(t.rate) === Number(rate);
    if (field === "team") return !team || (t.team || "").toLowerCase().includes(team);
    return true;
  };
  const out = [];
  for (const m of list) {
    const teams = (Array.isArray(m.teams) && m.teams.length) ? m.teams : [m.team1, m.team2].filter(Boolean);
    let trades; try { trades = await fetchTrades(m.id); } catch (e) { trades = []; }
    const all = trades.slice().sort(byNewest);                 // same ordering as the match screen
    const serialOf = {}; all.forEach((t, idx) => { serialOf[t.id] = all.length - idx; });   // oldest = 1
    all.filter((t) => !t.deleted && keep(t)).forEach((t) => {
      // money on the favorite (bet) team, qty on the others — the match GT distribution
      const cols = teams.map((tm) => (tm === t.team ? tradeMoney(t) : tradeQty(t)));
      out.push({ sr: serialOf[t.id], party: t.party_name, amount: t.qty, rate: t.rate, mode: t.mode, fav: t.team, teams, cols });
    });
  }
  state._fsTeams = list.length === 1 ? ((Array.isArray(list[0].teams) && list[0].teams.length) ? list[0].teams : [list[0].team1, list[0].team2].filter(Boolean)) : (out[0] ? out[0].teams : []);
  renderFsResults(out, "match");
}

async function fsSearchSession() {
  const matches = state._fsMatches || [];
  const list = state._fsSelMatch ? matches.filter((m) => m.id === state._fsSelMatch) : matches;
  const field = fsCheckedField("fssField");            // only the ticked criterion filters
  const party = $("fssParty").value.trim().toLowerCase();
  const amount = parseFloat($("fssAmount").value);
  const rate = $("fssRate").value.trim();
  const run = $("fssRun").value.trim();
  const keep = (b) => {
    if (field === "name") return !party || (b.party_name || "").toLowerCase().includes(party);
    if (field === "amount") return !(amount > 0) || Number(b.amount) === amount;
    if (field === "rate") return !rate || String(b.rate) === rate || Number(b.rate) === Number(rate);
    if (field === "run") return !run || String(b.run) === run;
    return true;
  };
  const pickSid = (!$("fsAllSessions") || !$("fsAllSessions").checked) && $("fsSessionSelect") ? $("fsSessionSelect").value : "";
  const out = [];
  for (const m of list) {
    let sessions; try { sessions = await api.listSessions(m.id); } catch (e) { sessions = []; }
    if (pickSid) sessions = sessions.filter((s) => s.id === pickSid);   // one chosen session, unless SELECT ALL
    for (const s of sessions) {
      let bets; try { bets = await fetchSessionBets(s.id); } catch (e) { bets = []; }
      const all = bets.slice().sort(byNewest);                 // same ordering as the session screen
      const serialOf = {}; all.forEach((b, idx) => { serialOf[b.id] = all.length - idx; });   // oldest = 1
      all.filter((b) => !b.deleted && keep(b)).forEach((b) => {
        const A = Number(b.amount), r = Number(b.rate);
        const yes = b.mode === "L" ? -A * r : A * r;   // runs reach the line
        const no = b.mode === "L" ? A : -A;            // runs stay below
        out.push({ sr: serialOf[b.id], party: b.party_name, amount: b.amount, rate: b.rate, mode: b.mode, run: b.run, cols: [yes, no] });
      });
    }
  }
  renderFsResults(out, "session");
}

function renderFsResults(rows, mode) {
  const numc = (v) => `<td class="num ${v < 0 ? "neg" : (v > 0 ? "pos" : "")}">${num2(v)}</td>`;
  if (mode === "session") {
    $("fsResHead").innerHTML = `<tr><th>Sr_No</th><th class="num">Amount</th><th class="num">Rate</th>
      <th class="num">Run</th><th>Mode</th><th>Party Name</th><th class="num">Yes</th><th class="num">No</th></tr>`;
    $("fsResults").innerHTML = rows.length
      ? rows.map((r) => `<tr><td>${r.sr}</td><td class="num">${num2(r.amount)}</td><td class="num">${Number(r.rate)}</td>
          <td class="num">${esc(String(r.run))}</td><td>${r.mode}</td><td class="pname">${esc(r.party) || "-"}</td>
          ${numc(r.cols[0])}${numc(r.cols[1])}</tr>`).join("")
      : `<tr><td colspan="8" class="muted" style="text-align:center;padding:14px">No matching bets.</td></tr>`;
    return;
  }
  // match: Sr_No, Amount, Rate, Fovrt, Mode, Party Name, <team columns>
  const teams = state._fsTeams || (rows[0] ? rows[0].teams : []);
  const teamHead = teams.map((t) => `<th class="num">${esc(t)}</th>`).join("");
  $("fsResHead").innerHTML = `<tr><th>Sr_No</th><th class="num">Amount</th><th class="num">Rate</th>
    <th>Fovrt</th><th>Mode</th><th>Party Name</th>${teamHead}</tr>`;
  $("fsResults").innerHTML = rows.length
    ? rows.map((r) => `<tr><td>${r.sr}</td><td class="num">${num2(r.amount)}</td><td class="num">${Number(r.rate)}</td>
        <td><b>${esc(r.fav) || "-"}</b></td><td>${r.mode}</td><td class="pname">${esc(r.party) || "-"}</td>
        ${teams.map((_, k) => numc(r.cols[k])).join("")}</tr>`).join("")
    : `<tr><td colspan="${6 + Math.max(teams.length, 1)}" class="muted" style="text-align:center;padding:14px">No matching bets.</td></tr>`;
}

// ---- Connect Report (tally with clients) ----
function showConnect() {
  $("matchReport").style.display = "none";
  $("trDetail").style.display = "none";
  $("connectView").style.display = "";
  const t = todayISO();
  if (!$("cnFrom").value) $("cnFrom").value = t;
  if (!$("cnTo").value) $("cnTo").value = t;
  $("cnMatches").innerHTML = `<tr><td colspan="5" class="muted" style="text-align:center;padding:14px">Loading…</td></tr>`;
  $("cnSessions").innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:14px"></td></tr>`;
  $("cnTx").innerHTML = `<tr><td colspan="3" class="muted" style="text-align:center;padding:14px"></td></tr>`;
  runConnect();   // auto-load so declared results show at once (Connect button re-runs after filter changes)
}

// Connect = two steps: list the matches/sessions (each with a tick box), then
// tally the Transactions from only the TICKED rows. Ticking a row recomputes live.
async function runConnect() {
  const useDate = $("cnDate").checked;
  const from = $("cnFrom").value, to = $("cnTo").value;
  const inRange = (d) => !useDate || ((!from || d >= from) && (!to || d <= to));
  const declared = (x) => String(x.result || "").trim() !== "";   // only declared items appear
  let allMatches;
  try { allMatches = await api.listMatches(); } catch (e) { return toast(e.message, true); }
  allMatches = allMatches.filter((m) => inRange((m.trade_date || "").slice(0, 10)));
  // gather sessions from every in-range match, then keep only declared ones
  let sessions = [];
  for (const m of allMatches) {
    try { const ss = await api.listSessions(m.id); ss.forEach((s) => { s._match = m; }); sessions.push(...ss); }
    catch (e) { /* skip */ }
  }
  sessions = sessions.filter((s) => declared(s) && inRange((s.session_date || "").slice(0, 10)));
  const matches = allMatches.filter(declared);   // the Matches list shows declared matches only
  // cache each one's trades/bets so toggling a tick box is instant
  const data = { matches: [], sessions: [] };
  for (const m of matches) { let tr = []; try { tr = await fetchTrades(m.id); } catch (e) {} data.matches.push({ m, trades: tr.filter((t) => !t.deleted) }); }
  for (const s of sessions) { let b = []; try { b = await fetchSessionBets(s.id); } catch (e) {} data.sessions.push({ s, bets: b.filter((x) => !x.deleted) }); }
  state._cnData = data;
  const prev = state._cnChecked || { matches: {}, sessions: {} };
  const ckM = (id) => (id in prev.matches) ? prev.matches[id] : true;
  const ckS = (id) => (id in prev.sessions) ? prev.sessions[id] : true;
  $("cnMatches").innerHTML = matches.length
    ? matches.map((m, i) => `<tr><td><input type="checkbox" class="cn-ck" data-mid="${m.id}" ${ckM(m.id) ? "checked" : ""}></td>
        <td>${i + 1}</td><td>${ddmmyyyy(m.trade_date)}</td><td>${esc(matchLabel(m))}</td><td>${esc(m.type) || "-"}</td><td class="num">${esc(m.result) || ""}</td></tr>`).join("")
    : `<tr><td colspan="6" class="muted" style="text-align:center;padding:14px">No matches in range.</td></tr>`;
  $("cnSessions").innerHTML = sessions.length
    ? sessions.map((s, i) => `<tr><td><input type="checkbox" class="cn-ck" data-sid="${s.id}" ${ckS(s.id) ? "checked" : ""}></td>
        <td>${i + 1}</td><td>${ddmmyyyy(s.session_date)}</td><td>${esc(s.name) || "-"}</td><td class="num">${esc(s.result) || ""}</td></tr>`).join("")
    : `<tr><td colspan="5" class="muted" style="text-align:center;padding:14px">No sessions in range.</td></tr>`;
  computeConnectTx();
}

function readCnChecked() {
  const c = { matches: {}, sessions: {} };
  $("cnMatches").querySelectorAll("input[data-mid]").forEach((el) => { c.matches[el.getAttribute("data-mid")] = el.checked; });
  $("cnSessions").querySelectorAll("input[data-sid]").forEach((el) => { c.sessions[el.getAttribute("data-sid")] = el.checked; });
  state._cnChecked = c;
  return c;
}

function computeConnectTx() {
  const data = state._cnData || { matches: [], sessions: [] };
  const checked = readCnChecked();
  const useMatch = $("cnMatch").checked, useSession = $("cnSession").checked;
  const amt = {};
  const add = (party, v) => { const k = (party || "").trim(); if (!k) return; amt[k] = (amt[k] || 0) + v; };
  if (useSession) data.sessions.forEach(({ s, bets }) => {
    if (!checked.sessions[s.id]) return;
    if (!String(s.result || "").trim()) return;      // only declared sessions settle
    const R = parseInt(s.result, 10);
    bets.forEach((b) => add(b.party_name, -sessionPayoff(b, R)));
  });
  if (useMatch) data.matches.forEach(({ m, trades }) => {
    if (!checked.matches[m.id]) return;
    trades.forEach((t) => add(t.party_name, tradeMoney(t)));
  });
  state._cnTx = amt;
  const names = Object.keys(amt).sort((a, b) => a.localeCompare(b));
  const PAIRS = 3;   // Name/Amount pairs per row (reference flows several across)
  const cell = (nm) => {
    if (nm == null) return `<td></td><td class="num"></td>`;
    const v = amt[nm];
    return `<td>${esc(nm)}</td><td class="num ${v < 0 ? "bal-neg" : "bal-pos"}">${num2(v)}</td>`;
  };
  let rows = "";
  for (let i = 0; i < names.length; i += PAIRS) {
    let r = "";
    for (let k = 0; k < PAIRS; k++) r += cell(names[i + k] != null ? names[i + k] : null);
    rows += `<tr>${r}</tr>`;
  }
  const tot = names.reduce((s, n) => s + amt[n], 0);
  $("cnTx").innerHTML = names.length
    ? rows + `<tr class="total-row"><td><b>Total</b></td><td class="num"><b>${num2(tot)}</b></td><td colspan="${PAIRS * 2 - 2}"></td></tr>`
    : `<tr><td colspan="${PAIRS * 2}" class="muted" style="text-align:center;padding:14px">No transactions — tick a declared session/match.</td></tr>`;
}

function printConnect() {
  const amt = state._cnTx || {};
  const names = Object.keys(amt).sort((a, b) => a.localeCompare(b));
  if (!names.length) return toast("Nothing to print — press Connect first.", true);
  if (!(window.jspdf && window.jspdf.jsPDF)) { window.print(); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let tot = 0;
  const body = names.map((nm) => { tot += amt[nm]; return [nm, num2(amt[nm])]; });
  doc.setFontSize(15); doc.setTextColor(31, 78, 95); doc.text(window.__BRAND || BUSINESS_NAME, 14, 16);
  doc.setFontSize(10); doc.setTextColor(90);
  doc.text(`Connect Report — ${$("cnFrom").value} to ${$("cnTo").value}`, 14, 23);
  doc.autoTable({ startY: 28, head: [["Party", "Amount"]], body,
    foot: [["Total", num2(tot)]], styles: { fontSize: 9 }, headStyles: { fillColor: [31, 78, 95] },
    columnStyles: { 1: { halign: "right" } } });
  deliverPdf(doc, `Connect_${todayISO()}.pdf`);
}

// ---- Declare / Un Declare a session (settle to the ledger) ----
function sessionRefTag(sessionId) { return `sess:${sessionId}`; }

function openDeclareModal() {
  if (!state.srSelectedId) return toast("Tap a session first", true);
  const s = (state.sessions || []).find((x) => x.id === state.srSelectedId);
  if (!s) return;
  if (s.result && String(s.result).trim()) return toast("Already declared — Un Declare first to change it.", true);
  state._declareSessionId = s.id;
  $("dcName").textContent = s.name || "(session)";
  $("dcRuns").value = "";
  openModal("declareModal");
}

function matchRefTag(id) { return `match:${id}`; }

// A client's agent(s) as an array. New model: one agent per client (cfg.agent);
// still reads the old cfg.agents array for backward compatibility.
function cfgAgents(cfg) {
  if (cfg.agent && (cfg.agent.name || "").trim()) return [cfg.agent];
  if (Array.isArray(cfg.agents)) return cfg.agents;
  return [];
}
// Global partners (shared across all clients). Held in state, saved in settings.
function globalPartners() { return Array.isArray(state.partners) ? state.partners : []; }

// A posting accumulator: rounds to paise, skips ~0, and tracks the running signed total
// so Capital can be posted as the exact balancing figure (always sums to zero).
function makePoster(date, ref) {
  const st = { sum: 0 };
  const post = async (party, signed, rmk) => {
    signed = Math.round(signed * 100) / 100;
    if (!party || Math.abs(signed) < 0.005) return;
    st.sum += signed;
    await api.addEntry({ party, type: signed > 0 ? "received" : "paid", amount: Math.abs(signed), date, reference: ref, remark: rmk });
  };
  return { post, st };
}

// Settle ONE client's book result P (P>0 = book gained from them) with commission rebate C.
// Commission is a rebate to the client (reduces what they owe); the NET pool (P−C) is shared
// by self / partner / agents — each PAID their %; the remainder is Capital's (left for the
// caller to post as the balancing figure). kind = "match" | "session".
async function settleClient(post, party, P, C, cfg, kind, remark, agentComm = 0) {
  const status = String(cfg.status || "").toLowerCase();
  const s = Number((cfg.self || {})[kind]) || 0;       // self share %
  const keep = (100 - s) / 100;                         // book portion that settles (party holds s%)

  // DUMMY: settles against Capital like a normal party. It is excluded ONLY from the GT /
  // match-book display (the DM row), not from the ledger.
  if (status === "dummy") {
    await post(party, -P, remark);                      // Capital absorbs this at the end of declare
    return;
  }

  // BOOKY (your upline): same settle direction as a client on the book (P>0 = he loses &
  // owes you keep·P). Commission fires only when YOU lose (C computed on the P<0 side in
  // doDeclareMatch): the booky then GIVES YOU a rebate, so you owe him keep·|P| − C (−C).
  if (status === "booky") {
    await post(party, -(keep * P) - C, remark);         // booky owes keep·P on his loss; on your loss you owe him keep·|P|−C
    return;                                             // Capital absorbs the balance at the end of declare
  }

  // CLIENT: the client holds his self share. Commission fires only when the CLIENT loses
  // (C computed on the P>0 side): you GIVE him a rebate, so he owes keep·P − C (+C here
  // reduces the negative = owes less). The house keeps the rest, shared with partners/agents.
  const agents = cfgAgents(cfg)
    .map((a) => ({ name: (a.name || "").trim(), pct: Number(a[kind]) || 0 }))
    .filter((a) => a.name);
  await post(party, -(keep * P) + C, remark);           // client owes (100−self)%·P, less the rebate you GIVE him
  const pool = keep * P - C;                            // what you received from this client (after his commission)
  let rem = pool;
  // AGENT: his FULL commission (agentComm, already figured on the received amount), then his
  // SHARE of what's LEFT after that commission. (agentComm applies to the first agent.)
  if (agents[0] && agentComm) { await post(agents[0].name, agentComm, `${remark} (agent commission of ${party})`); rem -= agentComm; }
  for (const ag of agents) if (ag.pct) { const share = rem * ag.pct / 100; await post(ag.name, share, `${remark} (agent share of ${party})`); rem -= share; }
  // PARTNERS last: their % of what's left after the agent is paid.
  for (const pt of globalPartners()) {
    const pct = Number(pt[kind]) || 0, nm = (pt.name || "").trim();
    if (nm && pct) await post(nm, rem * pct / 100, `${remark} (partner of ${party})`);
  }
}

async function doSaveDeclare() {
  const sid = state._declareSessionId;
  const s = (state.sessions || []).find((x) => x.id === sid);
  if (!s) return;
  const R = parseInt($("dcRuns").value, 10);
  if (!(R >= 0)) return toast("Enter the final runs", true);
  let bets;
  try { bets = await fetchSessionBets(sid); }
  catch (err) { return toast(err.message, true); }
  bets = (bets || []).filter((b) => !b.deleted);
  let cfgByName = {};
  try { (await api.listParties()).forEach((p) => { cfgByName[(p.name || "").toLowerCase()] = p.config || {}; }); } catch (e) {}
  // per-party P&L at run R, and per-party turnover split into normal (rate≈1) vs 90/110 saudas.
  // Commission runs only on the part through YOUR book (× keep); the client bears his self share's.
  const byParty = {}, toNorm = {}, toSpecial = {};
  bets.forEach((b) => {
    const key = (b.party_name || "").trim();
    if (!key) return;
    byParty[key] = (byParty[key] || 0) + sessionPayoff(b, R);
    if (b.mode === "BD") return;   // badla: P&L counts, but NO commission (skip turnover)
    const keep = (100 - (Number(((cfgByName[key.toLowerCase()] || {}).self || {}).session) || 0)) / 100;
    const stake = Math.abs(Number(b.amount) || 0) * keep;
    const special = Math.abs((Number(b.rate) || 1) - 1) > 0.0001;   // 90 (0.90) / 110 (1.10) rate
    if (special) toSpecial[key] = (toSpecial[key] || 0) + stake;
    else toNorm[key] = (toNorm[key] || 0) + stake;
  });
  const ref = sessionRefTag(sid);
  const remark = `SESSION ${s.name || ""} @${R}`.trim();
  const date = s.session_date ? s.session_date.slice(0, 10) : todayISO();
  const ctypeKey = (s.commission_type || "").toLowerCase();
  const { post, st } = makePoster(date, ref);
  try {
    for (const [party, payoff] of Object.entries(byParty)) {
      const cfg = cfgByName[party.toLowerCase()] || {};
      // session commission = % on turnover (rebate to the client); 90/110 saudas use a
      // separate % when the client has one, otherwise the same normal %.
      const cs = cfg.comm_session || {}, cs9 = cfg.comm_session_90110 || {}, csa = cfg.comm_session_agent || {}, csa9 = cfg.comm_session_agent_90110 || {};
      const pct = Number(cs[ctypeKey] || 0);
      const pct90 = Number(cs9[ctypeKey] || 0) || pct;      // 90/110 % for this session type; fallback to normal
      // comm_session is the TOTAL (client + agent) on normal & 90/110; comm_session_agent is the agent's cut.
      const Ctotal = Math.round(((toNorm[party] || 0) * pct + (toSpecial[party] || 0) * pct90)) / 100;
      const apct = Number(csa[ctypeKey] || 0);
      const apct90 = Number(csa9[ctypeKey] || 0);           // agent's 90/110 rate; 0 = no agent comm on 90/110
      const Ca = Math.round(((toNorm[party] || 0) * apct + (toSpecial[party] || 0) * apct90)) / 100;   // agent's cut
      const C = Math.round((Ctotal - Ca) * 100) / 100;      // client rebate = total − agent's cut
      await settleClient(post, party, payoff, C, cfg, "session", remark, Ca);
    }
    // Capital balances the books exactly.
    const cap = await api.getCapitalParty().catch(() => null);
    const capName = (cap && cap.name) || state.capitalName || "Capital Account";
    await post(capName, -st.sum, `SESSION ${s.name || ""} = ${R}`.trim());
    await api.updateSession(sid, { result: String(R) });
    if (state.runSession && state.runSession.id === sid) { state.runSession.result = String(R); applySessionLock(); }
    const idx = (state.sessions || []).findIndex((x) => x.id === sid);
    if (idx >= 0) state.sessions[idx].result = String(R);
    closeModal("declareModal");
    toast(`Declared — run ${R}`);
    await renderSessionReport();
    refreshParties && refreshParties();
  } catch (err) { toast(err.message, true); }
}

async function doUnDeclare() {
  if (!state.srSelectedId) return toast("Tap a session first", true);
  const s = (state.sessions || []).find((x) => x.id === state.srSelectedId);
  if (!s) return;
  if (!(s.result && String(s.result).trim())) return toast("This session is not declared.", true);
  if (!(await confirmAsk(`Un-declare session "${s.name}" and remove its ledger entries?`, "Un Declare"))) return;
  try {
    await api.deleteEntriesByRef(sessionRefTag(s.id));
    await api.updateSession(s.id, { result: "" });
    if (state.runSession && state.runSession.id === s.id) { state.runSession.result = ""; applySessionLock(); }
    const idx = (state.sessions || []).findIndex((x) => x.id === s.id);
    if (idx >= 0) state.sessions[idx].result = "";
    toast("Un-declared");
    await renderSessionReport();
    refreshParties && refreshParties();
  } catch (err) { toast(err.message, true); }
}

// ---- MATCH declare (team/horse bets settle on the winning column) ----
async function openMatchDeclare(id) {
  const m = (state.matches || []).find((x) => x.id === id);
  if (!m) return toast("Match not found", true);
  if (m.result && String(m.result).trim()) return toast("Already declared. Un-declare first.", true);
  state._declareMatchId = id;
  $("mdcName").textContent = (m.name || `${m.team1 || ""} v ${m.team2 || ""}`).trim() + (m.type ? ` · ${m.type}` : "");
  const cols = (Array.isArray(m.teams) && m.teams.length) ? m.teams : [m.team1 || "1", m.team2 || "2"];
  $("mdcResult").innerHTML = cols.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")
    + `<option value="Abandon">Abandon — void match (no lena/dena)</option>`
    + `<option value="Tie">Tie — void match (no lena/dena)</option>`;
  openModal("matchDeclareModal");
}

async function doDeclareMatch() {
  const id = state._declareMatchId;
  const m = (state.matches || []).find((x) => x.id === id);
  if (!m) return;
  const win = $("mdcResult").value;
  if (!win) return toast("Pick the result", true);
  // Don't let a match be declared while any of its sessions is still open — declare
  // (or delete) every session first, so nothing is left unsettled under the match.
  try {
    const sess = await api.listSessions(id);
    const open = (sess || []).filter((s) => String(s.result || "").trim() === "");
    if (open.length) {
      const names = open.map((s) => s.name || "session").join(", ");
      return toast(`Declare all sessions first — still open: ${names}`, true);
    }
  } catch (e) {}
  // Abandon / Tie: the whole match is void — NO match lena/dena is posted and the
  // trade entries are kept as-is. Sessions settle separately on their own results.
  const voidMatch = (win === "Abandon" || win === "Tie");
  const date = m.trade_date ? m.trade_date.slice(0, 10) : todayISO();
  try {
    if (!voidMatch) {
      const trades = (await fetchTrades(id)).filter((t) => !t.deleted);
      let cfgByName = {};
      try { (await api.listParties()).forEach((p) => { cfgByName[(p.name || "").toLowerCase()] = p.config || {}; }); } catch (e) {}
      // per-party match P&L at the winning column, + turnover + lost-bet stake.
      // lost-bet leg = one you REBATE on: a client's leg he lost to you (v>0), or — for a
      // booky — a leg YOU lost to him (v<0, so he rebates you). Booky is the mirror of a client.
      const byParty = {}, turnoverBy = {}, lostStakeBy = {};
      trades.forEach((t) => {
        const key = (t.party_name || "").trim(); if (!key) return;
        const isBooky = String((cfgByName[key.toLowerCase()] || {}).status || "").toLowerCase() === "booky";
        const v = (t.team === win) ? tradeMoney(t) : tradeQty(t);   // book P&L of this leg if `win` wins
        byParty[key] = (byParty[key] || 0) + v;
        const stake = Math.abs(Number(t.qty) || 0);
        turnoverBy[key] = (turnoverBy[key] || 0) + stake;
        // lost-bet = a leg you rebate on; its base is the LOSS on that leg (|v|), not the stake.
        if (isBooky ? v < 0 : v > 0) lostStakeBy[key] = (lostStakeBy[key] || 0) + Math.abs(v);
      });
      const ref = matchRefTag(id);
      const remark = `MATCH ${m.name || (m.team1 + " v " + m.team2)} = ${win}`.trim();
      const { post, st } = makePoster(date, ref);
      for (const [party, P] of Object.entries(byParty)) {
        const cfg = cfgByName[party.toLowerCase()] || {};
        const inc = cfg.inc || {};
        const type = inc.comm_match_type || "";
        const cstatus = String(cfg.status || "").toLowerCase();
        const sShare = Number((cfg.self || {}).match) || 0;
        const keepShare = (100 - sShare) / 100;   // commission runs only on the part that goes through YOUR book
        // Loss side flips by status: a CLIENT is rebated by YOU when HE loses (P>0);
        // a BOOKY rebates YOU when YOU lose (P<0, the booky wins). Base is after self share.
        const lossBase = (cstatus === "booky") ? (P < 0 ? -P : 0) : (P > 0 ? P : 0);
        const commOn = (pct) => {   // commission for a % using the party's match type
          if (!pct) return 0;
          if (type === "losing") return lossBase * keepShare * pct / 100;          // % of the net loss, after self share
          if (type === "turnover") return (turnoverBy[party] || 0) * keepShare * pct / 100000;  // ₹pct per 1,00,000 of after-share turnover, every sauda
          if (type === "lostbets") return (lostStakeBy[party] || 0) * keepShare * pct / 100;     // % of lost stakes
          return 0;
        };
        // comm_match is the TOTAL commission (client + agent); comm_agent is the agent's cut.
        // The client's own rebate is the difference; the agent's cut is paid to the agent below.
        const Ca = Math.round(commOn(Number(inc.comm_agent) || 0) * 100) / 100;              // agent's cut
        const C = Math.round((commOn(Number(inc.comm_match) || 0) - commOn(Number(inc.comm_agent) || 0)) * 100) / 100;   // client rebate = total − agent
        await settleClient(post, party, P, C, cfg, "match", remark, Ca);
      }
      const cap = await api.getCapitalParty().catch(() => null);
      const capName = (cap && cap.name) || state.capitalName || "Capital Account";
      await post(capName, -st.sum, remark);
    }
    await api.updateMatch(id, { result: String(win) });
    try { localStorage.removeItem("ssb_wd_" + id); } catch (e) {}   // parked withdrawals done — return to winner
    const mm = (state.matches || []).find((x) => x.id === id); if (mm) mm.result = String(win);
    if (state.trSession && state.trSession.id === id) { state.trSession.result = String(win); applyMatchLock(); }
    closeModal("matchDeclareModal");
    toast(voidMatch ? `Match ${win} — match saudas voided (sessions settle separately)` : `Match declared — ${win}`);
    await renderMatchReport();
    refreshParties && refreshParties();
  } catch (err) { toast(err.message, true); }
}

async function doUnDeclareMatch(id) {
  const m = (state.matches || []).find((x) => x.id === id);
  if (!m) return;
  if (!(m.result && String(m.result).trim())) return toast("This match is not declared.", true);
  if (!(await confirmAsk(`Un-declare match "${m.name || (m.team1 + " v " + m.team2)}" and remove its ledger entries?`, "Un Declare"))) return;
  try {
    await api.deleteEntriesByRef(matchRefTag(id));
    await api.updateMatch(id, { result: "" });
    try { localStorage.removeItem("ssb_wd_" + id); } catch (e) {}
    const mm = (state.matches || []).find((x) => x.id === id); if (mm) mm.result = "";
    if (state.trSession && state.trSession.id === id) { state.trSession.result = ""; applyMatchLock(); }
    toast("Match un-declared");
    await renderMatchReport();
    refreshParties && refreshParties();
  } catch (err) { toast(err.message, true); }
}

// A match is locked for new team bets once it has been declared.
function applyMatchLock() {
  const locked = !!(state.trSession && String(state.trSession.result || "").trim());
  ["trQty", "trRate", "trTeam", "trMode", "trParty", "trSubmit", "trModifyBtn"]
    .forEach((id) => { const el = $(id); if (el) el.disabled = locked; });
}

// A session is locked for editing once it has been declared (result set).
function isSessionDeclared() {
  return !!(state.runSession && String(state.runSession.result || "").trim());
}
function applySessionLock() {
  const locked = isSessionDeclared();
  ["syAmount", "syRate", "syRun", "syMode", "syParty", "sySubmit", "syModifyBtn", "syDeleteBtn"]
    .forEach((id) => { const el = $(id); if (el) el.disabled = locked; });
  const nm = state.runSession ? (state.runSession.name || "").trim() : "";
  const ty = state.runSession ? (state.runSession.commission_type || "").trim() : "";
  const ml = state.trSession ? matchLabel(state.trSession) : "";
  const lbl = `SESSION — ${ml ? ml + " · " : ""}${nm}${ty ? ` (${ty})` : ""}`;
  $("syTitle").textContent = locked ? `${lbl}  (DECLARED @${state.runSession.result})` : lbl;
}

// ---- Level 3: open a session's runs window ----
async function openSessionRuns(id) {
  const s = (state.sessions || []).find((x) => x.id === id);
  if (!s) return;
  state.runSession = s; state.srSelectedId = id; state.sySelectedId = null;
  state.rightMode = "session";
  cancelSessionEdit();
  applyPanes();
  await loadSessionBets();
  applySessionLock();
  if (!isSessionDeclared()) $("syRate").focus();
}

function backToSessions() {
  state.runSession = null; state.rightMode = "report";
  cancelSessionEdit();
  applyPanes();
  renderSessionReport();
}

// ---- Withdraw to Capital (per-match, interim). State is kept per device; the
// amount is parked (book shown reduced) and returns to the winner at declaration,
// so it never posts to the ledger (net-zero) — zero risk to the accounts. ----
function wdDefault() { return { list: [], auto: { on: false, everyN: 5, amount: 500, lastCount: 0 } }; }
function wdKey() { return state.trSession ? "ssb_wd_" + state.trSession.id : null; }
function wdLoad() {
  const k = wdKey(); if (!k) return wdDefault();
  try { const s = localStorage.getItem(k); if (s) { const d = JSON.parse(s); d.list = d.list || []; d.auto = Object.assign(wdDefault().auto, d.auto || {}); return d; } } catch (e) {}
  return wdDefault();
}
function wdSave(d) { const k = wdKey(); if (!k) return; try { localStorage.setItem(k, JSON.stringify(d)); } catch (e) {} }
function wdClear() { const k = wdKey(); if (k) try { localStorage.removeItem(k); } catch (e) {} }
function wdTotal() { return wdLoad().list.reduce((s, w) => s + (Number(w.amount) || 0), 0); }
function wdAutoCheck() {
  const d = wdLoad(); if (!d.auto || !d.auto.on || !(d.auto.everyN > 0) || !(d.auto.amount > 0)) return;
  const count = (state.trades || []).filter((t) => !t.deleted).length;
  let changed = false;
  while (count >= (d.auto.lastCount || 0) + d.auto.everyN) {
    d.auto.lastCount = (d.auto.lastCount || 0) + d.auto.everyN;
    d.list.push({ amount: d.auto.amount, atEntry: d.auto.lastCount, ts: Date.now(), auto: true });
    changed = true;
  }
  if (changed) wdSave(d);
}
function openWithdrawModal() {
  if (!state.trSession) return toast("Open a match first", true);
  if (state.trSession.result) return toast("Match is declared — un-declare to withdraw.", true);
  wdSwitchTab("now");
  const d = wdLoad();
  if ($("wdEveryN")) $("wdEveryN").value = d.auto.everyN;
  if ($("wdAutoAmt")) $("wdAutoAmt").value = d.auto.amount;
  if ($("wdAutoOn")) $("wdAutoOn").checked = !!d.auto.on;
  if ($("wdNowAmt")) $("wdNowAmt").value = "";
  updateWdUI();
  openModal("withdrawModal");
}
function wdSwitchTab(which) {
  const now = which === "now";
  $("wdPaneNow").style.display = now ? "" : "none";
  $("wdPaneAuto").style.display = now ? "none" : "";
  $("wdTabNow").classList.toggle("on", now);
  $("wdTabAuto").classList.toggle("on", !now);
}
function updateWdUI() {
  const d = wdLoad(), el = $("wdList"); if (!el) return;
  const tot = d.list.reduce((s, w) => s + (Number(w.amount) || 0), 0);
  if (!d.list.length) { el.innerHTML = '<div class="muted" style="font-size:12px">No withdrawals yet this match.</div>'; return; }
  el.innerHTML = '<div style="font-weight:700;margin-bottom:4px">Held in Capital: ' + inr(tot) + '</div>' +
    d.list.slice().reverse().map((w) => '<div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;border-bottom:1px solid var(--line)"><span>' + (w.auto ? 'auto @entry ' + w.atEntry : 'now') + '</span><span>' + inr(w.amount) + '</span></div>').join("");
}
function wdDoNow() {
  if (!state.trSession || state.trSession.result) return toast("Match is declared.", true);
  const amt = parseFloat($("wdNowAmt").value);
  if (!(amt > 0)) return toast("Enter an amount", true);
  const d = wdLoad();
  d.list.push({ amount: amt, atEntry: (state.trades || []).filter((t) => !t.deleted).length, ts: Date.now() });
  wdSave(d);
  $("wdNowAmt").value = ""; updateWdUI(); renderTrades();
  toast("Withdrew " + inr(amt) + " to Capital (held)");
}
function wdSaveAutoRule() {
  const d = wdLoad();
  d.auto.everyN = Math.max(1, parseInt($("wdEveryN").value, 10) || 5);
  d.auto.amount = Math.max(1, parseFloat($("wdAutoAmt").value) || 0);
  d.auto.on = !!$("wdAutoOn").checked;
  if (d.auto.on) d.auto.lastCount = (state.trades || []).filter((t) => !t.deleted).length; // count from now on
  wdSave(d); wdAutoCheck(); updateWdUI(); renderTrades();
  toast(d.auto.on ? ("Auto-withdraw ON — every " + d.auto.everyN + " → " + inr(d.auto.amount)) : "Auto-withdraw off");
}
function wdClearAll() {
  wdClear(); updateWdUI(); renderTrades(); toast("Withdrawals cleared");
}

async function loadTrades() {
  if (!state.trSession) return;
  try { state.trades = await fetchTrades(state.trSession.id); }
  catch (err) { return toast(err.message, true); }
  wdAutoCheck();     // fire any due auto-withdrawals for this match
  renderTrades();
}

// Format a number with 2 decimals (Indian grouping), no ₹ — columns mix money & qty.
function num2(v) { return inr(Number(v) || 0).replace("₹", ""); }

// ---- Home "Match GT" box: the per-column GT of a chosen match, on the home page ----
async function renderHomeGt(keepSelection) {
  const sel = $("hgMatch"), tbl = $("hgTable");
  if (!sel || !tbl) return;
  let matches = [];
  try { matches = await api.listMatches(); } catch (e) {}
  state._homeMatches = matches;
  if (!matches.length) {
    sel.innerHTML = "";
    tbl.innerHTML = `<tbody><tr><td class="muted" style="padding:14px">No matches yet.</td></tr></tbody>`;
    return;
  }
  const want = keepSelection && sel.value && matches.some((m) => m.id === sel.value) ? sel.value : matches[0].id;
  sel.innerHTML = matches.map((m) => {
    const label = (m.name || `${m.team1 || ""} v ${m.team2 || ""}`).trim() + (m.type ? ` (${m.type})` : "") + (m.result ? ` = ${m.result}` : "");
    return `<option value="${m.id}">${esc(label)}</option>`;
  }).join("");
  sel.value = want;
  await renderHomeGtTable(sel.value);
}

async function renderHomeGtTable(matchId) {
  const tbl = $("hgTable");
  if (!tbl) return;
  const m = (state._homeMatches || []).find((x) => x.id === matchId);
  if (!m) return;
  let trades = [];
  try { trades = (await fetchTrades(matchId)).filter((t) => !t.deleted); } catch (e) {}
  const cols = (Array.isArray(m.teams) && m.teams.length) ? m.teams : [m.team1 || "1", m.team2 || "2"];
  const totals = cols.map(() => 0);
  trades.forEach((t) => {
    const selIdx = cols.indexOf(t.team);
    const money = tradeMoney(t), qty = tradeQty(t);
    cols.forEach((_, k) => { totals[k] += (k === selIdx ? money : qty); });
  });
  const head = cols.map((c) => `<th class="num">${esc(c)}</th>`).join("");
  const cells = totals.map((v) => `<td class="num ${v < 0 ? "neg" : ""}">${num2(v)}</td>`).join("");
  tbl.innerHTML = `<thead><tr><th>Team</th>${head}</tr></thead><tbody><tr class="gt-row"><td><b>GT</b></td>${cells}</tr></tbody>`;
}

// Book average = the "settle-to-zero" sauda you'd place ON the selected team to flatten
// the (net) book. For a book of (selected B_s, other B_o) with opposite signs:
//   rate = |B_s| / |B_o| ,  amount = |B_o| ,  mode = L if B_o > 0 else K.
// e.g. book thunder +900 / perth -1000:  thunder -> 1000 @ 0.90 K ;  perth -> 900 @ 1.11 L.
function updateBookAverage() {
  const el = $("trAvg"); if (!el) return;
  const totals = state._trTotals || [];
  const cols = state._trCols || [];
  const sel = $("trTeam") ? $("trTeam").value : "";
  const i = cols.indexOf(sel);
  // biggest opposite-side position to settle against
  let oIdx = -1, other = 0;
  for (let k = 0; k < totals.length; k++) if (k !== i && Math.abs(totals[k]) > Math.abs(other)) { other = totals[k]; oIdx = k; }
  if (i < 0 || !(Math.abs(totals[i]) > 0) || oIdx < 0 || !(Math.abs(other) > 0)) {
    el.textContent = "Avg —"; el.title = "Book average (settle-to-zero rate) — needs a position on the selected team and an opposite side"; return;
  }
  const rate = Math.abs(totals[i]) / Math.abs(other);
  const amount = Math.round(Math.abs(other));
  const mode = other > 0 ? "L" : "K";
  el.textContent = `Avg ${rate.toFixed(2)}`;
  el.title = `To flatten the book: ${amount.toLocaleString("en-IN")} @ ${rate.toFixed(2)} ${mode} on ${sel}`;
}

function renderTrades() {
  const teams = Array.isArray(state.trSession.teams) ? state.trSession.teams : [];
  const cols = teams.length ? teams : ["1", "2"];   // one value column per team
  const rows = state.trades.slice().sort(byNewest);  // newest on top
  const totals = cols.map(() => 0);

  const bodyRows = rows.map((t, i) => {
    const selIdx = cols.indexOf(t.team);
    const money = tradeMoney(t), qty = tradeQty(t);
    // Selected team's column = money; every OTHER team's column = qty.
    const vals = cols.map((_, k) => (k === selIdx ? money : qty));
    if (!t.deleted) cols.forEach((_, k) => { totals[k] += vals[k]; });
    const cls = t.deleted ? "tr-del" : (t.modified ? "tr-mod" : "");
    const sr = rows.length - i;
    const time = new Date(t.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const colCells = vals.map((v, k) =>
      `<td class="num ${k === selIdx ? "money" : ""} ${v < 0 ? "neg" : ""}">${num2(v)}</td>`).join("");
    return `<tr data-id="${t.id}" class="${cls}">
      <td class="sr-col">${sr}</td>
      <td class="num">${num2(t.qty)}</td>
      <td class="num">${Number(t.rate)}</td>
      <td>${esc(t.team) || "-"}</td>
      <td>${t.mode}</td>
      <td class="pname">${esc(t.party_name) || "-"}</td>
      ${colCells}
      <td>${time}</td></tr>`;
  }).join("");

  const colHead = cols.map((c) => `<th class="num">${esc(c)}</th>`).join("");
  const span = 6 + cols.length + 1;

  // ----- GT box: GT (live book) + BK/MS (bookys) + DM (dummy) -----
  const wdt = wdTotal();                                  // withdraw comes off the live book
  const raw = computeGtBox(cols, "match");                // raw after-share book — feeds the Avg box
  const box = projectMatch(cols);                         // projected net incl. commission — what's shown
  const gt = box.gt.map((v) => v - wdt);
  const gtHead = cols.map((c) => `<th class="num">${esc(c)}</th>`).join("");
  const cells = (arr) => arr.map((v) => `<td class="num ${v < 0 ? "neg" : ""}">${num2(v)}</td>`).join("");
  let gtRows = `<tr class="gt-row"><td><b>GT</b></td>${cells(gt)}</tr>`;
  if (box.hasBooky) gtRows += `<tr class="bk-row"><td><b>BK</b></td>${cells(box.bk)}</tr>`
                            + `<tr class="ms-row"><td><b>MS</b></td>${cells(box.ms)}</tr>`;
  if (box.hasDummy) gtRows += `<tr class="dm-row"><td><b>DM</b></td>${cells(box.dm)}</tr>`;
  $("trGtTable").innerHTML = `
    <thead><tr><th>Team</th>${gtHead}</tr></thead>
    <tbody>${gtRows}</tbody>`;

  // Parked-in-capital readout (only while something is withdrawn).
  if ($("trWdHeld")) {
    if (wdt > 0) { $("trWdHeld").style.display = ""; $("trWdHeld").innerHTML = `Withdrawn to Capital (held): <b>${inr(wdt)}</b> — returns to the winner at declaration`; }
    else $("trWdHeld").style.display = "none";
  }

  // Book average (settle-to-zero rate) uses the shown (reduced) book.
  state._trCols = cols; state._trTotals = gt.slice();
  updateBookAverage();

  $("trTable").innerHTML = `
    <thead><tr>
      <th class="sr-col">Sr</th><th class="num">Amount</th><th class="num">Rate</th>
      <th>Fovrt</th><th>Mode</th><th>Party Name</th>${colHead}<th>Time</th>
    </tr></thead>
    <tbody>
      ${bodyRows || `<tr><td colspan="${span}" class="muted" style="text-align:center;padding:16px">No trades yet.</td></tr>`}
    </tbody>`;

  // row selection (tap a row, then Modify/Delete act on it)
  $("trTable").querySelectorAll("tbody tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => {
      state.trSelectedId = tr.getAttribute("data-id");
      $("trTable").querySelectorAll("tbody tr").forEach((r) => r.classList.remove("sel"));
      tr.classList.add("sel");
    }));

  renderBook();   // keep the Match Book side panel in sync
  renderTrBooks();   // agents & partners book panel
}

// ---------- Agents & Partners book (drill-down on the match screen) ----------
// Columns for this match.
function trBookCols() {
  const teams = Array.isArray(state.trSession && state.trSession.teams) ? state.trSession.teams : [];
  return teams.length ? teams : ["1", "2"];
}
// Per-party GT per team from the current (non-deleted) trades.
function partyColsGT(cols) {
  const by = {};
  (state.trades || []).forEach((t) => {
    if (t.deleted) return;
    const key = (t.party_name || "").trim(); if (!key) return;
    const sel = cols.indexOf(t.team), money = tradeMoney(t), qty = tradeQty(t);
    if (!by[key]) by[key] = cols.map(() => 0);
    cols.forEach((_, k) => { by[key][k] += (k === sel ? money : qty); });
  });
  return by;
}

// GT box split per sauda, by the party's Status + Self Share %.  kind = "match" | "session".
//   Booky party: you keep self% (MS), the rest (100−self)% is the booky's book (BK). Both the
//     booky's (100−self)% sits in the live book (GT); your self% (MS) is carved out of GT.
//   Client party with self%: the client holds self% (their panel); you keep (100−self)% in GT.
//   Normal party: full amount in GT.   Dummy party: goes to DM only, never into GT.
// Returns per-team arrays gt, bk, ms, dm (+ flags for which rows to show).
function computeGtBox(cols, kind) {
  const cfgByName = {};
  (state.parties || []).forEach((p) => { cfgByName[(p.name || "").trim().toLowerCase()] = p.config || {}; });
  const gt = cols.map(() => 0), bk = cols.map(() => 0), ms = cols.map(() => 0), dm = cols.map(() => 0);
  let hasBooky = false, hasDummy = false;
  (state.trades || []).forEach((t) => {
    if (t.deleted) return;
    const cfg = cfgByName[(t.party_name || "").trim().toLowerCase()] || {};
    const status = String(cfg.status || "").toLowerCase();
    const s = Number((cfg.self || {})[kind]) || 0;        // self share %
    const keep = (100 - s) / 100;
    const sel = cols.indexOf(t.team), money = tradeMoney(t), qty = tradeQty(t);
    cols.forEach((_, k) => {
      const P = (k === sel ? money : qty);
      if (status === "dummy") { dm[k] += P; return; }     // dummy: independent, not in GT
      gt[k] += P * keep;                                  // live book keeps (100−self)%
      if (status === "booky") { bk[k] += P * keep; ms[k] += P * (s / 100); }
    });
    if (status === "dummy") hasDummy = true;
    if (status === "booky") hasBooky = true;
  });
  return { gt, bk, ms, dm, hasBooky, hasDummy };
}

// Project the LIVE match book per team = run the real settlement as if each team wins, so the
// GT box and Match Book show your true net INCLUDING commission (positive = you win if that
// team wins). Display-only; the money is posted by doDeclareMatch — keep the two in sync.
function projectMatch(cols) {
  const cfgByName = {};
  (state.parties || []).forEach((p) => { cfgByName[(p.name || "").trim().toLowerCase()] = p.config || {}; });
  const trades = (state.trades || []).filter((t) => !t.deleted);
  const gt = cols.map(() => 0), bk = cols.map(() => 0), ms = cols.map(() => 0), dm = cols.map(() => 0);
  let hasBooky = false, hasDummy = false;
  const perParty = {};        // net incl. commission, less agent/partner share — feeds GT + settlement reference
  const perPartyGross = {};   // the client's FULL book: no commission, no agent/partner share (shown in the Match Book)
  cols.forEach((win, ti) => {
    const byParty = {}, turnoverBy = {}, lostStakeBy = {};
    trades.forEach((t) => {
      const key = (t.party_name || "").trim(); if (!key) return;
      const isBooky = String((cfgByName[key.toLowerCase()] || {}).status || "").toLowerCase() === "booky";
      const v = (t.team === win) ? tradeMoney(t) : tradeQty(t);
      byParty[key] = (byParty[key] || 0) + v;
      const stake = Math.abs(Number(t.qty) || 0);
      turnoverBy[key] = (turnoverBy[key] || 0) + stake;
      if (isBooky ? v < 0 : v > 0) lostStakeBy[key] = (lostStakeBy[key] || 0) + Math.abs(v);   // lost-bet base = the LOSS (|v|)
    });
    for (const party in byParty) {
      const P = byParty[party];
      const cfg = cfgByName[party.toLowerCase()] || {};
      const status = String(cfg.status || "").toLowerCase();
      const inc = cfg.inc || {};
      const type = inc.comm_match_type || "";
      const s = Number((cfg.self || {}).match) || 0;
      const keep = (100 - s) / 100;
      const lossBase = (status === "booky") ? (P < 0 ? -P : 0) : (P > 0 ? P : 0);
      const commOn = (pct) => {
        if (!pct) return 0;
        if (type === "losing") return lossBase * keep * pct / 100;
        if (type === "turnover") return (turnoverBy[party] || 0) * keep * pct / 100000;
        if (type === "lostbets") return (lostStakeBy[party] || 0) * keep * pct / 100;
        return 0;
      };
      // client rebate = TOTAL comm_match − agent's cut (comm_agent); booky/dummy have no agent.
      const C = Math.round((commOn(Number(inc.comm_match) || 0) - (status === "booky" || status === "dummy" ? 0 : commOn(Number(inc.comm_agent) || 0))) * 100) / 100;
      let signed;
      if (status === "dummy") signed = -P;
      else if (status === "booky") signed = -(keep * P) - C;
      else signed = -(keep * P) + C;
      signed = Math.round(signed * 100) / 100;
      const myNet = -signed;   // your gain from this party if `win` wins
      if (!perParty[party]) perParty[party] = cols.map(() => 0);
      perParty[party][ti] = myNet;
      // Gross client book = the raw position with NO commission and NO agent/partner share.
      // dummy: full P;  everyone else: keep·P (self-share carved out, nothing else).
      if (!perPartyGross[party]) perPartyGross[party] = cols.map(() => 0);
      perPartyGross[party][ti] = Math.round((status === "dummy" ? P : keep * P) * 100) / 100;
      if (status === "dummy") { dm[ti] += myNet; hasDummy = true; continue; }
      if (status === "booky") { gt[ti] += myNet; bk[ti] += keep * P; ms[ti] += C; hasBooky = true; continue; }  // BK = pure booky book; MS gains your commission
      // CLIENT: your take-home = the pool (keep·P − C) LESS the agent's commission, the agent's
      // profit share, and partners' share — mirror settleClient so the book = your TRUE net.
      let rem = myNet;                                                          // pool = keep·P − C
      const Ca = Math.round((commOn(Number(inc.comm_agent) || 0)) * 100) / 100;  // agent's commission
      const ags = cfgAgents(cfg).map((a) => ({ name: (a.name || "").trim(), pct: Number(a.match) || 0 })).filter((a) => a.name);
      if (ags[0] && Ca) rem = Math.round((rem - Ca) * 100) / 100;               // agent's commission out of the pool
      for (const ag of ags) if (ag.pct) rem = Math.round((rem - rem * ag.pct / 100) * 100) / 100;        // agent's profit share
      for (const ptn of globalPartners()) { const ppct = Number(ptn.match) || 0; if ((ptn.name || "").trim() && ppct) rem = Math.round((rem - rem * ppct / 100) * 100) / 100; }  // partners last
      perParty[party][ti] = rem;        // per-client book, net of your agent/partner
      gt[ti] += rem;
    }
  });
  // MS also carries your structural share (opposite the booky's book), on top of the commission above.
  trades.forEach((t) => {
    const cfg = cfgByName[(t.party_name || "").trim().toLowerCase()] || {};
    if (String(cfg.status || "").toLowerCase() !== "booky") return;
    const s = Number((cfg.self || {}).match) || 0;
    const sel = cols.indexOf(t.team), money = tradeMoney(t), qty = tradeQty(t);
    cols.forEach((_, k) => { const P = (k === sel ? money : qty); ms[k] -= P * s / 100; });
  });
  return { gt, bk, ms, dm, hasBooky, hasDummy, perParty, perPartyGross };
}
// Build agent/partner aggregates (their SHARE = client GT × their match %).
function buildTrBooks() {
  const cols = trBookCols();
  const pGT = partyColsGT(cols);
  const cfgOf = {}; (state.parties || []).forEach((p) => { cfgOf[(p.name || "").toLowerCase()] = p.config || {}; });
  const agents = {}, partners = {};
  Object.keys(pGT).forEach((party) => {
    const cfg = cfgOf[party.toLowerCase()] || {}, gt = pGT[party];
    cfgAgents(cfg).forEach((a) => {
      const nm = (a.name || "").trim(), pct = Number(a.match) || 0; if (!nm || !pct) return;
      if (!agents[nm]) agents[nm] = { cols: cols.map(() => 0), clients: {} };
      cols.forEach((_, k) => { agents[nm].cols[k] += gt[k] * pct / 100; });
      agents[nm].clients[party] = gt;
    });
    globalPartners().forEach((pt) => {
      const pn = (pt.name || "").trim(), ppct = Number(pt.match) || 0; if (!pn || !ppct) return;
      if (!partners[pn]) partners[pn] = { cols: cols.map(() => 0), clients: {} };
      cols.forEach((_, k) => { partners[pn].cols[k] += gt[k] * ppct / 100; });
      partners[pn].clients[party] = gt;
    });
  });
  return { cols, agents, partners };
}
function renderTrBooks() {
  const el = $("trBooks"); if (!el || !state.trSession) return;
  const { cols, agents, partners } = buildTrBooks();
  const d = state._bookDrill || { level: 0 };
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const numc = (v) => `<td class="${v < 0 ? "neg" : (v > 0 ? "pos" : "")}">${num2(v)}</td>`;

  if (d.level === 2 && d.client) {
    const rows = (state.trades || []).filter((t) => !t.deleted && (t.party_name || "") === d.client);
    const body = rows.map((t) => {
      const sel = cols.indexOf(t.team), money = tradeMoney(t), qty = tradeQty(t);
      const vals = cols.map((_, k) => (k === sel ? money : qty));
      return `<tr><td class="nm">${num2(t.qty)} ${t.mode} <span class="muted">${esc(t.team)}</span></td>${vals.map(numc).join("")}</tr>`;
    }).join("");
    el.innerHTML = `<div class="bk-head"><span class="bk-back" data-bk="up">← ${esc(d.client)} — saudas</span></div>
      <table><thead><tr><th class="nm">Sauda (amt · mode)</th>${head}</tr></thead>
      <tbody>${body || `<tr><td class="nm" colspan="${cols.length + 1}">No saudas for this client.</td></tr>`}</tbody></table>`;
  } else if (d.level === 1 && d.who) {
    const src = (d.kind === "partner" ? partners : agents)[d.who] || { clients: {} };
    const body = Object.keys(src.clients).map((c) =>
      `<tr class="clk" data-bk="client" data-client="${esc(c)}"><td class="nm">${esc(c)} ›</td>${src.clients[c].map(numc).join("")}</tr>`).join("");
    el.innerHTML = `<div class="bk-head"><span class="bk-back" data-bk="up">← ${esc(d.who)} — clients</span></div>
      <table><thead><tr><th class="nm">Client (tap → saudas)</th>${head}</tr></thead>
      <tbody>${body || `<tr><td class="nm" colspan="${cols.length + 1}">No clients.</td></tr>`}</tbody></table>`;
  } else {
    const aRows = Object.keys(agents).map((n) =>
      `<tr class="clk" data-bk="who" data-kind="agent" data-who="${esc(n)}"><td class="nm">${esc(n)} ›</td>${agents[n].cols.map(numc).join("")}</tr>`).join("");
    const pRows = Object.keys(partners).map((n) =>
      `<tr class="clk" data-bk="who" data-kind="partner" data-who="${esc(n)}"><td class="nm">${esc(n)} <span class="muted">· partner</span> ›</td>${partners[n].cols.map(numc).join("")}</tr>`).join("");
    const none = (!aRows && !pRows) ? `<tr><td class="nm" colspan="${cols.length + 1}">No agents or partners on these saudas yet.</td></tr>` : "";
    el.innerHTML = `<div class="bk-head"><span>Agents &amp; Partners <span class="muted">(their share · tap to open)</span></span></div>
      <table><thead><tr><th class="nm">Name</th>${head}</tr></thead><tbody>${aRows}${pRows}${none}</tbody></table>`;
  }
}
function onTrBooksClick(e) {
  const t = e.target.closest("[data-bk]"); if (!t) return;
  const bk = t.getAttribute("data-bk"), d = state._bookDrill || { level: 0 };
  if (bk === "who") state._bookDrill = { level: 1, who: t.getAttribute("data-who"), kind: t.getAttribute("data-kind") };
  else if (bk === "client") state._bookDrill = { level: 2, client: t.getAttribute("data-client"), who: d.who, kind: d.kind };
  else if (bk === "up") state._bookDrill = (d.level === 2) ? { level: 1, who: d.who, kind: d.kind } : { level: 0 };
  renderTrBooks();
}

// Live preview of the current entry's effect as you type.
function updateTradePreview() {
  const qty = parseFloat($("trQty").value);
  const rate = normalizeRate($("trRate").value);
  const el = $("trPreview");
  if (!el) return;
  if (!(qty > 0) || !(rate > 0)) { el.textContent = ""; return; }
  const mode = $("trMode").value;
  const money = mode === "L" ? qty * rate : -qty * rate;
  const q = mode === "L" ? -qty : qty;
  el.textContent = `→ ${num2(money)} / ${num2(q)}`;
}

// ================= VOICE / TYPED BET ENTRY =================
// Lagai (back) = L ; Khai (lay) = K — multilingual synonyms.
const V_L = ["lagaya", "lagai", "lagay", "laga", "lga", "lgaya", "lagau", "lagaav", "lagana", "lgana", "lav", "lavla", "laav", "lavlay", "lavili", "back", "lai", "लगाया", "लगाई", "लावला"];
const V_K = ["khaya", "khai", "khay", "kha", "khata", "khau", "khala", "khaata", "khaa", "lay", "खाया", "खाई", "खा"];
const V_IN = ["main", "mein", "mai", "may", "me", "madhe", "made", "mdhe", "madhye", "pe", "par", "मे", "में", "मैं", "मध्ये", "पे"];
// Plain integer words (count). "dozen" = 12.
const V_INT = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, cheh: 6, saat: 7, aath: 8, nau: 9, das: 10,
  gyarah: 11, barah: 12, bees: 20, tees: 30, chalis: 40, pachas: 50, don: 2, paach: 5, saha: 6, daha: 10,
  // Hindi number words in Devanagari (so "सवा दो पेटी", "सवा तीन पेटी" etc. work on Hindi voice)
  "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पांच": 5, "पाँच": 5, "छह": 6, "छे": 6, "सात": 7, "आठ": 8, "नौ": 9, "दस": 10,
  "ग्यारह": 11, "बारह": 12, "बीस": 20, "तीस": 30, "चालीस": 40, "पचास": 50, "सौ": 100,
  // satta slang number-names used before "peti" (e.g. "panja peti" = 5 peti). Confirmed with Vicky 2026-10-27.
  single: 1, jodi: 2, tiranga: 3, chocolate: 4, choclate: 4, panja: 5, congress: 5, chakka: 6, chagan: 6, damru: 8,
  // fractional counts (Vicky): ded/dedh = 1.5, dhai/adhai = 2.5 → "ded peti"=1.5 lakh, "dhai peti"=2.5 lakh
  ded: 1.5, dedh: 1.5, dhai: 2.5, dhaai: 2.5, adhai: 2.5,
  // "sava" alone = 1.25 ("sava peti" = 1.25 lakh). With a number after it, V_MOD adds ¼ ("sava 2" = 2.25).
  sava: 1.25, savaa: 1.25, sawa: 1.25,
};
// "sade/saadhe N" = N + ½ (sade teen = 3.5); "sava N" = N + ¼ (sava 2 = 2.25). Applied in toNumberTokens.
const V_MOD = { sade: 0.5, saadhe: 0.5, sadhe: 0.5, saade: 0.5, sava: 0.25, savaa: 0.25, sawa: 0.25 };
const V_DOZEN = { dozen: 12, dozn: 12, dozens: 12, darjan: 12, darzan: 12 };   // "2 dozen" = 24
// AMOUNT SCALE: the values below are REAL rupees. The amount that goes in the box
// = real ÷ the book's unit (state.amountUnit = 1 / 10 / 100 / 1000, default 100).
// So at 100×, 1 peti (₹1,00,000) fills the box as 1000 — same as before; at 1× it
// fills 100000, at 1000× it fills 100.  "peti" = 1 lakh.
// Fraction alone: quarter = ₹25,000, aadhi/hadhi = ₹50,000, paune = ₹75,000.
// Fraction + peti: quarter peti = ₹25,00,000, aadhi peti = ₹50,000, paune peti = ₹75,00,000.
const V_FRAC = {
  quarter: 25000, quarters: 25000, quartr: 25000, qurter: 25000, qurtr: 25000, quater: 25000, quaters: 25000, quatr: 25000, kwartar: 25000, kwarter: 25000, kwartr: 25000, kartar: 25000, karter: 25000, qtr: 25000,
  hadhi: 50000, haadi: 50000, hadi: 50000, hadhee: 50000, hadhhi: 50000, half: 50000, aadha: 50000, adha: 50000, aadhi: 50000,
  paune: 75000, pauna: 75000, "3quarter": 75000,
  luckyseven: 7000,  // "lucky seven" alone = ₹7,000 (collapsed to one token in parseVoiceBet)
};
// REAL value of "<fraction> peti". quarter peti = ₹25,00,000, 3 quarter peti = ₹75,00,000,
// but aadhi/hadhi peti = ₹50,000 (same as aadhi alone — Vicky: they mean the same).
const V_FRAC_PETI = {
  quarter: 2500000, quarters: 2500000, quartr: 2500000, qurter: 2500000, qurtr: 2500000, quater: 2500000, quaters: 2500000, quatr: 2500000, kwartar: 2500000, kwarter: 2500000, kwartr: 2500000, kartar: 2500000, karter: 2500000, qtr: 2500000,
  hadhi: 50000, haadi: 50000, hadi: 50000, hadhee: 50000, hadhhi: 50000, half: 50000, aadha: 50000, adha: 50000, aadhi: 50000,
  paune: 7500000, pauna: 7500000, "3quarter": 7500000,
  luckyseven: 700000,  // "lucky seven peti" = ₹7,00,000 (7 lakh)
};
const V_PETI = { peti: 100000, petti: 100000, peety: 100000, patti: 100000, pati: 100000 };     // 1 peti = ₹1,00,000
const V_UNIT = { hazaar: 1000, hazar: 1000, hajar: 1000, hajaar: 1000, thousand: 1000, sau: 100, hundred: 100, shambhar: 100, lakh: 100000, lac: 100000 }; // hazar ×1000, lakh ×1,00,000
const isNumWord = (t) => V_INT[t] != null || V_FRAC[t] != null || V_FRAC_PETI[t] != null || V_PETI[t] != null || V_UNIT[t] != null || V_DOZEN[t] != null || V_MOD[t] != null;

// Turn tokens into REAL-rupee numbers. "peti" = 1 lakh:
//   integer + peti → ×100000 ("1 peti"=100000, "25 peti"=2500000, "2 peti"=200000)
//   fraction alone: "quarter"=25000, "aadhi"=50000, "3 quarter"=75000
//   fraction + peti: "quarter peti"=2500000, "aadhi peti"=50000, "3 quarter peti"=7500000
// The caller divides the chosen AMOUNT by the book's unit (state.amountUnit) to get
// the box value; the rate/run is never scaled.
function toNumberTokens(tokens) {
  const nums = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    let base = null, sadeSkip = 0;
    if (V_MOD[t] != null) {                           // "sade/sava <number>" = number + ½ / + ¼
      const nx = tokens[i + 1]; let nv = null;
      if (nx != null) { if (/^\d+(\.\d+)?$/.test(nx)) nv = parseFloat(nx); else if (V_INT[nx] != null && V_MOD[nx] == null) nv = V_INT[nx]; }
      if (nv != null) { base = nv + V_MOD[t]; sadeSkip = 1; }
    }
    if (base == null) {
      if (/^\d+(\.\d+)?$/.test(t)) base = parseFloat(t);
      else if (V_INT[t] != null) base = V_INT[t];
    }
    if (base != null) {
      let j = i + 1 + sadeSkip;
      if (j < tokens.length && V_DOZEN[tokens[j]] != null) { base = base * 12; j++; }   // "2 dozen" = 24
      if (j < tokens.length && V_FRAC[tokens[j]] != null) {            // "3 quarter" / "3 quarter peti"
        const fr = tokens[j]; j++;
        if (j < tokens.length && V_PETI[tokens[j]] != null) { base = base * V_FRAC_PETI[fr]; j++; }  // 3×25000
        else base = base * V_FRAC[fr];                                 // 3×250
      } else if (j < tokens.length && V_PETI[tokens[j]] != null) { base = base * V_PETI[tokens[j]]; j++; } // "2 peti"
      else if (j < tokens.length && V_UNIT[tokens[j]] != null) { base = base * V_UNIT[tokens[j]]; j++; }    // "do hazaar"
      nums.push({ value: base, i }); i = j; continue;
    }
    if (V_FRAC[t] != null) {                                           // "quarter"=250, "quarter peti"=25000, "hadhi peti"=500
      let j = i + 1, val = V_FRAC[t];
      if (j < tokens.length && V_PETI[tokens[j]] != null) { val = V_FRAC_PETI[t]; j++; }
      nums.push({ value: val, i }); i = j; continue;
    }
    if (V_PETI[t] != null) { nums.push({ value: V_PETI[t], i }); i++; continue; }   // bare "peti" = 1000
    if (V_UNIT[t] != null) { nums.push({ value: V_UNIT[t], i }); i++; continue; }
    i++;
  }
  return nums;
}

const V_PMARK = ["number", "num", "numbr", "नंबर", "नं", "naam"];   // "5 number" → party named "5"

// Fixes for what the browser's voice engine actually hears, + Hindi (Devanagari)
// amount words → the romanized slang the parser knows. Add more as they come up.
const VOICE_ALIAS = [
  [/\bsabha\s*pati\b/g, "sava peti"], [/\bsabhapati\b/g, "sava peti"], [/सभापति/g, "sava peti"],
  [/पेटी/g, " peti "], [/सवा/g, " sava "], [/ढाई/g, " dhai "], [/डेढ़?/g, " ded "],
  [/आधी/g, " aadhi "], [/क्वार्टर|क्वाटर/g, " quarter "], [/पौना/g, " paune "],
  [/हज़ार|हजार/g, " hazar "], [/लाख/g, " lakh "], [/तिरंगा/g, " tiranga "],
  [/साढ़े|साढे/g, " sade "], [/पंजा/g, " panja "], [/छक्का/g, " chakka "], [/दर्जन/g, " dozen "],
];

// Parse a spoken/typed sentence into bet fields. Order-independent.
function parseVoiceBet(raw, ctx) {
  ctx = ctx || {};
  let text0 = String(raw || "").toLowerCase().trim()
    .replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)))  // Devanagari digits ०-९ → 0-9
    .replace(/[૦-૯]/g, (d) => String(d.charCodeAt(0) - 0x0AE6));  // Gujarati digits
  for (const [re, rep] of VOICE_ALIAS) text0 = text0.replace(re, rep);  // mishearings + Hindi words
  const text = text0
    .replace(/[,.!?|]/g, " ")
    // The voice engine renders Hindi fraction words as CLOCK TIMES: सवा दो→"2:15",
    // साढ़े तीन→"3:30", पौने चार→"3:45". Convert those back to fractions.
    .replace(/\b(\d+)[:.](15|१५)\b/g, "$1.25")   // sava N  → N.25
    .replace(/\b(\d+)[:.](30|३०)\b/g, "$1.5")    // sade N / ded / dhai → N.5
    .replace(/\b(\d+)[:.](45|४५)\b/g, "$1.75")   // paune N → N.75
    .replace(/[/]/g, " ")
    .replace(/\blucky\s+seven\b/g, "luckyseven")   // "lucky seven" = one slang token (7k / 7 peti)
    .replace(/(\d)([a-zऀ-ॿ])/gi, "$1 $2")   // split glued "2peti" → "2 peti"
    .replace(/([a-zऀ-ॿ])(\d)/gi, "$1 $2");  // and "peti2" → "peti 2"
  const tokens = text.split(/\s+/).filter(Boolean);
  const kwSet = new Set([...V_L, ...V_K, ...V_IN, ...V_PMARK]);
  // stem match so typos still register: laga/lga/lav… → L ; kha/khai… → K
  const RE_L = /^(lag|lga|lav|laag|lgi|lgai)/, RE_K = /^(kha|khai|khay|khi)/;
  const isKw = (t) => kwSet.has(t) || RE_L.test(t) || RE_K.test(t);
  let mode = null;
  if (tokens.some((t) => V_L.includes(t) || RE_L.test(t))) mode = "L";
  else if (tokens.some((t) => V_K.includes(t) || RE_K.test(t))) mode = "K";
  const inIdx = tokens.findIndex((t) => V_IN.includes(t));
  let nums = toNumberTokens(tokens);

  // A number tagged with "number" is a NUMERIC PARTY name (e.g. "india 5 number" → party "5").
  let partyNum = null, partyNumIdx = -1;
  const markIdx = tokens.findIndex((t) => V_PMARK.includes(t));
  if (markIdx >= 0 && nums.length) {
    let best = null, bd = 1e9;
    for (const n of nums) { const d = Math.abs(n.i - markIdx); if (d < bd) { bd = d; best = n; } }
    if (best) { partyNum = tokens[best.i]; partyNumIdx = best.i; const k = nums.indexOf(best); if (k >= 0) nums.splice(k, 1); }
  }

  let rateObj = null, amtObj = null, rateNum = null, amountNum = null;
  if (inIdx >= 0 && nums.length) {
    const before = nums.filter((n) => n.i < inIdx).sort((a, b) => b.i - a.i)[0];
    const after = nums.filter((n) => n.i > inIdx).sort((a, b) => a.i - b.i)[0];
    rateObj = before || after; if (rateObj) rateNum = rateObj.value;
    const pool = nums.filter((n) => n !== rateObj);
    if (pool.length) { amtObj = pool.reduce((a, b) => (b.value > a.value ? b : a)); amountNum = amtObj.value; }
  } else if (nums.length) {
    const sorted = nums.slice().sort((a, b) => b.value - a.value);
    amtObj = sorted[0]; amountNum = amtObj.value; rateObj = sorted[1] || null; rateNum = rateObj ? rateObj.value : null;
  }

  const teams = (ctx.teams || []).map(String), teamL = teams.map((x) => x.toLowerCase());
  const parties = (ctx.parties || []).map(String), partyL = parties.map((x) => x.toLowerCase());
  // team: named token (exact/prefix: "india"→"ind") OR a leftover digit that equals a team ("...ma 2" → team 2).
  const usedNumIdx = new Set();
  if (rateObj) usedNumIdx.add(rateObj.i);
  if (amtObj) usedNumIdx.add(amtObj.i);
  if (partyNumIdx >= 0) usedNumIdx.add(partyNumIdx);
  let team = null, teamIdx = -1;
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (kwSet.has(t)) continue;
    if (/^\d/.test(t)) {                            // numeric team only if this digit is a leftover
      if (usedNumIdx.has(idx)) continue;
      const k = teamL.indexOf(t);
      if (k >= 0) { team = teams[k]; teamIdx = idx; break; }
      continue;
    }
    let k = teamL.indexOf(t);
    if (k < 0) k = teamL.findIndex((tl) => tl.length >= 2 && Math.min(t.length, tl.length) >= 2 && (t.startsWith(tl) || tl.startsWith(t)));
    if (k >= 0) { team = teams[k]; teamIdx = idx; break; }
  }
  // party: numeric-party marker wins; else a known party name; else a leftover number; else a trailing word
  let party = partyNum;
  if (!party) { for (const t of tokens) { const k = partyL.indexOf(t); if (k >= 0 && partyL[k] !== String(team || "").toLowerCase()) { party = parties[k]; break; } } }
  if (!party) {
    const leftover = nums.filter((n) => !usedNumIdx.has(n.i) && n.i !== teamIdx);
    if (leftover.length) party = tokens[leftover[leftover.length - 1].i];
  }
  if (!party) {
    const cand = tokens.filter((t, idx) => !/^\d/.test(t) && !kwSet.has(t) && !isNumWord(t) && idx !== teamIdx);
    if (cand.length) party = cand[cand.length - 1];
  }
  // The amount is in REAL rupees — divide by the book's unit to get the box value.
  // (Rate/run is an odds/line number, never scaled.)
  if (amountNum != null) {
    const unit = (state && state.amountUnit > 0) ? state.amountUnit : 100;
    amountNum = Math.round((amountNum / unit) * 100) / 100;
  }
  return { mode, amount: amountNum, rate: rateNum, team, party, raw: text };
}

function _voiceScore(r) {
  return (r.amount != null ? 2 : 0) + (r.rate != null ? 2 : 0) +
         (r.mode ? 1 : 0) + (r.team ? 1 : 0) + (r.party ? 1 : 0);
}

async function fillFromVoice(kind, textArg) {
  // textArg may be one transcript, or several recognition guesses — try them all
  // and keep the one that parses into the most complete bet.
  const cands = (Array.isArray(textArg) ? textArg : [textArg])
    .map((s) => String(s != null ? s : "").trim()).filter(Boolean);
  if (!cands.length) return;
  let parties = [];
  try { parties = (await api.listParties()).map((p) => p.name); } catch (e) {}
  const teams = (kind === "match" && state.trSession && Array.isArray(state.trSession.teams)) ? state.trSession.teams : [];
  let r = null, best = -1, heard = cands[0];
  for (const c of cands) {
    const cand = parseVoiceBet(c, { teams, parties, kind });
    const sc = _voiceScore(cand);
    if (sc > best) { best = sc; r = cand; heard = c; }
  }
  return applyVoiceResult(kind, r, heard);
}

// Fill the entry fields from a parsed bet and tell the user what was heard.
// Shared by the browser-voice path and the AI (Whisper) path.
function applyVoiceResult(kind, r, heard) {
  if (!r) return r;
  // (Amount unit scaling already applied inside parseVoiceBet.)
  if (kind === "match") {
    if (r.amount != null) $("trQty").value = r.amount;
    if (r.rate != null) $("trRate").value = String(r.rate);
    if (r.team) { const sel = $("trTeam"); const o = [...sel.options].find((x) => x.value.toLowerCase() === String(r.team).toLowerCase()); if (o) sel.value = o.value; }
    if (r.mode) $("trMode").value = r.mode;
    if (r.party) $("trParty").value = r.party;
    if (typeof updateTradePreview === "function") updateTradePreview();
  } else {
    if (r.amount != null) $("syAmount").value = r.amount;
    if (r.rate != null) $("syRun").value = r.rate;               // the "main" number is the run
    if (!$("syRate").value) $("syRate").value = "1";
    if (r.mode) $("syMode").value = r.mode;
    if (r.party) $("syParty").value = r.party;
  }
  const filled = r.amount != null || r.rate != null || r.team || r.mode || r.party;
  // Diagnostic: show ONLY the raw words the voice engine heard (so mishearings are
  // visible). Temporary — remove once the slang mappings are tuned.
  if (heard) toast(`heard: “${heard}”`);
  if (filled) {
    const pf = $(kind === "match" ? "trParty" : "syParty");
    if (pf) { markPartyValidity(pf); pf.focus(); if (pf.value) { try { pf.setSelectionRange(pf.value.length, pf.value.length); } catch (e) {} } }
  }
  return r;
}

// The mic button. Uses AI voice (records a clip → Whisper) when it's turned on
// and this device can record; otherwise the free built-in browser voice. The AI
// path is self-healing: if the function isn't deployed / the key is missing /
// it errors, it switches to the browser path for the rest of the session.
let _aiVoiceDown = false;  // set true once we know AI voice isn't usable this session

// Cloud voice (DESKTOP): record a clip → OpenAI Whisper (via our Supabase "stt" function) →
// text → the SAME parser/field-fill. Works where the browser recognizer can't reach the
// network. The website keeps free browser voice.
const IS_ELECTRON = /electron/i.test((navigator.userAgent || ""));
let _cloudDown = false;   // set true if the stt function/key is unavailable this session
let _rec = { mr: null, chunks: [], kind: null, btn: null, stream: null, active: false, t: null };

function startVoice(kind) {
  const btn = $(kind === "match" ? "trMicBtn" : "syMicBtn");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // Desktop app → cloud voice (reliable). Website (working SR) → free browser/AI voice.
  if (VOICE_CLOUD && IS_ELECTRON && isConfigured && !_cloudDown) { startVoiceCloud(kind, btn); return; }
  if (VOICE_AI && !_aiVoiceDown && SR && isConfigured) {
    startVoiceAIText(kind, btn, SR);
  } else {
    startVoiceBrowser(kind, btn);
  }
}

// Tap mic = start recording; tap again (or after 8s) = stop, transcribe, fill.
async function startVoiceCloud(kind, btn) {
  btn = btn || $(kind === "match" ? "trMicBtn" : "syMicBtn");
  if (_rec.active) { stopVoiceCloud(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast("Allow the microphone, or type the bet", true); return; }
  let mr;
  try { mr = new MediaRecorder(stream); }
  catch (e) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} toast("Mic not available — type instead", true); return; }
  _rec = { mr, chunks: [], kind, btn, stream, active: true, t: null };
  mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) _rec.chunks.push(ev.data); };
  mr.onstop = async () => {
    try { _rec.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    if (_rec.btn) _rec.btn.classList.remove("rec");
    _rec.active = false;
    const blob = new Blob(_rec.chunks, { type: (_rec.chunks[0] && _rec.chunks[0].type) || "audio/webm" });
    if (!blob.size) { toast("Didn't catch that — try again", true); return; }
    toast("Understanding…");
    try {
      const text = await cloudTranscribe(blob);
      if (!text) { toast("Didn't catch that — try again", true); return; }
      const r = await fillFromVoice(kind, [text]);
      state._lastVoice = { heard: text, parsed: r || null, kind };
    } catch (err) {
      if (/HTTP 4|no key|not signed/i.test(String(err && err.message))) _cloudDown = true;
      toast("Voice service error — you can type", true);
    }
  };
  if (btn) btn.classList.add("rec");
  toast("Listening… tap the mic again to stop");
  mr.start();
  _rec.t = setTimeout(() => { if (_rec.active) stopVoiceCloud(); }, 8000);
}
function stopVoiceCloud() {
  try { if (_rec.t) clearTimeout(_rec.t); } catch (_) {}
  try { if (_rec.mr && _rec.mr.state !== "inactive") _rec.mr.stop(); } catch (_) {}
}
// Audio clip → our Supabase "stt" function (holds the OpenAI key) → transcript text.
async function cloudTranscribe(blob) {
  const sess = await currentSession();
  const token = sess && sess.access_token;
  if (!token) throw new Error("not signed in");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = ""; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  const b64 = btoa(bin);
  const lang = ((state && state.voiceLang) || "hi-IN").slice(0, 2);
  const resp = await fetch(SUPABASE_URL + "/functions/v1/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + token },
    body: JSON.stringify({ audio: b64, mime: blob.type || "audio/webm", lang }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || (data && data.error)) throw new Error((data && data.error) || ("HTTP " + resp.status));
  return String((data && data.text) || "").trim();
}
// Learning log: what was heard, what we parsed, and the FINAL submitted values. Best-effort.
async function logVoice(kind, finalFields) {
  const lv = state._lastVoice;
  if (!lv || lv.kind !== kind) return;
  state._lastVoice = null;
  try {
    const sess = await currentSession();
    const token = sess && sess.access_token;
    if (!token) return;
    await fetch(SUPABASE_URL + "/rest/v1/voice_log", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + token, "Prefer": "return=minimal" },
      body: JSON.stringify({ kind, heard: lv.heard, parsed: lv.parsed, final: finalFields, lang: (state && state.voiceLang) || null }),
    });
  } catch (e) { /* ignore */ }
}

// ---- AI voice (browser listens → Claude understands, via voice-parse) ----
function startVoiceAIText(kind, btn, SR) {
  const lang = (state && state.voiceLang) || "en-IN";
  let rec;
  try { rec = new SR(); } catch (e) { startVoiceBrowser(kind, btn); return; }
  rec.lang = lang; rec.interimResults = false; rec.maxAlternatives = 6; rec.continuous = false;
  if (btn) btn.classList.add("rec");
  toast("Listening… speak the bet");
  rec.onresult = async (e) => {
    const res = e.results[0];
    const cands = [];
    for (let i = 0; i < res.length; i++) if (res[i] && res[i].transcript) cands.push(res[i].transcript);
    if (!cands.length) { toast("Didn't catch that — try again", true); return; }
    toast("Understanding…");
    try {
      const done = await aiExtract(kind, cands);
      if (!done) fillFromVoice(kind, cands);        // Claude replied but found nothing → local parse
    } catch (err) {
      _aiVoiceDown = true;                          // function missing / key unset → basic voice from now on
      toast("AI voice unavailable — using basic voice", true);
      fillFromVoice(kind, cands);                   // still fill from what the browser heard
    }
  };
  rec.onerror = (e) => { toast("Mic: " + (e.error || "error") + " — you can type instead", true); };
  rec.onend = () => { if (btn) btn.classList.remove("rec"); };
  try { rec.start(); } catch (err) { if (btn) btn.classList.remove("rec"); startVoiceBrowser(kind, btn); }
}

// Send the browser's guesses to Claude; fill fields from its answer.
// Returns true if it applied a bet, false if Claude found nothing (caller
// then does a local parse). Throws if the function/key is unavailable.
async function aiExtract(kind, transcripts) {
  const sess = await currentSession();
  const token = sess && sess.access_token;
  if (!token) throw new Error("not signed in");
  let parties = [];
  try { parties = (await api.listParties()).map((p) => p.name); } catch (e) {}
  const teams = (kind === "match" && state.trSession && Array.isArray(state.trSession.teams)) ? state.trSession.teams : [];
  const resp = await fetch(SUPABASE_URL + "/functions/v1/voice-parse", {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + token },
    body: JSON.stringify({ transcripts, kind, teams, parties }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((data && data.error) || ("HTTP " + resp.status));
  const heard = String(data.transcript || transcripts[0] || "").trim();
  const p = data.parsed || null;
  if (!p || (p.amount == null && p.rate == null)) return false;
  const mode = (p.mode === "L" || p.mode === "K") ? p.mode : null;
  const r = { mode, amount: p.amount != null ? Number(p.amount) : null, rate: p.rate != null ? Number(p.rate) : null,
              team: p.team || null, party: p.party || null, raw: heard };
  if (_voiceScore(r) === 0) return false;
  applyVoiceResult(kind, r, heard || "voice");
  return true;
}

// ---- Free built-in browser voice (fallback) ----
function startVoiceBrowser(kind, btn) {
  btn = btn || $(kind === "match" ? "trMicBtn" : "syMicBtn");
  const lang = (state && state.voiceLang) || "en-IN";
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const t = prompt("Voice input isn't available here (try the live site in Chrome).\nType the bet instead, e.g.  1000 lagaya 32 main ma sa");
    if (t) fillFromVoice(kind, t);
    return;
  }
  try {
    const rec = new SR();
    rec.lang = lang; rec.interimResults = false; rec.maxAlternatives = 6; rec.continuous = false;
    if (btn) btn.classList.add("rec");
    toast("Listening… speak the bet");
    rec.onresult = (e) => {
      const res = e.results[0];
      const cands = [];
      for (let i = 0; i < res.length; i++) if (res[i] && res[i].transcript) cands.push(res[i].transcript);
      fillFromVoice(kind, cands.length ? cands : [""]);
    };
    rec.onerror = (e) => { toast("Mic: " + (e.error || "error") + " — you can type instead", true); };
    rec.onend = () => { if (btn) btn.classList.remove("rec"); };
    rec.start();
  } catch (err) {
    if (btn) btn.classList.remove("rec");
    const t = prompt("Type the bet, e.g.  1000 lagaya 32 main ma sa"); if (t) fillFromVoice(kind, t);
  }
}

// Submit = add a new trade, or update the one being modified.
// A sauda can only be entered for a client (party) that already exists.
function partyExists(name) {
  const n = (name || "").trim().toLowerCase();
  if (!n) return false;
  return (state.parties || []).some((p) => (p.name || "").toLowerCase() === n);
}

// Party names are case-insensitive: "mo" and "Mo" are the SAME client. Resolve a
// typed/stored name to the party's canonical (stored) spelling, so the book, the
// reports and settlement never split one client into two rows / two ledgers.
function canonParty(name) {
  const n = (name || "").trim();
  if (!n) return n;
  const hit = (state.parties || []).find((p) => (p.name || "").toLowerCase() === n.toLowerCase());
  return hit ? hit.name : n;
}
// Client names, alphabetical — used by the sauda party-box inline autocomplete.
function partyNamesSorted() {
  return (state.parties || []).map((p) => p.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
}
// Rewrite party_name to canonical on a freshly-fetched array of trades/bets.
function canonRows(rows) {
  (rows || []).forEach((r) => { if (r && r.party_name != null) r.party_name = canonParty(r.party_name); });
  return rows;
}
// All trade/bet reads go through these so names are always canonical (merges case variants).
const _apiListTrades = api.listTrades.bind(api);
const _apiListSessionBets = api.listSessionBets.bind(api);
async function fetchTrades(id) { return canonRows(await _apiListTrades(id)); }
async function fetchSessionBets(id) { return canonRows(await _apiListSessionBets(id)); }

// ---------------- keyboard shortcuts (per-device preference) ----------------
// Each client PC can choose its own keys for "jump to Match entry" and "jump to
// Session entry". Stored on this device; defaults to Ctrl+M / Ctrl+S.
const SC_DEFAULT = {
  match:   { ctrl: true, alt: false, shift: false, key: "m" },
  session: { ctrl: true, alt: false, shift: false, key: "s" },
};
function readShortcut(which) {
  try { const s = localStorage.getItem("ssb_sc_" + which); if (s) { const d = JSON.parse(s); if (d && d.key) return { ctrl: !!d.ctrl, alt: !!d.alt, shift: !!d.shift, key: String(d.key).toLowerCase() }; } } catch (e) {}
  return Object.assign({}, SC_DEFAULT[which]);
}
function writeShortcut(which, combo) { try { localStorage.setItem("ssb_sc_" + which, JSON.stringify(combo)); } catch (e) {} }
function shortcutLabel(c) {
  if (!c || !c.key) return "";
  const parts = [];
  if (c.ctrl) parts.push("Ctrl"); if (c.alt) parts.push("Alt"); if (c.shift) parts.push("Shift");
  const key = String(c.key);
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join(" + ");
}
function matchShortcut(e, c) {
  if (!c || !c.key) return false;
  return (!!e.ctrlKey === !!c.ctrl) && (!!e.altKey === !!c.alt) && (!!e.shiftKey === !!c.shift)
      && ((e.key || "").toLowerCase() === String(c.key).toLowerCase());
}
function sameCombo(a, b) {
  return !!a && !!b && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift
      && String(a.key).toLowerCase() === String(b.key).toLowerCase();
}
// Only one capture may be active at a time (clicking another field cancels the first).
let _scActiveCleanup = null;
// Click a settings field, then press the desired combo (needs Ctrl or Alt). Applies at once.
function wireShortcutCapture(inputId, which) {
  const el = $(inputId); if (!el || el._scWired) return; el._scWired = true;
  el.addEventListener("click", () => {
    if (_scActiveCleanup) _scActiveCleanup();        // cancel any other field still capturing
    const prev = el.value;
    el.value = "Press keys… (Esc to cancel)";
    el.classList.add("capturing");
    const other = which === "match" ? "session" : "match";
    const onKey = (ev) => {
      const key = ev.key || "";
      if (["Control", "Alt", "Shift", "Meta"].includes(key)) return;   // wait for the real key
      ev.preventDefault(); ev.stopPropagation();
      if (key === "Escape") { el.value = prev; cleanup(); return; }
      if (!ev.ctrlKey && !ev.altKey) { el.value = "Use Ctrl or Alt + a key…"; return; }   // keep listening
      const combo = { ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, key: key.toLowerCase() };
      // Don't let both shortcuts be the same key.
      if (sameCombo(combo, (state.shortcuts || {})[other])) {
        el.value = "Already the " + other + " key — pick another…";
        toast("That combo is already used for the " + other + " shortcut", true);
        return;   // keep listening
      }
      writeShortcut(which, combo);
      state.shortcuts = state.shortcuts || {}; state.shortcuts[which] = combo;   // live, no Save needed
      el.value = shortcutLabel(combo);
      cleanup();
      toast((which === "match" ? "Match" : "Session") + " shortcut set to " + shortcutLabel(combo));
    };
    const cleanup = () => {
      document.removeEventListener("keydown", onKey, true);
      el.classList.remove("capturing");
      if (_scActiveCleanup === cleanup) _scActiveCleanup = null;
    };
    _scActiveCleanup = cleanup;
    document.addEventListener("keydown", onKey, true);
  });
}

// ---------------- client credit limit (worst-case netted exposure; read-only gate) ----------------
function creditLimit() { let v = 0; try { const s = localStorage.getItem("ssb_credit_limit"); if (s) v = parseFloat(s); } catch (e) {} return v > 0 ? v : 0; }  // 0 = off
function setCreditLimit(v) { v = parseFloat(v); try { localStorage.setItem("ssb_credit_limit", String(v > 0 ? v : 0)); } catch (e) {} }
function partyBalance(name) {
  const n = (name || "").trim().toLowerCase();
  const p = (state.parties || []).find((x) => (x.name || "").toLowerCase() === n);
  return p ? (Number(p.balance) || 0) : 0;   // >0 = we owe them (settled, adds credit); <0 = they owe us
}
// Match worst-case for ONE party in the open match (+ an optional new trade).
function matchExposureFor(party, extraTrade) {
  if (!state.trSession) return { loss: 0, win: 0 };
  const cols = (Array.isArray(state.trSession.teams) && state.trSession.teams.length) ? state.trSession.teams : ["1", "2"];
  const n = (party || "").toLowerCase();
  const list = (state.trades || []).filter((t) => !t.deleted && (t.party_name || "").toLowerCase() === n).slice();
  if (extraTrade) list.push(extraTrade);
  if (!list.length) return { loss: 0, win: 0 };
  const cTot = cols.map(() => 0);
  list.forEach((t) => { const sel = cols.indexOf(t.team), m = tradeMoney(t), q = tradeQty(t);
    cols.forEach((_, k) => { cTot[k] += (k === sel ? m : q); }); });
  const M = Math.max.apply(null, cTot);   // bookie's best outcome against this client = client's worst loss
  return { loss: Math.max(0, M), win: Math.max(0, -M) };
}
// Session worst-case for ONE party in the open session (+ an optional new bet).
function sessionExposureFor(party, extraBet) {
  if (!state.runSession) return { loss: 0, win: 0 };
  const n = (party || "").toLowerCase();
  const list = (state.syBets || []).filter((b) => !b.deleted && (b.party_name || "").toLowerCase() === n).slice();
  if (extraBet) list.push(extraBet);
  if (!list.length) return { loss: 0, win: 0 };
  const cand = new Set([0]);
  list.forEach((b) => { const line = Number(b.run) || 0; cand.add(line); cand.add(Math.max(0, line - 1)); cand.add(line + 1);
    if (b.mode === "BD") cand.add(Number(b.rate) || 0); });
  let maxNet = 0;   // house P&L (+ = client loses) at the worst run outcome for the client
  cand.forEach((R) => { let net = 0; list.forEach((b) => { net += sessionPayoff(b, R); }); if (net > maxNet) maxNet = net; });
  return { loss: Math.max(0, maxNet), win: Math.max(0, -maxNet) };
}
function clientCredit(party, opts) {
  opts = opts || {};
  const limit = creditLimit();
  const eff = limit + partyBalance(party);
  const m = matchExposureFor(party, opts.extraTrade);
  const s = sessionExposureFor(party, opts.extraBet);
  return { limit, eff, matchWin: m.win, sessWin: s.win,
    matchAvail: eff + m.win - m.loss - s.loss,
    sessAvail: eff + s.win - m.loss - s.loss };
}
// Returns true if the entry may proceed, false if blocked (and not raised).
async function creditGate(kind, party, extraKey, extra) {
  if (!(creditLimit() > 0)) return true;
  let c = clientCredit(party, { [extraKey]: extra });
  let avail = kind === "match" ? c.matchAvail : c.sessAvail;
  if (avail < 0) {
    const over = Math.round(-avail);
    const ok = await confirmAsk(`Limit over for ${party} — ${kind} credit short by ${inr(over)} (limit ${inr(c.limit)}). Increase the limit to add this entry?`, "Limit reached");
    if (!ok) return false;
    const nv = prompt("New global credit limit:", String(Math.round(c.limit) + over));
    if (nv == null) return false;
    const v = parseFloat(nv); if (!(v > 0)) return false;
    setCreditLimit(v);
    c = clientCredit(party, { [extraKey]: extra });
    avail = kind === "match" ? c.matchAvail : c.sessAvail;
    if (avail < 0) { toast("Still over the limit — raise it more.", true); return false; }
  }
  const cap = (kind === "match" ? c.eff + c.matchWin : c.eff + c.sessWin);
  if (cap > 0 && avail <= cap * 0.2) toast(`⚠ ${party} near limit — ${kind} credit left ${inr(avail)}`, true);
  return true;
}

// Red border on a party field when the typed name isn't an added client.
function markPartyValidity(el) {
  if (!el) return;
  const v = (el.value || "").trim();
  el.classList.toggle("bad-party", v !== "" && !partyExists(v));
}

// ---- Amount unit (per-device): box amount = real rupees ÷ this (1/10/100/1000) ----
const AMOUNT_UNITS = [1, 10, 100, 1000];
function readAmountUnit() {
  let v = 100;
  try { const s = localStorage.getItem("ssb_amount_unit"); if (s) v = parseFloat(s); } catch (e) {}
  state.amountUnit = AMOUNT_UNITS.includes(v) ? v : 100;
  return state.amountUnit;
}
function writeAmountUnit(v) {
  v = parseFloat(v);
  state.amountUnit = AMOUNT_UNITS.includes(v) ? v : 100;
  try { localStorage.setItem("ssb_amount_unit", String(state.amountUnit)); } catch (e) {}
}

async function doSubmitTrade() {
  if (!state.trSession) return;
  if (String(state.trSession.result || "").trim()) return toast("Match is declared — un-declare to edit.", true);
  const qty = parseFloat($("trQty").value);
  const rate = normalizeRate($("trRate").value);
  const team = $("trTeam").value;
  const mode = $("trMode").value;
  const party_name = canonParty($("trParty").value);   // "mo" and "Mo" → the one stored party
  if (!(qty > 0)) return toast("Enter an amount (qty) greater than 0", true);
  if (!(rate > 0)) return toast("Enter a rate greater than 0", true);
  if (!party_name) return toast("Enter the client (party) name", true);
  if (!partyExists(party_name)) return toast(`"${party_name}" is not a client yet — create it first in Create → New Party.`, true);
  if (!beginWrite("trade")) return;                 // already saving — ignore the repeat
  const _b = $("trSubmit"); if (_b) _b.disabled = true;
  try {
    if (!state.trEditTradeId) {
      const ok = await creditGate("match", party_name, "extraTrade", { qty, rate, team, mode, party_name, deleted: false });
      if (!ok) return;
    }
    if (state.trEditTradeId) {
      await api.updateTrade(state.trEditTradeId, { qty, rate, team, mode, party_name });
      cancelEdit();
      toast("Trade updated");
    } else {
      await api.addTrade({ session_id: state.trSession.id, qty, rate, mode, team, party_name });
      logVoice("match", { amount: qty, rate, team, mode, party: party_name });
      $("trQty").value = ""; $("trRate").value = ""; $("trParty").value = "";
      updateTradePreview();
    }
    await loadTrades();
    $("trRate").focus();
  } catch (err) { toast(err.message, true); }
  finally { endWrite("trade"); if (_b) _b.disabled = false; }
}

// Modify: load the selected row into the bottom bar (no popup) and edit in place.
function startModify() {
  const t = state.trades.find((x) => x.id === state.trSelectedId);
  if (!t) return toast("Tap a trade in the list first", true);
  if (t.deleted) return toast("This trade is deleted.", true);
  state.trEditTradeId = t.id;
  $("trQty").value = t.qty;
  $("trRate").value = t.rate;
  $("trTeam").value = t.team;
  $("trMode").value = t.mode;
  $("trParty").value = t.party_name || "";
  $("trSubmit").textContent = "Update";
  $("trCancelEdit").style.display = "";
  $("trEntryBar").classList.add("editing");
  updateTradePreview();
  $("trRate").focus();
}

function cancelEdit() {
  state.trEditTradeId = null;
  $("trQty").value = ""; $("trRate").value = ""; $("trParty").value = "";
  $("trSubmit").textContent = "Submit";
  $("trCancelEdit").style.display = "none";
  $("trEntryBar").classList.remove("editing");
  updateTradePreview();
}

async function doDeleteTrade() {
  if (!state.trSelectedId) return toast("Tap a trade in the list first", true);
  try {
    await api.deleteTrade(state.trSelectedId);
    state.trSelectedId = null;
    toast("Trade deleted");
    await loadTrades();
  } catch (err) { toast(err.message, true); }
}

// The tally map for the open match: { partyName: ISO-timestamp of the newest sauda
// that was tallied with that client }. A sauda is "tallied" (shown green in the
// drill-down) when its created_at is <= that timestamp. Stored in the DB on the
// match row (trading_sessions.tally) so it survives restarts and syncs everywhere.
function matchTally() {
  const t = state.trSession && state.trSession.tally;
  return (t && typeof t === "object" && !Array.isArray(t)) ? t : {};
}

// Date + time a sauda (trade/bet) was entered, for the report drill-downs.
function saudaDateTime(x) {
  const ts = x && x.created_at;
  if (!ts) return { date: "-", time: "-" };
  let d;
  try { d = new Date(ts); } catch (e) { return { date: "-", time: "-" }; }
  return {
    date: ddmmyyyy(String(ts).slice(0, 10)),
    time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

// A client is "fully tallied" (tick shown) only when its tally checkpoint is at or
// after its newest sauda. A sauda added later makes this false, so the tick clears
// while the earlier green stays.
function isFullyTalliedMatch(party) {
  const cp = matchTally()[party];
  if (cp == null) return false;
  const mine = (state.trades || []).filter((t) => !t.deleted && (t.party_name || "").trim() === party);
  if (!mine.length) return false;
  const latest = mine.map((t) => t.created_at).sort().slice(-1)[0];
  return latest <= cp;
}

// Tick / untick one client's "book tallied till here" in the Match Book.
async function onTallyToggle(party, on) {
  if (!state.trSession) return;
  const tally = Object.assign({}, matchTally());
  if (on) {
    const mine = state.trades.filter((t) => !t.deleted && ((t.party_name || "").trim() === party));
    if (!mine.length) { toast("No saudas for " + party, true); renderBook(); return; }
    // checkpoint = the newest sauda for this client right now
    tally[party] = mine.map((t) => t.created_at).sort().slice(-1)[0];
  } else {
    delete tally[party];
  }
  state.trSession.tally = tally;          // optimistic — repaint at once
  renderBook();
  try { await api.updateMatch(state.trSession.id, { tally }); }
  catch (err) { toast(err.message, true); }
}

// ---- BOOK: Match Book in its own separate window (maximise independently) ----
// Compute the party-wise grid: same team columns (1/2/DRW…) per party + Total.
function computeBook() {
  const cols = (Array.isArray(state.trSession.teams) && state.trSession.teams.length)
    ? state.trSession.teams : ["1", "2"];
  const byParty = projectMatch(cols).perPartyGross;   // the client's FULL/gross book — no commission, no agent share
  const names = Object.keys(byParty).sort((a, b) => a.localeCompare(b));
  const tally = matchTally();
  const totals = cols.map(() => 0);
  const rowsHtml = names.map((nm) => {
    const arr = byParty[nm];
    const tds = arr.map((v, k) => { totals[k] += v; return `<td class="${v < 0 ? "neg" : ""}">${num2(v)}</td>`; }).join("");
    // Ticked only when the client is tallied up to its NEWEST sauda. A new sauda
    // after the last tally clears the tick (something to re-check) — but the green
    // on the already-tallied saudas stays (see renderPartySaudas).
    const on = isFullyTalliedMatch(nm);
    return `<tr class="mbk-prow ${on ? "mbk-ticked" : ""}" data-party="${esc(nm)}" style="cursor:pointer">
      <td class="mbk-tick"><input type="checkbox" class="mbk-chk" data-party="${esc(nm)}" ${on ? "checked" : ""}></td>
      <td>${esc(nm)}</td>${tds}</tr>`;
  }).join("");
  const headCols = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const totCells = totals.map((v) => `<td class="${v < 0 ? "neg" : ""}">${num2(v)}</td>`).join("");
  const sub = `${cols.map(esc).join(" VS ")} &nbsp;—&nbsp; ${ddmmyyyy(state.trSession.trade_date)}`;
  const tableHtml = `<table class="mbk"><thead><tr><th class="mbk-tick">✓</th><th>Party-Name</th>${headCols}</tr></thead>
    <tbody>${rowsHtml || `<tr><td colspan="${cols.length + 2}" style="text-align:center;padding:16px;color:#888">No trades yet.</td></tr>`}
      <tr class="total"><td></td><td><b>Total :</b></td>${totCells}</tr></tbody></table>
    <div id="mbkDrill" class="mbk-drill"></div>`;
  return { sub, tableHtml };
}

function renderBook() {
  if (!state.trSession) return;
  const { sub, tableHtml } = computeBook();
  $("fbSub").innerHTML = sub;
  $("fbBody").innerHTML = tableHtml;
  // Tick box -> mark that client's book "tallied till here" (its own handler, no drill).
  $("fbBody").querySelectorAll(".mbk-chk").forEach((chk) =>
    chk.addEventListener("change", (ev) => {
      ev.stopPropagation();
      onTallyToggle(chk.getAttribute("data-party"), chk.checked);
    }));
  // Click any party row -> show that party's actual saudas for this match (verify the book).
  $("fbBody").onclick = (e) => {
    if (e.target.closest && e.target.closest(".mbk-tick")) return;   // the tick cell is handled above
    if (e.target.closest && e.target.closest(".mbk-drill-x")) {
      state._bookDrillParty = null; const d = $("mbkDrill"); if (d) d.innerHTML = ""; return;
    }
    const tr = e.target.closest && e.target.closest("tr.mbk-prow");
    if (!tr) return;
    state._bookDrillParty = tr.getAttribute("data-party");
    renderPartySaudas(state._bookDrillParty);
  };
  if (state._bookDrillParty) renderPartySaudas(state._bookDrillParty);   // keep it open across refreshes
}

// Drill-down: the raw saudas for one party in this match (opened by clicking a Match Book row).
function renderPartySaudas(party) {
  const host = $("mbkDrill"); if (!host) return;
  const cols = (Array.isArray(state.trSession.teams) && state.trSession.teams.length) ? state.trSession.teams : ["1", "2"];
  const rows = state.trades.filter((t) => !t.deleted && ((t.party_name || "").trim() === party)).sort(byNewest);
  if (!rows.length) { host.innerHTML = ""; return; }
  const cp = matchTally()[party] || null;   // checkpoint: saudas up to here are tallied (green)
  const head = cols.map((c) => `<th class="num">${esc(c)}</th>`).join("");
  const body = rows.map((t, i) => {
    const sel = cols.indexOf(t.team), money = tradeMoney(t), qty = tradeQty(t);
    const cells = cols.map((_, k) => { const v = (k === sel ? money : qty); return `<td class="num ${k === sel ? "money" : ""} ${v < 0 ? "neg" : ""}">${num2(v)}</td>`; }).join("");
    const time = new Date(t.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const date = ddmmyyyy((t.created_at || "").slice(0, 10));
    const green = cp && t.created_at && (t.created_at <= cp);   // tallied with the client
    return `<tr class="${green ? "mbk-tallied" : ""}"><td>${rows.length - i}</td><td class="num">${num2(t.qty)}</td><td class="num">${Number(t.rate)}</td><td>${esc(t.team) || "-"}</td><td>${t.mode}</td><td>${time}</td><td>${date}</td>${cells}</tr>`;
  }).join("");
  host.innerHTML = `<div style="margin-top:10px;font-weight:700;color:#1f4e5f">Saudas — <b>${esc(party)}</b> <span class="mbk-drill-x" style="cursor:pointer;float:right;color:#b00">✕ close</span></div>
    <table class="mbk mbk-saudas" style="margin-top:4px"><thead><tr><th>Sr</th><th>Amount</th><th>Rate</th><th>Fovrt</th><th>Mode</th><th>Time</th><th>Date</th>${head}</tr></thead>
    <tbody>${body}</tbody></table>`;
}

// ================= SESSION (runs) =================
// One bet's result if the session ends on exactly R runs:
//   L (Lagai): R >= line -> +Amount*Rate ; R < line -> -Amount
//   K (Khai) : R >= line -> -Amount       ; R < line -> +Amount*Rate
function sessionPayoff(b, R) {
  const A = Number(b.amount), r = Number(b.rate), line = Number(b.run);
  // Badla: run = our run (mera, stored in run), rate = client's run (tera, stored in rate).
  // House view: + = client loses (book wins), − = client wins (house pays).
  if (b.mode === "BD") {
    const ourRun = Number(b.run), cliRun = Number(b.rate);
    if (R === cliRun) return -A;   // client's run (tera) hits → client wins → house pays
    if (R === ourRun) return A;    // our run (mera) hits → book wins → client pays
    return 0;                      // any other run → void
  }
  // House view: + = client loses, - = client wins.
  // A 90/110 rate only changes the WIN amount (stake × rate); a loss is always
  // the FULL stake. e.g. a 0.90 sauda: win = 900, loss = 1000.
  // Rate applies to the "runs reach the line" (R>=line) outcome: that side pays
  // stake × rate; the "stays below" side pays the full stake. K wins when runs
  // reach the line, L wins when they stay below.
  if (b.mode === "L") return R >= line ? A * r : -A;   // L loses A*r on reach, wins A below
  return R >= line ? -A * r : A;                        // K wins A*r on reach, loses A below
}

async function loadSessionBets() {
  if (!state.runSession) return;
  try { state.syBets = await fetchSessionBets(state.runSession.id); }
  catch (err) { return toast(err.message, true); }
  // ladder centres on the last entered run: 10 runs below and 10 above it
  const lr = lastEnteredRun();
  if (lr > 0 && $("syLayFrom")) $("syLayFrom").value = Math.max(1, lr - 10);
  renderSession();
  const c = $("syLadder") && $("syLadder").parentElement; if (c) c.scrollTop = 0;
}

// Last run entered (newest bet) — the ladder centres on this.
function lastEnteredRun() {
  const bets = (state.syBets || []).filter((b) => !b.deleted);
  if (!bets.length) return 0;
  return Number(bets.slice().sort(byNewest)[0].run) || 0;
}
// Total session commission the house rebates to clients (on turnover, so the
// same at every run) — used to show the NP ladder NET of commission.
function sessionCommTotal() {
  const bets = (state.syBets || []).filter((b) => !b.deleted);
  const ctypeKey = (state.runSession.commission_type || "").toLowerCase();
  const cfgByName = {}; (state.parties || []).forEach((p) => { cfgByName[(p.name || "").toLowerCase()] = p.config || {}; });
  const toNorm = {}, toSpecial = {};
  bets.forEach((b) => {
    const key = (b.party_name || "").trim(); if (!key) return;
    if (b.mode === "BD") return;   // badla: no commission
    const keep = (100 - (Number(((cfgByName[key.toLowerCase()] || {}).self || {}).session) || 0)) / 100;
    const stake = Math.abs(Number(b.amount) || 0) * keep;   // on the book portion (after self share)
    const special = Math.abs((Number(b.rate) || 1) - 1) > 0.0001;   // 90/110 saudas
    if (special) toSpecial[key] = (toSpecial[key] || 0) + stake;
    else toNorm[key] = (toNorm[key] || 0) + stake;
  });
  let total = 0;
  const names = new Set([...Object.keys(toNorm), ...Object.keys(toSpecial)]);
  names.forEach((key) => {
    const cfg = cfgByName[key.toLowerCase()] || {};
    const cs = cfg.comm_session || {}, cs9 = cfg.comm_session_90110 || {};
    const pct = Number(cs[ctypeKey] || 0);
    const pct90 = Number(cs9[ctypeKey] || 0) || pct;
    total += ((toNorm[key] || 0) * pct + (toSpecial[key] || 0) * pct90) / 100;
  });
  return Math.round(total * 100) / 100;
}

// Your net (capital) if the session ends at run R — the real after-share, after-commission
// settlement, mirroring doSaveDeclare. Used by the NP ladder so it matches what you settle.
function projectSessionNP(R) {
  const cfgByName = {};
  (state.parties || []).forEach((p) => { cfgByName[(p.name || "").trim().toLowerCase()] = p.config || {}; });
  const bets = (state.syBets || []).filter((b) => !b.deleted);
  const ctypeKey = (state.runSession.commission_type || "").toLowerCase();
  const byParty = {}, toNorm = {}, toSpecial = {};
  bets.forEach((b) => {
    const key = (b.party_name || "").trim(); if (!key) return;
    byParty[key] = (byParty[key] || 0) + sessionPayoff(b, R);
    if (b.mode === "BD") return;
    const keep = (100 - (Number(((cfgByName[key.toLowerCase()] || {}).self || {}).session) || 0)) / 100;
    const stake = Math.abs(Number(b.amount) || 0) * keep;
    const special = Math.abs((Number(b.rate) || 1) - 1) > 0.0001;
    if (special) toSpecial[key] = (toSpecial[key] || 0) + stake;
    else toNorm[key] = (toNorm[key] || 0) + stake;
  });
  let sum = 0;
  for (const party in byParty) {
    const P = byParty[party];
    const cfg = cfgByName[party.toLowerCase()] || {};
    const status = String(cfg.status || "").toLowerCase();
    const keep = (100 - (Number((cfg.self || {}).session) || 0)) / 100;
    const cs = cfg.comm_session || {}, cs9 = cfg.comm_session_90110 || {}, csa = cfg.comm_session_agent || {}, csa9 = cfg.comm_session_agent_90110 || {};
    const pct = Number(cs[ctypeKey] || 0);
    const pct90 = Number(cs9[ctypeKey] || 0) || pct;
    const apct = Number(csa[ctypeKey] || 0);
    const apct90 = Number(csa9[ctypeKey] || 0);           // agent's 90/110 rate; 0 = no agent comm on 90/110
    // client rebate = TOTAL (comm_session) − agent's cut (comm_session_agent); ladder shows the client book.
    const Ctotal = Math.round(((toNorm[party] || 0) * pct + (toSpecial[party] || 0) * pct90)) / 100;
    const Ca = (status === "booky" || status === "dummy") ? 0 : Math.round(((toNorm[party] || 0) * apct + (toSpecial[party] || 0) * apct90)) / 100;
    const C = Math.round((Ctotal - Ca) * 100) / 100;
    if (status === "dummy") { sum += Math.round(-P * 100) / 100; continue; }
    if (status === "booky") { sum += Math.round((-(keep * P) - C) * 100) / 100; continue; }
    // client + agent commission + agent share + partners (mirror settleClient so the ladder = your TRUE net)
    sum += Math.round((-(keep * P) + C) * 100) / 100;
    let rem = keep * P - C;
    const agents = cfgAgents(cfg).map((a) => ({ name: (a.name || "").trim(), pct: Number(a.session) || 0 })).filter((a) => a.name);
    if (agents[0] && Ca) { sum += Ca; rem -= Ca; }
    for (const ag of agents) if (ag.pct) { const share = Math.round(rem * ag.pct / 100 * 100) / 100; sum += share; rem -= share; }
    for (const ptn of globalPartners()) { const ppct = Number(ptn.session) || 0, nm = (ptn.name || "").trim(); if (nm && ppct) { const psh = Math.round(rem * ppct / 100 * 100) / 100; sum += psh; rem -= psh; } }
  }
  return Math.round(-sum * 100) / 100;
}
function renderSession() {
  if (!state.runSession) return;
  const bets = (state.syBets || []).filter((b) => !b.deleted);
  const layFrom = Math.max(1, parseInt($("syLayFrom").value, 10) || 1);
  const maxRun = (state.syBets || []).reduce((m, b) => Math.max(m, Number(b.run) || 0), layFrom);
  // 21-row window (10 below + run + 10 above); still extend up to cover any higher sauda.
  const end = Math.max(layFrom + 20, maxRun + 2);
  const comm = sessionCommTotal();   // house rebate — NP shown net of this
  // Show the commission being applied (and which type), so it's never a mystery.
  if ($("syCommInfo")) {
    const typeLabel = (state.runSession.commission_type || "").toUpperCase() || "no type";
    $("syCommInfo").innerHTML = comm > 0
      ? `comm <b>${typeLabel}</b>: ${num2(comm)}`
      : `comm <b>${typeLabel}</b>: 0 <span class="sy-comm-hint">— no active client has a ${typeLabel} session %</span>`;
  }
  // RUN / NP ladder (NP is NET of commission), laid out in TWO run columns so
  // twice as many runs show at once (no DM column).
  const items = [];
  for (let R = layFrom; R <= end; R++) {
    items.push({ R, np: projectSessionNP(R) });   // after-share, after-commission net (matches settlement)
  }
  const half = Math.ceil(items.length / 2);
  const cell = (it) => it
    ? `<td><b>${it.R}</b></td><td class="num ${it.np < 0 ? "neg" : (it.np > 0 ? "pos" : "")}">${num2(it.np)}</td>`
    : `<td></td><td class="num"></td>`;
  let ladder = `<thead><tr><th>RUN</th><th class="num">NP</th><th>RUN</th><th class="num">NP</th></tr></thead><tbody>`;
  for (let i = 0; i < half; i++) ladder += `<tr>${cell(items[i])}${cell(items[i + half])}</tr>`;
  ladder += `</tbody>`;
  $("syLadder").innerHTML = ladder;
  // entries list (newest first) — Yes = result if runs pass the line, No = if they fail
  const rows = (state.syBets || []).slice().sort(byNewest);
  let et = `<thead><tr><th class="sr-col">Sr</th><th class="num">Amount</th><th class="num">Run</th><th class="num">Rate</th>
    <th>Mode</th><th>Party_Name</th><th class="num">Yes</th><th class="num">No</th><th>Time</th></tr></thead><tbody>`;
  et += rows.length ? rows.map((b, i) => {
    const A = Number(b.amount), r = Number(b.rate);
    const time = new Date(b.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const cls = b.deleted ? "tr-del" : (b.modified ? "tr-mod" : "");
    if (b.mode === "BD") {
      // Badla: Run = our run (mera), the "Rate" column shows the client's run (tera).
      // Yes col = if OUR run (book wins, +A); No col = if CLIENT's run (house pays, −A).
      return `<tr data-id="${b.id}" class="${cls}"><td class="sr-col">${rows.length - i}</td>
        <td class="num">${num2(b.amount)}</td><td class="num">${Number(b.run)}</td>
        <td class="num">${Number(b.rate)}</td><td><b>BD</b></td>
        <td class="pname">${esc(b.party_name) || "-"}</td>
        <td class="num pos">${num2(A)}</td>
        <td class="num neg">${num2(-A)}</td>
        <td>${time}</td></tr>`;
    }
    // client P&L: the "reach the line" side settles at stake × rate, the "below" side at full stake
    const yes = b.mode === "L" ? -A * r : A * r;   // runs reach the line
    const no = b.mode === "L" ? A : -A;            // runs stay below
    return `<tr data-id="${b.id}" class="${cls}"><td class="sr-col">${rows.length - i}</td>
      <td class="num">${num2(b.amount)}</td><td class="num">${Number(b.run)}</td>
      <td class="num">${Number(b.rate)}</td><td>${b.mode}</td>
      <td class="pname">${esc(b.party_name) || "-"}</td>
      <td class="num ${yes < 0 ? "neg" : "pos"}">${num2(yes)}</td>
      <td class="num ${no < 0 ? "neg" : "pos"}">${num2(no)}</td>
      <td>${time}</td></tr>`;
  }).join("") : `<tr><td colspan="9" class="muted" style="text-align:center;padding:14px">No session bets yet.</td></tr>`;
  et += `</tbody>`;
  $("syEntries").innerHTML = et;
  $("syEntries").querySelectorAll("tr[data-id]").forEach((tr) =>
    tr.addEventListener("click", () => {
      state.sySelectedId = tr.getAttribute("data-id");
      $("syEntries").querySelectorAll("tr").forEach((r) => r.classList.remove("sel"));
      tr.classList.add("sel");
    }));
  if (typeof applySessionLock === "function") applySessionLock();
}

function updateSessionPreview() {
  const el = $("syPreview");
  if (!el) return;
  const mode = $("syMode").value;
  if (mode === "BD") {
    const A = parseFloat($("syAmount").value), our = parseInt($("syRun").value, 10), cli = parseInt($("syClientRun").value, 10);
    if (!(A > 0) || !(our > 0) || !(cli > 0)) { el.textContent = ""; return; }
    el.textContent = `Badla · ${our} (mera) → book +${num2(A)} · ${cli} (tera) → client ${num2(-A)} · else void`;
    return;
  }
  const A = parseFloat($("syAmount").value), r = parseFloat($("syRate").value), line = parseInt($("syRun").value, 10);
  if (!(A > 0) || !(r > 0) || !(line > 0)) { el.textContent = ""; return; }
  // reach the line (R>=line) settles at stake × rate; stays below at full stake
  const atReach = mode === "L" ? -A * r : A * r;
  const atBelow = mode === "L" ? A : -A;
  el.textContent = `≥${line}: ${num2(atReach)} · <${line}: ${num2(atBelow)}`;
}

// Badla (BD) swaps the Rate box for an extra "Client run (tera)" box.
function syncSyMode() {
  const bd = $("syMode") && $("syMode").value === "BD";
  if ($("syClientRun")) $("syClientRun").style.display = bd ? "" : "none";
  if ($("syRate")) $("syRate").style.display = bd ? "none" : "";
}

async function doSubmitSession() {
  if (!state.runSession) return;
  if (isSessionDeclared()) return toast("Session is declared — Un Declare first to edit.", true);
  const amount = parseFloat($("syAmount").value);
  const mode = $("syMode").value;
  const run = parseInt($("syRun").value, 10);
  const party_name = canonParty($("syParty").value);   // "mo" and "Mo" → the one stored party
  // For a badla, "Run" is our run (mera) and the extra box is the client's run (tera).
  // We store the client's run in `rate` (badla has no rate / no commission).
  const isBD = (mode === "BD");
  const rate = isBD ? parseInt($("syClientRun").value, 10) : parseFloat($("syRate").value);
  if (!(amount > 0)) return toast("Enter an amount greater than 0", true);
  if (!(run > 0)) return toast(isBD ? "Enter our run (mera)" : "Enter a run greater than 0", true);
  if (isBD) {
    if (!(rate > 0)) return toast("Enter the client's run (tera)", true);
    if (rate === run) return toast("Client run (tera) and our run (mera) must differ", true);
  } else if (!(rate > 0)) return toast("Enter a rate greater than 0", true);
  if (!party_name) return toast("Enter the client (party) name", true);
  if (!partyExists(party_name)) return toast(`"${party_name}" is not a client yet — create it first in Create → New Party.`, true);
  if (!beginWrite("session")) return;               // already saving — ignore the repeat
  const _b = $("sySubmit"); if (_b) _b.disabled = true;
  try {
    if (!state.syEditId) {
      const ok = await creditGate("session", party_name, "extraBet", { amount, rate, run, mode, party_name, deleted: false });
      if (!ok) return;
    }
    if (state.syEditId) {
      await api.updateSessionBet(state.syEditId, { amount, rate, run, mode, party_name });
      cancelSessionEdit(); toast("Bet updated");
    } else {
      await api.addSessionBet({ session_id: state.runSession.id, amount, rate, run, mode, party_name });
      logVoice("session", { amount, rate, run, mode, party: party_name });
      $("syAmount").value = ""; $("syRate").value = "1"; $("syRun").value = ""; $("syClientRun").value = ""; $("syParty").value = "";
      updateSessionPreview();
    }
    await loadSessionBets();
    $("syRate").focus();
  } catch (err) { toast(err.message, true); }
  finally { endWrite("session"); if (_b) _b.disabled = false; }
}

function startSessionModify() {
  if (isSessionDeclared()) return toast("Session is declared — Un Declare first to edit.", true);
  const b = (state.syBets || []).find((x) => x.id === state.sySelectedId);
  if (!b) return toast("Tap a bet in the list first", true);
  if (b.deleted) return toast("This bet is deleted.", true);
  state.syEditId = b.id;
  $("syAmount").value = b.amount; $("syRun").value = b.run;
  $("syMode").value = b.mode; $("syParty").value = b.party_name || "";
  if (b.mode === "BD") { $("syClientRun").value = b.rate; $("syRate").value = "1"; }
  else { $("syRate").value = b.rate; $("syClientRun").value = ""; }
  syncSyMode();
  $("sySubmit").textContent = "Update"; $("syCancelEdit").style.display = "";
  $("syEntryBar").classList.add("editing");
  updateSessionPreview(); $("syRate").focus();
}

function cancelSessionEdit() {
  state.syEditId = null;
  $("syAmount").value = ""; $("syRate").value = "1"; $("syRun").value = ""; $("syClientRun").value = ""; $("syParty").value = "";
  if ($("syClientRun")) syncSyMode();
  $("sySubmit").textContent = "Submit"; $("syCancelEdit").style.display = "none";
  $("syEntryBar").classList.remove("editing");
  updateSessionPreview();
}

async function doDeleteSessionBet() {
  if (isSessionDeclared()) return toast("Session is declared — Un Declare first to edit.", true);
  if (!state.sySelectedId) return toast("Tap a bet in the list first", true);
  try {
    await api.deleteSessionBet(state.sySelectedId);
    state.sySelectedId = null; toast("Bet deleted");
    await loadSessionBets();
  } catch (err) { toast(err.message, true); }
}

// BOOK opens the Match Book as its own overlay window (toggle).
function toggleBook() {
  if (!state.trSession) return;
  state.bookOpen = !state.bookOpen;
  if (!state.bookOpen) $("trPaneBook").classList.remove("full");
  $("trPaneBook").style.display = state.bookOpen ? "" : "none";
  if (state.bookOpen) renderBook();
}

// Maximise a screen to fill the window (click again to restore the split).
function maximisePane(which) {   // which = "main" | "right"
  state.trMax = (state.trMax === which) ? null : which;
  applyPanes();
}

function applyPanes() {
  const split = $("trSplit");
  const showSession = state.rightMode === "session";
  $("trPaneReport").style.display = showSession ? "none" : "";
  $("trPaneSession").style.display = showSession ? "" : "none";
  split.classList.toggle("max-main", state.trMax === "main");
  split.classList.toggle("max-right", state.trMax === "right");
}

// Print: PDF of the open session (GT + entries).
function printTradingSession() {
  if (!state.trSession) return;
  if (!(window.jspdf && window.jspdf.jsPDF)) { window.print(); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const cols = (Array.isArray(state.trSession.teams) && state.trSession.teams.length)
    ? state.trSession.teams : ["1", "2"];
  const rows = state.trades.slice().sort(byNewest);
  const totals = cols.map(() => 0);
  const body = rows.map((t, i) => {
    const selIdx = cols.indexOf(t.team);
    const money = tradeMoney(t), qty = tradeQty(t);
    const vals = cols.map((_, k) => (k === selIdx ? money : qty));
    if (!t.deleted) cols.forEach((_, k) => { totals[k] += vals[k]; });
    return [rows.length - i, num2(t.qty), Number(t.rate), t.team, t.mode,
      t.party_name || "", ...vals.map(num2), t.deleted ? "DEL" : (t.modified ? "MOD" : "")];
  });
  doc.setFontSize(15); doc.setTextColor(31, 78, 95);
  doc.text(window.__BRAND || BUSINESS_NAME, 14, 16);
  doc.setFontSize(10); doc.setTextColor(90);
  doc.text(`Trading — ${ddmmyyyy(state.trSession.trade_date)}`, 14, 23);
  doc.autoTable({ startY: 27, head: [["GT", ...cols]], body: [["", ...totals.map(num2)]],
    styles: { fontSize: 9 }, headStyles: { fillColor: [31, 78, 95] } });
  doc.autoTable({ startY: doc.lastAutoTable.finalY + 4,
    head: [["Sr", "Amount", "Rate", "Team", "Mode", "Party", ...cols, "Flag"]],
    body, styles: { fontSize: 8 }, headStyles: { fillColor: [31, 78, 95] } });
  deliverPdf(doc, `Trading_${state.trSession.trade_date}.pdf`);
}

// go
$("entryDate") && ($("entryDate").value = todayISO());
boot();
