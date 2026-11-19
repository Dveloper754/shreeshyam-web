// Data access layer. Everything the UI (and, later, an agent) needs, in one
// place. Each function returns plain data or throws on error.
import { supabase } from "./supabaseClient.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

// ---------- Agent API (secure Edge Function) ----------
// The bookmaker calls this to manage their agents' app logins. The master key
// is NEVER here — the function runs server-side with the service role and
// verifies the caller owns the book.
export async function agentFn(payload) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Signed out");
  const r = await fetch(SUPABASE_URL + "/functions/v1/agent", {
    method: "POST",
    headers: { "Authorization": "Bearer " + session.access_token, "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({ error: "Bad response" }));
  if (!r.ok || j.error) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}

// ---------- Parties ----------
export async function listParties(search = "") {
  let q = supabase.from("party_balances").select("*").order("name", { ascending: true });
  if (search.trim()) q = q.ilike("name", `%${search.trim()}%`);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function getParty(partyId) {
  const { data, error } = await supabase
    .from("party_balances").select("*").eq("id", partyId).single();
  if (error) throw error;
  return data;
}

export async function createParty({ name, phone = "", opening_balance = 0, notes = "", config = null }) {
  const row = { name: name.trim(), phone, opening_balance, notes };
  if (config) row.config = config;
  const { data, error } = await supabase.from("parties").insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function updateParty(partyId, fields) {
  const { data, error } = await supabase
    .from("parties").update(fields).eq("id", partyId).select().single();
  if (error) throw error;
  return data;
}

export async function deleteParty(partyId) {
  const { error } = await supabase.from("parties").delete().eq("id", partyId);
  if (error) throw error;
}

// ---------- Entries ----------
// Add via the SQL function so the party is auto-created if new (one call).
export async function addEntry({ party, type, amount, date, mode = "cash", reference = "", remark = "" }) {
  const { data, error } = await supabase.rpc("add_entry", {
    p_party: party,
    p_type: type,
    p_amount: amount,
    p_date: date || null,
    p_mode: mode,
    p_reference: reference,
    p_remark: remark,
  });
  if (error) throw error;
  return data;
}

export async function updateEntry(entryId, fields) {
  const { data, error } = await supabase
    .from("entries").update(fields).eq("id", entryId).select().single();
  if (error) throw error;
  return data;
}

// Edit an entry from the open party's perspective. `signed` is the new amount as
// shown in that party's ledger (positive = left column, negative = right). Both
// legs of a transfer are updated so the change reflects everywhere.
export async function editEntrySigned(entryId, { signed, date, remark }) {
  const { data: sel, error: e0 } = await supabase
    .from("entries").select("id, transfer_id").eq("id", entryId).single();
  if (e0) throw e0;
  const amount = Math.abs(signed);
  const selType = signed >= 0 ? "received" : "paid";
  const otherType = signed >= 0 ? "paid" : "received";
  const { error: e1 } = await supabase.from("entries")
    .update({ type: selType, amount, entry_date: date, remark }).eq("id", entryId);
  if (e1) throw e1;
  if (sel.transfer_id) {
    const { error: e2 } = await supabase.from("entries")
      .update({ type: otherType, amount, entry_date: date, remark })
      .eq("transfer_id", sel.transfer_id).neq("id", entryId);
    if (e2) throw e2;
  }
}

// Permanently remove an entry (and its transfer partner) — no "deleted" mark.
export async function hardDeleteEntry(entryId) {
  const { data } = await supabase.from("entries").select("transfer_id").eq("id", entryId).single();
  if (data && data.transfer_id) {
    const { error } = await supabase.from("entries").delete().eq("transfer_id", data.transfer_id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("entries").delete().eq("id", entryId);
    if (error) throw error;
  }
}

export async function deleteEntry(entryId) {
  // Soft delete: mark as deleted (kept visible, not counted). If this entry is
  // part of a transfer, mark both sides.
  const { data } = await supabase.from("entries").select("transfer_id").eq("id", entryId).single();
  if (data && data.transfer_id) {
    const { error } = await supabase.from("entries").update({ deleted: true }).eq("transfer_id", data.transfer_id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("entries").update({ deleted: true }).eq("id", entryId);
    if (error) throw error;
  }
}

// Hawala (cash transfer) report: transfers for a date, as Jama(+party) / Nave(−party).
export async function listHawala(date) {
  let q = supabase.from("entries").select("*").eq("mode", "transfer").eq("deleted", false);
  if (date) q = q.eq("entry_date", date);
  const { data, error } = await q.order("created_at", { ascending: true });
  if (error) throw error;
  const groups = {};
  (data || []).forEach((e) => { (groups[e.transfer_id] = groups[e.transfer_id] || []).push(e); });
  return Object.values(groups).map((g) => {
    const recv = g.find((x) => x.type === "received") || {};
    const paid = g.find((x) => x.type === "paid") || {};
    return {
      date: (recv.entry_date || paid.entry_date),
      jama: paid.counterparty || "",   // received-side party (balance +)
      nave: recv.counterparty || "",   // paid-side party (balance −)
      amount: Number(recv.amount || paid.amount || 0),
      remark: recv.remark || paid.remark || "",
    };
  });
}

// Delete every entry carrying a given reference tag (used to un-declare a session).
export async function deleteEntriesByRef(reference) {
  const { error } = await supabase.from("entries").delete().eq("reference", reference);
  if (error) throw error;
}

// ---------- Transfer between two party accounts ----------
export async function transfer({ from, to, amount, date, remark = "" }) {
  const { data, error } = await supabase.rpc("transfer", {
    p_from: from, p_to: to, p_amount: amount, p_date: date || null, p_remark: remark,
  });
  if (error) throw error;
  return data;
}

// ---------- Ledger (current period, with running Sub-Total) ----------
export async function getLedger(partyId) {
  const { data, error } = await supabase
    .from("party_ledger").select("*")
    .eq("party_id", partyId)
    .order("entry_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

// ---------- Backup / Export / Import ----------
export async function exportData() {
  const { data, error } = await supabase.rpc("export_data");
  if (error) throw error;
  return data;
}
export async function restoreData(data) {
  const { error } = await supabase.rpc("restore_data", { p_data: data });
  if (error) throw error;
}
export async function createBackup(note = "", kind = "manual") {
  const { data, error } = await supabase.rpc("create_backup", { p_note: note, p_kind: kind });
  if (error) throw error;
  return data;
}
export async function listBackups() {
  const { data, error } = await supabase
    .from("backups").select("id, created_at, kind, note")
    .order("created_at", { ascending: false }).limit(30);
  if (error) throw error;
  return data;
}
export async function restoreBackup(id) {
  const { error } = await supabase.rpc("restore_backup", { p_id: id });
  if (error) throw error;
}
export async function getSettings() {
  // One settings row per user; RLS returns only the caller's row.
  const { data, error } = await supabase.from("settings").select("*").limit(1).maybeSingle();
  if (error) throw error;
  return data || {};
}
export async function setAutoBackup(on) {
  // No id filter — RLS scopes the update to this user's own settings row.
  const { error } = await supabase.from("settings").update({ auto_backup: on }).not("owner", "is", null);
  if (error) throw error;
}
// Merge arbitrary fields (e.g. agents/partners master lists) into this user's settings row.
export async function updateSettings(patch) {
  const { error } = await supabase.from("settings").update(patch).not("owner", "is", null);
  if (error) throw error;
}

// This user's tenant profile (white-label business name + paid mobile flag).
// Read-only for the user; the owner sets these via the admin tool.
export async function getProfile() {
  const { data, error } = await supabase.from("profiles").select("business_name, mobile_enabled, access_until").limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

// First-login setup for a user: make sure they have their own settings row and
// their own Capital account. Safe to call on every login (no-ops once they exist).
export async function ensureUserSetup() {
  try {
    const { data: s } = await supabase.from("settings").select("owner").limit(1);
    if (!s || s.length === 0) {
      await supabase.from("settings").insert({ opening_capital: 0, auto_backup: true, capital_name: "Capital Account" });
    }
  } catch (e) { /* non-fatal */ }
  try {
    const cap = await getCapitalParty();
    if (!cap) {
      await supabase.from("parties").insert({ name: "Capital Account", is_capital: true, opening_balance: 0 });
    }
  } catch (e) { /* non-fatal */ }
}
// The Capital account is a normal party flagged is_capital = true.
export async function getCapitalParty() {
  const { data, error } = await supabase.from("party_balances")
    .select("*").eq("is_capital", true).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}
export async function setCapitalName(name) {
  const cap = await getCapitalParty();
  if (!cap) throw new Error("Capital account not found — please re-run database.sql.");
  const { error } = await supabase.from("parties")
    .update({ name: (name || "").trim() || "Capital Account" }).eq("id", cap.id);
  if (error) throw error;
}

// ---------- Resets ----------
export async function entriesReset() {
  const { error } = await supabase.rpc("entries_reset");
  if (error) throw error;
}
export async function fullReset() {
  const { error } = await supabase.rpc("full_reset");
  if (error) throw error;
}
// Clear all entries/balances but keep the client names (parties).
export async function resetKeepParties() {
  const { error } = await supabase.rpc("reset_keep_parties");
  if (error) throw error;
}
// Erase EVERYTHING — entries, parties, closings, AND backups. Zero records.
export async function eraseAll() {
  const { error } = await supabase.rpc("erase_all");
  if (error) throw error;
}

// ---------- Day Book (only the entries dated on one day) ----------
// Returns today's ledger movements (party_name, type, amount), excluding
// deleted/archived rows. Used by the Day Book so it shows TODAY'S lena-dena
// only, never the all-time outstanding balances (that is the Trial report).
export async function listDayEntries(date) {
  const { data, error } = await supabase
    .from("party_ledger")
    .select("party_name, type, amount, deleted, entry_date")
    .eq("entry_date", date)
    .eq("deleted", false);
  if (error) throw error;
  return data || [];
}

// ---------- Statement (for the printable Ledger, any date range, all periods) ----------
export async function getStatement(partyId, dateFrom, dateTo) {
  let q = supabase.from("entries").select("*")
    .eq("party_id", partyId).eq("deleted", false)
    .order("entry_date", { ascending: true }).order("created_at", { ascending: true });
  if (dateFrom) q = q.gte("entry_date", dateFrom);
  if (dateTo) q = q.lte("entry_date", dateTo);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

// ---------- Monday Final ----------
export async function mondayFinal(partyId, closedOn = null) {
  const { data, error } = await supabase.rpc("monday_final", {
    p_party: partyId,
    p_closed_on: closedOn,
  });
  if (error) throw error;
  return data;
}

// ---------- Capital account (master cash) ----------
export async function getCapital() {
  const { data, error } = await supabase.from("capital_account").select("*").single();
  if (error) throw error;
  return data;
}

export async function getCapitalLedger() {
  const { data, error } = await supabase
    .from("capital_ledger").select("*")
    .order("entry_date", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function setOpeningCapital(value) {
  const cap = await getCapitalParty();
  if (!cap) throw new Error("Capital account not found — please re-run database.sql.");
  const { data, error } = await supabase
    .from("parties").update({ opening_balance: value }).eq("id", cap.id).select().single();
  if (error) throw error;
  return data;
}

// ---------- Old Record (archived periods + their entries) ----------
export async function oldRecords(partyId) {
  const { data: closings, error: e1 } = await supabase
    .from("closings").select("*").eq("party_id", partyId)
    .order("closed_on", { ascending: false });
  if (e1) throw e1;

  const { data: entries, error: e2 } = await supabase
    .from("entries").select("*").eq("party_id", partyId).eq("archived", true)
    .order("entry_date", { ascending: true });
  if (e2) throw e2;

  return { closings: closings || [], entries: entries || [] };
}

// ---------- Matches (team betting) ----------
export async function listMatches() {
  const { data, error } = await supabase.from("trading_sessions").select("*")
    .order("trade_date", { ascending: false }).order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}
export async function createMatch({ team1 = "", team2 = "", type = "", trade_date, teams }) {
  const { data, error } = await supabase.from("trading_sessions")
    .insert({ team1, team2, type, trade_date: trade_date || null, teams: teams || [] }).select().single();
  if (error) throw error;
  return data;
}
export async function updateMatch(id, fields) {
  const { data, error } = await supabase.from("trading_sessions").update(fields).eq("id", id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteMatch(id) {
  const { error } = await supabase.from("trading_sessions").delete().eq("id", id);
  if (error) throw error;
}

// ---------- Sessions within a match ----------
export async function listSessions(matchId) {
  const { data, error } = await supabase.from("match_sessions").select("*")
    .eq("match_id", matchId).order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}
export async function createSession({ match_id, name = "", session_date, commission_type = "" }) {
  const { data, error } = await supabase.from("match_sessions")
    .insert({ match_id, name, session_date: session_date || null, commission_type }).select().single();
  if (error) throw error;
  return data;
}
export async function updateSession(id, fields) {
  const { data, error } = await supabase.from("match_sessions").update(fields).eq("id", id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteSession(id) {
  const { error } = await supabase.from("match_sessions").delete().eq("id", id);
  if (error) throw error;
}

// ---------- Match team bets (trading_entries, keyed by match via session_id) ----------
export async function listTrades(sessionId) {
  const { data, error } = await supabase.from("trading_entries").select("*")
    .eq("session_id", sessionId).order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}
export async function addTrade(t) {
  const { data, error } = await supabase.from("trading_entries").insert(t).select().single();
  if (error) throw error;
  return data;
}
export async function updateTrade(id, fields) {
  const { data, error } = await supabase.from("trading_entries")
    .update({ ...fields, modified: true }).eq("id", id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteTrade(id) {
  const { error } = await supabase.from("trading_entries").update({ deleted: true }).eq("id", id);
  if (error) throw error;
}

// ---------- Session (runs) bets ----------
export async function listSessionBets(sessionId) {
  const { data, error } = await supabase.from("session_bets").select("*")
    .eq("session_id", sessionId).order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}
export async function addSessionBet(b) {
  const { data, error } = await supabase.from("session_bets").insert(b).select().single();
  if (error) throw error;
  return data;
}
export async function updateSessionBet(id, fields) {
  const { data, error } = await supabase.from("session_bets")
    .update({ ...fields, modified: true }).eq("id", id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteSessionBet(id) {
  const { error } = await supabase.from("session_bets").update({ deleted: true }).eq("id", id);
  if (error) throw error;
}
